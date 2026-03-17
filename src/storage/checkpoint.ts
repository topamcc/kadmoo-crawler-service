/**
 * Per-site crawl checkpoint storage for resume support.
 * Persists queue/visited/depth state in Redis with TTL.
 */
import Redis from "ioredis";
import { config } from "../config/index.js";
import { logger } from "../logger/index.js";
import type { CrawlJobConfig } from "../shared/types.js";

const CHECKPOINT_PREFIX = "crawl:checkpoint:";
const CHECKPOINT_TTL_SEC = 24 * 60 * 60; // 24h

export interface CrawlCheckpoint {
  site_id: string;
  seed_url: string;
  queue_urls: string[];
  visited_urls: string[];
  failed_urls: string[];
  depth_map: Record<string, number>;
  pages_crawled_count: number;
  updated_at: string;
  expires_at: string;
  crawl_fingerprint: string;
}

function fingerprint(config: CrawlJobConfig): string {
  const parts = [
    config.url,
    config.maxPages,
    config.maxDepth,
    config.maxDurationMinutes,
    config.concurrency,
    config.timeoutMs,
    config.respectRobotsTxt,
    config.forcePlaywright,
    config.includeSubdomains,
  ];
  return parts.join("|");
}

function checkpointKey(siteId: string | undefined, seedUrl: string): string {
  const sid = siteId ?? "anonymous";
  const normalized = seedUrl.replace(/\/$/, "").toLowerCase();
  const hash = Buffer.from(normalized).toString("base64url").slice(0, 32);
  return `${CHECKPOINT_PREFIX}${sid}:${hash}`;
}

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
  }
  return redis;
}

export async function saveCheckpoint(
  siteId: string | undefined,
  seedUrl: string,
  jobConfig: CrawlJobConfig,
  data: {
    queueUrls: Set<string>;
    visitedUrls: string[];
    failedUrls: Set<string>;
    depthMap: Map<string, number>;
    pagesCrawledCount: number;
  },
): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CHECKPOINT_TTL_SEC * 1000);
  const checkpoint: CrawlCheckpoint = {
    site_id: siteId ?? "anonymous",
    seed_url: seedUrl,
    queue_urls: Array.from(data.queueUrls),
    visited_urls: data.visitedUrls,
    failed_urls: Array.from(data.failedUrls),
    depth_map: Object.fromEntries(data.depthMap),
    pages_crawled_count: data.pagesCrawledCount,
    updated_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    crawl_fingerprint: fingerprint(jobConfig),
  };

  const key = checkpointKey(siteId, seedUrl);
  const client = getRedis();
  await client.setex(key, CHECKPOINT_TTL_SEC, JSON.stringify(checkpoint));
  logger.debug({ key, pagesCrawled: data.pagesCrawledCount }, "Checkpoint saved");
}

export async function loadCheckpoint(
  siteId: string | undefined,
  seedUrl: string,
  jobConfig: CrawlJobConfig,
): Promise<CrawlCheckpoint | null> {
  const key = checkpointKey(siteId ?? "anonymous", seedUrl);
  const client = getRedis();
  const raw = await client.get(key);
  if (!raw) return null;

  let checkpoint: CrawlCheckpoint;
  try {
    checkpoint = JSON.parse(raw) as CrawlCheckpoint;
  } catch {
    await client.del(key);
    return null;
  }

  const now = new Date();
  if (new Date(checkpoint.expires_at) < now) {
    await client.del(key);
    return null;
  }

  if (checkpoint.crawl_fingerprint !== fingerprint(jobConfig)) {
    return null;
  }

  return checkpoint;
}

export async function deleteCheckpoint(siteId: string | undefined, seedUrl: string): Promise<void> {
  const key = checkpointKey(siteId ?? "anonymous", seedUrl);
  await getRedis().del(key);
}

export async function getStaleCheckpointCount(): Promise<number> {
  const client = getRedis();
  const keys = await client.keys(`${CHECKPOINT_PREFIX}*`);
  const now = Date.now();
  let stale = 0;
  for (const key of keys) {
    const ttl = await client.ttl(key);
    if (ttl < 0 || ttl < CHECKPOINT_TTL_SEC / 2) stale++;
  }
  return stale;
}

export async function closeCheckpointRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}
