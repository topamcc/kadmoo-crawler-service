import { startServer } from "./api/server.js";
import { startWorker, stopWorker } from "./queue/worker.js";
import { closeQueue } from "./queue/crawl-queue.js";
import { logger } from "./logger/index.js";

async function main() {
  const app = await startServer();
  const worker = await startWorker();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down gracefully...");
    await app.close();
    await stopWorker();
    await closeQueue();
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
