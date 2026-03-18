/**
 * Keyword Research analyzer — uses a single Gemini call to generate keyword
 * recommendations, topic clusters, and competitor gap insights.
 */

import * as cheerio from "cheerio";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { withRetry, isTransientError } from "./utils/retry.js";
import { logApiUsage, geminiCostFromTokens } from "./utils/api-logger.js";
import type {
  CrawlResult,
  CrawledPage,
  KeywordAnalysisResult,
  KeywordRecommendation,
  AuditFinding,
} from "./types.js";

const GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;

function getGenAI() {
  if (!GEMINI_API_KEY) throw new Error("Missing GOOGLE_GEMINI_API_KEY");
  return new GoogleGenerativeAI(GEMINI_API_KEY);
}

function extractPageSummary(page: CrawledPage): string {
  if (!page.html) return "";
  const $ = cheerio.load(page.html);
  const title = $("title").first().text().trim();
  const h1 = $("h1").first().text().trim();
  const headings = $("h2, h3")
    .map((_, el) => $(el).text().trim())
    .get()
    .slice(0, 10)
    .join(", ");
  const metaDesc = $('meta[name="description"]').attr("content")?.trim() ?? "";
  const bodyText = $("body").text().replace(/\s+/g, " ").trim().slice(0, 500);

  return `URL: ${page.url}\nTitle: ${title}\nH1: ${h1}\nSubheadings: ${headings}\nMeta: ${metaDesc}\nContent: ${bodyText}`;
}

