/**
 * Converts external crawler results (CrawledPageData[]) into the internal
 * CrawlResult format expected by the audit analysis modules.
 */

import type {
  CrawlResult,
  CrawledPage,
  SitemapData,
  RobotsData,
  BrokenLink,
  CrawlMeta,
  ImageInventoryItem,
  PdfLinkItem,
} from "./types.js";
import type {
  CrawledPageData,
  CrawlResultSummary,
  CrawlJobResultsResponse,
} from "../shared/types.js";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildSyntheticHtml(page: CrawledPageData): string {
  const headParts: string[] = [];
  if (page.title) {
    headParts.push(`<title>${escapeHtml(page.title)}</title>`);
  }
  if (page.metaDescription) {
    headParts.push(
      `<meta name="description" content="${escapeHtml(page.metaDescription)}">`,
    );
  }
  if (page.canonicalUrl) {
    headParts.push(`<link rel="canonical" href="${escapeHtml(page.canonicalUrl)}">`);
  }

  const bodyParts: string[] = [];
  for (const h of page.h1) {
    bodyParts.push(`<h1>${escapeHtml(h)}</h1>`);
  }
  for (const h of page.h2) {
    bodyParts.push(`<h2>${escapeHtml(h)}</h2>`);
  }

  if (page.mainContent) {
    bodyParts.push(`<main><p>${escapeHtml(page.mainContent)}</p></main>`);
  }

  const allLinks = [
    ...page.internalLinks.map((l) => ({ ...l, external: false })),
    ...page.externalLinks.map((l) => ({ ...l, external: true })),
  ];
  for (const link of allLinks) {
    const rel = link.nofollow ? ' rel="nofollow"' : "";
    bodyParts.push(`<a href="${escapeHtml(link.url)}"${rel}>${escapeHtml(link.text)}</a>`);
  }

  return [
    "<!DOCTYPE html>",
    "<html>",
    `<head>${headParts.join("")}</head>`,
    `<body>${bodyParts.join("")}</body>`,
    "</html>",
  ].join("");
}

function toCrawledPage(page: CrawledPageData): CrawledPage {
  return {
    url: page.finalUrl || page.url,
    statusCode: page.statusCode,
    headers: {},
    html: buildSyntheticHtml(page),
    redirectChain:
      page.finalUrl && page.finalUrl !== page.url
        ? [{ url: page.url, statusCode: 301 }]
        : [],
    responseTimeMs: page.responseTimeMs,
    contentType: page.contentType || "text/html",
    contentLength: page.contentLength,
  };
}

function extractBrokenLinks(
  pages: CrawledPageData[],
  targetUrl: string,
): BrokenLink[] {
  const baseHost = (() => {
    try {
      return new URL(targetUrl).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      return "";
    }
  })();

  const brokenUrls = new Set<string>();
  for (const p of pages) {
    if (p.statusCode >= 400) brokenUrls.add(p.url);
  }

  const linkToSources = new Map<string, string[]>();
  for (const page of pages) {
    for (const link of [...page.internalLinks, ...page.externalLinks]) {
      if (brokenUrls.has(link.url)) {
        const arr = linkToSources.get(link.url) ?? [];
        if (!arr.includes(page.url)) arr.push(page.url);
        linkToSources.set(link.url, arr);
      }
    }
  }

  const broken: BrokenLink[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    if (page.statusCode >= 400 && !seen.has(page.url)) {
      seen.add(page.url);
      broken.push({
        url: page.url,
        sourcePages: linkToSources.get(page.url) ?? [],
        statusCode: page.statusCode,
        isInternal: (() => {
          try {
            const host = new URL(page.url).hostname.toLowerCase().replace(/^www\./, "");
            return host === baseHost || host.endsWith(`.${baseHost}`);
          } catch {
            return false;
          }
        })(),
      });
    }
  }
  return broken;
}

function buildCrawlMeta(
  summary: CrawlResultSummary,
  pages: CrawledPageData[],
  pagesQueued?: number,
): CrawlMeta {
  const subPageStatusCodes: Record<number, number> = {};
  for (const p of pages.slice(1)) {
    subPageStatusCodes[p.statusCode] = (subPageStatusCodes[p.statusCode] ?? 0) + 1;
  }

  const crawled = summary.totalPages;
  const totalCandidateUrls =
    pagesQueued != null && pagesQueued > 0 ? Math.max(pagesQueued, crawled) : crawled;

  return {
    sitemapUrlsDiscovered: 0,
    linkDiscoveryUrlsFound: summary.totalInternalLinks,
    robotsSitemapsUsed: [],
    totalCandidateUrls,
    pagesCrawled: crawled,
    subPageStatusCodes,
  };
}

const IMAGE_EXTENSIONS = /\.(jpe?g|png|gif|webp|svg|avif|bmp)(\?|$)/i;
const PDF_PATTERN = /\.pdf(\?|$)/i;

function getOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function isSameOrigin(resolvedUrl: string, origin: string): boolean {
  try {
    const u = new URL(resolvedUrl);
    const uHost = u.hostname.toLowerCase().replace(/^www\./, "");
    const oHost = (origin ? new URL(origin).hostname : "").toLowerCase().replace(/^www\./, "");
    return uHost === oHost || uHost.endsWith(`.${oHost}`);
  } catch {
    return false;
  }
}

