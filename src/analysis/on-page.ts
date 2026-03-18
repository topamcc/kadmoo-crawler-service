/**
 * On-page SEO analyzer — titles, meta tags, headings, images, URL structure,
 * content quality. Uses cheerio for HTML parsing.
 */

import * as cheerio from "cheerio";
import type {
  CrawledPage,
  OnPageResult,
  AuditFinding,
  HeadingInfo,
  ImageInfo,
  CrawlResult,
} from "./types.js";

function getExtension(src: string): string {
  try {
    const pathname = new URL(src, "https://placeholder.com").pathname;
    const ext = pathname.split(".").pop()?.toLowerCase() ?? "";
    return ext;
  } catch {
    return "";
  }
}

export function analyseOnPage(page: CrawledPage): OnPageResult {
  const findings: AuditFinding[] = [];
  const $ = cheerio.load(page.html);

  const titleEls = $("title");
  const titleValue = titleEls.first().text().trim();
  const titleLength = titleValue.length;
  const titleIsMultiple = titleEls.length > 1;
  const titleOutsideHead = $("body title").length > 0;

  if (!titleValue) {
    findings.push({ id: "op-title-missing", category: "page_titles", severity: "issue", priority: "critical", title: "Page title missing", description: "No <title> tag found. Page titles are a top ranking signal.", howToFix: "Add a unique, descriptive <title> tag in the <head>." });
  } else {
    if (titleLength > 60) {
      findings.push({ id: "op-title-long", category: "page_titles", severity: "opportunity", priority: "medium", title: `Title too long (${titleLength} chars)`, description: "Title exceeds 60 characters and may be truncated in search results.", howToFix: "Shorten the title to 30-60 characters." });
    }
    if (titleLength < 30 && titleLength > 0) {
      findings.push({ id: "op-title-short", category: "page_titles", severity: "opportunity", priority: "low", title: `Title too short (${titleLength} chars)`, description: "Title is under 30 characters. Longer titles provide more context.", howToFix: "Expand the title to 30-60 characters with relevant keywords." });
    }
  }

  if (titleIsMultiple) {
    findings.push({ id: "op-title-multiple", category: "page_titles", severity: "issue", priority: "high", title: "Multiple title tags found", description: `Found ${titleEls.length} <title> elements. Only one should exist.`, howToFix: "Remove duplicate <title> tags, keeping only one in <head>." });
  }

  if (titleOutsideHead) {
    findings.push({ id: "op-title-outside-head", category: "page_titles", severity: "issue", priority: "high", title: "Title tag outside <head>", description: "A <title> tag was found inside <body>.", howToFix: "Move the <title> tag into the <head> section." });
  }

  const metaDescs = $('meta[name="description"]');
  const metaDescValue = metaDescs.first().attr("content")?.trim() ?? "";
  const metaDescLength = metaDescValue.length;

  if (!metaDescValue) {
    findings.push({ id: "op-meta-desc-missing", category: "meta_tags", severity: "opportunity", priority: "medium", title: "Meta description missing", description: "No meta description found. Search engines may use page content instead.", howToFix: 'Add <meta name="description" content="..."> in the <head>.' });
  } else {
    if (metaDescLength > 155) {
      findings.push({ id: "op-meta-desc-long", category: "meta_tags", severity: "opportunity", priority: "low", title: `Meta description too long (${metaDescLength} chars)`, description: "May be truncated in search results.", howToFix: "Keep the meta description between 70-155 characters." });
    }
    if (metaDescLength < 70) {
      findings.push({ id: "op-meta-desc-short", category: "meta_tags", severity: "opportunity", priority: "low", title: `Meta description too short (${metaDescLength} chars)`, description: "Short meta descriptions miss the opportunity to entice clicks.", howToFix: "Expand to 70-155 characters with a compelling description." });
    }
  }

  if (metaDescs.length > 1) {
    findings.push({ id: "op-meta-desc-multiple", category: "meta_tags", severity: "issue", priority: "medium", title: "Multiple meta descriptions found", description: `Found ${metaDescs.length} meta description tags.`, howToFix: "Keep only one meta description tag." });
  }

  const metaViewport = $('meta[name="viewport"]').length > 0;
  if (!metaViewport) {
    findings.push({ id: "op-no-viewport", category: "meta_tags", severity: "issue", priority: "high", title: "Meta viewport not set", description: "Missing viewport meta tag. Page may not render correctly on mobile.", howToFix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.' });
  }

  const ogTitle = $('meta[property="og:title"]').length > 0;
  const ogDesc = $('meta[property="og:description"]').length > 0;
  const ogImage = $('meta[property="og:image"]').length > 0;
  if (!ogTitle || !ogDesc || !ogImage) {
    const missing = [!ogTitle && "og:title", !ogDesc && "og:description", !ogImage && "og:image"].filter(Boolean);
    findings.push({ id: "op-og-missing", category: "meta_tags", severity: "opportunity", priority: "low", title: `Open Graph tags missing: ${missing.join(", ")}`, description: "Open Graph tags improve link previews on social media.", howToFix: "Add the missing Open Graph meta tags in the <head>." });
  }

  const twitterCard = $('meta[name="twitter:card"]').length > 0;

  const robotsContent = ($('meta[name="robots"]').attr("content") ?? "").toLowerCase();
  const noindex = robotsContent.includes("noindex");
  const nofollow = robotsContent.includes("nofollow");
  const nosnippet = robotsContent.includes("nosnippet");

  if (noindex) {
    findings.push({ id: "op-noindex", category: "meta_tags", severity: "warning", priority: "critical", title: "Page is set to noindex", description: "This page will not appear in search results.", howToFix: "Remove noindex if you want this page indexed." });
  }
  if (nosnippet) {
    findings.push({ id: "op-nosnippet", category: "meta_tags", severity: "warning", priority: "high", title: "Page is set to nosnippet", description: "This page cannot be shown in AI Overviews or featured snippets.", howToFix: "Remove nosnippet to allow snippet eligibility." });
  }

  const canonicalEls = $('link[rel="canonical"]');
  const canonicalValue = canonicalEls.first().attr("href")?.trim() ?? "";
  const canonicalIsAbsolute = canonicalValue.startsWith("http");
  const canonicalIsMultiple = canonicalEls.length > 1;

  if (!canonicalValue) {
    findings.push({ id: "op-canonical-missing", category: "meta_tags", severity: "warning", priority: "medium", title: "Canonical tag missing", description: "No canonical tag found. This can lead to duplicate content issues.", howToFix: 'Add <link rel="canonical" href="..."> in the <head>.' });
  } else {
    if (!canonicalIsAbsolute) {
      findings.push({ id: "op-canonical-relative", category: "meta_tags", severity: "warning", priority: "medium", title: "Canonical uses relative URL", description: "The canonical tag uses a relative URL, which can be ambiguous.", howToFix: "Use an absolute URL in the canonical tag." });
    }
    if (canonicalIsMultiple) {
      findings.push({ id: "op-canonical-multiple", category: "meta_tags", severity: "issue", priority: "high", title: "Multiple canonical tags found", description: "Multiple canonical tags cause confusion for search engines.", howToFix: "Keep only one canonical tag per page." });
    }
  }

  const hreflangTags: { lang: string; href: string }[] = [];
  $('link[rel="alternate"][hreflang]').each((_, el) => {
    hreflangTags.push({
      lang: $(el).attr("hreflang") ?? "",
      href: $(el).attr("href") ?? "",
    });
  });

  const htmlLang = $("html").attr("lang") ?? "";
  if (!htmlLang) {
    findings.push({ id: "op-no-html-lang", category: "meta_tags", severity: "warning", priority: "medium", title: "Missing html lang attribute", description: "The <html> tag has no lang attribute. This helps search engines and screen readers.", howToFix: 'Add lang attribute: <html lang="en">.' });
  }

  const headings: HeadingInfo[] = [];
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const tagName = (el as any).tagName?.toLowerCase() ?? "";
    const level = parseInt(tagName.replace("h", ""), 10);
    headings.push({ level, text: $(el).text().trim().slice(0, 200) });
  });

  const h1Elements = $("h1");
  const h1Count = h1Elements.length;
  const h1Value = h1Elements.first().text().trim();

  if (h1Count === 0) {
    findings.push({ id: "op-h1-missing", category: "headings", severity: "issue", priority: "high", title: "H1 heading missing", description: "No H1 heading found. H1 is the most important on-page heading.", howToFix: "Add a single, descriptive H1 tag to the page." });
  } else if (h1Count > 1) {
    findings.push({ id: "op-h1-multiple", category: "headings", severity: "warning", priority: "medium", title: `Multiple H1 tags (${h1Count})`, description: "More than one H1 heading found. Best practice is a single H1.", howToFix: "Keep one H1 and convert others to H2." });
  }

  if (h1Value && h1Value.length > 70) {
    findings.push({ id: "op-h1-long", category: "headings", severity: "opportunity", priority: "low", title: "H1 over 70 characters", description: `H1 is ${h1Value.length} characters. Shorter headings are more effective.`, howToFix: "Shorten the H1 to under 70 characters." });
  }

  const titleSameAsH1 = titleValue && h1Value && titleValue.toLowerCase() === h1Value.toLowerCase();
  if (titleSameAsH1) {
    findings.push({ id: "op-title-same-h1", category: "page_titles", severity: "opportunity", priority: "low", title: "Title is identical to H1", description: "Having slightly different title and H1 can capture more search queries.", howToFix: "Differentiate the page title from the H1 slightly." });
  }

  if ($("h2").length === 0) {
    findings.push({ id: "op-h2-missing", category: "headings", severity: "warning", priority: "medium", title: "No H2 headings found", description: "H2 tags structure content into sections and help SEO.", howToFix: "Add H2 subheadings to break content into logical sections." });
  }

  let hierarchyValid = true;
  for (let i = 1; i < headings.length; i++) {
    if (headings[i].level > headings[i - 1].level + 1) {
      hierarchyValid = false;
      break;
    }
  }
  if (!hierarchyValid) {
    findings.push({ id: "op-heading-hierarchy", category: "headings", severity: "warning", priority: "medium", title: "Heading hierarchy is not sequential", description: "Headings skip levels (e.g., H1 to H3). Use a logical H1>H2>H3 order.", howToFix: "Restructure headings so they follow a sequential hierarchy." });
  }

  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const wordCount = bodyText.split(/\s+/).filter(Boolean).length;
  const htmlLength = page.html.length;
  const contentToHtmlRatio = htmlLength > 0 ? Math.round((bodyText.length / htmlLength) * 100) : 0;
  const hasLoremIpsum = /lorem ipsum/i.test(bodyText);

  if (contentToHtmlRatio < 10 && htmlLength > 0) {
    findings.push({
      id: "op-low-text-ratio",
      category: "content",
      severity: "warning",
      priority: "medium",
      title: `Low text-to-HTML ratio (${contentToHtmlRatio}%)`,
      description: "Text content is less than 10% of HTML. Search engines prefer content-rich pages.",
      howToFix: "Reduce code bloat, move scripts/styles to external files, add more text content.",
    });
  }

  if (wordCount < 300) {
    findings.push({ id: "op-thin-content", category: "content", severity: "warning", priority: "high", title: `Thin content (${wordCount} words)`, description: "Pages with fewer than 300 words may be considered low-quality.", howToFix: "Add more substantive, relevant content to the page." });
  }

  if (hasLoremIpsum) {
    findings.push({ id: "op-lorem-ipsum", category: "content", severity: "issue", priority: "high", title: "Lorem ipsum placeholder text detected", description: "Placeholder text is still present on the live page.", howToFix: "Replace all placeholder text with real content." });
  }

  const imageItems: ImageInfo[] = [];
  let missingAlt = 0;
  let missingAltAttr = 0;
  let altOver100 = 0;
  let missingDims = 0;
  let modernFormats = 0;
  let lazyLoaded = 0;

  $("img").each((_, el) => {
    const src = $(el).attr("src") ?? "";
    const altAttr = $(el).attr("alt");
    const hasAltAttr = altAttr !== undefined;
    const alt = altAttr ?? null;
    const hasWidth = !!$(el).attr("width");
    const hasHeight = !!$(el).attr("height");
    const hasWidthHeight = hasWidth && hasHeight;
    const isLazy = $(el).attr("loading") === "lazy";
    const ext = getExtension(src);
    const isModern = ["webp", "avif"].includes(ext);

    if (!hasAltAttr) missingAltAttr++;
    else if (!alt || alt.trim() === "") missingAlt++;
    if (alt && alt.length > 100) altOver100++;
    if (!hasWidthHeight) missingDims++;
    if (isModern) modernFormats++;
    if (isLazy) lazyLoaded++;

    imageItems.push({ src, alt, hasWidthHeight, isLazy, format: ext });
  });

  const totalImages = imageItems.length;
  if (missingAltAttr > 0) {
    findings.push({ id: "op-img-no-alt-attr", category: "images", severity: "issue", priority: "high", title: `${missingAltAttr} image(s) missing alt attribute`, description: "Images without alt attributes hurt accessibility and SEO.", howToFix: "Add descriptive alt attributes to all images." });
  }
  if (missingAlt > 0) {
    findings.push({ id: "op-img-empty-alt", category: "images", severity: "warning", priority: "medium", title: `${missingAlt} image(s) with empty alt text`, description: "Images have alt attribute but it is empty.", howToFix: "Add descriptive alt text unless the image is purely decorative." });
  }
  if (missingDims > 0 && totalImages > 0) {
    findings.push({ id: "op-img-no-dimensions", category: "images", severity: "opportunity", priority: "medium", title: `${missingDims} image(s) missing width/height`, description: "Images without explicit dimensions can cause layout shift (CLS).", howToFix: "Add width and height attributes to all images." });
  }

  const url = page.url || "";
  let pathname = "";
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = "";
  }
  const urlAnalysis = {
    hasSpaces: /\s|%20/.test(url),
    hasUppercase: /[A-Z]/.test(pathname),
    over115Chars: url.length > 115,
    hasParameters: url.includes("?"),
    hasMultipleSlashes: /\/{2,}/.test(pathname),
    hasUnderscores: pathname.includes("_"),
    length: url.length,
  };

  if (urlAnalysis.hasSpaces) {
    findings.push({ id: "op-url-spaces", category: "url_structure", severity: "issue", priority: "medium", title: "URL contains spaces", description: "Spaces in URLs cause encoding issues.", howToFix: "Replace spaces with hyphens in URLs." });
  }
  if (urlAnalysis.hasUppercase) {
    findings.push({ id: "op-url-uppercase", category: "url_structure", severity: "warning", priority: "low", title: "URL contains uppercase letters", description: "Lowercase URLs are preferred for consistency.", howToFix: "Use lowercase URLs and set up redirects from uppercase versions." });
  }
  if (urlAnalysis.over115Chars) {
    findings.push({ id: "op-url-long", category: "url_structure", severity: "opportunity", priority: "low", title: `URL over 115 characters (${url.length})`, description: "Very long URLs can be truncated in search results.", howToFix: "Shorten the URL path where possible." });
  }
  if (urlAnalysis.hasUnderscores) {
    findings.push({
      id: "op-url-underscore",
      category: "url_structure",
      severity: "warning",
      priority: "low",
      title: "URL contains underscores",
      description: "Underscores as word separators may not be interpreted correctly by search engines.",
      howToFix: "Use hyphens instead of underscores in URLs.",
    });
  }

  const linkCount = $("a[href]").length;
  if (linkCount > 3000) {
    findings.push({
      id: "op-too-many-links",
      category: "links",
      severity: "warning",
      priority: "medium",
      title: `Too many on-page links (${linkCount})`,
      description: "Over 3,000 links on a page can look spammy to search engines.",
      howToFix: "Reduce the number of links. Paginate or consolidate where possible.",
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
      title: {
        exists: !!titleValue,
        value: titleValue,
        length: titleLength,
        isMultiple: titleIsMultiple,
        isOutsideHead: titleOutsideHead,
        sameAsH1: !!titleSameAsH1,
      },
      metaDescription: {
        exists: !!metaDescValue,
        value: metaDescValue,
        length: metaDescLength,
        isMultiple: metaDescs.length > 1,
      },
      metaViewport,
      openGraph: { title: ogTitle, description: ogDesc, image: ogImage },
      twitterCard,
      metaRobots: { noindex, nofollow, nosnippet },
      canonical: {
        exists: !!canonicalValue,
        value: canonicalValue,
        isAbsolute: canonicalIsAbsolute,
        isMultiple: canonicalIsMultiple,
        matchesUrl: canonicalValue === page.url,
      },
      hreflang: hreflangTags,
      htmlLang,
      headings,
      h1Count,
      h1Value,
      headingHierarchyValid: hierarchyValid,
      wordCount,
      contentToHtmlRatio,
      hasLoremIpsum,
      images: {
        total: totalImages,
        missingAlt,
        missingAltAttribute: missingAltAttr,
        altOver100Chars: altOver100,
        missingDimensions: missingDims,
        modernFormats,
        lazyLoaded,
        items: imageItems.slice(0, 50),
      },
      urlAnalysis,
    },
  };
}

