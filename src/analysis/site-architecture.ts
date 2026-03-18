/**
 * Site Architecture analyzer — navigation structure, header/footer audit,
 * crawl depth mapping, and orphan page detection.
 */

import * as cheerio from "cheerio";
import type {
  CrawlResult,
  CrawledPage,
  SiteArchitectureResult,
  AuditFinding,
  NavItem,
} from "./types.js";

function extractNavigation(html: string, pageUrl: string): NavItem[] {
  const $ = cheerio.load(html);
  const items: NavItem[] = [];
  const seen = new Set<string>();

  function addItem(text: string, href: string, depth: number) {
    if (!href || !text) return;
    try {
      const resolved = new URL(href, pageUrl).href;
      const key = `${resolved}|${depth}`;
      if (!seen.has(key)) {
        seen.add(key);
        items.push({ text: text.slice(0, 100), href: resolved, depth });
      }
    } catch { /* skip */ }
  }

  function processLinks(parent: cheerio.Cheerio<any>, depth: number) {
    parent.children("li, a").each((_, el) => {
      const tag = (el as any).tagName?.toLowerCase();
      if (tag === "a") {
        addItem($(el).text().trim(), $(el).attr("href") ?? "", depth);
      } else if (tag === "li") {
        const link = $(el).children("a").first();
        addItem(link.text().trim(), link.attr("href") ?? "", depth);

        const subMenu = $(el).find("ul, ol, [class*='sub-menu'], [class*='submenu'], [class*='dropdown-menu'], [class*='dropdown_menu']");
        if (subMenu.length > 0) {
          processLinks(subMenu.first(), depth + 1);
        }
      }
    });
  }

  function processNavElement(navEl: any) {
    const lists = $(navEl).find("> ul, > ol, > div > ul, > div > ol");
    if (lists.length > 0) {
      lists.each((_, ul) => processLinks($(ul), 0));
    } else {
      const nestedLists = $(navEl).find("ul, ol");
      if (nestedLists.length > 0) {
        nestedLists.each((_, ul) => {
          const parentDepth = $(ul).parents("ul, ol").length;
          processLinks($(ul), parentDepth);
        });
      } else {
        $(navEl).find("a").each((_, a) => {
          addItem($(a).text().trim(), $(a).attr("href") ?? "", 0);
        });
      }
    }

    $(navEl).find("[class*='dropdown'], [class*='sub-menu'], [class*='submenu'], [class*='mega-menu'], [class*='megamenu']").each((_, subEl) => {
      const depth = $(subEl).parents("[class*='dropdown'], [class*='sub-menu'], [class*='submenu']").length + 1;
      $(subEl).find("> a, > li > a, > div > a").each((_, a) => {
        addItem($(a).text().trim(), $(a).attr("href") ?? "", depth);
      });
    });
  }

  $("nav").each((_, navEl) => processNavElement(navEl));

  $('[role="navigation"]').each((_, navEl) => {
    if ($(navEl).prop("tagName")?.toLowerCase() !== "nav") {
      processNavElement(navEl);
    }
  });

  if (items.length === 0) {
    const menuSelectors = [
      '[class*="main-menu"]', '[class*="main_menu"]', '[class*="primary-menu"]',
      '[class*="primary_menu"]', '[class*="site-nav"]', '[class*="site_nav"]',
      '[class*="navbar-nav"]', '[class*="nav-menu"]', '[class*="nav_menu"]',
      'header [class*="menu"]', 'header ul',
    ];
    $(menuSelectors.join(", ")).each((_, el) => processNavElement(el));
  }

  return items;
}

function analyseHeader(html: string): {
  hasLogo: boolean;
  hasCta: boolean;
  hasPhone: boolean;
  hasSearch: boolean;
} {
  const $ = cheerio.load(html);
  const header = $("header").first();
  if (header.length === 0) {
    return { hasLogo: false, hasCta: false, hasPhone: false, hasSearch: false };
  }

  const headerHtml = header.html() ?? "";
  const headerText = header.text().toLowerCase();

  const hasLogo =
    header.find("img[class*='logo'], img[alt*='logo'], a[class*='logo'], .logo, [class*='site-logo']").length > 0
    || /logo/i.test(headerHtml);

  const hasCta =
    header.find("a.btn, a.button, button.cta, [class*='cta'], a[class*='btn'], .wp-block-button").length > 0
    || /book|schedule|contact|appointment|call|get started|sign up/i.test(headerText);

  const hasPhone =
    header.find('a[href^="tel:"]').length > 0
    || /\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/.test(headerText);

  const hasSearch =
    header.find('input[type="search"], form[role="search"], .search-form, [class*="search"]').length > 0;

  return { hasLogo, hasCta, hasPhone, hasSearch };
}