export async function analyseKeywords(
  crawl: CrawlResult,
): Promise<KeywordAnalysisResult> {
  const findings: AuditFinding[] = [];
  const allPages = [crawl.homepage, ...crawl.subPages].filter(
    (p) => p.html && p.statusCode < 400,
  );

  const pageSummaries = allPages
    .slice(0, 15)
    .map(extractPageSummary)
    .join("\n---\n");

  const sitemapUrlCount = crawl.sitemap.urlCount;

  let recommendations: KeywordRecommendation[] = [];
  let topicClusters: { name: string; keywords: string[] }[] = [];
  let competitorInsights = "";
  let aiAnalysis = "";

  try {
    const genAI = getGenAI();
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const prompt = `You are an expert SEO strategist. Analyze the following website pages and provide keyword recommendations.

SITE DATA (${allPages.length} pages crawled, ${sitemapUrlCount} total in sitemap):
${pageSummaries}

Respond ONLY with valid JSON in this exact structure:
{
  "recommendations": [
    {
      "keyword": "target keyword phrase",
      "difficulty": "low" | "medium" | "high",
      "intent": "informational" | "transactional" | "navigational" | "commercial",
      "reasoning": "why this keyword fits the site",
      "suggestedPage": "URL or page type where this should be targeted",
      "topicCluster": "cluster name"
    }
  ],
  "topicClusters": [
    { "name": "cluster name", "keywords": ["kw1", "kw2"] }
  ],
  "competitorInsights": "2-3 sentence analysis of competitive gaps and opportunities",
  "overallAnalysis": "2-3 sentence summary of the site's keyword coverage and strategy recommendations"
}

Requirements:
- Provide 15-20 keyword recommendations
- Group keywords into 3-6 topic clusters
- Include a mix of difficulty levels (roughly 40% low, 40% medium, 20% high)
- Include a mix of intents
- Base recommendations on the actual content and industry of the site
- For each keyword, suggest which existing page should target it (or if a new page is needed)
- Consider long-tail keywords and questions people might ask
- Identify gaps where the site has no content but should`;

    const result = await withRetry(
      () => model.generateContent(prompt),
      { maxRetries: 2, baseDelay: 1000, retryOn: isTransientError },
    );

    const usage = result.response.usageMetadata;
    const inputTokens = usage?.promptTokenCount ?? 0;
    const outputTokens = usage?.candidatesTokenCount ?? 0;
    logApiUsage({
      provider: "gemini",
      serviceType: "audit_keywords",
      costUsd: geminiCostFromTokens(inputTokens, outputTokens),
      inputTokens,
      outputTokens,
    }).catch(() => {});

    const text = result.response.text();
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);

      if (Array.isArray(parsed.recommendations)) {
        recommendations = parsed.recommendations
          .filter(
            (r: any) =>
              r.keyword &&
              ["low", "medium", "high"].includes(r.difficulty) &&
              ["informational", "transactional", "navigational", "commercial"].includes(r.intent),
          )
          .slice(0, 25)
          .map((r: any) => ({
            keyword: String(r.keyword),
            difficulty: r.difficulty as "low" | "medium" | "high",
            intent: r.intent as "informational" | "transactional" | "navigational" | "commercial",
            reasoning: String(r.reasoning ?? ""),
            suggestedPage: String(r.suggestedPage ?? ""),
            topicCluster: String(r.topicCluster ?? ""),
          }));
      }

      if (Array.isArray(parsed.topicClusters)) {
        topicClusters = parsed.topicClusters
          .filter((c: any) => c.name && Array.isArray(c.keywords))
          .slice(0, 10)
          .map((c: any) => ({
            name: String(c.name),
            keywords: c.keywords.map(String).slice(0, 10),
          }));
      }

      competitorInsights = String(parsed.competitorInsights ?? "");
      aiAnalysis = String(parsed.overallAnalysis ?? "");
    }
  } catch (err: any) {
    findings.push({
      id: "kw-ai-error",
      category: "keywords",
      severity: "warning",
      priority: "medium",
      title: "Keyword analysis AI call failed",
      description: `Could not complete AI-powered keyword research: ${err.message}`,
      howToFix: "Check GOOGLE_GEMINI_API_KEY configuration and retry.",
    });
  }

  const lowDifficulty = recommendations.filter((r) => r.difficulty === "low");
  const highDifficulty = recommendations.filter((r) => r.difficulty === "high");
  const transactional = recommendations.filter((r) => r.intent === "transactional" || r.intent === "commercial");

  if (lowDifficulty.length > 0) {
    findings.push({
      id: "kw-quick-wins",
      category: "keywords",
      severity: "opportunity",
      priority: "high",
      title: `${lowDifficulty.length} quick-win keyword opportunities`,
      description: `Found ${lowDifficulty.length} low-difficulty keywords the site could target for fast results.`,
      howToFix: "Create or optimize content for these low-difficulty keywords.",
      affectedElements: lowDifficulty.map((r) => r.keyword),
    });
  }

  if (transactional.length > 0) {
    findings.push({
      id: "kw-commercial-opportunities",
      category: "keywords",
      severity: "opportunity",
      priority: "high",
      title: `${transactional.length} commercial/transactional keyword opportunities`,
      description: "These keywords indicate purchase intent and can drive conversions.",
      howToFix: "Create landing pages optimized for these transactional keywords.",
      affectedElements: transactional.map((r) => r.keyword),
    });
  }

  if (recommendations.length === 0 && findings.length === 0) {
    findings.push({
      id: "kw-no-data",
      category: "keywords",
      severity: "warning",
      priority: "medium",
      title: "No keyword recommendations generated",
      description: "The keyword analysis could not generate recommendations.",
      howToFix: "Ensure the site has sufficient content for analysis.",
    });
  }

  if (topicClusters.length === 0 && recommendations.length > 0) {
    const clusterMap = new Map<string, string[]>();
    for (const r of recommendations) {
      const cluster = r.topicCluster || "General";
      clusterMap.set(cluster, [...(clusterMap.get(cluster) ?? []), r.keyword]);
    }
    topicClusters = Array.from(clusterMap.entries()).map(([name, keywords]) => ({ name, keywords }));
  }

  const score = recommendations.length >= 10 ? 85 : recommendations.length >= 5 ? 70 : 50;

  return {
    score,
    findings,
    data: {
      recommendations,
      topicClusters,
      competitorInsights,
      aiAnalysis,
    },
  };
}
