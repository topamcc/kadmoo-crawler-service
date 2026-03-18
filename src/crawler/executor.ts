import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { CheerioCrawler, PlaywrightCrawler, RequestQueue } from "crawlee";
import { config } from "../config/index.js";
import { logger } from "../logger/index.js";
import { extractPageData } from "./page-extractor.js";
import { normalizeUrl, isSameDomain, ensureAbsoluteUrl, isNonHtmlResource } from "./url-normalizer.js";
import { fetchRobotsRules, isUrlAllowed } from "./robots-parser.js";
import { loadCheckpoint, saveCheckpoint } from "../storage/checkpoint.js";
import type { CrawlJobConfig, CrawledPageData, CrawlJobProgress, CrawlResultSummary } from "../shared/types.js";

export interface CrawlExecutionResult {
  pages: CrawledPageData[];
  summary: CrawlResultSummary;
  usedPlaywrightFallback: boolean;
  artifactUrl?: string;
  resumed?: boolean;
  reusedPages?: number;
  /** Path to NDJSON file (for streaming upload). Caller must delete after use. */
  ndjsonPath?: string;
}

const CHECKPOINT_SAVE_INTERVAL = 100;

function safeJobIdForFilename(jobId: string): string {
  return jobId.replace(/[^a-zA-Z0-9-_]/g, "_");
}

