import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { CheerioCrawler, PlaywrightCrawler, RequestQueue } from "crawlee";
import { config } from "../config/index.js";
import { logger } from "../logger/index.js";
import { extractPageData } from "./page-extractor.js";
import { normalizeUrl, isSameDomain, ensureAbsoluteUrl, isNonHtmlResource } from "./url-normalizer.js";
import { fetchRobotsRules, isUrlAllowed } from "./robots-parser.js";
import { getCrawlPolicy } from "./crawl-policy.js";
import type {
  CrawlJobConfig,
  CrawlJobProgress,
  CrawlResultSummary,
  CrawlSitemapSnapshot,
} from "../shared/types.js";
import { discoverSitemapUrls } from "./sitemap-discovery.js";

export interface CrawlExecutionResult {
  summary: CrawlResultSummary;
  usedPlaywrightFallback: boolean;
  /** Path to NDJSON file. Caller must stream-read and delete after use. */
  ndjsonPath: string;
  sitemap?: CrawlSitemapSnapshot;
}

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

  enqueuedUrls.add(normalizedBase);
  depthMap.set(normalizedBase, 0);

  // Robots.txt (always fetch for Sitemap: lines; disallowed paths only when respecting robots)
  const rules = await fetchRobotsRules(baseUrl);
  const disallowedPaths = jobConfig.respectRobotsTxt ? rules.disallowed : [];

  let sitemapSnapshot: CrawlSitemapSnapshot | undefined;
  let sitemapSeedsEnqueued = 0;

  if (jobConfig.maxPages > 0) {
    const discovery = await discoverSitemapUrls(
      baseUrl,
      jobConfig,
      disallowedPaths,
      rules.sitemapUrls,
    );

    for (const u of discovery.urls) {
      if (enqueuedUrls.size >= jobConfig.maxPages) break;
      if (u === normalizedBase || enqueuedUrls.has(u)) continue;

      enqueuedUrls.add(u);
      depthMap.set(u, 0);
      sitemapSeedsEnqueued++;
    }

    sitemapSnapshot = {
      exists: discovery.exists,
      url: discovery.primarySitemapUrl,
      urls: discovery.urls,
      urlCount: discovery.urls.length,
      isValid: discovery.isValid,
      errors: discovery.errors,
      robotsSitemapsUsed: discovery.robotsSitemapsUsed,
    };

    log.info(
      {
        sitemapUrls: discovery.urls.length,
        sitemapSeedsEnqueued,
        queueSize: enqueuedUrls.size,
      },
      "Sitemap discovery complete",
    );
  }

  // Cheerio-based crawling — seed queue (homepage first, then sitemap URLs)
  const requestQueue = await RequestQueue.open(`crawl-${Date.now()}` as any);
  await requestQueue.addRequest({
    url: normalizedBase,
    userData: { depth: 0, startTime: Date.now() },
  });
  for (const seedUrl of enqueuedUrls) {
    if (seedUrl === normalizedBase) continue;
    await requestQueue.addRequest({
      url: seedUrl,
      userData: { depth: 0, startTime: Date.now() },
    });
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
        if (isNonHtmlResource(normalized)) continue;
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
      pagesCrawled: pagesCount,
      pagesFailed: failedUrls.size,
      currentUrl: request.url,
      elapsedMs: Date.now() - crawlStartTime,
      estimatedRemainingMs: pagesCount > 0
        ? Math.round(((Date.now() - crawlStartTime) / pagesCount) * (enqueuedUrls.size - pagesCount))
        : undefined,
    });
  };

  const handleFailed = async (ctx: any) => {
    failedUrls.add(ctx.request.url);
    log.warn({ url: ctx.request.url, error: ctx.error?.message }, "Page crawl failed");
  };

  const policy = getCrawlPolicy(baseUrl, {
    concurrency: jobConfig.concurrency ?? config.crawl.defaultConcurrency,
    maxRequestsPerMinute: config.crawl.defaultMaxRequestsPerMinute,
    timeoutMs: jobConfig.timeoutMs,
  });
  if (policy.useHttp1 || policy.maxConcurrency < (jobConfig.concurrency ?? config.crawl.defaultConcurrency)) {
    log.info({ policy }, "Using defensive crawl policy");
  }

  // Phase 1: Cheerio crawl with Crawlee best practices
  if (!jobConfig.forcePlaywright && jobConfig.maxPages > 0) {
    const crawler = new CheerioCrawler({
      requestQueue,
      maxConcurrency: policy.maxConcurrency,
      maxRequestsPerMinute: policy.maxRequestsPerMinute,
      minConcurrency: 2,
      maxRequestsPerCrawl: jobConfig.maxPages,
      requestHandlerTimeoutSecs: Math.ceil((policy.requestTimeoutMs ?? jobConfig.timeoutMs) / 1000),
      maxRequestRetries: 4,
      additionalMimeTypes: ["application/xhtml+xml"],
      preNavigationHooks: policy.useHttp1
        ? [(_ctx: any, gotOptions: any) => { gotOptions.http2 = false; }]
        : undefined,
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
        await pwQueue.addRequest({ url: normalizedBase, userData: { depth: 0, startTime: Date.now(), usedPlaywright: true } });
      } else {
        for (const url of failedUrls) {
          const depth = depthMap.get(url) ?? 0;
          await pwQueue.addRequest({ url, userData: { depth, startTime: Date.now(), usedPlaywright: true } });
        }
      }

      const pwCrawler = new PlaywrightCrawler({
        requestQueue: pwQueue,
        maxConcurrency: Math.min(policy.maxConcurrency, config.crawl.playwrightMaxConcurrency),
        maxRequestsPerCrawl: jobConfig.forcePlaywright ? jobConfig.maxPages : failedUrls.size,
        requestHandlerTimeoutSecs: Math.ceil((policy.requestTimeoutMs ?? jobConfig.timeoutMs) / 1000) * 2,
        maxRequestRetries: 2,
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
    sitemapUrlsDiscovered: sitemapSnapshot?.urlCount,
    sitemapSeedsEnqueued,
    finalEnqueuedUrlCount: enqueuedUrls.size,
  };

  return {
    summary,
    usedPlaywrightFallback,
    ndjsonPath,
    sitemap: sitemapSnapshot,
  };
}
