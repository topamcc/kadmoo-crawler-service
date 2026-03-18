/**
 * Runs the full audit analysis pipeline in the crawler service.
 * No page cap, no analytics enrichment (GA/SC), no DataForSEO.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { analyseTechnicalSeo } from "./technical-seo.js";
import { analyseOnPageMulti } from "./on-page.js";
import { analyseSchemaMulti } from "./schema-analyzer.js";
import { analyseLinksMulti } from "./link-analyzer.js";
import { analysePageSpeed } from "./pagespeed.js";
import { analyseGeo } from "./geo-analyzer.js";
import { analyseSiteArchitecture } from "./site-architecture.js";
import { analyseKeywords } from "./keyword-analyzer.js";
import { buildReport, mergeDuplicateContentIntoReport } from "./scorer.js";
import { detectDuplicateContent } from "./internal-duplicate-detector.js";
import { convertExternalResultsToCrawlResult } from "./result-converter.js";
import type { CrawlJobResultsResponse } from "../shared/types.js";

export interface RunAnalysisParams {
  auditId: string;
  url: string;
  siteId: string;
  results: CrawlJobResultsResponse;
  supabase: SupabaseClient;
  pagesQueued?: number;
}

export async function runAnalysis(
  params: RunAnalysisParams,
): Promise<{ success: boolean; error?: string }> {
  const { auditId, url, siteId, results, supabase, pagesQueued } = params;
  const trimmedUrl = url.trim();

  try {
    const rawPageCount = results.pages.length;

    // Extract lightweight data needed for duplicate detection before freeing raw pages
    const pagesForDup = rawPageCount >= 50
      ? results.pages.map((p) => ({
          url: p.finalUrl || p.url,
          title: p.title ?? "",
          metaDescription: p.metaDescription ?? "",
          mainContent: (p.mainContent ?? "").slice(0, 5000),
          crawlDepth: p.crawlDepth,
        }))
      : [];

    const crawl = convertExternalResultsToCrawlResult(results, trimmedUrl, pagesQueued);

    const totalCrawled = results.summary?.totalPages ?? rawPageCount;

    // Free raw crawl data to reduce memory pressure on large sites
    results.pages.length = 0;
    (results as { pages: unknown[] }).pages = [];

    await supabase
      .from("site_audits")
      .update({
        status: "analyzing",
        pages_crawled: totalCrawled,
        progress: {
          percent: 40,
          phase: "analyzing",
          current_step: "Running SEO analysis on crawled data...",
        },
      })
      .eq("id", auditId);

    const allPages = [crawl.homepage, ...crawl.subPages];

    const technicalSeo = analyseTechnicalSeo(crawl);
    const onPage = analyseOnPageMulti(allPages, crawl);
    const links = analyseLinksMulti(allPages, crawl.brokenLinks);
    const schema = analyseSchemaMulti(allPages);
    const architecture = analyseSiteArchitecture(crawl);

    const [pageSpeed, geo, keywords] = await Promise.all([
      analysePageSpeed(trimmedUrl),
      analyseGeo(crawl, onPage, schema),
      analyseKeywords(crawl),
    ]);

    const dataSources: ("link" | "ga" | "sc")[] = ["link"];

    for (const page of allPages) {
      (page as { html?: string }).html = "";
    }

    await supabase
      .from("site_audits")
      .update({
        status: "scoring",
        progress: {
          percent: 80,
          phase: "scoring",
          current_step: "Building report...",
        },
      })
      .eq("id", auditId);

    const crawledUrls = allPages.map((p) => p.url);
    let report = buildReport(
      trimmedUrl,
      allPages.length,
      technicalSeo,
      onPage,
      links,
      schema,
      pageSpeed,
      geo,
      architecture,
      keywords,
      undefined,
      crawledUrls,
      crawl.crawlMeta,
      dataSources,
      null,
      null,
      { images: crawl.imagesInventory ?? [], pdfs: crawl.pdfLinks ?? [] },
      { usedFallback: false, finalDepth: rawPageCount },
    );

    if (pagesForDup.length >= 50) {
      const duplicateContent = detectDuplicateContent(pagesForDup);
      report = mergeDuplicateContentIntoReport(report, duplicateContent);
    }
    pagesForDup.length = 0;

    const updatePayload: Record<string, unknown> = {
      status: "completed",
      data_sources: dataSources,
      overall_score: report.overallScore,
      technical_score: report.sections.technicalSeo.score,
      on_page_score: report.sections.onPage.score,
      performance_score: report.sections.performance.score,
      geo_score: report.sections.geo.score,
      schema_score: report.sections.schema.score,
      links_score: report.sections.links.score,
      architecture_score: report.sections.architecture.score,
      keywords_score: report.sections.keywords.score,
      report,
      issues_found: report.summary.issuesCount,
      warnings_found: report.summary.warningsCount,
      opportunities_found: report.summary.opportunitiesCount,
      completed_at: new Date().toISOString(),
      progress: { percent: 100, phase: "completed", current_step: "Done" },
    };

    if (report.sections.duplicateContent) {
      updatePayload.duplicate_content_score = report.sections.duplicateContent.score;
    }

    await supabase
      .from("site_audits")
      .update(updatePayload)
      .eq("id", auditId);

    return { success: true };
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "External analysis failed";
    console.error("[runAnalysis] Failed:", error);

    await supabase
      .from("site_audits")
      .update({
        status: "failed",
        error_message: message,
        progress: { percent: 0, phase: "failed", current_step: message },
      })
      .eq("id", auditId);

    return { success: false, error: message };
  }
}
