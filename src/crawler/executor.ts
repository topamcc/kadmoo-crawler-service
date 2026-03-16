import { CheerioCrawler, PlaywrightCrawler, RequestQueue } from "crawlee";
import { config } from "../config/index.js";
import { logger } from "../logger/index.js";
import { extractPageData } from "./page-extractor.js";
import { normalizeUrl, isSameDomain, ensureAbsoluteUrl } from "./url-normalizer.js";
import { fetchRobotsRules, isUrlAllowed } from "./robots-parser.js";
import type { CrawlJobConfig, CrawledPageData, CrawlJobProgress, CrawlResultSummary } from "../shared/types.js";

export interface CrawlExecutionResult {
  pages: CrawledPageData[];
  summary: CrawlResultSummary;
  usedPlaywrightFallback: boolean;
  artifactUrl?: string;
}

interface PageMeta {
  depth: number;
  startTime: number;
}

export async function executeCrawl(
  jobConfig: CrawlJobConfig,
  onProgress: (progress: CrawlJobProgress) => void,
): Promise<CrawlExecutionResult> {
  const baseUrl = ensureAbsoluteUrl(jobConfig.url);
  const crawlStartTime = Date.now();
  const deadlineMs = jobConfig.maxDurationMinutes * 60 * 1000;
  const pages: CrawledPageData[] = [];
  const failedUrls = new Set<string>();
  const enqueuedUrls = new Set<string>();
  let usedPlaywrightFallback = false;
  const depthMap = new Map<string, number>();
  const statusCodes: Record<number, number> = {};

  // Robots.txt
  let disallowedPaths: string[] = [];
  if (jobConfig.respectRobotsTxt) {
    const rules = await fetchRobotsRules(baseUrl);
    disallowedPaths = rules.disallowed;
  }

  const normalizedBase = normalizeUrl(baseUrl) ?? baseUrl;
  enqueuedUrls.add(normalizedBase);
  depthMap.set(normalizedBase, 0);

  const log = logger.child({ url: baseUrl });

  // Cheerio-based crawling
  const requestQueue = await RequestQueue.open(`crawl-${Date.now()}` as any);
  await requestQueue.addRequest({ url: normalizedBase, userData: { depth: 0 } });

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
    );
    pages.push(pageData);

    // Enqueue internal links
    if (depth < jobConfig.maxDepth && pages.length + enqueuedUrls.size < jobConfig.maxPages * 2) {
      for (const link of pageData.internalLinks) {
        const normalized = normalizeUrl(link.url);
        if (!normalized) continue;
        if (enqueuedUrls.has(normalized)) continue;
        if (!isSameDomain(normalized, baseUrl)) continue;
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
      pagesCrawled: pages.length,
      pagesFailed: failedUrls.size,
      currentUrl: request.url,
      elapsedMs: Date.now() - crawlStartTime,
      estimatedRemainingMs: pages.length > 0
        ? Math.round(((Date.now() - crawlStartTime) / pages.length) * (enqueuedUrls.size - pages.length))
        : undefined,
    });
  };

  const handleFailed = async (ctx: any, error?: Error) => {
    failedUrls.add(ctx.request.url);
    log.warn({ url: ctx.request.url, error: ctx.error?.message }, "Page crawl failed");
  };

  // Phase 1: Cheerio crawl
  if (!jobConfig.forcePlaywright) {
    const crawler = new CheerioCrawler({
      requestQueue,
      maxConcurrency: jobConfig.concurrency,
      maxRequestsPerCrawl: jobConfig.maxPages,
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
        maxConcurrency: Math.min(jobConfig.concurrency, 3),
        maxRequestsPerCrawl: jobConfig.forcePlaywright ? jobConfig.maxPages : failedUrls.size,
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

  const crawlDurationMs = Date.now() - crawlStartTime;
  const successfulPages = pages.filter((p) => p.statusCode >= 200 && p.statusCode < 400);
  const totalResponseTime = pages.reduce((sum, p) => sum + p.responseTimeMs, 0);

  const depthDistribution: Record<number, number> = {};
  for (const page of pages) {
    depthDistribution[page.crawlDepth] = (depthDistribution[page.crawlDepth] ?? 0) + 1;
  }

  const summary: CrawlResultSummary = {
    totalPages: pages.length,
    successfulPages: successfulPages.length,
    failedPages: failedUrls.size,
    totalInternalLinks: pages.reduce((sum, p) => sum + p.internalLinks.length, 0),
    totalExternalLinks: pages.reduce((sum, p) => sum + p.externalLinks.length, 0),
    averageResponseTimeMs: pages.length > 0 ? Math.round(totalResponseTime / pages.length) : 0,
    totalContentLength: pages.reduce((sum, p) => sum + p.contentLength, 0),
    crawlDurationMs,
    uniqueStatusCodes: statusCodes,
    depthDistribution,
    playwriteFallbackCount: usedPlaywrightFallback
      ? pages.filter((p) => p.usedPlaywright).length
      : 0,
  };

  return { pages, summary, usedPlaywrightFallback };
}
