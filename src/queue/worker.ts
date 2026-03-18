import { Worker, type Job } from "bullmq";
import { getRedisConnection as getRedisUrl } from "./crawl-queue.js";
import { config } from "../config/index.js";
import { logger } from "../logger/index.js";
import { crawlManager } from "../crawler/manager.js";
import { webhookDispatcher } from "../webhook/dispatcher.js";
import { quotaManager } from "../budget/quota-manager.js";
import { saveResults } from "../storage/results-store.js";
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
    const result = await crawlManager.execute(jobConfig, (progress) => {
      job.data.progress = progress;
      job.updateProgress(progress.pagesCrawled);

      // Periodic webhook updates (every 20 pages)
      if (jobConfig.webhookUrl && progress.pagesCrawled % 20 === 0 && progress.pagesCrawled > 0) {
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

    // Persist results to dedicated store (Redis key + S3) so they survive BullMQ eviction
    if (result && job.id) {
      await saveResults(job.id, result).catch((err) =>
        logger.warn({ err, jobId: job.id }, "Failed to persist results to results-store"),
      );
    }

    // Emit crawl.completed only after BullMQ has stored returnvalue, so
    // GET /crawl/:id/results is available when the app receives the webhook.
    const jobConfig = job.data.config;
    if (jobConfig?.webhookUrl && result) {
      const payload: CrawlJobStatusResponse = {
        jobId: result.jobId,
        status: "completed",
        progress: {
          pagesQueued: 0,
          pagesCrawled: result.summary.totalPages,
          pagesFailed: result.summary.failedPages,
          elapsedMs: result.summary.crawlDurationMs,
        },
        config: jobConfig,
        createdAt: new Date(job.timestamp).toISOString(),
        startedAt: new Date(job.timestamp).toISOString(),
        completedAt: new Date().toISOString(),
        usedPlaywrightFallback: job.data.usedPlaywrightFallback,
        ...(result.resumed && { resumed: true, reusedPages: result.reusedPages }),
      };
      await webhookDispatcher.send(jobConfig.webhookUrl, {
        event: "crawl.completed",
        jobId: result.jobId,
        timestamp: new Date().toISOString(),
        data: payload,
      }).catch((err) => logger.warn({ err, jobId: job.id }, "crawl.completed webhook failed"));
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
