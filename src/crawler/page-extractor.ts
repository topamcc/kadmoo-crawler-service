import * as cheerio from "cheerio";
import type { CrawledPageData, LinkData } from "../shared/types.js";
import { normalizeUrl, isSameDomain } from "./url-normalizer.js";

export function extractPageData(
  html: string,
  requestUrl: string,
  finalUrl: string,
  statusCode: number,
  responseTimeMs: number,
  crawlDepth: number,
  usedPlaywright: boolean,
  includeSubdomains = false,
): CrawledPageData {
  const $ = cheerio.load(html);
  const baseUrl = finalUrl || requestUrl;

  const title = $("title").first().text().trim();
  const metaDescription =
    $('meta[name="description"]').attr("content")?.trim() ?? "";
  const canonicalUrl =
    $('link[rel="canonical"]').attr("href")?.trim() ?? undefined;

  const h1: string[] = [];
  $("h1").each((_, el) => {
    const text = $(el).text().trim();
    if (text) h1.push(text);
  });

  const h2: string[] = [];
  $("h2").each((_, el) => {
    const text = $(el).text().trim();
    if (text) h2.push(text);
  });

  // Main content: try <main>, then <article>, then <body>
  let mainContent = "";
  const mainEl = $("main").first();
  if (mainEl.length) {
    mainContent = mainEl.text().replace(/\s+/g, " ").trim();
  } else {
    const articleEl = $("article").first();
    if (articleEl.length) {
      mainContent = articleEl.text().replace(/\s+/g, " ").trim();
    } else {
      mainContent = $("body").text().replace(/\s+/g, " ").trim();
    }
  }
  // Cap content length to avoid memory issues
  if (mainContent.length > 50000) {
    mainContent = mainContent.slice(0, 50000);
  }

  const internalLinks: LinkData[] = [];
  const externalLinks: LinkData[] = [];
  const seenUrls = new Set<string>();

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    const resolved = normalizeUrl(href, baseUrl);
    if (!resolved || seenUrls.has(resolved)) return;
    seenUrls.add(resolved);

    const rel = $(el).attr("rel") ?? "";
    const link: LinkData = {
      url: resolved,
      text: $(el).text().trim().slice(0, 200),
      rel: rel || undefined,
      nofollow: rel.includes("nofollow"),
    };

    if (isSameDomain(resolved, baseUrl, includeSubdomains)) {
      internalLinks.push(link);
    } else {
      externalLinks.push(link);
    }
  });

  // Extract image URLs from img[src]
  const images: { src: string }[] = [];
  const seenImageUrls = new Set<string>();
  $("img[src]").each((_, el) => {
    const src = $(el).attr("src")?.trim();
    if (!src || src.startsWith("data:") || src.startsWith("blob:")) return;
    try {
      const resolved = new URL(src, baseUrl).href;
      if (!seenImageUrls.has(resolved)) {
        seenImageUrls.add(resolved);
        images.push({ src: resolved });
      }
    } catch {
      /* skip invalid URLs */
    }
  });

  const contentType = "text/html";
  const contentLength = Buffer.byteLength(html, "utf-8");

  return {
    url: requestUrl,
    finalUrl,
    statusCode,
    contentType,
    title,
    metaDescription,
    h1,
    h2,
    canonicalUrl: canonicalUrl
      ? normalizeUrl(canonicalUrl, baseUrl) ?? canonicalUrl
      : undefined,
    mainContent,
    internalLinks,
    externalLinks,
    crawlDepth,
    responseTimeMs,
    contentLength,
    usedPlaywright,
    images,
  };
}