function extractPdfLinksFromPages(
  pages: CrawledPageData[],
  targetUrl: string,
): PdfLinkItem[] {
  const origin = getOrigin(targetUrl);
  const linkMap = new Map<string, Set<string>>();
  for (const page of pages) {
    const pageUrl = page.finalUrl || page.url;
    for (const link of page.internalLinks) {
      const href = link.url?.trim();
      if (!href || !PDF_PATTERN.test(href)) continue;
      try {
        const resolved = new URL(href, pageUrl).href;
        if (!isSameOrigin(resolved, origin)) continue;
        const key = resolved.replace(/\/+$/, "").split("?")[0];
        const existing = linkMap.get(key) ?? new Set<string>();
        existing.add(pageUrl);
        linkMap.set(key, existing);
      } catch {
        /* skip */
      }
    }
  }
  return Array.from(linkMap.entries()).map(([url, sourcePages]) => ({
    url,
    sourcePages: Array.from(sourcePages),
  }));
}

function extractImagesFromPages(
  pages: CrawledPageData[],
  targetUrl: string,
): ImageInventoryItem[] {
  const origin = getOrigin(targetUrl);
  const imageMap = new Map<string, Set<string>>();

  for (const page of pages) {
    const pageUrl = page.finalUrl || page.url;

    const imageUrls = page.images?.map((i) => i.src) ?? (page as any).imageUrls ?? [];

    for (const src of imageUrls) {
      const s = src?.trim();
      if (!s || s.startsWith("data:") || s.startsWith("blob:")) continue;
      try {
        const resolved = new URL(s, pageUrl).href;
        if (!isSameOrigin(resolved, origin)) continue;
        const existing = imageMap.get(resolved) ?? new Set<string>();
        existing.add(pageUrl);
        imageMap.set(resolved, existing);
      } catch {
        /* skip */
      }
    }

    for (const link of page.internalLinks) {
      const href = link.url?.trim();
      if (!href || !IMAGE_EXTENSIONS.test(href)) continue;
      try {
        const resolved = new URL(href, pageUrl).href;
        if (!isSameOrigin(resolved, origin)) continue;
        const existing = imageMap.get(resolved) ?? new Set<string>();
        existing.add(pageUrl);
        imageMap.set(resolved, existing);
      } catch {
        /* skip */
      }
    }
  }

  return Array.from(imageMap.entries()).map(([src, sourcePages]) => {
    const ext = IMAGE_EXTENSIONS.exec(src);
    const format = ext ? ext[1].toLowerCase() : undefined;
    return { src, sourcePages: Array.from(sourcePages), format };
  });
}

const STUB_SITEMAP: SitemapData = {
  exists: false,
  url: "",
  urls: [],
  urlCount: 0,
  isValid: false,
  errors: ["Sitemap data not available from external crawler"],
};

const STUB_ROBOTS: RobotsData = {
  exists: false,
  content: "",
  sitemapUrls: [],
  disallowedPaths: [],
  allowsGPTBot: true,
  allowsPerplexityBot: true,
  allowsGoogleExtended: true,
  errors: ["Robots.txt data not available from external crawler"],
};

export function convertExternalResultsToCrawlResult(
  results: CrawlJobResultsResponse,
  targetUrl: string,
  pagesQueued?: number,
): CrawlResult {
  const { pages, summary } = results;

  if (pages.length === 0) {
    const emptyPage: CrawledPage = {
      url: targetUrl,
      statusCode: 0,
      headers: {},
      html: "",
      redirectChain: [],
      responseTimeMs: 0,
      contentType: "text/html",
      contentLength: 0,
    };
    return {
      homepage: emptyPage,
      subPages: [],
      sitemap: STUB_SITEMAP,
      robots: STUB_ROBOTS,
      brokenLinks: [],
      crawlMeta: buildCrawlMeta(summary, [], pagesQueued),
      imagesInventory: [],
      pdfLinks: [],
    };
  }

  const normalise = (u: string) =>
    u.replace(/\/+$/, "").replace(/^https?:\/\/www\./, "https://");
  const normTarget = normalise(targetUrl);
  const homepageIdx = pages.findIndex(
    (p) =>
      normalise(p.url) === normTarget ||
      normalise(p.finalUrl) === normTarget,
  );

  const homepageData = homepageIdx >= 0 ? pages[homepageIdx] : pages[0];
  const subPagesData =
    homepageIdx >= 0
      ? [...pages.slice(0, homepageIdx), ...pages.slice(homepageIdx + 1)]
      : pages.slice(1);

  const pdfLinks = extractPdfLinksFromPages(pages, targetUrl);
  const imagesInventory = extractImagesFromPages(pages, targetUrl);

  return {
    homepage: toCrawledPage(homepageData),
    subPages: subPagesData.map(toCrawledPage),
    sitemap: STUB_SITEMAP,
    robots: STUB_ROBOTS,
    brokenLinks: extractBrokenLinks(pages, targetUrl),
    crawlMeta: buildCrawlMeta(summary, pages, pagesQueued),
    imagesInventory,
    pdfLinks,
  };
}
