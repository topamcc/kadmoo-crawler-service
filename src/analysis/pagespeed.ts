/**
 * PageSpeed Insights integration — Core Web Vitals, Lighthouse scores
 * for both mobile and desktop. Uses the free PSI API v5.
 */

import { logApiUsage } from "./utils/api-logger.js";
import type { PageSpeedResult, CoreWebVitals, LighthouseScores, AuditFinding } from "./types.js";
import { withRetry, isTransientError } from "./utils/retry.js";

const PSI_API_KEY = process.env.GOOGLE_PSI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || "";
const PSI_BASE = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

interface CruxMetric {
  percentile?: number;
  category?: string;
}

interface PsiResponse {
  lighthouseResult?: {
    categories?: Record<string, { score: number }>;
    audits?: Record<string, { numericValue?: number; details?: any }>;
  };
  loadingExperience?: {
    metrics?: {
      LARGEST_CONTENTFUL_PAINT_MS?: CruxMetric;
      CUMULATIVE_LAYOUT_SHIFT_SCORE?: CruxMetric;
      FIRST_CONTENTFUL_PAINT_MS?: CruxMetric;
      INTERACTION_TO_NEXT_PAINT?: CruxMetric;
    };
  };
  originLoadingExperience?: {
    metrics?: {
      LARGEST_CONTENTFUL_PAINT_MS?: CruxMetric;
      CUMULATIVE_LAYOUT_SHIFT_SCORE?: CruxMetric;
      FIRST_CONTENTFUL_PAINT_MS?: CruxMetric;
      INTERACTION_TO_NEXT_PAINT?: CruxMetric;
    };
  };
  error?: { message: string };
}

async function fetchPsi(url: string, strategy: "mobile" | "desktop"): Promise<PsiResponse | null> {
  const apiUrl = `${PSI_BASE}?url=${encodeURIComponent(url)}&strategy=${strategy}&category=performance&category=accessibility&category=seo&category=best-practices${PSI_API_KEY ? `&key=${PSI_API_KEY}` : ""}`;

  try {
    const res = await withRetry(
      async () => {
        const r = await fetch(apiUrl, {
          headers: { "Accept": "application/json" },
        });
        if (!r.ok && r.status >= 500) throw new Error(`PSI returned ${r.status}`);
        return r;
      },
      { maxRetries: 2, baseDelay: 3000, retryOn: isTransientError },
    );

    const data = (await res.json()) as PsiResponse;
    logApiUsage({
      provider: "google_psi",
      serviceType: "pagespeed",
      costUsd: 0,
      metadata: { strategy },
    }).catch(() => {});
    return data;
  } catch (e) {
    console.error(`[pagespeed] Failed to fetch PSI for ${strategy}:`, e);
    return null;
  }
}

function extractCwv(data: PsiResponse): CoreWebVitals {
  const audits = data.lighthouseResult?.audits ?? {};
  return {
    lcp: audits["largest-contentful-paint"]?.numericValue ?? 0,
    cls: audits["cumulative-layout-shift"]?.numericValue ?? 0,
    tbt: audits["total-blocking-time"]?.numericValue ?? 0,
    fcp: audits["first-contentful-paint"]?.numericValue ?? 0,
    si: audits["speed-index"]?.numericValue ?? 0,
    tti: audits["interactive"]?.numericValue ?? 0,
  };
}

function extractFieldCwv(data: PsiResponse): CoreWebVitals | null {
  const le = data.loadingExperience ?? data.originLoadingExperience;
  const m = le?.metrics;
  if (!m) return null;
  const lcp = m.LARGEST_CONTENTFUL_PAINT_MS?.percentile;
  const cls = m.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile;
  const fcp = m.FIRST_CONTENTFUL_PAINT_MS?.percentile;
  const inp = m.INTERACTION_TO_NEXT_PAINT?.percentile;
  if (lcp == null && cls == null && fcp == null) return null;
  return {
    lcp: lcp ?? 0,
    cls: cls ?? 0,
    tbt: inp ?? 0,
    fcp: fcp ?? 0,
    si: 0,
    tti: 0,
  };
}

function extractScores(data: PsiResponse): LighthouseScores {
  const cats = data.lighthouseResult?.categories ?? {};
  return {
    performance: Math.round((cats["performance"]?.score ?? 0) * 100),
    accessibility: Math.round((cats["accessibility"]?.score ?? 0) * 100),
    bestPractices: Math.round((cats["best-practices"]?.score ?? 0) * 100),
    seo: Math.round((cats["seo"]?.score ?? 0) * 100),
  };
}

function extractPerformanceDetails(data: PsiResponse) {
  const audits = data.lighthouseResult?.audits ?? {};
  return {
    renderBlockingResources: audits["render-blocking-resources"]?.details?.items?.length ?? 0,
    unusedCssBytes: audits["unused-css-rules"]?.numericValue ?? 0,
    unusedJsBytes: audits["unused-javascript"]?.numericValue ?? 0,
    domSize: audits["dom-size"]?.numericValue ?? 0,
    cacheIssues: audits["uses-long-cache-ttl"]?.details?.items?.length ?? 0,
    imageOptimization: audits["uses-optimized-images"]?.details?.items?.length ?? 0,
  };
}

