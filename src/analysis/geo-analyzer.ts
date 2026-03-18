/**
 * GEO (Generative Engine Optimization) analyzer — BLUF, citations, E-E-A-T,
 * snippet eligibility, AI crawler access. Uses one Gemini call for AI analysis.
 */

import * as cheerio from "cheerio";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { withRetry, isTransientError } from "./utils/retry.js";
import { logApiUsage, geminiCostFromTokens } from "./utils/api-logger.js";
import type {
  CrawlResult,
  OnPageResult,
  SchemaResult,
  GeoResult,
  AuditFinding,
} from "./types.js";

const GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;

function getGenAI() {
  if (!GEMINI_API_KEY) throw new Error("Missing GOOGLE_GEMINI_API_KEY");
  return new GoogleGenerativeAI(GEMINI_API_KEY);
}

function checkAiCrawlerAccess(crawl: CrawlResult) {
  return {
    gptBot: crawl.robots.allowsGPTBot,
    perplexityBot: crawl.robots.allowsPerplexityBot,
    googleExtended: crawl.robots.allowsGoogleExtended,
  };
}

function checkSnippetEligibility(onPage: OnPageResult) {
  return {
    eligible: !onPage.data.metaRobots.noindex && !onPage.data.metaRobots.nosnippet,
    blockedByNosnippet: onPage.data.metaRobots.nosnippet,
    blockedByNoindex: onPage.data.metaRobots.noindex,
  };
}

function checkFreshnessSignals(htmlStrings: string[]) {
  let hasLastModified = false;
  let hasPublicationDate = false;
  for (const html of htmlStrings) {
    const $ = cheerio.load(html);
    if ($('meta[http-equiv="last-modified"]').length > 0 || $('meta[property="article:modified_time"]').length > 0) {
      hasLastModified = true;
    }
    if ($('meta[property="article:published_time"]').length > 0 || $("time[datetime]").length > 0 || $('[itemprop="datePublished"]').length > 0) {
      hasPublicationDate = true;
    }
    if (hasLastModified && hasPublicationDate) break;
  }
  return { hasLastModified, hasPublicationDate };
}

function checkContentDepth(crawl: CrawlResult) {
  const allPages = [crawl.homepage, ...crawl.subPages];
  const wordCounts = allPages.map((p) => {
    const $ = cheerio.load(p.html);
    return $("body").text().replace(/\s+/g, " ").trim().split(/\s+/).length;
  });
  const avg = wordCounts.length > 0
    ? Math.round(wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length)
    : 0;

  const subheadingCounts = allPages.map((p) => {
    const $ = cheerio.load(p.html);
    return $("h2, h3").length;
  });
  const avgSubheadings = subheadingCounts.length > 0
    ? Math.round(subheadingCounts.reduce((a, b) => a + b, 0) / subheadingCounts.length)
    : 0;

  return { avgWordCountPerPage: avg, subheadingFrequency: avgSubheadings };
}

function checkConversationalRelevance(onPage: OnPageResult) {
  const questionHeadings = onPage.data.headings.filter((h) =>
    /\?|how|what|why|when|where|who|which|can|do|does|is|are|should|מה|איך|למה|מתי|איפה|מי|האם/i.test(h.text)
  ).length;
  return {
    questionBasedHeadings: questionHeadings,
    totalHeadings: onPage.data.headings.length,
  };
}

const SEMANTIC_TAGS = ["article", "section", "nav", "header", "footer", "main", "aside", "figure", "figcaption"];

function checkSemanticHtmlRatio(html: string): number {
  const $ = cheerio.load(html);
  let semanticCount = 0;
  let totalCount = 0;
  $("*").each((_, el) => {
    const tag = (el as any).tagName?.toLowerCase();
    if (!tag || tag === "html" || tag === "head" || tag === "body") return;
    totalCount++;
    if (SEMANTIC_TAGS.includes(tag)) semanticCount++;
  });
  return totalCount > 0 ? Math.round((semanticCount / totalCount) * 100) : 0;
}

