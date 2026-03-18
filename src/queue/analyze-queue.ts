import { Queue } from "bullmq";
import { config } from "../config/index.js";

let analyzeQueue: Queue | null = null;

export interface AnalyzeJobData {
  jobId: string;
  auditId: string;
  externalJobId: string;
  url: string;
  siteId: string;
  pagesQueued?: number;
  webhookUrl: string;
}

export function getAnalyzeQueue(): Queue<AnalyzeJobData> {
  if (!analyzeQueue) {
    analyzeQueue = new Queue<AnalyzeJobData>("analyze-jobs", {
      connection: { url: config.redisUrl },
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { age: 86400, count: 1000 },
        removeOnFail: { age: 604800, count: 500 },
      },
    });
  }
  return analyzeQueue;
}

export async function closeAnalyzeQueue() {
  if (analyzeQueue) {
    await analyzeQueue.close();
    analyzeQueue = null;
  }
}
