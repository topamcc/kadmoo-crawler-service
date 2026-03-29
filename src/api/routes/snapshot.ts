import type { FastifyInstance } from "fastify";
import { homepageSnapshotSchema } from "../../shared/schemas.js";
import { apiKeyAuth } from "../middleware/auth.js";
import { quotaManager } from "../../budget/quota-manager.js";
import { fetchHomepageSnapshot } from "../../crawler/homepage-snapshot.js";
import { logger } from "../../logger/index.js";

export async function snapshotRoutes(app: FastifyInstance) {
  app.addHook("onRequest", apiKeyAuth);

  /**
   * POST /snapshot/homepage
   * Synchronous fetch of homepage HTML (fetch + optional Playwright) for FTR fallback.
   */
  app.post("/snapshot/homepage", async (request, reply) => {
    const parsed = homepageSnapshotSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: "Validation failed",
        code: "VALIDATION_ERROR",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { url, forcePlaywright } = parsed.data;

    const budgetCheck = await quotaManager.checkBudget(undefined);
    if (!budgetCheck.allowed) {
      return reply.code(429).send({
        ok: false,
        error: budgetCheck.reason ?? "Too many concurrent operations",
        code: "BUDGET_EXCEEDED",
      });
    }

    await quotaManager.recordJobStart(undefined, 1);
    try {
      const result = await fetchHomepageSnapshot(url, { forcePlaywright });
      if (!result.ok) {
        logger.warn({ url, code: result.code, httpStatus: result.httpStatus }, "Homepage snapshot failed");
        return reply.code(200).send({
          ok: false,
          error: result.message,
          code: result.code,
          httpStatus: result.httpStatus,
        });
      }
      logger.info({ url, source: result.source, statusCode: result.statusCode }, "Homepage snapshot ok");
      return reply.send({
        ok: true,
        html: result.html,
        statusCode: result.statusCode,
        finalUrl: result.finalUrl,
        source: result.source,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, url }, "Homepage snapshot unexpected error");
      return reply.code(500).send({
        ok: false,
        error: message,
        code: "INTERNAL_ERROR",
      });
    } finally {
      await quotaManager.recordJobEnd();
    }
  });
}
