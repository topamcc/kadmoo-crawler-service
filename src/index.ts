import { startServer } from "./api/server.js";
import { startWorker, stopWorker } from "./queue/worker.js";
import { startAnalyzeWorker, stopAnalyzeWorker } from "./queue/analyze-worker.js";
import { closeQueue } from "./queue/crawl-queue.js";
import { closeAnalyzeQueue } from "./queue/analyze-queue.js";
import { closeResultsRedis } from "./storage/results-store.js";
import { closeCheckpointRedis } from "./storage/checkpoint.js";
import { logger } from "./logger/index.js";

async function main() {
  const app = await startServer();
  const worker = await startWorker();
  const analyzeWorker = await startAnalyzeWorker();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down gracefully...");
    await app.close();
    await stopWorker();
    await stopAnalyzeWorker();
    await closeQueue();
    await closeAnalyzeQueue();
    await closeResultsRedis().catch(() => {});
    await closeCheckpointRedis().catch(() => {});
    logger.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "Uncaught exception");
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    logger.fatal({ err }, "Unhandled rejection");
    process.exit(1);
  });
}

main().catch((err) => {
  logger.fatal({ err }, "Failed to start");
  process.exit(1);
});
