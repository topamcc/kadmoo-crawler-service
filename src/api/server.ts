import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { config } from "../config/index.js";
import { logger } from "../logger/index.js";
import { globalErrorHandler } from "./middleware/error-handler.js";
import { healthRoutes } from "./routes/health.js";
import { crawlRoutes } from "./routes/crawl.js";
import { analyzeRoutes } from "./routes/analyze.js";

export async function buildServer() {
  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 1048576, // 1MB
  });

  await app.register(cors, { origin: true });
  await app.register(helmet);
  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
    keyGenerator: (req) =>
      (req.headers["x-api-key"] as string) ?? req.ip,
  });

  app.setErrorHandler(globalErrorHandler);

  await app.register(healthRoutes);
  await app.register(crawlRoutes);
  await app.register(analyzeRoutes);

  return app;
}

export async function startServer() {
  const app = await buildServer();

  try {
    await app.listen({ port: config.port, host: config.host });
    logger.info({ port: config.port, host: config.host }, "Crawler service started");
  } catch (err) {
    logger.fatal(err, "Failed to start server");
    process.exit(1);
  }

  return app;
}
