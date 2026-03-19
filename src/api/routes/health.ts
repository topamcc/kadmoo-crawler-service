import type { FastifyInstance } from "fastify";
import { getCrawlQueue } from "../../queue/crawl-queue.js";
import { config } from "../../config/index.js";
import type { HealthResponse } from "../../shared/types.js";

const startTime = Date.now();

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async (_req, reply) => {
    let queueStats = { active: 0, waiting: 0, completed: 0, failed: 0 };
    let redisOk = false;

    try {
      const queue = getCrawlQueue();
      const [active, waiting, completed, failed] = await Promise.all([
        queue.getActiveCount(),
        queue.getWaitingCount(),
        queue.getCompletedCount(),
        queue.getFailedCount(),
      ]);
      queueStats = { active, waiting, completed, failed };
      redisOk = true;
    } catch {
      redisOk = false;
    }

    const response: HealthResponse = {
      status: redisOk ? "ok" : "degraded",
      version: "1.0.0",
      uptime: Date.now() - startTime,
      queue: queueStats,
      redis: redisOk,
      active_jobs: queueStats.active,
    };

    reply.code(redisOk ? 200 : 503).send(response);
  });
}
