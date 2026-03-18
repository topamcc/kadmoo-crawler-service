import { Worker, type Job } from "bullmq";
import { getRedisConnection } from "./crawl-queue.js";
import { getCrawlQueue } from "./crawl-queue.js";
import { loadResults } from "../storage/results-store.js";
import { webhookDispatcher } from "../webhook/dispatcher.js";
import { getSupabaseClient } from "../supabase/client.js";
import { runAnalysis } from "../analysis/run-analysis.js";
import { logger } from "../logger/index.js";
import type { CrawlJobResultsResponse } from "../shared/types.js";
import type { AnalyzeJobData } from "./analyze-queue.js";

async function loadCrawlResults(externalJobId: string): Promise<CrawlJobResultsResponse | null> {
  const stored = await loadResults(externalJobId);
  if (stored) return stored;

  const queue = getCrawlQueue();
  const job = await queue.getJob(externalJobId);
  if (job) {
    const state = await job.getState();
    if (state === "completed") {
      const result = job.returnvalue as CrawlJobResultsResponse | undefined;
      if (result) return result;
    }
  }

  return null;
}

async function processAnalyzeJob(job: Job<AnalyzeJobData>): Promise<void> {
  const { auditId, externalJobId, url, siteId, pagesQueued, webhookUrl } = job.data;
  const log = logger.child({ jobId: job.id, auditId, externalJobId });

  log.info("Starting analyze job");

  const results = await loadCrawlResults(externalJobId);
  if (!results) {
    const errMsg = "Crawl results not found (job may have been evicted or not yet completed)";
    log.error({ externalJobId }, errMsg);

    if (webhookUrl) {
      await webhookDispatcher.send(webhookUrl, {
        event: "analyze.failed",
        jobId: job.id!,
        timestamp: new Date().toISOString(),
        data: {
          auditId,
          jobId: job.id!,
          status: "failed",
          error: errMsg,
        },
      }).catch((e) => log.warn({ err: e }, "analyze.failed webhook failed"));
    }

    throw new Error(errMsg);
  }

  const supabase = getSupabaseClient();
  const { success, error } = await runAnalysis({
    auditId,
    url,
    siteId,
    results,
    supabase,
    pagesQueued,
  });

  if (webhookUrl) {
    await webhookDispatcher.send(webhookUrl, {
      event: success ? "analyze.completed" : "analyze.failed",
      jobId: job.id!,
      timestamp: new Date().toISOString(),
      data: {
        auditId,
        jobId: job.id!,
        status: success ? "completed" : "failed",
        ...(error && { error }),
      },
    }).catch((e) => log.warn({ err: e }, "analyze webhook failed"));
  }

  if (!success) {
    throw new Error(error ?? "Analysis failed");
  }

  log.info("Analyze job completed");
}

let workerInstance: Worker<AnalyzeJobData> | null = null;

export async function startAnalyzeWorker(): Promise<Worker<AnalyzeJobData>> {
  if (workerInstance) return workerInstance;

  workerInstance = new Worker<AnalyzeJobData>(
    "analyze-jobs",
    processAnalyzeJob,
    {
      connection: { url: getRedisConnection() },
      concurrency: 2,
    },
  );

  workerInstance.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, auditId: job?.data?.auditId, err }, "Analyze job failed");
  });

  workerInstance.on("error", (err) => {
    logger.error({ err }, "Analyze worker error");
  });

  logger.info({ concurrency: 2 }, "Analyze worker started");
  return workerInstance;
}

export async function stopAnalyzeWorker() {
  if (workerInstance) {
    await workerInstance.close();
    workerInstance = null;
  }
}
