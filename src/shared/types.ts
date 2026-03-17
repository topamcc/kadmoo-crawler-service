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
}

export interface CrawlJobResultsResponse {
  jobId: string;
  status: CrawlJobStatus;
  summary: CrawlResultSummary;
  pages: CrawledPageData[];
  artifactUrl?: string;
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
}

// ---------------------------------------------------------------------------
// Webhook events
// ---------------------------------------------------------------------------

export type WebhookEventType =
  | "crawl.started"
  | "crawl.progress"
  | "crawl.completed"
  | "crawl.failed";

export interface WebhookPayload {
  event: WebhookEventType;
  jobId: string;
  timestamp: string;
  data: CrawlJobStatusResponse;
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
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export interface ApiError {
  error: string;
  code?: string;
  details?: unknown;
}
