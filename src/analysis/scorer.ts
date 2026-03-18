/**
 * Scorer — calculates weighted overall score and generates prioritised action items.
 */

import type {
  TechnicalSeoResult,
  OnPageResult,
  LinksResult,
  SchemaResult,
  PageSpeedResult,
  GeoResult,
  SiteArchitectureResult,
  KeywordAnalysisResult,
  DuplicateContentResult,
  AuditReport,
  ActionItem,
  AuditFinding,
  FindingPriority,
  CrawlMeta,
  AuditDataSource,
  AnalyticsInsightsResult,
  SearchConsoleInsightsResult,
  DomainAssetsResult,
  ImageInventoryItem,
  PdfLinkItem,
} from "./types.js";

const CATEGORY_WEIGHTS = {
  technicalSeo: 0.13,
  onPage: 0.13,
  links: 0.11,
  schema: 0.09,
  performance: 0.14,
  geo: 0.14,
  architecture: 0.08,
  keywords: 0.09,
  duplicateContent: 0.09,
};

const PRIORITY_ORDER: FindingPriority[] = ["critical", "high", "medium", "low"];

function collectAllFindings(
  tech: TechnicalSeoResult,
  onPage: OnPageResult,
  links: LinksResult,
  schema: SchemaResult,
  perf: PageSpeedResult,
  geo: GeoResult,
  architecture: SiteArchitectureResult,
  keywords: KeywordAnalysisResult,
  duplicateContent?: DuplicateContentResult,
): AuditFinding[] {
  const base = [
    ...tech.findings,
    ...onPage.findings,
    ...links.findings,
    ...schema.findings,
    ...perf.findings,
    ...geo.findings,
    ...architecture.findings,
    ...keywords.findings,
  ];
  if (duplicateContent) {
    base.push(...duplicateContent.findings);
  }
  return base;
}

function generateActionItems(findings: AuditFinding[]): ActionItem[] {
  const issuesAndWarnings = findings.filter(
    (f) => f.severity === "issue" || f.severity === "warning" || f.priority === "high" || f.priority === "critical"
  );

  const grouped = new Map<string, AuditFinding[]>();
  for (const f of issuesAndWarnings) {
    const key = `${f.title}|${f.category}`;
    const list = grouped.get(key) ?? [];
    list.push(f);
    grouped.set(key, list);
  }

  const items: ActionItem[] = [];
  for (const group of grouped.values()) {
    const first = group[0];
    const count = group.length;
    const desc = count > 1 ? `${first.description} (${count} pages)` : first.description;
    items.push({
      priority: group.reduce(
        (best, f) =>
          PRIORITY_ORDER.indexOf(f.priority) < PRIORITY_ORDER.indexOf(best) ? f.priority : best,
        first.priority
      ),
      category: first.category,
      title: first.title,
      description: desc,
      technicalDetails: first.howToFix,
    });
  }
  items.sort((a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority));

  const oppFindings = findings.filter(
    (f) => f.severity === "opportunity" && f.priority !== "high" && f.priority !== "critical"
  );
  const oppGrouped = new Map<string, AuditFinding[]>();
  for (const f of oppFindings) {
    const key = `${f.title}|${f.category}`;
    const list = oppGrouped.get(key) ?? [];
    list.push(f);
    oppGrouped.set(key, list);
  }
  for (const group of oppGrouped.values()) {
    const first = group[0];
    const count = group.length;
    const desc = count > 1 ? `${first.description} (${count} pages)` : first.description;
    items.push({
      priority: first.priority,
      category: first.category,
      title: first.title,
      description: desc,
      technicalDetails: first.howToFix,
    });
  }

  return items;
}

function computeOverallScore(
  tech: TechnicalSeoResult,
  onPage: OnPageResult,
  links: LinksResult,
  schema: SchemaResult,
  perf: PageSpeedResult,
  geo: GeoResult,
  architecture: SiteArchitectureResult,
  keywords: KeywordAnalysisResult,
  duplicateContent?: DuplicateContentResult,
): number {
  let sum =
    tech.score * CATEGORY_WEIGHTS.technicalSeo +
    onPage.score * CATEGORY_WEIGHTS.onPage +
    links.score * CATEGORY_WEIGHTS.links +
    schema.score * CATEGORY_WEIGHTS.schema +
    perf.score * CATEGORY_WEIGHTS.performance +
    geo.score * CATEGORY_WEIGHTS.geo +
    architecture.score * CATEGORY_WEIGHTS.architecture +
    keywords.score * CATEGORY_WEIGHTS.keywords;
  if (duplicateContent) {
    sum += duplicateContent.score * CATEGORY_WEIGHTS.duplicateContent;
  } else {
    sum += 100 * CATEGORY_WEIGHTS.duplicateContent;
  }
  return Math.round(sum);
}

