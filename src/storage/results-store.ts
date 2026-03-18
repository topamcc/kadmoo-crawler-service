/**
 * Persistent results storage for crawl jobs.
 * Saves results to a dedicated Redis key (7-day TTL) independent of BullMQ job lifecycle.
 * Falls back to S3 object storage when available.
 */
import Redis from "ioredis";
import { config } from "../config/index.js";
import { logger } from "../logger/index.js";
import { objectStorage } from "./object-storage.js";
import type { CrawlJobResultsResponse } from "../shared/types.js";

const RESULTS_PREFIX = "crawl:results:";
const RESULTS_TTL_SEC = 7 * 24 * 60 * 60; // 7 days

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
  }
  return redis;
}

function redisKey(jobId: string): string {
  return `${RESULTS_PREFIX}${jobId}`;
}

function s3Key(jobId: string): string {
  return `results/${jobId}.json.gz`;
}

export async function saveResults(jobId: string, data: CrawlJobResultsResponse): Promise<void> {
  const json = JSON.stringify(data);

  // Save to dedicated Redis key (survives BullMQ job eviction)
  try {
    await getRedis().setex(redisKey(jobId), RESULTS_TTL_SEC, json);
    logger.debug({ jobId, sizeBytes: json.length }, "Results saved to Redis");
  } catch (err) {
    logger.warn({ err, jobId }, "Failed to save results to Redis");
  }

  // Also save to S3 for persistence across Redis restarts
  if (objectStorage.isEnabled()) {
    try {
      await objectStorage.uploadJson(s3Key(jobId), data);
      logger.debug({ jobId }, "Results saved to S3");
    } catch (err) {
      logger.warn({ err, jobId }, "Failed to save results to S3");
    }
  }
}

export async function loadResults(jobId: string): Promise<CrawlJobResultsResponse | null> {
  // Try dedicated Redis key first
  try {
    const raw = await getRedis().get(redisKey(jobId));
    if (raw) {
      logger.debug({ jobId }, "Results loaded from Redis");
      return JSON.parse(raw) as CrawlJobResultsResponse;
    }
  } catch (err) {
    logger.warn({ err, jobId }, "Failed to load results from Redis");
  }

  // Fall back to S3
  if (objectStorage.isEnabled()) {
    try {
      const data = await objectStorage.downloadJson<CrawlJobResultsResponse>(s3Key(jobId));
      if (data) {
        logger.debug({ jobId }, "Results loaded from S3");
        return data;
      }
    } catch (err) {
      logger.warn({ err, jobId }, "Failed to load results from S3");
    }
  }

  return null;
}

export async function closeResultsRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}