async function checkLlmsTxt(origin: string): Promise<{ exists: boolean; url: string; hasFormattingIssues?: boolean }> {
  const url = `${origin}/llms.txt`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "KadmooAuditBot/1.0" },
    });
    if (res.status !== 200) {
      return { exists: false, url };
    }
    const text = await res.text();
    const lines = text.split("\n").filter((l) => l.trim());
    const hasFormattingIssues = lines.some((l) => {
      const trimmed = l.trim();
      if (!trimmed || trimmed.startsWith("#")) return false;
      return !trimmed.includes(":") && !trimmed.startsWith("-");
    });
    return { exists: true, url, hasFormattingIssues: hasFormattingIssues && lines.length > 1 };
  } catch {
    return { exists: false, url };
  }
}

async function runGeminiGeoAnalysis(
  textContent: string,
  headings: string[],
  schemaTypes: string[],
): Promise<{
  blufScore: number;
  hasDirectAnswer: boolean;
  summaryExcerpt: string;
  citationScore: number;
  hasStatistics: boolean;
  hasExpertQuotes: boolean;
  quantitativeDataCount: number;
  interpretabilityScore: number;
  clearHierarchy: boolean;
  shortParagraphs: boolean;
  usesLists: boolean;
  hasFaq: boolean;
  hasComparison: boolean;
  hasAuthorBio: boolean;
  hasAboutPage: boolean;
  hasCredentials: boolean;
  hasMethodology: boolean;
  aiAnalysis: string;
} | null> {
  if (!GEMINI_API_KEY) return null;

  const genAI = getGenAI();
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  const prompt = `You are an expert GEO (Generative Engine Optimization) auditor for 2026.
Analyze the following website content and return ONLY valid JSON (no markdown fences).

Content (first 2000 words):
${textContent.slice(0, 8000)}

Headings found: ${headings.slice(0, 30).join(" | ")}
Schema types found: ${schemaTypes.join(", ") || "none"}

Return this exact JSON structure:
{
  "blufScore": <0-100, does the page lead with a direct answer in the first 200 words?>,
  "hasDirectAnswer": <boolean>,
  "summaryExcerpt": "<the first 2 sentences that could serve as a BLUF answer>",
  "citationScore": <0-100, how citation-ready is the content for AI engines?>,
  "hasStatistics": <boolean, are there specific numbers/statistics with sources?>,
  "hasExpertQuotes": <boolean, are there named expert quotes or credentials?>,
  "quantitativeDataCount": <number of specific data points/statistics found>,
  "interpretabilityScore": <0-100, how well structured for AI parsing?>,
  "clearHierarchy": <boolean, is the heading hierarchy logical and complete?>,
  "shortParagraphs": <boolean, are paragraphs under 200 words with subheadings?>,
  "usesLists": <boolean, are bullet/numbered lists used for key information?>,
  "hasFaq": <boolean, is there an FAQ section?>,
  "hasComparison": <boolean, are there comparison tables or pros/cons?>,
  "hasAuthorBio": <boolean, is there an author bio or byline?>,
  "hasAboutPage": <boolean, is there a link to an about page?>,
  "hasCredentials": <boolean, are professional credentials mentioned?>,
  "hasMethodology": <boolean, is methodology or process described?>,
  "aiAnalysis": "<2-3 sentence summary of GEO readiness and top recommendations>"
}`;

  try {
    const result = await withRetry(
      () => model.generateContent(prompt),
      { maxRetries: 2, baseDelay: 2000, retryOn: isTransientError },
    );
    const usage = result.response.usageMetadata;
    const inputTokens = usage?.promptTokenCount ?? 0;
    const outputTokens = usage?.candidatesTokenCount ?? 0;
    logApiUsage({
      provider: "gemini",
      serviceType: "audit_geo",
      costUsd: geminiCostFromTokens(inputTokens, outputTokens),
      inputTokens,
      outputTokens,
    }).catch(() => {});
    const text = result.response.text();
    const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.error("[geo-analyzer] Gemini analysis failed:", e);
    return null;
  }
}

