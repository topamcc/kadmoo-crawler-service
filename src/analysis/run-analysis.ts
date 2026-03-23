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
import { logger } from "../logger/index.js";

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

  const { data: existingAudit } = await supabase
    .from("site_audits")
    .select("status")
    .eq("id", auditId)
    .single();

  if (existingAudit?.status === "completed") {
    logger.info({ auditId }, "Audit already completed, skipping re-analysis");
    return { success: true };
  }

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
    logger.info({ auditId, rawPageCount }, "Converted crawl results, running analysis...");

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
    logger.info({ auditId, allPages: allPages.length }, "Running analysis steps...");

    const technicalSeo = analyseTechnicalSeo(crawl);
    logger.info({ auditId }, "step 1/5 technicalSeo done");

    const onPage = analyseOnPageMulti(allPages, crawl);
    logger.info({ auditId }, "step 2/5 onPage done");

    const links = analyseLinksMulti(allPages, crawl.brokenLinks);
    logger.info({ auditId }, "step 3/5 links done");

    const schema = analyseSchemaMulti(allPages);
    logger.info({ auditId }, "step 4/5 schema done");

    const architecture = analyseSiteArchitecture(crawl);
    logger.info({ auditId }, "step 5/5 architecture done");

    const [pageSpeed, geo, keywords] = await Promise.all([
      analysePageSpeed(trimmedUrl),
      analyseGeo(crawl, onPage, schema),
      analyseKeywords(crawl),
    ]);

    // Free HTML from all pages now that all analysis is done
    for (const page of allPages) {
      (page as { html?: string }).html = "";
    }

    const dataSources: ("link" | "ga" | "sc")[] = ["link"];

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

    // Truncate large arrays to avoid "Invalid string length" when serializing for Supabase
    const MAX_CRAWLED_URLS = 3000;
    const MAX_AFFECTED_URLS = 100;
    const trimmedReport = { ...report };
    if (trimmedReport.crawledUrls && trimmedReport.crawledUrls.length > MAX_CRAWLED_URLS) {
      trimmedReport.crawledUrls = trimmedReport.crawledUrls.slice(0, MAX_CRAWLED_URLS);
    }
    const MAX_FINDINGS_PER_SECTION = 200;
    for (const section of Object.values(trimmedReport.sections) as { findings?: Array<{ affectedUrls?: string[] }> }[]) {
      if (section?.findings) {
        if (section.findings.length > MAX_FINDINGS_PER_SECTION) {
          section.findings = section.findings.slice(0, MAX_FINDINGS_PER_SECTION);
        }
        for (const f of section.findings) {
          if (f.affectedUrls && f.affectedUrls.length > MAX_AFFECTED_URLS) {
            f.affectedUrls = f.affectedUrls.slice(0, MAX_AFFECTED_URLS);
          }
        }
      }
    }
    if (trimmedReport.sections.links?.data?.links?.length > 500) {
      trimmedReport.sections.links.data.links = trimmedReport.sections.links.data.links.slice(0, 500);
    }
    if (trimmedReport.sections.links?.data?.brokenLinks?.length > 200) {
      trimmedReport.sections.links.data.brokenLinks = trimmedReport.sections.links.data.brokenLinks.slice(0, 200);
    }
    // Truncate architecture.crawlDepth and domainAssets to avoid "Invalid string length"
    const archData = trimmedReport.sections?.architecture?.data;
    if (archData?.crawlDepth && archData.crawlDepth.length > 500) {
      archData.crawlDepth = archData.crawlDepth.slice(0, 500);
    }
    const MAX_DOMAIN_ASSET_IMAGES = 15_000;
    const MAX_DOMAIN_ASSET_PDFS = 15_000;
    const da = trimmedReport.sections?.domainAssets?.data;
    if (da?.images && da.images.length > MAX_DOMAIN_ASSET_IMAGES) {
      da.images = da.images.slice(0, MAX_DOMAIN_ASSET_IMAGES);
    }
    if (da?.pdfs && da.pdfs.length > MAX_DOMAIN_ASSET_PDFS) {
      da.pdfs = da.pdfs.slice(0, MAX_DOMAIN_ASSET_PDFS);
    }

    // Aggressively strip section data to keep JSON under V8 string limit
    for (const [, section] of Object.entries(trimmedReport.sections) as [string, { data?: Record<string, unknown>; findings?: unknown[] }][]) {
      if (!section) continue;
      // Strip any huge data arrays we haven't already handled
      if (section.data && typeof section.data === "object") {
        for (const [dk, dv] of Object.entries(section.data)) {
          if (dk === "images" || dk === "pdfs") continue;
          if (Array.isArray(dv) && dv.length > 500) {
            (section.data as Record<string, unknown>)[dk] = dv.slice(0, 500);
          }
        }
      }
    }

    logger.info({ auditId }, "Report built, truncating and updating Supabase...");

    // Validate the report can be serialized before sending to Supabase
    let reportJson: string;
    try {
      reportJson = JSON.stringify(trimmedReport);
    } catch {
      logger.warn({ auditId }, "Report too large for JSON.stringify, stripping findings and data");
      // Emergency strip: remove all findings and large data from sections
      for (const section of Object.values(trimmedReport.sections) as { findings?: unknown[]; data?: Record<string, unknown> }[]) {
        if (!section) continue;
        if (section.findings) section.findings = section.findings.slice(0, 20);
        if (section.data && typeof section.data === "object") {
          for (const [dk, dv] of Object.entries(section.data)) {
            if (!Array.isArray(dv)) continue;
            if (dk === "images" || dk === "pdfs") {
              if (dv.length > 8000) {
                (section.data as Record<string, unknown>)[dk] = dv.slice(0, 8000);
              }
              continue;
            }
            if (dv.length > 50) {
              (section.data as Record<string, unknown>)[dk] = dv.slice(0, 50);
            }
          }
        }
      }
      if (trimmedReport.crawledUrls) trimmedReport.crawledUrls = trimmedReport.crawledUrls.slice(0, 500);
      try {
        reportJson = JSON.stringify(trimmedReport);
      } catch {
        logger.error({ auditId }, "Report still too large after emergency strip");
        reportJson = "{}";
      }
    }
    logger.info({ auditId, reportSizeKB: Math.round(reportJson.length / 1024) }, "Report JSON size");

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
      report: JSON.parse(reportJson),
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

    logger.info({ auditId }, "Supabase update done");
    return { success: true };
  } catch (error: unknown) {
    const message =
      (error instanceof Error ? error.message : "External analysis failed").slice(0, 500);
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
