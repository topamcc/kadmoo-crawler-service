import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { createCrawlJobSchema } from "../../shared/schemas.js";
import type {
  CreateCrawlJobResponse,
  CrawlJobStatusResponse,
  CrawlJobResultsResponse,
  CrawlJobConfig,
} from "../../shared/types.js";
import { getCrawlQueue } from "../../queue/crawl-queue.js";
import { config } from "../../config/index.js";
import { apiKeyAuth } from "../middleware/auth.js";
import { quotaManager } from "../../budget/quota-manager.js";
import { logger } from "../../logger/index.js";
import { loadResults } from "../../storage/results-store.js";

export async function crawlRoutes(app: FastifyInstance) {
  app.addHook("onRequest", apiKeyAuth);

  // ── POST /crawl ──────────────────────────────────────
  app.post("/crawl", async (request, reply) => {
    const parsed = createCrawlJobSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Validation failed",
        code: "VALIDATION_ERROR",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const input = parsed.data;

    // Idempotency check
    if (input.idempotencyKey) {
      const existing = await quotaManager.getJobByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        return reply.code(200).send({
          jobId: existing,
          status: "queued",
          createdAt: new Date().toISOString(),
        } satisfies CreateCrawlJobResponse);
      }
    }

    // Budget check
    const budgetCheck = await quotaManager.checkBudget(input.siteId);
    if (!budgetCheck.allowed) {
      return reply.code(429).send({
        error: budgetCheck.reason ?? "Budget exceeded",
        code: "BUDGET_EXCEEDED",
      });
    }

    const jobId = nanoid(21);
    const jobConfig: CrawlJobConfig = {
      url: input.url,
      siteId: input.siteId,
      maxPages: input.maxPages ?? config.crawl.defaultMaxPages,
      maxDepth: input.maxDepth ?? config.crawl.defaultMaxDepth,
      maxDurationMinutes: input.maxDurationMinutes ?? config.crawl.defaultMaxDurationMinutes,
      concurrency: input.concurrency ?? config.crawl.defaultConcurrency,
      timeoutMs: input.timeoutMs ?? config.crawl.defaultTimeoutMs,
      respectRobotsTxt: input.respectRobotsTxt ?? true,
      forcePlaywright: input.forcePlaywright ?? false,
      includeSubdomains: input.includeSubdomains ?? true,
      webhookUrl: input.webhookUrl,
      idempotencyKey: input.idempotencyKey,
    };

    const queue = getCrawlQueue();
    await queue.add("crawl", { jobId, config: jobConfig }, {
      jobId,
      attempts: 2,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { age: 86400, count: 1000 },
      removeOnFail: { age: 604800, count: 5000 },
    });

    if (input.idempotencyKey) {
      await quotaManager.registerIdempotencyKey(input.idempotencyKey, jobId);
    }
    await quotaManager.recordJobStart(input.siteId, jobConfig.maxPages);

    logger.info({ jobId, url: input.url, siteId: input.siteId }, "Crawl job created");

    const response: CreateCrawlJobResponse = {
      jobId,
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    return reply.code(201).send(response);
  });

  // ── GET /crawl/:id/status ────────────────────────────
  app.get<{ Params: { id: string } }>("/crawl/:id/status", async (request, reply) => {
    const { id } = request.params;
    const queue = getCrawlQueue();
    const job = await queue.getJob(id);

    if (!job) {
      return reply.code(404).send({ error: "Job not found", code: "NOT_FOUND" });
    }

    const state = await job.getState();
    const statusMap: Record<string, string> = {
      waiting: "queued",
      delayed: "queued",
      active: "running",
      completed: "completed",
      failed: "failed",
    };

    const response: CrawlJobStatusResponse = {
      jobId: id,
      status: (statusMap[state] ?? "queued") as CrawlJobStatusResponse["status"],
      progress: job.data.progress ?? {
        pagesQueued: 0,
        pagesCrawled: 0,
        pagesFailed: 0,
        elapsedMs: 0,
      },
      config: job.data.config,
      createdAt: new Date(job.timestamp).toISOString(),
      startedAt: job.processedOn ? new Date(job.processedOn).toISOString() : undefined,
      completedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : undefined,
      error: state === "failed" ? job.failedReason : undefined,
      usedPlaywrightFallback: job.data.usedPlaywrightFallback,
    };

    return reply.send(response);
  });

  // ── GET /crawl/:id/results ───────────────────────────
  app.get<{ Params: { id: string } }>("/crawl/:id/results", async (request, reply) => {
    const { id } = request.params;
    const queue = getCrawlQueue();
    const job = await queue.getJob(id);

    if (job) {
      const state = await job.getState();
      if (state !== "completed") {
        return reply.code(409).send({
          error: "Job not yet completed",
          code: "JOB_NOT_COMPLETED",
          status: state,
        });
      }

      const result = job.returnvalue as CrawlJobResultsResponse | undefined;
      if (result) {
        return reply.send(result);
      }
    }

    // Fallback: BullMQ job evicted or returnvalue missing -- try persistent store
    const stored = await loadResults(id);
    if (stored) {
      logger.info({ jobId: id }, "Serving results from persistent store (BullMQ job evicted)");
      return reply.send(stored);
    }

    return reply.code(404).send({ error: "Job not found", code: "NOT_FOUND" });
  });
}
