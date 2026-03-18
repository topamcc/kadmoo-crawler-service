/**
 * Technical SEO analyzer — response codes, redirects, HTTPS, security headers,
 * sitemap validation, robots.txt analysis.
 */

import * as cheerio from "cheerio";
import type {
  CrawlResult,
  TechnicalSeoResult,
  AuditFinding,
} from "./types.js";

const MAX_TECH_PAGES = 2500;

export function analyseTechnicalSeo(crawl: CrawlResult): TechnicalSeoResult {
  const findings: AuditFinding[] = [];
  const { homepage, subPages, sitemap, robots, brokenCanonicals } = crawl;
  const h = homepage.headers;
  const allPages = [homepage, ...subPages.slice(0, MAX_TECH_PAGES - 1)];

  if (homepage.statusCode !== 200) {
    findings.push({
      id: "tech-status-code",
      category: "crawl",
      severity: "issue",
      priority: "critical",
      title: `Homepage returns ${homepage.statusCode}`,
      description: `The homepage did not return HTTP 200. Status: ${homepage.statusCode}.`,
      howToFix: "Ensure the homepage URL resolves to a 200 OK response without errors.",
    });
  }

  const hops = homepage.redirectChain.length;
  if (hops > 2) {
    findings.push({
      id: "tech-redirect-chain",
      category: "crawl",
      severity: "warning",
      priority: "high",
      title: `Redirect chain with ${hops} hops`,
      description: `The homepage goes through ${hops} redirects before reaching the final URL.`,
      howToFix: "Reduce the redirect chain to a single 301 redirect at most.",
      affectedUrls: homepage.redirectChain.map((r) => r.url),
    });
  }

  if (
    homepage.redirectChain.some((r) => r.statusCode === 302 || r.statusCode === 307)
  ) {
    findings.push({
      id: "tech-temporary-redirect",
      category: "crawl",
      severity: "warning",
      priority: "medium",
      title: "Temporary redirect (302/307) detected",
      description: "A 302 or 307 temporary redirect was found in the chain. Permanent 301 redirects pass more link equity.",
      howToFix: "Change temporary redirects to 301 permanent redirects if the move is permanent.",
    });
  }

  if (homepage.responseTimeMs > 2000) {
    findings.push({
      id: "tech-slow-ttfb",
      category: "crawl",
      severity: "warning",
      priority: "high",
      title: `Slow TTFB: ${homepage.responseTimeMs}ms`,
      description: `Time to First Byte is ${homepage.responseTimeMs}ms. Target is under 800ms.`,
      howToFix: "Improve server response time via caching, CDN, or server optimisation.",
    });
  }

  const isHttps = homepage.url.startsWith("https://");
  if (!isHttps) {
    findings.push({
      id: "tech-no-https",
      category: "security",
      severity: "issue",
      priority: "critical",
      title: "Site not served over HTTPS",
      description: "The homepage does not use HTTPS, which is a ranking signal and a security requirement.",
      howToFix: "Install an SSL certificate and redirect all HTTP traffic to HTTPS.",
    });
  }

  const securityHeaders = {
    hsts: !!h["strict-transport-security"],
    csp: !!h["content-security-policy"],
    xContentType: !!h["x-content-type-options"],
    xFrameOptions: !!h["x-frame-options"],
    referrerPolicy: !!h["referrer-policy"],
    permissionsPolicy: !!h["permissions-policy"],
  };

  const missingHeaders = Object.entries(securityHeaders)
    .filter(([, present]) => !present)
    .map(([name]) => name);

  if (missingHeaders.length > 0) {
    findings.push({
      id: "tech-security-headers",
      category: "security",
      severity: "warning",
      priority: "medium",
      title: `${missingHeaders.length} security header(s) missing`,
      description: `Missing: ${missingHeaders.join(", ")}. Security headers protect against XSS, clickjacking, and other attacks.`,
      howToFix: "Add the missing HTTP security headers to your server configuration.",
      affectedElements: missingHeaders,
    });
  }

  if (isHttps && homepage.html.includes('src="http://')) {
    findings.push({
      id: "tech-mixed-content",
      category: "security",
      severity: "issue",
      priority: "high",
      title: "Mixed content detected",
      description: "The HTTPS page loads resources over insecure HTTP, which triggers browser warnings.",
      howToFix: "Update all resource URLs to use HTTPS or protocol-relative URLs.",
    });
  }

  const http2 = h["alt-svc"]?.includes("h3") || h["alt-svc"]?.includes("h2") || false;

  if (!sitemap.exists) {
    findings.push({
      id: "tech-no-sitemap",
      category: "crawl",
      severity: "issue",
      priority: "high",
      title: "sitemap.xml not found",
      description: "No sitemap.xml was found at the root. Sitemaps help search engines discover and index pages.",
      howToFix: "Create and submit an XML sitemap at /sitemap.xml.",
    });
  } else if (!sitemap.isValid) {
    findings.push({
      id: "tech-invalid-sitemap",
      category: "crawl",
      severity: "warning",
      priority: "medium",
      title: "sitemap.xml exists but may be invalid",
      description: sitemap.errors.join("; ") || "The sitemap was found but contained no valid URLs.",
      howToFix: "Ensure the sitemap follows the XML sitemap protocol with valid <url><loc> entries.",
    });
  }

  if (!robots.exists) {
    findings.push({
      id: "tech-no-robots",
      category: "crawl",
      severity: "warning",
      priority: "medium",
      title: "robots.txt not found",
      description: "No robots.txt file was found. While not required, it helps control crawl behaviour.",
      howToFix: "Create a robots.txt at the site root with appropriate directives.",
    });
  }

  if (robots.disallowedPaths.includes("/")) {
    findings.push({
      id: "tech-robots-blocks-all",
      category: "crawl",
      severity: "issue",
      priority: "critical",
      title: "robots.txt blocks all crawlers",
      description: 'Disallow: / found for User-agent: *, which blocks all search engines from crawling.',
      howToFix: "Remove or narrow the Disallow directive to only block non-public paths.",
    });
  }

  if (robots.sitemapUrls.length === 0 && robots.exists) {
    findings.push({
      id: "tech-robots-no-sitemap",
      category: "crawl",
      severity: "opportunity",
      priority: "low",
      title: "No sitemap declared in robots.txt",
      description: "robots.txt does not reference a sitemap. Adding one helps engines discover it faster.",
      howToFix: "Add Sitemap: https://yourdomain.com/sitemap.xml to robots.txt.",
    });
  }

  let siteOrigin = "";
  try {
    siteOrigin = new URL(homepage.url).origin;
  } catch {
    /* skip */
  }
  if (siteOrigin && robots.sitemapUrls.length > 0) {
    const externalSitemaps = robots.sitemapUrls.filter((u) => {
      try {
        return new URL(u).origin !== siteOrigin;
      } catch {
        return false;
      }
    });
    if (externalSitemaps.length > 0) {
      findings.push({
        id: "tech-robots-external-sitemaps",
        category: "crawl",
        severity: "warning",
        priority: "medium",
        title: `robots.txt references ${externalSitemaps.length} external sitemap(s)`,
        description: `Sitemap URLs from different domains: ${externalSitemaps.slice(0, 3).join(", ")}${externalSitemaps.length > 3 ? "..." : ""}`,
        howToFix: "Remove external sitemap references unless intentional.",
        affectedUrls: externalSitemaps,
      });
    }
  }

  const pages4xx = subPages.filter((p) => p.statusCode >= 400 && p.statusCode < 500);
  const pages5xx = subPages.filter((p) => p.statusCode >= 500);
  if (pages5xx.length > 0) {
    findings.push({
      id: "tech-subpage-5xx",
      category: "crawl",
      severity: "issue",
      priority: "critical",
      title: `${pages5xx.length} sub-page(s) returning 5XX`,
      description: "Server errors prevent crawlers and users from accessing these pages.",
      howToFix: "Investigate server errors and fix the underlying issues.",
      affectedUrls: pages5xx.map((p) => p.url).slice(0, 10),
    });
  }
  if (pages4xx.length > 0) {
    findings.push({
      id: "tech-subpage-4xx",
      category: "crawl",
      severity: "issue",
      priority: "high",
      title: `${pages4xx.length} sub-page(s) returning 4XX`,
      description: "Client errors (404, 403, etc.) indicate broken or inaccessible pages.",
      howToFix: "Fix or remove links to these pages. Use 301 redirects for moved content.",
      affectedUrls: pages4xx.map((p) => p.url).slice(0, 10),
    });
  }

  const pagesWithMetaRefresh: string[] = [];
  const pagesWithoutCharset: string[] = [];
  const pagesWithoutDoctype: string[] = [];
  const pagesWithLargeHtml: string[] = [];
  const HTML_SIZE_LIMIT = 2 * 1024 * 1024;

  for (const page of allPages) {
    if (!page.html) continue;
    const $ = cheerio.load(page.html);
    if ($('meta[http-equiv="refresh"]').length > 0) {
      pagesWithMetaRefresh.push(page.url);
    }
    const hasCharset =
      $('meta[charset]').length > 0 ||
      $('meta[http-equiv="content-type"]').filter((_, el) =>
        !!$(el).attr("content")?.toLowerCase().includes("charset="),
      ).length > 0;
    if (!hasCharset) {
      pagesWithoutCharset.push(page.url);
    }
    const htmlLower = page.html.slice(0, 500).toLowerCase();
    if (!/<!doctype\s/i.test(htmlLower)) {
      pagesWithoutDoctype.push(page.url);
    }
    const size = page.contentLength || page.html.length;
    if (size > HTML_SIZE_LIMIT) {
      pagesWithLargeHtml.push(page.url);
    }
  }

  if (pagesWithMetaRefresh.length > 0) {
    findings.push({
      id: "tech-meta-refresh",
      category: "crawl",
      severity: "warning",
      priority: "medium",
      title: "Meta refresh tag detected",
      description: `${pagesWithMetaRefresh.length} page(s) use meta refresh, which is slow and not recommended for redirects.`,
      howToFix: "Replace meta refresh with 301 server redirects.",
      affectedUrls: pagesWithMetaRefresh.slice(0, 5),
    });
  }
  if (pagesWithoutCharset.length > 0) {
    findings.push({
      id: "tech-no-charset",
      category: "crawl",
      severity: "warning",
      priority: "medium",
      title: "No character encoding declared",
      description: `${pagesWithoutCharset.length} page(s) lack charset declaration.`,
      howToFix: 'Add <meta charset="utf-8"> or Content-Type header with charset.',
      affectedUrls: pagesWithoutCharset.slice(0, 5),
    });
  }
  if (pagesWithoutDoctype.length > 0) {
    findings.push({
      id: "tech-no-doctype",
      category: "crawl",
      severity: "warning",
      priority: "medium",
      title: "No doctype declared",
      description: `${pagesWithoutDoctype.length} page(s) lack a doctype declaration.`,
      howToFix: 'Add <!DOCTYPE html> at the very top of each page.',
      affectedUrls: pagesWithoutDoctype.slice(0, 5),
    });
  }
  if (pagesWithLargeHtml.length > 0) {
    findings.push({
      id: "tech-html-too-large",
      category: "crawl",
      severity: "warning",
      priority: "high",
      title: "HTML page size too large",
      description: `${pagesWithLargeHtml.length} page(s) exceed 2MB, which slows loading.`,
      howToFix: "Optimise HTML: remove inline scripts/styles, minimise DOM size.",
      affectedUrls: pagesWithLargeHtml.slice(0, 5),
    });
  }

  if (isHttps && sitemap.urls.some((u) => u.startsWith("http://"))) {
    const httpUrls = sitemap.urls.filter((u) => u.startsWith("http://")).slice(0, 5);
    findings.push({
      id: "tech-sitemap-http-urls",
      category: "crawl",
      severity: "warning",
      priority: "medium",
      title: "HTTP URLs in sitemap.xml on HTTPS site",
      description: "Sitemap contains HTTP URLs while the site uses HTTPS. Use consistent HTTPS URLs.",
      howToFix: "Replace all HTTP URLs in the sitemap with HTTPS equivalents.",
      affectedUrls: httpUrls,
    });
  }

  if (brokenCanonicals && brokenCanonicals.length > 0) {
    findings.push({
      id: "tech-broken-canonical",
      category: "crawl",
      severity: "issue",
      priority: "high",
      title: "Broken canonical link(s)",
      description: `${brokenCanonicals.length} canonical URL(s) return non-200 status.`,
      howToFix: "Ensure canonical URLs point to existing, accessible pages.",
      affectedUrls: brokenCanonicals.map((c) => c.canonicalUrl).slice(0, 5),
    });
  }

  if (sitemap.urlCount >= 50000) {
    findings.push({
      id: "tech-sitemap-too-large",
      category: "crawl",
      severity: "warning",
      priority: "medium",
      title: "Sitemap contains 50,000+ URLs",
      description: "Sitemaps over 50K URLs may be ignored by search engines. Split into multiple sitemaps.",
      howToFix: "Create a sitemap index and split URLs across multiple sitemap files.",
    });
  }

  let redirectType: TechnicalSeoResult["data"]["redirectType"] = "none";
  if (homepage.redirectChain.length > 1) {
    const firstHop = homepage.redirectChain[0];
    if (firstHop.statusCode === 301) redirectType = "301";
    else if (firstHop.statusCode === 302) redirectType = "302";
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
      homepageStatus: homepage.statusCode,
      ttfbMs: homepage.responseTimeMs,
      http2Support: http2,
      redirectChain: homepage.redirectChain,
      redirectType,
      isHttps,
      sitemap,
      robots,
      securityHeaders,
    },
  };
}
