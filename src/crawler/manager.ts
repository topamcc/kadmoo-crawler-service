import * as fs from "node:fs";
import type { CrawlJobConfig, CrawlJobProgress } from "../shared/types.js";
import { executeCrawl, type CrawlExecutionResult } from "./executor.js";
import { objectStorage } from "../storage/object-storage.js";
import { logger } from "../logger/index.js";

const STREAMING_UPLOAD_THRESHOLD = 2500;

class CrawlManager {
  async execute(
    jobId: string,
    jobConfig: CrawlJobConfig,
    onProgress: (progress: CrawlJobProgress) => void,
  ): Promise<CrawlExecutionResult> {
    const result = await executeCrawl(jobId, jobConfig, onProgress);

    if (!objectStorage.isEnabled()) return result;

    const crawlResultsKey = `crawl-results/${jobConfig.siteId ?? "anonymous"}/${Date.now()}.json.gz`;
    const useStreaming =
      result.ndjsonPath &&
      result.pages.length >= STREAMING_UPLOAD_THRESHOLD;

    if (useStreaming && result.ndjsonPath) {
      try {
        await objectStorage.uploadNdjsonStream(result.ndjsonPath, crawlResultsKey, {
          summary: result.summary,
          config: jobConfig,
          jobId,
          status: "completed",
        });
        result.artifactUrl = crawlResultsKey;
        logger.info({ key: crawlResultsKey, pages: result.pages.length }, "Crawl artifacts streamed to S3");
      } catch (err) {
        logger.warn({ err }, "Failed to stream crawl artifacts (non-blocking)");
      } finally {
        try {
          fs.unlinkSync(result.ndjsonPath!);
        } catch (e) {
          logger.warn({ err: e, ndjsonPath: result.ndjsonPath }, "Failed to delete temp NDJSON");
        }
      }
    } else {
      const payload = {
        config: jobConfig,
        summary: result.summary,
        pages: result.pages,
      };
      try {
        await objectStorage.uploadJson(crawlResultsKey, payload);
        result.artifactUrl = crawlResultsKey;
        logger.info({ key: crawlResultsKey }, "Crawl artifacts uploaded to object storage");
      } catch (err) {
        logger.warn({ err }, "Failed to upload crawl artifacts (non-blocking)");
      }
      if (result.ndjsonPath) {
        try {
          fs.unlinkSync(result.ndjsonPath);
        } catch {
          /* ignore */
        }
      }
    }

    return result;
  }
}

export const crawlManager = new CrawlManager();