function analyseFooter(html: string, pageUrl: string): {
  links: { text: string; href: string }[];
  hasSocial: boolean;
  hasLegal: boolean;
  hasSitemapLink: boolean;
} {
  const $ = cheerio.load(html);
  const footer = $("footer").first();

  if (footer.length === 0) {
    return { links: [], hasSocial: false, hasLegal: false, hasSitemapLink: false };
  }

  const links: { text: string; href: string }[] = [];
  footer.find("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const text = $(el).text().trim().slice(0, 100);
    if (href && text) {
      try {
        links.push({ text, href: new URL(href, pageUrl).href });
      } catch { /* skip */ }
    }
  });

  const footerText = footer.text().toLowerCase();
  const footerHtml = footer.html()?.toLowerCase() ?? "";

  const socialPatterns = /facebook|twitter|linkedin|instagram|youtube|tiktok|x\.com/i;
  const hasSocial = socialPatterns.test(footerHtml);

  const hasLegal =
    /privacy|terms|conditions|disclaimer|cookie|gdpr/i.test(footerText);

  const hasSitemapLink =
    links.some((l) => /sitemap/i.test(l.text) || /sitemap/i.test(l.href));

  return { links: links.slice(0, 50), hasSocial, hasLegal, hasSitemapLink };
}

function detectTestimonials(html: string): boolean {
  const lower = html.toLowerCase();
  const patterns = [
    /class="[^"]*testimonial[^"]*"/,
    /id="[^"]*testimonial[^"]*"/,
    /class="[^"]*review[^"]*"/,
    /id="[^"]*review[^"]*"/,
    /class="[^"]*rating[^"]*"/,
    /class="[^"]*testimonials[^"]*"/,
    /class="[^"]*reviews[^"]*"/,
    /data-[a-z-]*="[^"]*review[^"]*"/,
  ];
  return patterns.some((p) => p.test(lower));
}

function calculateCrawlDepth(
  pages: CrawledPage[],
  homepage: CrawledPage,
): { url: string; depth: number }[] {
  const origin = (() => { try { return new URL(homepage.url).origin; } catch { return ""; } })();
  const pageUrls = new Set(pages.map((p) => p.url));

  const linkGraph = new Map<string, Set<string>>();
  for (const page of pages) {
    if (!page.html) continue;
    const $ = cheerio.load(page.html);
    const targets = new Set<string>();
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href")?.trim();
      if (!href) return;
      try {
        const resolved = new URL(href, page.url).href.replace(/\/$/, "");
        if (resolved.startsWith(origin) && pageUrls.has(resolved)) {
          targets.add(resolved);
        }
      } catch { /* skip */ }
    });
    linkGraph.set(page.url, targets);
  }

  const depths = new Map<string, number>();
  depths.set(homepage.url, 0);
  const queue = [homepage.url];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentDepth = depths.get(current)!;
    const neighbours = linkGraph.get(current);
    if (!neighbours) continue;

    for (const next of neighbours) {
      if (!depths.has(next)) {
        depths.set(next, currentDepth + 1);
        queue.push(next);
      }
    }
  }

  return Array.from(depths.entries())
    .map(([url, depth]) => ({ url, depth }))
    .sort((a, b) => a.depth - b.depth);
}

