import { Queue } from "bullmq";
import { config } from "../config/index.js";

let queue: Queue | null = null;

export function getRedisConnection() {
  return config.redisUrl;
}

export function getCrawlQueue(): Queue {
  if (!queue) {
    queue = new Queue("crawl-jobs", {
      connection: { url: config.redisUrl },
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "exponential", delay: 5000 },
      },
    });
  }
  return queue;
}

export async function closeQueue() {
  if (queue) {
    await queue.close();
    queue = null;
  }
}
