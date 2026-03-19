import type { CrawlJobConfig, CrawlJobProgress } from "../shared/types.js";
import { executeCrawl, type CrawlExecutionResult } from "./executor.js";

class CrawlManager {
  async execute(
    jobId: string,
    jobConfig: CrawlJobConfig,
    onProgress: (progress: CrawlJobProgress) => void,
  ): Promise<CrawlExecutionResult> {
    return executeCrawl(jobId, jobConfig, onProgress);
  }
}

export const crawlManager = new CrawlManager();
