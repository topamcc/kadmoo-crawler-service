import { Worker, type Job } from "bullmq";
import { getRedisConnection as getRedisUrl } from "./crawl-queue.js";
import { config } from "../config/index.js";
import { logger } from "../logger/index.js";
import { crawlManager } from "../crawler/manager.js";
import { webhookDispatcher } from "../webhook/dispatcher.js";
import { quotaManager } from "../budget/quota-manager.js";
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
    };

    // Notify webhook: completed
    if (jobConfig.webhookUrl) {
      await webhookDispatcher.send(jobConfig.webhookUrl, {
        event: "crawl.completed",
        jobId,
        timestamp: new Date().toISOString(),
        data: makeStatusPayload({
          status: "completed",
          completedAt: new Date().toISOString(),
          progress: {
            pagesQueued: 0,
            pagesCrawled: result.summary.totalPages,
            pagesFailed: result.summary.failedPages,
            elapsedMs: result.summary.crawlDurationMs,
          },
          usedPlaywrightFallback: result.usedPlaywrightFallback,
        }),
      });
    }

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

export function startWorker(): Worker {
  if (workerInstance) return workerInstance;

  workerInstance = new Worker<CrawlJobData>("crawl-jobs", processCrawlJob, {
    connection: { url: getRedisUrl() },
    concurrency: config.budget.maxConcurrentJobs,
  });

  workerInstance.on("completed", (job) => {
    logger.info({ jobId: job.id }, "Job completed");
    quotaManager.recordJobEnd().catch((e) =>
      logger.warn({ err: e }, "Failed to decrement active_jobs on complete"),
    );
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
