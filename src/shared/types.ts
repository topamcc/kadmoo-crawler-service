/**
 * Shared types for the Kadmoo Crawler Service.
 * These types define the API contract between the web app and crawler service.
 * A mirror copy should exist in the web app for type-safe integration.
 */

// ---------------------------------------------------------------------------
// Job lifecycle
// ---------------------------------------------------------------------------

export type CrawlJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface CrawlJobConfig {
  auditId: string;
  url: string;
  siteId?: string;
  maxPages: number;
  maxDepth: number;
  maxDurationMinutes: number;
  concurrency: number;
  timeoutMs: number;
  respectRobotsTxt: boolean;
  forcePlaywright: boolean;
  includeSubdomains: boolean;
  webhookUrl?: string;
  idempotencyKey?: string;
}

export interface CrawlJobProgress {
  pagesQueued: number;
  pagesCrawled: number;
  pagesFailed: number;
  currentUrl?: string;
  elapsedMs: number;
  estimatedRemainingMs?: number;
  resumed?: boolean;
  reusedPages?: number;
}

export interface CreateCrawlJobRequest {
  url: string;
  siteId?: string;
  maxPages?: number;
  maxDepth?: number;
  maxDurationMinutes?: number;
  concurrency?: number;
  timeoutMs?: number;
  respectRobotsTxt?: boolean;
  forcePlaywright?: boolean;
  includeSubdomains?: boolean;
  webhookUrl?: string;
  idempotencyKey?: string;
}

export interface CreateCrawlJobResponse {
  jobId: string;
  status: CrawlJobStatus;
  createdAt: string;
}

export interface CrawlJobStatusResponse {
  jobId: string;
  status: CrawlJobStatus;
  progress: CrawlJobProgress;
  config: CrawlJobConfig;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  usedPlaywrightFallback?: boolean;
  resumed?: boolean;
  reusedPages?: number;
}

/** Sitemap snapshot from crawl seed phase (for analysis + crawl meta) */
export interface CrawlSitemapSnapshot {
  exists: boolean;
  url: string;
  urls: string[];
  urlCount: number;
  isValid: boolean;
  errors: string[];
  robotsSitemapsUsed: string[];
}

export interface CrawlJobResultsResponse {
  jobId: string;
  status: CrawlJobStatus;
  summary: CrawlResultSummary;
  pages: CrawledPageData[];
  artifactUrl?: string;
  resumed?: boolean;
  reusedPages?: number;
  /** Populated when external crawler ran sitemap discovery */
  sitemap?: CrawlSitemapSnapshot;
}

// ---------------------------------------------------------------------------
// Crawled page data
// ---------------------------------------------------------------------------

export interface CrawledPageData {
  url: string;
  finalUrl: string;
  statusCode: number;
  contentType: string;
  title: string;
  metaDescription: string;
  h1: string[];
  h2: string[];
  canonicalUrl?: string;
  mainContent: string;
  internalLinks: LinkData[];
  externalLinks: LinkData[];
  crawlDepth: number;
  responseTimeMs: number;
  contentLength: number;
  usedPlaywright: boolean;
  error?: string;
  /** Per-page image URLs extracted from img[src]. */
  images?: { src: string }[];
}

export interface LinkData {
  url: string;
  text: string;
  rel?: string;
  nofollow: boolean;
}

export interface CrawlResultSummary {
  totalPages: number;
  successfulPages: number;
  failedPages: number;
  totalInternalLinks: number;
  totalExternalLinks: number;
  averageResponseTimeMs: number;
  totalContentLength: number;
  crawlDurationMs: number;
  uniqueStatusCodes: Record<number, number>;
  depthDistribution: Record<number, number>;
  playwriteFallbackCount: number;
  /** URLs read from sitemap(s) after crawl filters */
  sitemapUrlsDiscovered?: number;
  /** Sitemap URLs actually added to the crawl queue (deduped, within maxPages) */
  sitemapSeedsEnqueued?: number;
  /** Size of URL frontier after crawl completes (for coverage meta) */
  finalEnqueuedUrlCount?: number;
}

// ---------------------------------------------------------------------------
// Webhook events
// ---------------------------------------------------------------------------

export type WebhookEventType =
  | "audit.completed"
  | "audit.failed";

export interface AuditEventData {
  auditId: string;
  jobId: string;
  status: "completed" | "failed";
  error?: string;
}

export interface WebhookPayload {
  event: WebhookEventType;
  jobId: string;
  timestamp: string;
  data: AuditEventData;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface HealthResponse {
  status: "ok" | "degraded";
  version: string;
  uptime: number;
  queue: {
    active: number;
    waiting: number;
    completed: number;
    failed: number;
  };
  redis: boolean;
  active_jobs?: number;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export interface ApiError {
  error: string;
  code?: string;
  details?: unknown;
}
