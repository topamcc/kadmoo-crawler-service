import * as fs from "node:fs";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { Worker, type Job } from "bullmq";
import { getRedisConnection as getRedisUrl } from "./crawl-queue.js";
import { config } from "../config/index.js";
import { logger } from "../logger/index.js";
import { crawlManager } from "../crawler/manager.js";
import { webhookDispatcher } from "../webhook/dispatcher.js";
import { quotaManager } from "../budget/quota-manager.js";
import { getSupabaseClient } from "../supabase/client.js";
import { runAnalysis } from "../analysis/run-analysis.js";
import type {
  CrawlJobConfig,
  CrawlJobProgress,
  CrawlJobResultsResponse,
  CrawledPageData,
} from "../shared/types.js";

interface CrawlJobData {
  jobId: string;
  config: CrawlJobConfig;
  progress?: CrawlJobProgress;
  usedPlaywrightFallback?: boolean;
}

async function readNdjsonToPages(ndjsonPath: string): Promise<CrawledPageData[]> {
  const pages: CrawledPageData[] = [];
  const rl = createInterface({
    input: createReadStream(ndjsonPath),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed) pages.push(JSON.parse(trimmed) as CrawledPageData);
  }
  return pages;
}

async function processCrawlJob(job: Job<CrawlJobData>): Promise<void> {
  const { jobId, config: jobConfig } = job.data;
  const { auditId, url, siteId, webhookUrl } = jobConfig;
  const log = logger.child({ jobId, auditId, url: jobConfig.url });

  log.info("Starting crawl + analysis job");
  await quotaManager.recordJobStart(siteId, jobConfig.maxPages);

  const supabase = getSupabaseClient();

  const { data: audit } = await (supabase as any)
    .from("site_audits")
    .select("status")
    .eq("id", auditId)
    .single();

  if ((audit as { status?: string } | null)?.status === "completed") {
    log.info({ auditId }, "Audit already completed (idempotency), skipping");
    return;
  }

  try {
    const { error: updateErr } = await (supabase as any)
      .from("site_audits")
      .update({
        status: "crawling",
        progress: {
          percent: 5,
          phase: "crawling",
          current_step: "מתחיל סריקה...",
        },
      })
      .eq("id", auditId);
    if (updateErr) log.warn({ err: updateErr }, "Initial progress update failed");

    const result = await crawlManager.execute(jobId, jobConfig, async (progress) => {
      job.data.progress = progress;
      job.updateProgress(progress.pagesCrawled);

      if (progress.pagesCrawled > 0 && progress.pagesCrawled % 100 === 0) {
        const pct = Math.min(80, Math.round((progress.pagesCrawled / (progress.pagesQueued || progress.pagesCrawled)) * 80) || 20);
        const { error: progErr } = await (supabase as any)
          .from("site_audits")
          .update({
            status: "crawling",
            pages_crawled: progress.pagesCrawled,
            progress: {
              percent: pct,
              phase: "crawling",
              current_step: `נסרקו ${progress.pagesCrawled} דפים...`,
              pagesQueued: progress.pagesQueued,
              pagesCrawled: progress.pagesCrawled,
              estimatedRemainingMs: progress.estimatedRemainingMs,
            },
          })
          .eq("id", auditId);
        if (progErr) log.warn({ err: progErr }, "Progress update failed");
      }
    });

    job.data.usedPlaywrightFallback = result.usedPlaywrightFallback;

    log.info({ pages: result.summary.totalPages }, "Crawl completed, loading pages for analysis...");

    const pages = await readNdjsonToPages(result.ndjsonPath);

    try {
      fs.unlinkSync(result.ndjsonPath);
    } catch (e) {
      log.warn({ err: e, ndjsonPath: result.ndjsonPath }, "Failed to delete temp NDJSON");
    }

    const results: CrawlJobResultsResponse = {
      jobId,
      status: "completed",
      summary: result.summary,
      pages,
    };

    const { success, error } = await runAnalysis({
      auditId,
      url: url.trim(),
      siteId: siteId ?? "",
      results,
      supabase,
      pagesQueued: result.summary.totalPages,
    });

    results.pages.length = 0;

    if (!success) {
      throw new Error(error ?? "Analysis failed");
    }

    if (webhookUrl) {
      await webhookDispatcher.send(webhookUrl, {
        event: "audit.completed",
        jobId,
        timestamp: new Date().toISOString(),
        data: {
          auditId,
          jobId,
          status: "completed",
        },
      }).catch((err) => log.warn({ err }, "audit.completed webhook failed"));
    }

    log.info({ auditId }, "Audit job completed");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ err: error }, "Audit job failed");

    const { error: failErr } = await (supabase as any)
      .from("site_audits")
      .update({
        status: "failed",
        error_message: message,
        progress: { percent: 0, phase: "failed", current_step: message },
      })
      .eq("id", auditId);
    if (failErr) log.warn({ err: failErr }, "Failed to update audit status");

    if (webhookUrl) {
      await webhookDispatcher.send(webhookUrl, {
        event: "audit.failed",
        jobId,
        timestamp: new Date().toISOString(),
        data: {
          auditId,
          jobId,
          status: "failed",
          error: message,
        },
      }).catch(() => {});
    }

    throw error;
  } finally {
    await quotaManager.recordJobEnd();
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
    lockDuration: config.queue.workerLockDurationMs,
    lockRenewTime: config.queue.workerLockRenewTimeMs,
  });

  workerInstance.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "Job failed");
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
