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
const MAX_PAGES_FOR_PERSISTENCE = 2000;

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
  if (data.pages && data.pages.length > MAX_PAGES_FOR_PERSISTENCE) {
    logger.info(
      { jobId, pageCount: data.pages.length },
      "Skipping results persistence -- payload too large. Data remains in BullMQ returnvalue for 24h.",
    );
    return;
  }

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

/** Legacy path: crawl-results/{siteId}/{timestamp}.json.gz (old crawls before results/{jobId}.json.gz). */
export async function loadResultsFromLegacyPath(
  siteId: string,
  jobId: string,
): Promise<CrawlJobResultsResponse | null> {
  if (!objectStorage.isEnabled()) return null;

  const prefix = `crawl-results/${siteId}/`;
  try {
    const keys = await objectStorage.listObjects(prefix);
    if (keys.length === 0) return null;

    // Sorted ascending; take the most recent (last)
    const latestKey = keys[keys.length - 1];
    const raw = await objectStorage.downloadJson<{ config?: unknown; summary: CrawlJobResultsResponse["summary"]; pages: CrawlJobResultsResponse["pages"] }>(
      latestKey,
    );

    if (!raw?.summary || !raw?.pages) return null;

    const response: CrawlJobResultsResponse = {
      jobId,
      status: "completed",
      summary: raw.summary,
      pages: raw.pages,
      artifactUrl: latestKey,
    };
    logger.debug({ jobId, key: latestKey }, "Results loaded from legacy S3 path");
    return response;
  } catch (err) {
    logger.warn({ err, jobId, siteId }, "Failed to load results from legacy S3 path");
    return null;
  }
}

export async function closeResultsRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}