export function buildReport(
  url: string,
  pagesCrawled: number,
  tech: TechnicalSeoResult,
  onPage: OnPageResult,
  links: LinksResult,
  schema: SchemaResult,
  perf: PageSpeedResult,
  geo: GeoResult,
  architecture: SiteArchitectureResult,
  keywords: KeywordAnalysisResult,
  duplicateContent?: DuplicateContentResult,
  crawledUrls?: string[],
  crawlMeta?: CrawlMeta,
  dataSources?: AuditDataSource[],
  analyticsInsights?: AnalyticsInsightsResult | null,
  searchConsoleInsights?: SearchConsoleInsightsResult | null,
  domainAssets?: { images: ImageInventoryItem[]; pdfs: PdfLinkItem[] },
  crawlDepthMetadata?: { usedFallback?: boolean; finalDepth?: number },
): AuditReport {
  const overallScore = computeOverallScore(tech, onPage, links, schema, perf, geo, architecture, keywords, duplicateContent);

  const allFindings = collectAllFindings(tech, onPage, links, schema, perf, geo, architecture, keywords, duplicateContent);
  const actionItems = generateActionItems(allFindings);

  const issuesCount = allFindings.filter((f) => f.severity === "issue").length;
  const warningsCount = allFindings.filter((f) => f.severity === "warning").length;
  const opportunitiesCount = allFindings.filter((f) => f.severity === "opportunity").length;

  const topIssuesRaw = allFindings
    .filter((f) => f.severity === "issue")
    .sort((a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority));
  const topIssues: string[] = [];
  const seen = new Set<string>();
  for (const f of topIssuesRaw) {
    if (topIssues.length >= 5) break;
    if (!seen.has(f.title)) {
      seen.add(f.title);
      topIssues.push(f.title);
    }
  }

  const sections: AuditReport["sections"] = {
    technicalSeo: tech,
    onPage,
    links,
    schema,
    performance: perf,
    geo,
    architecture,
    keywords,
  };
  if (duplicateContent) {
    sections.duplicateContent = duplicateContent;
  }
  if (analyticsInsights) {
    sections.analyticsInsights = analyticsInsights;
  }
  if (searchConsoleInsights) {
    sections.searchConsoleInsights = searchConsoleInsights;
  }
  if (domainAssets) {
    const domainAssetsResult: DomainAssetsResult = {
      score: 100,
      findings: [],
      data: {
        images: domainAssets.images,
        pdfs: domainAssets.pdfs,
      },
    };
    sections.domainAssets = domainAssetsResult;
  }

  return {
    version: "2.0",
    generatedAt: new Date().toISOString(),
    url,
    pagesCrawled,
    crawledUrls,
    crawlMeta,
    overallScore: Math.max(0, Math.min(100, overallScore)),
    sections,
    dataSources: dataSources ?? ["link"],
    actionItems,
    summary: {
      issuesCount,
      warningsCount,
      opportunitiesCount,
      topIssues,
    },
    ...(crawlDepthMetadata?.finalDepth != null && { crawlDepthUsed: crawlDepthMetadata.finalDepth }),
    ...(crawlDepthMetadata?.usedFallback && { crawlDepthFallback: true }),
  };
}

export function mergeDuplicateContentIntoReport(
  report: AuditReport,
  duplicateContent: DuplicateContentResult,
): AuditReport {
  const { sections } = report;
  const newSections = { ...sections, duplicateContent };

  const overallScore = computeOverallScore(
    sections.technicalSeo,
    sections.onPage,
    sections.links,
    sections.schema,
    sections.performance,
    sections.geo,
    sections.architecture,
    sections.keywords,
    duplicateContent,
  );

  const allFindings = [
    ...sections.technicalSeo.findings,
    ...sections.onPage.findings,
    ...sections.links.findings,
    ...sections.schema.findings,
    ...sections.performance.findings,
    ...sections.geo.findings,
    ...sections.architecture.findings,
    ...sections.keywords.findings,
    ...duplicateContent.findings,
  ];
  const actionItems = generateActionItems(allFindings);

  const issuesCount = allFindings.filter((f) => f.severity === "issue").length;
  const warningsCount = allFindings.filter((f) => f.severity === "warning").length;
  const opportunitiesCount = allFindings.filter((f) => f.severity === "opportunity").length;

  const topIssuesRaw = allFindings
    .filter((f) => f.severity === "issue")
    .sort((a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority));
  const topIssues: string[] = [];
  const seen = new Set<string>();
  for (const f of topIssuesRaw) {
    if (topIssues.length >= 5) break;
    if (!seen.has(f.title)) {
      seen.add(f.title);
      topIssues.push(f.title);
    }
  }

  return {
    ...report,
    sections: newSections,
    overallScore: Math.max(0, Math.min(100, overallScore)),
    actionItems,
    summary: {
      issuesCount,
      warningsCount,
      opportunitiesCount,
      topIssues,
    },
  };
}