function findPagesWithSingleIncomingLink(
  pages: CrawledPage[],
  homepage: CrawledPage,
): string[] {
  const origin = (() => { try { return new URL(homepage.url).origin; } catch { return ""; } })();
  const pageUrls = new Set(pages.map((p) => p.url));
  const incomingCount = new Map<string, number>();

  for (const page of pages) {
    if (!page.html) continue;
    const $ = cheerio.load(page.html);
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href")?.trim();
      if (!href) return;
      try {
        const resolved = new URL(href, page.url).href.replace(/\/$/, "");
        if (resolved.startsWith(origin) && pageUrls.has(resolved) && resolved !== page.url) {
          incomingCount.set(resolved, (incomingCount.get(resolved) ?? 0) + 1);
        }
      } catch { /* skip */ }
    });
  }

  return [...incomingCount.entries()]
    .filter(([, count]) => count === 1)
    .map(([url]) => url)
    .filter((url) => url !== homepage.url);
}

function findOrphanPages(
  sitemapUrls: string[],
  pages: CrawledPage[],
  homepage: CrawledPage,
): string[] {
  const origin = (() => { try { return new URL(homepage.url).origin; } catch { return ""; } })();

  function normalizeUrl(u: string): string {
    try {
      const url = new URL(u);
      return (url.origin + url.pathname).replace(/\/$/, "").toLowerCase();
    } catch {
      return u.replace(/\/$/, "").toLowerCase();
    }
  }

  const linkedUrls = new Set<string>();
  for (const page of pages) {
    if (!page.html) continue;
    const $ = cheerio.load(page.html);
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href")?.trim();
      if (!href) return;
      try {
        const resolved = new URL(href, page.url).href;
        if (resolved.startsWith(origin)) {
          linkedUrls.add(normalizeUrl(resolved));
        }
      } catch { /* skip */ }
    });
  }

  const normalisedHome = normalizeUrl(homepage.url);

  return sitemapUrls
    .filter((u) => {
      const normalised = normalizeUrl(u);
      return !linkedUrls.has(normalised) && normalised !== normalisedHome;
    })
    .slice(0, 100);
}

const MAX_ARCH_PAGES = 2500;