export async function analyseGeo(
  crawl: CrawlResult,
  onPage: OnPageResult,
  schema: SchemaResult,
): Promise<GeoResult> {
  const findings: AuditFinding[] = [];

  const aiCrawlerAccess = checkAiCrawlerAccess(crawl);
  const snippetEligibility = checkSnippetEligibility(onPage);
  const allHtml = [crawl.homepage.html, ...crawl.subPages.map((p) => p.html).filter(Boolean)];
  const freshness = checkFreshnessSignals(allHtml);
  const contentDepth = checkContentDepth(crawl);
  const conversational = checkConversationalRelevance(onPage);

  const origin = (() => { try { return new URL(crawl.homepage.url).origin; } catch { return ""; } })();
  const llmsTxt = origin ? await checkLlmsTxt(origin) : { exists: false, url: "" };

  const semanticRatios = [crawl.homepage.html, ...crawl.subPages.map((p) => p.html).filter(Boolean)]
    .map((h) => checkSemanticHtmlRatio(h));
  const avgSemanticRatio = semanticRatios.length > 0
    ? Math.round(semanticRatios.reduce((a, b) => a + b, 0) / semanticRatios.length)
    : 0;

  const allWordCounts = [crawl.homepage, ...crawl.subPages].map((p) => {
    const $ = cheerio.load(p.html);
    return $("body").text().replace(/\s+/g, " ").trim().split(/\s+/).filter(Boolean).length;
  });
  const maxWordCount = allWordCounts.length > 0 ? Math.max(...allWordCounts) : 0;

  const $ = cheerio.load(crawl.homepage.html);
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const headingTexts = onPage.data.headings.map((h) => h.text);

  const ai = await runGeminiGeoAnalysis(bodyText, headingTexts, schema.data.typesFound);

  const blufReadiness = {
    score: ai?.blufScore ?? 30,
    hasDirectAnswer: ai?.hasDirectAnswer ?? false,
    summaryExcerpt: ai?.summaryExcerpt ?? "",
  };

  const citationReadiness = {
    score: ai?.citationScore ?? 20,
    hasStatistics: ai?.hasStatistics ?? false,
    hasExpertQuotes: ai?.hasExpertQuotes ?? false,
    quantitativeDataCount: ai?.quantitativeDataCount ?? 0,
  };

  const contentInterpretability = {
    score: ai?.interpretabilityScore ?? 40,
    clearHierarchy: ai?.clearHierarchy ?? false,
    shortParagraphs: ai?.shortParagraphs ?? false,
    usesLists: ai?.usesLists ?? false,
  };

  const eeatSignals = {
    hasAuthorBio: ai?.hasAuthorBio ?? false,
    hasAboutPage: ai?.hasAboutPage ?? false,
    hasCredentials: ai?.hasCredentials ?? false,
    hasMethodology: ai?.hasMethodology ?? false,
  };

  const entityPresence = {
    hasOrgSchema: schema.data.hasOrganization || schema.data.hasLocalBusiness || schema.data.hasMedicalOrganization,
    hasConsistentNap: schema.data.hasLocalBusiness,
  };

  if (!blufReadiness.hasDirectAnswer) {
    findings.push({
      id: "geo-no-bluf",
      category: "geo",
      severity: "warning",
      priority: "high",
      title: "No BLUF (Bottom Line Up Front) answer",
      description: "The page does not lead with a direct answer in the first 200 words. AI engines prefer concise answers upfront.",
      howToFix: "Add a 2-3 sentence summary answering the main query at the very top of the content.",
    });
  }

  if (!citationReadiness.hasStatistics) {
    findings.push({
      id: "geo-no-stats",
      category: "geo",
      severity: "opportunity",
      priority: "high",
      title: "No statistics or quantitative data found",
      description: "Content with specific statistics and sourced data is 40% more likely to be cited by AI engines.",
      howToFix: "Add specific numbers, percentages, and statistics with source citations.",
    });
  }

  if (!citationReadiness.hasExpertQuotes) {
    findings.push({
      id: "geo-no-expert-quotes",
      category: "geo",
      severity: "opportunity",
      priority: "medium",
      title: "No expert quotes or credentials",
      description: "Expert quotes with credentials increase AI citation likelihood significantly.",
      howToFix: "Include named expert quotes with their credentials and affiliations.",
    });
  }

  if (!contentInterpretability.usesLists) {
    findings.push({
      id: "geo-no-lists",
      category: "geo",
      severity: "opportunity",
      priority: "medium",
      title: "No structured lists found",
      description: "Bullet and numbered lists make content easier for AI to parse and cite.",
      howToFix: "Structure key information using bullet points or numbered lists.",
    });
  }

  if (!entityPresence.hasOrgSchema) {
    findings.push({
      id: "geo-no-entity",
      category: "geo",
      severity: "warning",
      priority: "high",
      title: "No entity schema (Organization / LocalBusiness)",
      description: "Without entity schema, AI engines have difficulty identifying and trusting the source.",
      howToFix: "Add Organization or LocalBusiness JSON-LD with complete information.",
    });
  }

  if (!snippetEligibility.eligible) {
    findings.push({
      id: "geo-snippet-blocked",
      category: "geo",
      severity: "issue",
      priority: "critical",
      title: "Page is not snippet-eligible",
      description: `Blocked by ${snippetEligibility.blockedByNoindex ? "noindex" : "nosnippet"}. This page cannot appear in AI Overviews.`,
      howToFix: "Remove noindex/nosnippet directives to allow snippet eligibility.",
    });
  }

  if (!aiCrawlerAccess.gptBot) {
    findings.push({
      id: "geo-gptbot-blocked",
      category: "geo",
      severity: "warning",
      priority: "medium",
      title: "GPTBot blocked in robots.txt",
      description: "ChatGPT cannot crawl this site. This limits visibility in AI-powered search.",
      howToFix: "Allow GPTBot in robots.txt if you want visibility in ChatGPT responses.",
    });
  }

  if (!aiCrawlerAccess.perplexityBot) {
    findings.push({
      id: "geo-perplexity-blocked",
      category: "geo",
      severity: "warning",
      priority: "medium",
      title: "PerplexityBot blocked in robots.txt",
      description: "Perplexity AI cannot crawl this site.",
      howToFix: "Allow PerplexityBot in robots.txt for visibility in Perplexity search.",
    });
  }

  if (!aiCrawlerAccess.googleExtended) {
    findings.push({
      id: "geo-google-extended-blocked",
      category: "geo",
      severity: "warning",
      priority: "medium",
      title: "Google-Extended blocked in robots.txt",
      description: "Google's AI training crawler cannot access this site. This may affect visibility in AI-powered features.",
      howToFix: "Allow Google-Extended in robots.txt if you want content used for AI training.",
    });
  }

  if (!freshness.hasPublicationDate) {
    findings.push({
      id: "geo-no-pub-date",
      category: "geo",
      severity: "opportunity",
      priority: "medium",
      title: "No publication date found",
      description: "Content with visible dates earns 3.2x more AI citations than undated content.",
      howToFix: "Add article:published_time meta tag and visible publication dates.",
    });
  }

  if (!(ai?.hasFaq ?? false) && !schema.data.hasFAQPage) {
    findings.push({
      id: "geo-no-faq",
      category: "geo",
      severity: "opportunity",
      priority: "medium",
      title: "No FAQ section found",
      description: "FAQ content addresses conversational queries that AI engines frequently answer.",
      howToFix: "Add an FAQ section with common questions and concise answers.",
    });
  }

  const noEeat = !eeatSignals.hasAuthorBio && !eeatSignals.hasCredentials;
  if (noEeat) {
    findings.push({
      id: "geo-no-eeat",
      category: "geo",
      severity: "warning",
      priority: "high",
      title: "Weak E-E-A-T signals",
      description: "No author bio, credentials, or methodology found. AI engines prioritise trustworthy sources.",
      howToFix: "Add author bios with credentials, link to an About page, and describe methodologies.",
    });
  }

  if (conversational.questionBasedHeadings === 0 && conversational.totalHeadings > 0) {
    findings.push({
      id: "geo-no-question-headings",
      category: "geo",
      severity: "opportunity",
      priority: "medium",
      title: "No question-based headings",
      description: "Question-format headings align with how users query AI engines.",
      howToFix: "Rephrase some H2/H3 headings as questions (e.g., 'What is...?', 'How to...?').",
    });
  }

  if (!llmsTxt.exists) {
    findings.push({
      id: "geo-no-llms-txt",
      category: "geo",
      severity: "opportunity",
      priority: "medium",
      title: "llms.txt not found",
      description: "The llms.txt file helps AI search engines understand your site. See llmstxt.org for the spec.",
      howToFix: "Create an llms.txt file at your site root with usage guidance and content summary.",
    });
  } else if (llmsTxt.hasFormattingIssues) {
    findings.push({
      id: "geo-llms-txt-format",
      category: "geo",
      severity: "warning",
      priority: "medium",
      title: "llms.txt has formatting issues",
      description: "Incorrect formatting may prevent AI engines from parsing llms.txt correctly.",
      howToFix: "Follow the llms.txt spec at llmstxt.org. Use key: value pairs.",
    });
  }

  if (avgSemanticRatio < 20 && semanticRatios.length > 0) {
    findings.push({
      id: "geo-low-semantic-html",
      category: "geo",
      severity: "opportunity",
      priority: "medium",
      title: `Low semantic HTML usage (${avgSemanticRatio}%)`,
      description: "Semantic tags (article, section, nav, header, footer) help AI understand content structure.",
      howToFix: "Use semantic HTML5 elements: article, section, nav, header, footer, main.",
    });
  }

  if (maxWordCount > 10000) {
    findings.push({
      id: "geo-content-too-long",
      category: "geo",
      severity: "opportunity",
      priority: "low",
      title: "Page content exceeds 10,000 words",
      description: "Very long pages may be truncated by AI models. Key information could be lost.",
      howToFix: "Split long content into multiple pages or add a clear summary at the top.",
    });
  }

  const geoScore = Math.round(
    blufReadiness.score * 0.2 +
    citationReadiness.score * 0.25 +
    contentInterpretability.score * 0.2 +
    (snippetEligibility.eligible ? 100 : 0) * 0.15 +
    (entityPresence.hasOrgSchema ? 100 : 0) * 0.1 +
    (Object.values(eeatSignals).filter(Boolean).length / 4) * 100 * 0.1,
  );

  return {
    score: Math.max(0, Math.min(100, geoScore)),
    findings,
    data: {
      blufReadiness,
      citationReadiness,
      contentInterpretability,
      faqPresence: ai?.hasFaq ?? false,
      comparisonContent: ai?.hasComparison ?? false,
      eeatSignals,
      entityPresence,
      freshnessSignals: freshness,
      snippetEligibility,
      aiCrawlerAccess,
      contentDepth,
      conversationalRelevance: conversational,
      aiAnalysis: ai?.aiAnalysis ?? "AI analysis unavailable.",
      llmsTxt: llmsTxt.exists ? { exists: true, url: llmsTxt.url, hasFormattingIssues: llmsTxt.hasFormattingIssues } : undefined,
      semanticHtmlRatio: avgSemanticRatio,
    },
  };
}
