import { Worker, type Job } from "bullmq";
import { getRedisConnection } from "./crawl-queue.js";
import { getCrawlQueue } from "./crawl-queue.js";
import { loadResults, loadResultsFromLegacyPath } from "../storage/results-store.js";
import { objectStorage } from "../storage/object-storage.js";
import { webhookDispatcher } from "../webhook/dispatcher.js";
import { getSupabaseClient } from "../supabase/client.js";
import { runAnalysis } from "../analysis/run-analysis.js";
import { logger } from "../logger/index.js";
import type { CrawlJobResultsResponse } from "../shared/types.js";
import type { AnalyzeJobData } from "./analyze-queue.js";

async function loadCrawlResults(
  externalJobId: string,
  siteId: string,
  artifactUrl?: string,
): Promise<CrawlJobResultsResponse | null> {
  // Priority 1: direct S3 load via artifactUrl
  // Try legacy (downloadJson) first for existing scans; streaming (downloadNdjsonStream) for new format
  if (artifactUrl && objectStorage.isEnabled()) {
    try {
      const data = await objectStorage.downloadJson<CrawlJobResultsResponse>(artifactUrl);
      if (data?.summary && Array.isArray(data.pages)) {
        logger.info({ externalJobId, artifactUrl, pages: data.pages.length }, "Results loaded from artifactUrl (legacy)");
        if (!data.jobId) data.jobId = externalJobId;
        if (!data.status) data.status = "completed";
        return data;
      }
    } catch (legacyErr) {
      try {
        const data = await objectStorage.downloadNdjsonStream<CrawlJobResultsResponse>(artifactUrl);
        if (data?.summary && Array.isArray(data.pages)) {
          logger.info({ externalJobId, artifactUrl, pages: data.pages.length }, "Results loaded from artifactUrl (streaming)");
          if (!data.jobId) data.jobId = externalJobId;
          if (!data.status) data.status = "completed";
          return data;
        }
      } catch (streamErr) {
        logger.warn({ err: streamErr, externalJobId, artifactUrl }, "Streaming load also failed");
      }
      logger.warn({ err: legacyErr, externalJobId, artifactUrl }, "Failed to load from artifactUrl, trying fallbacks");
    }
  }

  // Priority 2: results-store (Redis + S3 results/{jobId}.json.gz)
  const stored = await loadResults(externalJobId);
  if (stored) return stored;

  // Priority 3: legacy S3 path crawl-results/{siteId}/
  const legacy = await loadResultsFromLegacyPath(siteId, externalJobId);
  if (legacy) return legacy;

  // Priority 4: BullMQ returnvalue
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

const ANALYZE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 60000}m`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function processAnalyzeJob(job: Job<AnalyzeJobData>): Promise<void> {
  const { auditId, externalJobId, url, siteId, pagesQueued, webhookUrl, artifactUrl } = job.data;
  const log = logger.child({ jobId: job.id, auditId, externalJobId });

  log.info({ artifactUrl }, "Starting analyze job");

  const results = await loadCrawlResults(externalJobId, siteId, artifactUrl);
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
  const { success, error } = await withTimeout(
    runAnalysis({
      auditId,
      url,
      siteId,
      results,
      supabase,
      pagesQueued,
    }),
    ANALYZE_TIMEOUT_MS,
    `Analysis for audit ${auditId}`,
  );

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
      concurrency: 1,
    },
  );

  workerInstance.on("failed", (job, err) => {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(
      { jobId: job?.id, auditId: job?.data?.auditId, errMsg, stack: err instanceof Error ? err.stack : undefined },
      "Analyze job failed",
    );
  });

  workerInstance.on("error", (err) => {
    logger.error({ err }, "Analyze worker error");
  });

  logger.info({ concurrency: 1 }, "Analyze worker started");
  return workerInstance;
}

export async function stopAnalyzeWorker() {
  if (workerInstance) {
    await workerInstance.close();
    workerInstance = null;
  }
}
