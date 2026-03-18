import { Worker, type Job } from "bullmq";
import { getRedisConnection as getRedisUrl } from "./crawl-queue.js";
import { config } from "../config/index.js";
import { logger } from "../logger/index.js";
import { crawlManager } from "../crawler/manager.js";
import { webhookDispatcher } from "../webhook/dispatcher.js";
import { quotaManager } from "../budget/quota-manager.js";
import { saveResults } from "../storage/results-store.js";
import { deleteCheckpoint } from "../storage/checkpoint.js";
import { ensureAbsoluteUrl, normalizeUrl } from "../crawler/url-normalizer.js";
import type {
  CrawlJobConfig,
  CrawlJobProgress,
  CrawlJobResultsResponse,
  CrawlJobStatusResponse,
} from "../shared/types.js";

interface CrawlJobData {
  jobId: string;
  config: CrawlJobConfig;
  progress?: CrawlJobProgress;
  usedPlaywrightFallback?: boolean;
}

async function processCrawlJob(job: Job<CrawlJobData>): Promise<CrawlJobResultsResponse> {
  const { jobId, config: jobConfig } = job.data;
  const log = logger.child({ jobId, url: jobConfig.url });

  log.info("Starting crawl job");
  await quotaManager.recordJobStart(jobConfig.siteId, jobConfig.maxPages);
  const startTime = Date.now();

  // Notify webhook: started
  const makeStatusPayload = (overrides: Partial<CrawlJobStatusResponse> = {}): CrawlJobStatusResponse => ({
    jobId,
    status: "running",
    progress: job.data.progress ?? {
      pagesQueued: 0,
      pagesCrawled: 0,
      pagesFailed: 0,
      elapsedMs: Date.now() - startTime,
    },
    config: jobConfig,
    createdAt: new Date(job.timestamp).toISOString(),
    startedAt: new Date().toISOString(),
    ...overrides,
  });

  if (jobConfig.webhookUrl) {
    await webhookDispatcher.send(jobConfig.webhookUrl, {
      event: "crawl.started",
      jobId,
      timestamp: new Date().toISOString(),
      data: makeStatusPayload(),
    });
  }

  try {
    const result = await crawlManager.execute(jobId, jobConfig, (progress) => {
      job.data.progress = progress;
      job.updateProgress(progress.pagesCrawled);

      // Periodic webhook updates (every 100 pages)
      if (jobConfig.webhookUrl && progress.pagesCrawled % 100 === 0 && progress.pagesCrawled > 0) {
        webhookDispatcher.send(jobConfig.webhookUrl, {
          event: "crawl.progress",
          jobId,
          timestamp: new Date().toISOString(),
          data: makeStatusPayload({ progress }),
        }).catch((err) => log.warn({ err }, "Progress webhook failed"));
      }
    });

    job.data.usedPlaywrightFallback = result.usedPlaywrightFallback;

    const response: CrawlJobResultsResponse = {
      jobId,
      status: "completed",
      summary: result.summary,
      pages: result.pages,
      artifactUrl: result.artifactUrl,
      ...(result.resumed && { resumed: true, reusedPages: result.reusedPages }),
    };

    // crawl.completed webhook is sent from worker.on("completed") so it fires
    // only after BullMQ has stored returnvalue and /crawl/:id/results is available.

    log.info(
      { pages: result.summary.totalPages, durationMs: result.summary.crawlDurationMs },
      "Crawl job completed",
    );

    const seedUrl = normalizeUrl(ensureAbsoluteUrl(jobConfig.url)) ?? ensureAbsoluteUrl(jobConfig.url);
    await deleteCheckpoint(jobConfig.siteId, seedUrl).catch((e) =>
      log.warn({ err: e }, "Failed to delete checkpoint"),
    );

    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ err: error }, "Crawl job failed");

    if (jobConfig.webhookUrl) {
      await webhookDispatcher.send(jobConfig.webhookUrl, {
        event: "crawl.failed",
        jobId,
        timestamp: new Date().toISOString(),
        data: makeStatusPayload({
          status: "failed",
          error: message,
          completedAt: new Date().toISOString(),
        }),
      }).catch(() => {});
    }

    const seedUrl = normalizeUrl(ensureAbsoluteUrl(jobConfig.url)) ?? ensureAbsoluteUrl(jobConfig.url);
    await deleteCheckpoint(jobConfig.siteId, seedUrl).catch(() => {});

    throw error;
  }
}

let workerInstance: Worker | null = null;

export async function startWorker(): Promise<Worker> {
  if (workerInstance) return workerInstance;

  await quotaManager.resetActiveJobsOnStartup().catch((e) => {
    logger.warn({ err: e }, "Failed to reset active_jobs on startup");
  });

  workerInstance = new Worker<CrawlJobData>("crawl-jobs", processCrawlJob, {
    connection: { url: getRedisUrl() },
    concurrency: config.budget.maxConcurrentJobs,
  });

  workerInstance.on("completed", async (job, result: CrawlJobResultsResponse) => {
    logger.info({ jobId: job.id }, "Job completed");
    quotaManager.recordJobEnd().catch((e) =>
      logger.warn({ err: e }, "Failed to decrement active_jobs on complete"),
    );

    const jobConfig = job.data.config;

    // CRITICAL: Send webhook FIRST so the app gets crawl.completed even if saveResults OOMs.
    // The app triggers /api/audit/analyze which fetches from GET /crawl/:id/results (BullMQ).
    if (jobConfig?.webhookUrl && result) {
      const payload = {
        jobId: result.jobId,
        status: "completed" as const,
        progress: {
          pagesQueued: result.summary.totalPages,
          pagesCrawled: result.summary.totalPages,
          pagesFailed: result.summary.failedPages,
          elapsedMs: result.summary.crawlDurationMs,
        },
        config: jobConfig,
        createdAt: new Date(job.timestamp).toISOString(),
        startedAt: new Date(job.timestamp).toISOString(),
        completedAt: new Date().toISOString(),
        usedPlaywrightFallback: job.data.usedPlaywrightFallback,
        artifactUrl: result.artifactUrl ?? `results/${result.jobId}.json.gz`,
        ...(result.resumed && { resumed: true, reusedPages: result.reusedPages }),
      };
      await webhookDispatcher.send(jobConfig.webhookUrl, {
        event: "crawl.completed",
        jobId: result.jobId,
        timestamp: new Date().toISOString(),
        data: payload,
      }).catch((err) => logger.warn({ err, jobId: job.id }, "crawl.completed webhook failed"));
    }

    // Fire-and-forget: persist to backup store (non-critical, BullMQ has data for 24h)
    if (result && job.id) {
      saveResults(job.id, result).catch((err) =>
        logger.warn({ err, jobId: job.id }, "Failed to persist results to results-store"),
      );
    }
  });

  workerInstance.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "Job failed");
    quotaManager.recordJobEnd().catch((e) =>
      logger.warn({ err: e }, "Failed to decrement active_jobs on failure"),
    );
  });

  workerInstance.on("error", (err) => {
    logger.error({ err }, "Worker error");
  });

  logger.info({ concurrency: config.budget.maxConcurrentJobs }, "Crawl worker started");
  return workerInstance;
}

export async function stopWorker() {
  if (workerInstance) {
    await workerInstance.close();
    workerInstance = null;
  }
}
