/**
 * Discover URLs from sitemap.xml, sitemap indexes, and robots.txt Sitemap: lines.
 * Mirrors the internal app crawler behaviour for parity with the external Crawlee service.
 */

import { config } from "../config/index.js";
import type { CrawlJobConfig } from "../shared/types.js";
import { normalizeUrl, isSameDomain, isNonHtmlResource } from "./url-normalizer.js";
import { isUrlAllowed } from "./robots-parser.js";

const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT =
  "KadmooAuditBot/1.0 (+https://kadmoo.com/bot; SEO audit crawler)";

export interface SitemapDiscoveryResult {
  /** Filtered page URLs from sitemap(s), capped for memory */
  urls: string[];
  primarySitemapUrl: string;
  exists: boolean;
  isValid: boolean;
  errors: string[];
  /** robots.txt Sitemap: URLs that were fetched and merged (same-origin only) */
  robotsSitemapsUsed: string[];
}

/** Exported for unit tests */
export function extractLocUrlsFromSitemapXml(text: string): string[] {
  const locMatches = text.match(/<loc>\s*(.*?)\s*<\/loc>/gi) ?? [];
  return locMatches.map((m) => m.replace(/<\/?loc>/gi, "").trim()).filter(Boolean);
}

async function fetchText(url: string): Promise<{ ok: boolean; text: string }> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
    });
    if (!res.ok) return { ok: false, text: "" };
    const text = await res.text();
    return { ok: true, text };
  } catch {
    return { ok: false, text: "" };
  }
}

/**
 * Fetch a sitemap URL and return page URLs (handles sitemap index one level deep).
 */
export async function fetchSitemapUrlsFromUrl(
  sitemapUrl: string,
  maxUrls: number,
): Promise<string[]> {
  const { ok, text } = await fetchText(sitemapUrl);
  if (!ok || !text) return [];

  try {
    const isSitemapIndex = /<sitemapindex/i.test(text);
    if (isSitemapIndex) {
      const childSitemapUrls = extractLocUrlsFromSitemapXml(text);
      const allUrls: string[] = [];
      for (const childUrl of childSitemapUrls) {
        if (allUrls.length >= maxUrls) break;
        const child = await fetchText(childUrl);
        if (!child.ok || !child.text) continue;
        const childLocs = extractLocUrlsFromSitemapXml(child.text);
        for (const loc of childLocs) {
          if (allUrls.length >= maxUrls) break;
          allUrls.push(loc);
        }
      }
      return [...new Set(allUrls)].slice(0, maxUrls);
    }
    return [...new Set(extractLocUrlsFromSitemapXml(text))].slice(0, maxUrls);
  } catch {
    return [];
  }
}

function filterUrlForCrawl(
  rawUrl: string,
  baseUrl: string,
  jobConfig: CrawlJobConfig,
  disallowedPaths: string[],
): string | null {
  const normalized = normalizeUrl(rawUrl);
  if (!normalized) return null;
  try {
    const u = new URL(normalized);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  } catch {
    return null;
  }
  if (!isSameDomain(normalized, baseUrl, jobConfig.includeSubdomains)) return null;
  if (isNonHtmlResource(normalized)) return null;
  if (jobConfig.respectRobotsTxt && !isUrlAllowed(normalized, disallowedPaths)) {
    return null;
  }
  return normalized;
}

/**
 * Max URLs to read from sitemap XML before filtering (memory / time budget).
 */
export function getSitemapFetchCap(jobConfig: CrawlJobConfig): number {
  const fromJob = Math.max(jobConfig.maxPages * 2, 10_000);
  return Math.min(config.crawl.sitemapMaxUrls, fromJob);
}

/**
 * Discover and filter sitemap URLs for enqueue + analysis metadata.
 */
export async function discoverSitemapUrls(
  baseUrl: string,
  jobConfig: CrawlJobConfig,
  disallowedPaths: string[],
  robotsSitemapUrls: string[],
): Promise<SitemapDiscoveryResult> {
  const origin = (() => {
    try {
      return new URL(baseUrl).origin;
    } catch {
      return baseUrl.replace(/\/+$/, "");
    }
  })();

  const primarySitemapUrl = `${origin}/sitemap.xml`;
  const maxFetch = getSitemapFetchCap(jobConfig);
  const errors: string[] = [];
  const robotsSitemapsUsed: string[] = [];

  const urlSet = new Set<string>();
  const ordered: string[] = [];

  const pushUnique = (u: string) => {
    if (urlSet.has(u)) return;
    urlSet.add(u);
    ordered.push(u);
  };

  const primaryUrls = await fetchSitemapUrlsFromUrl(primarySitemapUrl, maxFetch);
  if (primaryUrls.length === 0) {
    errors.push("sitemap.xml not found or returned no URLs");
  }

  for (const loc of primaryUrls) {
    if (ordered.length >= maxFetch) break;
    const filtered = filterUrlForCrawl(loc, baseUrl, jobConfig, disallowedPaths);
    if (filtered) pushUnique(filtered);
  }

  for (const robotsLine of robotsSitemapUrls) {
    if (ordered.length >= maxFetch) break;
    try {
      const parsed = new URL(robotsLine);
      if (parsed.origin !== origin) continue;
      const extra = await fetchSitemapUrlsFromUrl(
        robotsLine,
        maxFetch - ordered.length,
      );
      if (extra.length === 0) continue;
      let added = false;
      for (const loc of extra) {
        if (ordered.length >= maxFetch) break;
        const filtered = filterUrlForCrawl(loc, baseUrl, jobConfig, disallowedPaths);
        if (filtered && !urlSet.has(filtered)) {
          pushUnique(filtered);
          added = true;
        }
      }
      if (added) robotsSitemapsUsed.push(robotsLine);
    } catch {
      /* invalid URL */
    }
  }

  const exists = primaryUrls.length > 0 || robotsSitemapsUsed.length > 0;
  const isValid = ordered.length > 0;

  return {
    urls: ordered,
    primarySitemapUrl,
    exists,
    isValid,
    errors,
    robotsSitemapsUsed,
  };
}
