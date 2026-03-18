/**
 * Link analyzer — internal/external link counts, anchor text quality, issues.
 */

import * as cheerio from "cheerio";
import type { CrawledPage, LinksResult, LinkInfo, AuditFinding, BrokenLink, BrokenLinkDetail } from "./types.js";

const GENERIC_ANCHORS = new Set([
  "click here", "here", "read more", "learn more", "more",
  "link", "this", "go", "see more", "details", "info", "page",
  "לחץ כאן", "כאן", "קרא עוד", "עוד", "פרטים",
]);

export function analyseLinks(page: CrawledPage): LinksResult {
  const findings: AuditFinding[] = [];
  const $ = cheerio.load(page.html);

  let origin: string;
  try {
    origin = new URL(page.url).origin;
  } catch {
    origin = "";
  }

  const links: LinkInfo[] = [];
  let totalInternal = 0;
  let totalExternal = 0;
  let internalNoAnchor = 0;
  let nonDescriptiveAnchors = 0;
  let internalNofollow = 0;
  let externalNofollow = 0;
  let emptyHref = 0;
  let localhostLinks = 0;
  const internalTargets = new Set<string>();

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href")?.trim() ?? "";
    const anchorText = $(el).text().trim();
    const rel = ($(el).attr("rel") ?? "").toLowerCase();
    const isNofollow = rel.includes("nofollow");

    if (!href || href === "#") {
      emptyHref++;
      return;
    }

    let resolvedUrl: string;
    try {
      resolvedUrl = new URL(href, page.url).href;
    } catch {
      return;
    }

    const isLocalhost = /localhost|127\.0\.0\.1/.test(resolvedUrl);
    if (isLocalhost) localhostLinks++;

    const isInternal = resolvedUrl.startsWith(origin);
    const isExternal = !isInternal && resolvedUrl.startsWith("http");

    if (isInternal) {
      totalInternal++;
      internalTargets.add(resolvedUrl);
      if (!anchorText) internalNoAnchor++;
      if (isNofollow) internalNofollow++;
    } else if (isExternal) {
      totalExternal++;
      if (isNofollow) externalNofollow++;
    }

    if (anchorText && GENERIC_ANCHORS.has(anchorText.toLowerCase())) {
      nonDescriptiveAnchors++;
    }

    links.push({
      href: resolvedUrl,
      anchorText: anchorText.slice(0, 100),
      isInternal,
      isNofollow,
      isExternal,
    });
  });

  if (localhostLinks > 0) {
    findings.push({
      id: "links-localhost",
      category: "links",
      severity: "issue",
      priority: "high",
      title: `${localhostLinks} link(s) to localhost`,
      description: "Links pointing to localhost will not work for visitors.",
      howToFix: "Replace localhost links with the correct production URLs.",
    });
  }

  if (emptyHref > 0) {
    findings.push({
      id: "links-empty-href",
      category: "links",
      severity: "warning",
      priority: "medium",
      title: `${emptyHref} link(s) with empty or # href`,
      description: "Empty href links waste crawl budget and confuse users.",
      howToFix: "Remove or fix links with empty href attributes.",
    });
  }

  if (internalNoAnchor > 0) {
    findings.push({
      id: "links-no-anchor",
      category: "links",
      severity: "opportunity",
      priority: "medium",
      title: `${internalNoAnchor} internal link(s) with no anchor text`,
      description: "Internal links without anchor text miss the opportunity to pass topical relevance.",
      howToFix: "Add descriptive anchor text to internal links.",
    });
  }

  if (nonDescriptiveAnchors > 0) {
    findings.push({
      id: "links-generic-anchor",
      category: "links",
      severity: "opportunity",
      priority: "low",
      title: `${nonDescriptiveAnchors} non-descriptive anchor text(s)`,
      description: 'Generic anchors like "click here" do not help SEO.',
      howToFix: "Replace generic anchor text with descriptive, keyword-rich text.",
    });
  }

  if (internalNofollow > 0) {
    findings.push({
      id: "links-internal-nofollow",
      category: "links",
      severity: "warning",
      priority: "medium",
      title: `${internalNofollow} internal nofollow link(s)`,
      description: "Nofollowed internal links prevent PageRank flow within your site.",
      howToFix: "Remove nofollow from internal links unless intentional.",
    });
  }

  if (totalInternal === 0) {
    findings.push({
      id: "links-no-internal",
      category: "links",
      severity: "warning",
      priority: "high",
      title: "No internal outlinks found",
      description: "The page has no internal links to other pages on the site.",
      howToFix: "Add relevant internal links to improve site navigation and crawlability.",
    });
  }

  let deductions = 0;
  for (const f of findings) {
    if (f.severity === "issue") deductions += f.priority === "critical" ? 20 : 12;
    else if (f.severity === "warning") deductions += f.priority === "high" ? 8 : 5;
    else deductions += 2;
  }
  const score = Math.max(0, 100 - deductions);

  return {
    score,
    findings,
    data: {
      totalInternal,
      totalExternal,
      internalNoAnchor,
      nonDescriptiveAnchors,
      internalNofollow,
      externalNofollow,
      emptyHref,
      localhostLinks,
      uniqueInternalTargets: internalTargets.size,
      brokenLinks: [],
      links: links.slice(0, 200),
      pagesAnalysed: 1,
    },
  };
}