export function analyseOnPageMulti(pages: CrawledPage[], crawl?: CrawlResult): OnPageResult {
  if (pages.length === 0) {
    return analyseOnPage({
      url: "",
      statusCode: 0,
      headers: {},
      html: "",
      redirectChain: [],
      responseTimeMs: 0,
      contentType: "",
      contentLength: 0,
    });
  }

  const allFindings: AuditFinding[] = [];
  const perPage: OnPageResult[] = [];

  for (const page of pages) {
    if (!page.html || page.statusCode >= 400) continue;
    const result = analyseOnPage(page);
    perPage.push(result);
    for (const f of result.findings) {
      allFindings.push({
        ...f,
        id: `${f.id}@${page.url}`,
        affectedUrls: [page.url],
      });
    }
  }

  const titleMap = new Map<string, string[]>();
  const h1Map = new Map<string, string[]>();
  const descMap = new Map<string, string[]>();

  for (let i = 0; i < perPage.length; i++) {
    const d = perPage[i].data;
    const url = pages.filter((p) => p.html && p.statusCode < 400)[i]?.url ?? "";
    if (d.title.value) {
      const key = d.title.value.toLowerCase();
      titleMap.set(key, [...(titleMap.get(key) ?? []), url]);
    }
    if (d.h1Value) {
      const key = d.h1Value.toLowerCase();
      h1Map.set(key, [...(h1Map.get(key) ?? []), url]);
    }
    if (d.metaDescription.value) {
      const key = d.metaDescription.value.toLowerCase();
      descMap.set(key, [...(descMap.get(key) ?? []), url]);
    }
  }

  for (const [title, urls] of titleMap) {
    if (urls.length > 1) {
      allFindings.push({
        id: `op-duplicate-title-${title.slice(0, 30)}`,
        category: "page_titles",
        severity: "issue",
        priority: "high",
        title: `Duplicate title across ${urls.length} pages`,
        description: `The title "${title.slice(0, 60)}..." is used on multiple pages.`,
        howToFix: "Give each page a unique, descriptive title.",
        affectedUrls: urls,
      });
    }
  }

  for (const [h1, urls] of h1Map) {
    if (urls.length > 1) {
      allFindings.push({
        id: `op-duplicate-h1-${h1.slice(0, 30)}`,
        category: "headings",
        severity: "warning",
        priority: "medium",
        title: `Duplicate H1 across ${urls.length} pages`,
        description: `The H1 "${h1.slice(0, 60)}..." is used on multiple pages.`,
        howToFix: "Each page should have a unique H1 heading.",
        affectedUrls: urls,
      });
    }
  }

  for (const [desc, urls] of descMap) {
    if (urls.length > 1) {
      allFindings.push({
        id: `op-duplicate-desc-${desc.slice(0, 30)}`,
        category: "meta_tags",
        severity: "warning",
        priority: "medium",
        title: `Duplicate meta description across ${urls.length} pages`,
        description: "The same meta description is used on multiple pages.",
        howToFix: "Write a unique meta description for each page.",
        affectedUrls: urls,
      });
    }
  }

  if (crawl?.brokenImages && crawl.brokenImages.length > 0) {
    const affectedUrls = [...new Set(crawl.brokenImages.map((b) => b.sourcePage))];
    allFindings.push({
      id: "op-broken-images",
      category: "images",
      severity: "issue",
      priority: "high",
      title: `${crawl.brokenImages.length} broken internal image(s)`,
      description: "Images return 4XX/5XX status. Broken images hurt UX and SEO.",
      howToFix: "Fix or remove broken image URLs. Ensure images are hosted correctly.",
      affectedUrls: affectedUrls.slice(0, 10),
    });
  }

  const avgScore =
    perPage.length > 0
      ? Math.round(perPage.reduce((sum, r) => sum + r.score, 0) / perPage.length)
      : 0;

  const homepageResult = perPage[0] ?? analyseOnPage(pages[0]);

  return {
    score: avgScore,
    findings: allFindings,
    data: homepageResult.data,
  };
}