export async function analysePageSpeed(url: string): Promise<PageSpeedResult> {
  const findings: AuditFinding[] = [];

  const [mobileData, desktopData] = await Promise.all([
    fetchPsi(url, "mobile"),
    fetchPsi(url, "desktop"),
  ]);

  let mobileResult: PageSpeedResult["data"]["mobile"] = null;
  let desktopResult: PageSpeedResult["data"]["desktop"] = null;
  let details = {
    renderBlockingResources: 0,
    unusedCssBytes: 0,
    unusedJsBytes: 0,
    domSize: 0,
    cacheIssues: 0,
    imageOptimization: 0,
  };

  if (mobileData?.lighthouseResult) {
    const fieldCwv = extractFieldCwv(mobileData);
    mobileResult = {
      cwv: extractCwv(mobileData),
      fieldCwv: fieldCwv ?? undefined,
      dataSource: fieldCwv ? "field" : "lab",
      scores: extractScores(mobileData),
    };
    details = extractPerformanceDetails(mobileData);
  }

  if (desktopData?.lighthouseResult) {
    const fieldCwv = extractFieldCwv(desktopData);
    desktopResult = {
      cwv: extractCwv(desktopData),
      fieldCwv: fieldCwv ?? undefined,
      dataSource: fieldCwv ? "field" : "lab",
      scores: extractScores(desktopData),
    };
  }

  const cwv = mobileResult?.fieldCwv ?? mobileResult?.cwv;
  const scores = mobileResult?.scores;

  if (!mobileData?.lighthouseResult) {
    findings.push({
      id: "perf-psi-failed",
      category: "performance",
      severity: "warning",
      priority: "medium",
      title: "PageSpeed Insights data unavailable",
      description: "Could not retrieve performance data from Google PageSpeed Insights.",
      howToFix: "Ensure the URL is publicly accessible and try again.",
    });
  }

  if (cwv) {
    if (cwv.lcp > 4000) {
      findings.push({
        id: "perf-lcp-poor",
        category: "performance",
        severity: "issue",
        priority: "critical",
        title: `Poor LCP: ${(cwv.lcp / 1000).toFixed(1)}s`,
        description: "Largest Contentful Paint exceeds 4s (poor). Target: under 2.5s.",
        howToFix: "Optimise images, reduce server response time, eliminate render-blocking resources.",
      });
    } else if (cwv.lcp > 2500) {
      findings.push({
        id: "perf-lcp-needs-improvement",
        category: "performance",
        severity: "warning",
        priority: "high",
        title: `LCP needs improvement: ${(cwv.lcp / 1000).toFixed(1)}s`,
        description: "LCP is between 2.5-4s. Target: under 2.5s.",
        howToFix: "Optimise the largest above-the-fold element (often a hero image).",
      });
    }

    if (cwv.cls > 0.25) {
      findings.push({
        id: "perf-cls-poor",
        category: "performance",
        severity: "issue",
        priority: "high",
        title: `Poor CLS: ${cwv.cls.toFixed(3)}`,
        description: "Cumulative Layout Shift exceeds 0.25 (poor). Target: under 0.1.",
        howToFix: "Add explicit dimensions to images/videos, avoid inserting content above existing content.",
      });
    } else if (cwv.cls > 0.1) {
      findings.push({
        id: "perf-cls-needs-improvement",
        category: "performance",
        severity: "warning",
        priority: "medium",
        title: `CLS needs improvement: ${cwv.cls.toFixed(3)}`,
        description: "CLS is between 0.1-0.25. Target: under 0.1.",
        howToFix: "Set explicit width/height on images and embeds.",
      });
    }

    if (cwv.tbt > 600) {
      findings.push({
        id: "perf-tbt-poor",
        category: "performance",
        severity: "issue",
        priority: "high",
        title: `Poor TBT: ${Math.round(cwv.tbt)}ms`,
        description: "Total Blocking Time exceeds 600ms (proxy for INP). Target: under 200ms.",
        howToFix: "Reduce JavaScript execution time, split long tasks, defer non-critical JS.",
      });
    } else if (cwv.tbt > 200) {
      findings.push({
        id: "perf-tbt-needs-improvement",
        category: "performance",
        severity: "warning",
        priority: "medium",
        title: `TBT needs improvement: ${Math.round(cwv.tbt)}ms`,
        description: "TBT is between 200-600ms. Target: under 200ms.",
        howToFix: "Optimise JavaScript execution and reduce third-party scripts.",
      });
    }
  }

  if (scores && scores.performance < 50) {
    findings.push({
      id: "perf-score-poor",
      category: "performance",
      severity: "issue",
      priority: "critical",
      title: `Poor mobile performance score: ${scores.performance}/100`,
      description: "The Lighthouse performance score is below 50 (poor).",
      howToFix: "Address the specific performance opportunities listed above.",
    });
  }

  if (details.renderBlockingResources > 3) {
    findings.push({
      id: "perf-render-blocking",
      category: "performance",
      severity: "warning",
      priority: "medium",
      title: `${details.renderBlockingResources} render-blocking resources`,
      description: "Multiple resources block the initial page render.",
      howToFix: "Defer or async non-critical CSS/JS, inline critical CSS.",
    });
  }

  if (details.domSize > 1500) {
    findings.push({
      id: "perf-large-dom",
      category: "performance",
      severity: "opportunity",
      priority: "medium",
      title: `Large DOM size: ${details.domSize} elements`,
      description: "Excessive DOM nodes slow down rendering and scripting.",
      howToFix: "Simplify the page structure, use virtualized lists for large datasets.",
    });
  }

  const performanceScore = scores?.performance ?? 50;
  const score = Math.max(0, Math.min(100, performanceScore));

  return {
    score,
    findings,
    data: {
      mobile: mobileResult,
      desktop: desktopResult,
      ...details,
    },
  };
}