export function analyseLinksMulti(
  pages: CrawledPage[],
  brokenLinks: BrokenLink[],
): LinksResult {
  const allFindings: AuditFinding[] = [];
  let totalInternal = 0;
  let totalExternal = 0;
  let internalNoAnchor = 0;
  let nonDescAnchors = 0;
  let intNofollow = 0;
  let extNofollow = 0;
  let emptyHrefs = 0;
  let localhosts = 0;
  let httpsToHttpCount = 0;
  let tooLongUrlCount = 0;
  const internalTargets = new Set<string>();
  const allLinks: LinkInfo[] = [];

  let origin = "";
  let pageIsHttps = false;
  try {
    const firstUrl = pages[0]?.url ?? "";
    origin = new URL(firstUrl).origin;
    pageIsHttps = firstUrl.startsWith("https://");
  } catch { /* skip */ }

  for (const page of pages) {
    const pageHttps = page.url.startsWith("https://");
    if (!page.html) continue;
    const $ = cheerio.load(page.html);

    $("a[href]").each((_, el) => {
      const href = $(el).attr("href")?.trim() ?? "";
      const anchorText = $(el).text().trim();
      const rel = ($(el).attr("rel") ?? "").toLowerCase();
      const isNofollow = rel.includes("nofollow");

      if (!href || href === "#") {
        emptyHrefs++;
        return;
      }

      let resolvedUrl: string;
      try { resolvedUrl = new URL(href, page.url).href; } catch { return; }

      const isLocalhost = /localhost|127\.0\.0\.1/.test(resolvedUrl);
      if (isLocalhost) localhosts++;

      const isInternal = resolvedUrl.startsWith(origin);
      const isExternal = !isInternal && resolvedUrl.startsWith("http");

      if (isInternal) {
        totalInternal++;
        internalTargets.add(resolvedUrl);
        if (!anchorText) internalNoAnchor++;
        if (isNofollow) intNofollow++;
      } else if (isExternal) {
        totalExternal++;
        if (isNofollow) extNofollow++;
      }

      if (anchorText && GENERIC_ANCHORS.has(anchorText.toLowerCase())) {
        nonDescAnchors++;
      }

      if (pageHttps && resolvedUrl.startsWith("http://")) {
        httpsToHttpCount++;
      }
      if (resolvedUrl.length > 2000) {
        tooLongUrlCount++;
      }

      allLinks.push({
        href: resolvedUrl,
        anchorText: anchorText.slice(0, 100),
        isInternal,
        isNofollow,
        isExternal,
      });
    });
  }

  const external403Count = brokenLinks.filter((b) => !b.isInternal && b.statusCode === 403).length;

  if (localhosts > 0) {
    allFindings.push({ id: "links-localhost", category: "links", severity: "issue", priority: "high", title: `${localhosts} link(s) to localhost`, description: "Links pointing to localhost will not work for visitors.", howToFix: "Replace localhost links with the correct production URLs." });
  }
  if (emptyHrefs > 0) {
    allFindings.push({ id: "links-empty-href", category: "links", severity: "warning", priority: "medium", title: `${emptyHrefs} link(s) with empty or # href`, description: "Empty href links waste crawl budget and confuse users.", howToFix: "Remove or fix links with empty href attributes." });
  }
  if (internalNoAnchor > 0) {
    allFindings.push({ id: "links-no-anchor", category: "links", severity: "opportunity", priority: "medium", title: `${internalNoAnchor} internal link(s) with no anchor text`, description: "Internal links without anchor text miss the opportunity to pass topical relevance.", howToFix: "Add descriptive anchor text to internal links." });
  }
  if (nonDescAnchors > 0) {
    allFindings.push({ id: "links-generic-anchor", category: "links", severity: "opportunity", priority: "low", title: `${nonDescAnchors} non-descriptive anchor text(s)`, description: 'Generic anchors like "click here" do not help SEO.', howToFix: "Replace generic anchor text with descriptive, keyword-rich text." });
  }
  if (intNofollow > 0) {
    allFindings.push({ id: "links-internal-nofollow", category: "links", severity: "warning", priority: "medium", title: `${intNofollow} internal nofollow link(s)`, description: "Nofollowed internal links prevent PageRank flow within your site.", howToFix: "Remove nofollow from internal links unless intentional." });
  }
  if (httpsToHttpCount > 0) {
    allFindings.push({
      id: "links-https-to-http",
      category: "links",
      severity: "warning",
      priority: "medium",
      title: "HTTPS pages linking to HTTP",
      description: `${httpsToHttpCount} link(s) on HTTPS pages point to HTTP URLs, which can trigger mixed content warnings.`,
      howToFix: "Update all links to use HTTPS URLs.",
    });
  }
  if (external403Count > 0) {
    allFindings.push({
      id: "links-403-external",
      category: "links",
      severity: "opportunity",
      priority: "low",
      title: `${external403Count} external link(s) returning 403`,
      description: "External resources may be blocking our crawler. Verify links work in a browser.",
      howToFix: "Check if the target site allows crawlers. Consider replacing links if they are permanently blocked.",
    });
  }
  if (tooLongUrlCount > 0) {
    allFindings.push({
      id: "links-url-too-long",
      category: "links",
      severity: "warning",
      priority: "low",
      title: `${tooLongUrlCount} link(s) with URL over 2000 characters`,
      description: "Very long URLs may not work in all browsers and can cause issues.",
      howToFix: "Shorten URLs or use POST for complex parameters.",
    });
  }

  const brokenInternal = brokenLinks.filter((b) => b.isInternal);
  const brokenExternal = brokenLinks.filter((b) => !b.isInternal);
  const brokenDetails: BrokenLinkDetail[] = [];

  if (brokenInternal.length > 0) {
    allFindings.push({
      id: "links-broken-internal",
      category: "links",
      severity: "issue",
      priority: "critical",
      title: `${brokenInternal.length} broken internal link(s)`,
      description: "Broken internal links create dead-ends for users and waste crawl budget.",
      howToFix: "Fix or remove the broken internal links listed in the report.",
      affectedUrls: brokenInternal.map((b) => b.url),
    });
  }

  if (brokenExternal.length > 0) {
    allFindings.push({
      id: "links-broken-external",
      category: "links",
      severity: "warning",
      priority: "high",
      title: `${brokenExternal.length} broken external link(s)`,
      description: "Broken external links hurt user trust and can impact perceived quality.",
      howToFix: "Update or remove the broken external links.",
      affectedUrls: brokenExternal.map((b) => b.url),
    });
  }

  const urlMatches = (a: string, b: string): boolean => {
    try {
      const ua = new URL(a);
      const ub = new URL(b);
      const pa = ua.pathname.replace(/\/+$/, "") || "/";
      const pb = ub.pathname.replace(/\/+$/, "") || "/";
      return ua.origin === ub.origin && pa === pb && ua.search === ub.search;
    } catch {
      return a === b;
    }
  };

  const getStatusLabel = (code: number): string => {
    if (code === 0) return "Connection failed";
    if (code === 400) return "Bad Request";
    if (code === 401) return "Unauthorized";
    if (code === 403) return "Forbidden";
    if (code === 404) return "Not Found";
    if (code === 408) return "Request Timeout";
    if (code >= 500 && code < 600) return "Server Error";
    if (code >= 400 && code < 500) return "Client Error";
    return `HTTP ${code}`;
  };

  for (const bl of brokenLinks) {
    for (const src of bl.sourcePages) {
      brokenDetails.push({
        sourceUrl: src,
        targetUrl: bl.url,
        statusCode: bl.statusCode,
        statusLabel: getStatusLabel(bl.statusCode),
        anchorText: allLinks.find((l) => urlMatches(l.href, bl.url))?.anchorText ?? "",
        isInternal: bl.isInternal,
      });
    }
  }

  let deductions = 0;
  for (const f of allFindings) {
    if (f.severity === "issue") deductions += f.priority === "critical" ? 20 : 12;
    else if (f.severity === "warning") deductions += f.priority === "high" ? 8 : 5;
    else deductions += 2;
  }
  const score = Math.max(0, 100 - deductions);

  return {
    score,
    findings: allFindings,
    data: {
      totalInternal,
      totalExternal,
      internalNoAnchor,
      nonDescriptiveAnchors: nonDescAnchors,
      internalNofollow: intNofollow,
      externalNofollow: extNofollow,
      emptyHref: emptyHrefs,
      localhostLinks: localhosts,
      uniqueInternalTargets: internalTargets.size,
      brokenLinks: brokenDetails,
      links: allLinks.slice(0, 300),
      pagesAnalysed: pages.length,
    },
  };
}
