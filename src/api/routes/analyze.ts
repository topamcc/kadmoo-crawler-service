import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { getAnalyzeQueue, type AnalyzeJobData } from "../../queue/analyze-queue.js";
import { apiKeyAuth } from "../middleware/auth.js";
import { logger } from "../../logger/index.js";

export async function analyzeRoutes(app: FastifyInstance) {
  app.addHook("onRequest", apiKeyAuth);

  app.post<{
    Body: {
      auditId: string;
      externalJobId: string;
      url: string;
      siteId: string;
      pagesQueued?: number;
      webhookUrl: string;
    };
  }>("/analyze", async (request, reply) => {
    const body = request.body;

    if (
      !body.auditId ||
      !body.externalJobId ||
      !body.url ||
      !body.siteId ||
      !body.webhookUrl
    ) {
      return reply.code(400).send({
        error: "Missing required fields: auditId, externalJobId, url, siteId, webhookUrl",
        code: "VALIDATION_ERROR",
      });
    }

    const jobId = nanoid(21);
    const jobData: AnalyzeJobData = {
      jobId,
      auditId: body.auditId,
      externalJobId: body.externalJobId,
      url: body.url.trim(),
      siteId: body.siteId,
      pagesQueued: body.pagesQueued,
      webhookUrl: body.webhookUrl.replace(/\/$/, ""),
    };

    const queue = getAnalyzeQueue();
    await queue.add("analyze", jobData, {
      jobId,
      attempts: 2,
      backoff: { type: "exponential", delay: 5000 },
    });

    logger.info({ jobId, auditId: body.auditId, externalJobId: body.externalJobId }, "Analyze job queued");

    return reply.code(201).send({
      jobId,
      status: "queued",
    });
  });
}