export async function executeCrawl(
  jobId: string,
  jobConfig: CrawlJobConfig,
  onProgress: (progress: CrawlJobProgress) => void,
): Promise<CrawlExecutionResult> {
  const baseUrl = ensureAbsoluteUrl(jobConfig.url);
  const crawlStartTime = Date.now();
  const deadlineMs = jobConfig.maxDurationMinutes * 60 * 1000;
  const failedUrls = new Set<string>();
  const enqueuedUrls = new Set<string>();
  let usedPlaywrightFallback = false;
  const depthMap = new Map<string, number>();
  const statusCodes: Record<number, number> = {};
  let resumed = false;
  let reusedPages = 0;

  const ndjsonPath = path.join(os.tmpdir(), `crawl-${safeJobIdForFilename(jobId)}.ndjson`);
  const writeStream = fs.createWriteStream(ndjsonPath, { flags: "w" });

  let pagesCount = 0;
  const visitedUrls = new Set<string>();
  let totalResponseTime = 0;
  let totalInternalLinks = 0;
  let totalExternalLinks = 0;
  let totalContentLength = 0;
  let successfulPagesCount = 0;
  let playwriteFallbackCount = 0;
  const depthDistribution: Record<number, number> = {};

  const normalizedBase = normalizeUrl(baseUrl) ?? baseUrl;
  const log = logger.child({ url: baseUrl });

  let checkpoint: Awaited<ReturnType<typeof loadCheckpoint>> = null;
  if (config.resume.enabled) {
    checkpoint = await loadCheckpoint(jobConfig.siteId, normalizedBase, jobConfig);
  }

  if (checkpoint) {
    resumed = true;
    reusedPages = checkpoint.pages_crawled_count;
    for (const u of checkpoint.queue_urls) enqueuedUrls.add(u);
    for (const u of checkpoint.visited_urls) enqueuedUrls.add(u); // avoid re-enqueueing
    for (const [u, d] of Object.entries(checkpoint.depth_map)) depthMap.set(u, d);
    for (const u of checkpoint.failed_urls) failedUrls.add(u);
    log.info(
      { resume_reason: "checkpoint_valid", reusedPages, queueSize: checkpoint.queue_urls.length },
      "Resumed from checkpoint",
    );
  } else {
    enqueuedUrls.add(normalizedBase);
    depthMap.set(normalizedBase, 0);
    if (config.resume.enabled) {
      log.info({ fresh_reason: "no_checkpoint_or_expired_or_config_mismatch" }, "Fresh crawl");
    }
  }

  // Robots.txt
  let disallowedPaths: string[] = [];
  if (jobConfig.respectRobotsTxt) {
    const rules = await fetchRobotsRules(baseUrl);
    disallowedPaths = rules.disallowed;
  }

  // Cheerio-based crawling
  const requestQueue = await RequestQueue.open(`crawl-${Date.now()}` as any);
  if (!resumed) {
    await requestQueue.addRequest({ url: normalizedBase, userData: { depth: 0 } });
  } else {
    for (const url of checkpoint!.queue_urls) {
      if (isNonHtmlResource(url)) continue; // Skip PDFs, images, etc. when resuming
      const depth = depthMap.get(url) ?? 0;
      await requestQueue.addRequest({ url, userData: { depth, startTime: Date.now() } });
    }
  }

  const handlePage = async (ctx: any) => {
    const { request, body } = ctx;
    const html = typeof body === "string" ? body : body?.toString("utf-8") ?? "";
    const depth: number = request.userData?.depth ?? 0;
    const startTime = request.userData?.startTime ?? Date.now();
    const responseTimeMs = Date.now() - startTime;
    const statusCode = (ctx as any).response?.statusCode ?? 200;

    statusCodes[statusCode] = (statusCodes[statusCode] ?? 0) + 1;

    const pageData = extractPageData(
      html,
      request.url,
      request.loadedUrl ?? request.url,
      statusCode,
      responseTimeMs,
      depth,
      request.userData?.usedPlaywright ?? false,
      jobConfig.includeSubdomains,
    );

    writeStream.write(JSON.stringify(pageData) + "\n");
    pagesCount++;
    visitedUrls.add(pageData.url);
    totalResponseTime += pageData.responseTimeMs;
    totalInternalLinks += pageData.internalLinks.length;
    totalExternalLinks += pageData.externalLinks.length;
    totalContentLength += pageData.contentLength;
    if (pageData.statusCode >= 200 && pageData.statusCode < 400) successfulPagesCount++;
    if (pageData.usedPlaywright) playwriteFallbackCount++;
    depthDistribution[pageData.crawlDepth] = (depthDistribution[pageData.crawlDepth] ?? 0) + 1;

    // Enqueue internal links
    if (depth < jobConfig.maxDepth && pagesCount + enqueuedUrls.size < jobConfig.maxPages * 2) {
      for (const link of pageData.internalLinks) {
        const normalized = normalizeUrl(link.url);
        if (!normalized) continue;
        if (enqueuedUrls.has(normalized)) continue;
        if (isNonHtmlResource(normalized)) continue; // CheerioCrawler only supports HTML
        if (!isSameDomain(normalized, baseUrl, jobConfig.includeSubdomains)) continue;
        if (jobConfig.respectRobotsTxt && !isUrlAllowed(normalized, disallowedPaths)) continue;
        if (enqueuedUrls.size >= jobConfig.maxPages) break;

        enqueuedUrls.add(normalized);
        depthMap.set(normalized, depth + 1);
        await requestQueue.addRequest({
          url: normalized,
          userData: { depth: depth + 1, startTime: Date.now() },
        });
      }
    }

    onProgress({
      pagesQueued: enqueuedUrls.size,
      pagesCrawled: pagesCount + reusedPages,
      pagesFailed: failedUrls.size,
      currentUrl: request.url,
      elapsedMs: Date.now() - crawlStartTime,
      estimatedRemainingMs: pagesCount > 0
        ? Math.round(((Date.now() - crawlStartTime) / pagesCount) * (enqueuedUrls.size - pagesCount))
        : undefined,
      ...(resumed && { resumed: true, reusedPages }),
    });

    // Periodic checkpoint save (resume support)
    if (config.resume.enabled && pagesCount > 0 && pagesCount % CHECKPOINT_SAVE_INTERVAL === 0) {
      const queueUrls = new Set([...enqueuedUrls].filter((u) => !visitedUrls.has(u)));
      saveCheckpoint(jobConfig.siteId, normalizedBase, jobConfig, {
        queueUrls,
        visitedUrls: [...visitedUrls],
        failedUrls,
        depthMap,
        pagesCrawledCount: pagesCount + reusedPages,
      }).catch((err) => log.warn({ err }, "Checkpoint save failed"));
    }
  };

  const handleFailed = async (ctx: any, error?: Error) => {
    failedUrls.add(ctx.request.url);
    log.warn({ url: ctx.request.url, error: ctx.error?.message }, "Page crawl failed");
  };

  const effectiveMaxRequests = resumed
    ? Math.max(0, jobConfig.maxPages - reusedPages)
    : jobConfig.maxPages;

  // Phase 1: Cheerio crawl
  if (!jobConfig.forcePlaywright && effectiveMaxRequests > 0) {
    const crawler = new CheerioCrawler({
      requestQueue,
      maxConcurrency: jobConfig.concurrency,
      maxRequestsPerCrawl: effectiveMaxRequests,
      requestHandlerTimeoutSecs: Math.ceil(jobConfig.timeoutMs / 1000),
      maxRequestRetries: 2,
      additionalMimeTypes: ["application/xhtml+xml"],
      requestHandler: handlePage,
      failedRequestHandler: handleFailed,
    });

    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        log.warn("Crawl duration limit reached, aborting");
        crawler.autoscaledPool?.abort();
        resolve();
      }, deadlineMs);
    });

    await Promise.race([crawler.run(), timeoutPromise]);
  }

  // Phase 2: Playwright fallback for failed URLs (or forced)
  const needsPlaywright =
    (config.playwrightEnabled && failedUrls.size > 0) || jobConfig.forcePlaywright;

  if (needsPlaywright) {
    usedPlaywrightFallback = true;
    log.info({ count: failedUrls.size, forced: jobConfig.forcePlaywright }, "Using Playwright fallback");

    try {
      const pwQueue = await RequestQueue.open(`pw-crawl-${Date.now()}` as any);

      if (jobConfig.forcePlaywright) {
        // Full Playwright crawl
        await pwQueue.addRequest({ url: normalizedBase, userData: { depth: 0, startTime: Date.now(), usedPlaywright: true } });
      } else {
        // Only retry failed URLs
        for (const url of failedUrls) {
          const depth = depthMap.get(url) ?? 0;
          await pwQueue.addRequest({ url, userData: { depth, startTime: Date.now(), usedPlaywright: true } });
        }
      }

      const pwCrawler = new PlaywrightCrawler({
        requestQueue: pwQueue,
        maxConcurrency: Math.min(jobConfig.concurrency, config.crawl.playwrightMaxConcurrency),
        maxRequestsPerCrawl: jobConfig.forcePlaywright ? effectiveMaxRequests : failedUrls.size,
        requestHandlerTimeoutSecs: Math.ceil(jobConfig.timeoutMs / 1000) * 2,
        maxRequestRetries: 1,
        launchContext: {
          launchOptions: {
            headless: true,
            args: ["--no-sandbox", "--disable-dev-shm-usage"],
          },
        },
        requestHandler: async (ctx) => {
          const html = await ctx.page.content();
          const mockCtx = {
            ...ctx,
            body: html,
            response: { statusCode: ctx.response?.status() ?? 200 },
          };
          await handlePage(mockCtx as any);
        },
        failedRequestHandler: handleFailed,
      });

      const remainingTime = deadlineMs - (Date.now() - crawlStartTime);
      if (remainingTime > 10000) {
        const pwTimeout = new Promise<void>((resolve) => {
          setTimeout(() => {
            pwCrawler.autoscaledPool?.abort();
            resolve();
          }, remainingTime);
        });
        await Promise.race([pwCrawler.run(), pwTimeout]);
      }
    } catch (err) {
      log.error({ err }, "Playwright fallback failed");
    }
  }

  await new Promise<void>((resolve, reject) => {
    writeStream.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
  });

  const crawlDurationMs = Date.now() - crawlStartTime;
  const summary: CrawlResultSummary = {
    totalPages: pagesCount,
    successfulPages: successfulPagesCount,
    failedPages: failedUrls.size,
    totalInternalLinks,
    totalExternalLinks,
    averageResponseTimeMs: pagesCount > 0 ? Math.round(totalResponseTime / pagesCount) : 0,
    totalContentLength,
    crawlDurationMs,
    uniqueStatusCodes: statusCodes,
    depthDistribution,
    playwriteFallbackCount: usedPlaywrightFallback ? playwriteFallbackCount : 0,
  };

  const pages: CrawledPageData[] = [];
  const rl = createInterface({
    input: createReadStream(ndjsonPath),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed) pages.push(JSON.parse(trimmed) as CrawledPageData);
  }

  return {
    pages,
    summary,
    usedPlaywrightFallback,
    ndjsonPath,
    ...(resumed && { resumed: true, reusedPages }),
  };
}
