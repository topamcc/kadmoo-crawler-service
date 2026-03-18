import type { CrawlJobConfig, CrawlJobProgress } from "../shared/types.js";
import { executeCrawl, type CrawlExecutionResult } from "./executor.js";
import { objectStorage } from "../storage/object-storage.js";
import { logger } from "../logger/index.js";

class CrawlManager {
  async execute(
    jobId: string,
    jobConfig: CrawlJobConfig,
    onProgress: (progress: CrawlJobProgress) => void,
  ): Promise<CrawlExecutionResult> {
    const result = await executeCrawl(jobId, jobConfig, onProgress);

    // Upload full results to object storage if available
    if (objectStorage.isEnabled()) {
      const payload = {
        config: jobConfig,
        summary: result.summary,
        pages: result.pages,
      };
      const crawlResultsKey = `crawl-results/${jobConfig.siteId ?? "anonymous"}/${Date.now()}.json.gz`;
      const loadResultsKey = `results/${jobId}.json.gz`;

      try {
        await objectStorage.uploadJson(crawlResultsKey, payload);
        result.artifactUrl = crawlResultsKey;
        logger.info({ key: crawlResultsKey }, "Crawl artifacts uploaded to object storage");
      } catch (err) {
        logger.warn({ err }, "Failed to upload crawl artifacts (non-blocking)");
      }

      // Also save to results/{jobId}.json.gz so loadResults can find it for analyze worker
      try {
        await objectStorage.uploadJson(loadResultsKey, {
          jobId,
          status: "completed",
          summary: result.summary,
          pages: result.pages,
          artifactUrl: result.artifactUrl,
          ...(result.resumed && { resumed: true, reusedPages: result.reusedPages }),
        });
        logger.debug({ jobId }, "Results saved to S3 for analyze worker");
      } catch (err) {
        logger.warn({ err, jobId }, "Failed to save results to S3 for analyze (non-blocking)");
      }
    }

    return result;
  }
}

export const crawlManager = new CrawlManager();
