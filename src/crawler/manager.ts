import type { CrawlJobConfig, CrawlJobProgress } from "../shared/types.js";
import { executeCrawl, type CrawlExecutionResult } from "./executor.js";
import { objectStorage } from "../storage/object-storage.js";
import { logger } from "../logger/index.js";

class CrawlManager {
  async execute(
    jobConfig: CrawlJobConfig,
    onProgress: (progress: CrawlJobProgress) => void,
  ): Promise<CrawlExecutionResult> {
    const result = await executeCrawl(jobConfig, onProgress);

    // Upload full results to object storage if available
    if (objectStorage.isEnabled()) {
      try {
        const key = `crawl-results/${jobConfig.siteId ?? "anonymous"}/${Date.now()}.json.gz`;
        await objectStorage.uploadJson(key, {
          config: jobConfig,
          summary: result.summary,
          pages: result.pages,
        });
        result.artifactUrl = key;
        logger.info({ key }, "Crawl artifacts uploaded to object storage");
      } catch (err) {
        logger.warn({ err }, "Failed to upload crawl artifacts (non-blocking)");
      }
    }

    return result;
  }
}

export const crawlManager = new CrawlManager();