export function analyseSiteArchitecture(crawl: CrawlResult): SiteArchitectureResult {
  const findings: AuditFinding[] = [];
  const limitedSubPages = crawl.subPages.length > MAX_ARCH_PAGES - 1
    ? crawl.subPages.slice(0, MAX_ARCH_PAGES - 1)
    : crawl.subPages;
  const allPages = [crawl.homepage, ...limitedSubPages];

  const navigation = {
    items: extractNavigation(crawl.homepage.html, crawl.homepage.url),
    maxDepth: 0,
  };
  navigation.maxDepth = navigation.items.length > 0
    ? Math.max(...navigation.items.map((i) => i.depth))
    : 0;

  const header = analyseHeader(crawl.homepage.html);
  const footer = analyseFooter(crawl.homepage.html, crawl.homepage.url);
  const hasTestimonials = detectTestimonials(crawl.homepage.html);
  const crawlDepthMap = calculateCrawlDepth(allPages, crawl.homepage);
  const orphanPages = findOrphanPages(crawl.sitemap.urls, allPages, crawl.homepage);
  const maxCrawlDepth = crawlDepthMap.length > 0 ? Math.max(...crawlDepthMap.map((d) => d.depth)) : 0;
  const singleIncomingPages = findPagesWithSingleIncomingLink(allPages, crawl.homepage);

  let totalInternalLinks = 0;
  const origin = (() => { try { return new URL(crawl.homepage.url).origin; } catch { return ""; } })();
  for (const page of allPages) {
    if (!page.html) continue;
    const $ = cheerio.load(page.html);
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href")?.trim();
      if (!href) return;
      try {
        if (new URL(href, page.url).href.startsWith(origin)) totalInternalLinks++;
      } catch { /* skip */ }
    });
  }

  if (navigation.items.length === 0) {
    findings.push({
      id: "arch-no-nav",
      category: "architecture",
      severity: "issue",
      priority: "high",
      title: "No navigation structure found",
      description: "No <nav> element with links was found on the homepage.",
      howToFix: "Add a semantic <nav> element with the site's main navigation links.",
    });
  } else if (navigation.maxDepth > 3) {
    findings.push({
      id: "arch-deep-nav",
      category: "architecture",
      severity: "warning",
      priority: "medium",
      title: `Deep navigation (${navigation.maxDepth + 1} levels)`,
      description: "Navigation has more than 3 levels of depth, which can be confusing.",
      howToFix: "Simplify the navigation structure. Keep menus to 3 levels or fewer.",
    });
  }

  if (!header.hasLogo) {
    findings.push({
      id: "arch-no-logo",
      category: "architecture",
      severity: "warning",
      priority: "low",
      title: "No logo detected in header",
      description: "A logo in the header reinforces brand identity and trust.",
      howToFix: "Add a logo image in the <header> element.",
    });
  }

  if (!header.hasCta) {
    findings.push({
      id: "arch-no-header-cta",
      category: "architecture",
      severity: "opportunity",
      priority: "medium",
      title: "No CTA found in header",
      description: "A clear call-to-action in the header improves conversions.",
      howToFix: "Add a prominent CTA button (e.g., 'Book Now', 'Contact Us') in the header.",
    });
  }

  if (!header.hasPhone) {
    findings.push({
      id: "arch-no-header-phone",
      category: "architecture",
      severity: "opportunity",
      priority: "low",
      title: "No phone number in header",
      description: "Displaying a phone number improves trust and local SEO signals.",
      howToFix: "Add a clickable phone link (tel:) in the header.",
    });
  }

  if (!footer.hasSocial) {
    findings.push({
      id: "arch-no-social",
      category: "architecture",
      severity: "opportunity",
      priority: "low",
      title: "No social media links in footer",
      description: "Social links in the footer signal active online presence.",
      howToFix: "Add links to your social media profiles in the footer.",
    });
  }

  if (!footer.hasLegal) {
    findings.push({
      id: "arch-no-legal",
      category: "architecture",
      severity: "warning",
      priority: "medium",
      title: "No legal pages linked in footer",
      description: "Missing privacy policy or terms of service links can hurt trust and compliance.",
      howToFix: "Add links to Privacy Policy and Terms of Service in the footer.",
    });
  }

  if (maxCrawlDepth > 3) {
    findings.push({
      id: "arch-deep-crawl",
      category: "architecture",
      severity: "warning",
      priority: "medium",
      title: `Deep site structure (${maxCrawlDepth} clicks from homepage)`,
      description: "Some pages require more than 3 clicks to reach from the homepage.",
      howToFix: "Flatten the site structure so all important pages are reachable within 3 clicks.",
      affectedUrls: crawlDepthMap.filter((d) => d.depth > 3).map((d) => d.url).slice(0, 10),
    });
  }

  const pagesWithXRobotsNoindex = allPages.filter((p) => {
    const xRobots = p.headers["x-robots-tag"]?.toLowerCase() ?? "";
    return xRobots.includes("noindex");
  });
  if (pagesWithXRobotsNoindex.length > 0) {
    findings.push({
      id: "arch-xrobotstag-noindex",
      category: "architecture",
      severity: "warning",
      priority: "high",
      title: `${pagesWithXRobotsNoindex.length} page(s) blocked by X-Robots-Tag: noindex`,
      description: "HTTP header X-Robots-Tag: noindex prevents indexing of these pages.",
      howToFix: "Remove X-Robots-Tag: noindex from HTTP headers for pages you want indexed.",
      affectedUrls: pagesWithXRobotsNoindex.map((p) => p.url).slice(0, 10),
    });
  }

  if (orphanPages.length > 0) {
    findings.push({
      id: "arch-orphan-pages",
      category: "architecture",
      severity: "warning",
      priority: "high",
      title: `${orphanPages.length} orphan page(s) detected`,
      description: "Pages in the sitemap that have no internal links pointing to them.",
      howToFix: "Add internal links to these pages from relevant content, or remove them from the sitemap.",
      affectedUrls: orphanPages.slice(0, 50),
    });
  }

  if (singleIncomingPages.length > 0) {
    findings.push({
      id: "arch-single-incoming",
      category: "architecture",
      severity: "opportunity",
      priority: "medium",
      title: `${singleIncomingPages.length} page(s) with only 1 incoming link`,
      description: "Pages with very few incoming links may be under-discovered by crawlers and users.",
      howToFix: "Add more internal links to these pages from relevant content.",
      affectedUrls: singleIncomingPages.slice(0, 10),
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
      navigation,
      header,
      footer,
      trust: { hasTestimonials },
      crawlDepth: crawlDepthMap,
      orphanPages,
      maxCrawlDepth,
      totalInternalLinks,
    },
  };
}
