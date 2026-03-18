/**
 * Type definitions for the SEO/GEO Audit system.
 * Covers all 12 audit categories and the complete report structure.
 */

// ---------------------------------------------------------------------------
// Severity & finding types
// ---------------------------------------------------------------------------

export type FindingSeverity = "issue" | "warning" | "opportunity";
export type FindingPriority = "critical" | "high" | "medium" | "low";

export interface AuditFinding {
  id: string;
  category: AuditCategory;
  severity: FindingSeverity;
  priority: FindingPriority;
  title: string;
  description: string;
  howToFix?: string;
  affectedUrls?: string[];
  affectedElements?: string[];
  value?: string | number;
  expected?: string | number;
}

export type AuditCategory =
  | "crawl"
  | "security"
  | "url_structure"
  | "page_titles"
  | "meta_tags"
  | "headings"
  | "images"
  | "links"
  | "schema"
  | "performance"
  | "geo"
  | "architecture"
  | "keywords"
  | "portfolio"
  | "duplicate_content"
  | "content";

// ---------------------------------------------------------------------------
// Crawler raw data
// ---------------------------------------------------------------------------

export interface CrawledPage {
  url: string;
  statusCode: number;
  headers: Record<string, string>;
  html: string;
  redirectChain: RedirectHop[];
  responseTimeMs: number;
  contentType: string;
  contentLength: number;
}

export interface RedirectHop {
  url: string;
  statusCode: number;
}

export interface SitemapData {
  exists: boolean;
  url: string;
  urls: string[];
  urlCount: number;
  isValid: boolean;
  errors: string[];
}

export interface RobotsData {
  exists: boolean;
  content: string;
  sitemapUrls: string[];
  disallowedPaths: string[];
  allowsGPTBot: boolean;
  allowsPerplexityBot: boolean;
  allowsGoogleExtended: boolean;
  errors: string[];
}

export interface BrokenLink {
  url: string;
  sourcePages: string[];
  statusCode: number;
  isInternal: boolean;
}

export interface CrawlMeta {
  sitemapUrlsDiscovered: number;
  linkDiscoveryUrlsFound: number;
  robotsSitemapsUsed: string[];
  totalCandidateUrls: number;
  pagesCrawled: number;
  subPageStatusCodes: Record<number, number>;
}

export interface BrokenCanonical {
  canonicalUrl: string;
  sourcePage: string;
  statusCode: number;
}

export interface BrokenImage {
  src: string;
  sourcePage: string;
  statusCode: number;
}

export interface ImageInventoryItem {
  src: string;
  sourcePages: string[];
  format?: string;
}

export interface PdfLinkItem {
  url: string;
  sourcePages: string[];
}

export interface CrawlResult {
  homepage: CrawledPage;
  subPages: CrawledPage[];
  sitemap: SitemapData;
  robots: RobotsData;
  brokenLinks: BrokenLink[];
  brokenCanonicals?: BrokenCanonical[];
  brokenImages?: BrokenImage[];
  crawlMeta?: CrawlMeta;
  imagesInventory?: ImageInventoryItem[];
  pdfLinks?: PdfLinkItem[];
}

// ---------------------------------------------------------------------------
// Category 1: Crawl & Response Codes
// ---------------------------------------------------------------------------

export interface TechnicalSeoResult {
  score: number;
  findings: AuditFinding[];
  data: {
    homepageStatus: number;
    ttfbMs: number;
    http2Support: boolean;
    redirectChain: RedirectHop[];
    redirectType: "none" | "301" | "302" | "meta" | "js";
    isHttps: boolean;
    sitemap: SitemapData;
    robots: RobotsData;
    securityHeaders: {
      hsts: boolean;
      csp: boolean;
      xContentType: boolean;
      xFrameOptions: boolean;
      referrerPolicy: boolean;
      permissionsPolicy: boolean;
    };
  };
}

// ---------------------------------------------------------------------------
// Categories 4-7: On-Page
// ---------------------------------------------------------------------------

export interface HeadingInfo {
  level: number;
  text: string;
}

export interface ImageInfo {
  src: string;
  alt: string | null;
  hasWidthHeight: boolean;
  isLazy: boolean;
  format: string;
}

export interface OnPageResult {
  score: number;
  findings: AuditFinding[];
  data: {
    title: {
      exists: boolean;
      value: string;
      length: number;
      isMultiple: boolean;
      isOutsideHead: boolean;
      sameAsH1: boolean;
    };
    metaDescription: {
      exists: boolean;
      value: string;
      length: number;
      isMultiple: boolean;
    };
    metaViewport: boolean;
    openGraph: {
      title: boolean;
      description: boolean;
      image: boolean;
    };
    twitterCard: boolean;
    metaRobots: {
      noindex: boolean;
      nofollow: boolean;
      nosnippet: boolean;
    };
    canonical: {
      exists: boolean;
      value: string;
      isAbsolute: boolean;
      isMultiple: boolean;
      matchesUrl: boolean;
    };
    hreflang: { lang: string; href: string }[];
    htmlLang: string;
    headings: HeadingInfo[];
    h1Count: number;
    h1Value: string;
    headingHierarchyValid: boolean;
    wordCount: number;
    contentToHtmlRatio: number;
    hasLoremIpsum: boolean;
    images: {
      total: number;
      missingAlt: number;
      missingAltAttribute: number;
      altOver100Chars: number;
      missingDimensions: number;
      modernFormats: number;
      lazyLoaded: number;
      items: ImageInfo[];
    };
    urlAnalysis: {
      hasSpaces: boolean;
      hasUppercase: boolean;
      over115Chars: boolean;
      hasParameters: boolean;
      hasMultipleSlashes: boolean;
      hasUnderscores: boolean;
      length: number;
    };
  };
}

// ---------------------------------------------------------------------------
// Category 8: Links
// ---------------------------------------------------------------------------

export interface LinkInfo {
  href: string;
  anchorText: string;
  isInternal: boolean;
  isNofollow: boolean;
  isExternal: boolean;
}

export interface BrokenLinkDetail {
  sourceUrl: string;
  targetUrl: string;
  statusCode: number;
  statusLabel: string;
  anchorText: string;
  isInternal: boolean;
}

export interface LinksResult {
  score: number;
  findings: AuditFinding[];
  data: {
    totalInternal: number;
    totalExternal: number;
    internalNoAnchor: number;
    nonDescriptiveAnchors: number;
    internalNofollow: number;
    externalNofollow: number;
    emptyHref: number;
    localhostLinks: number;
    uniqueInternalTargets: number;
    brokenLinks: BrokenLinkDetail[];
    links: LinkInfo[];
    pagesAnalysed: number;
  };
}

// ---------------------------------------------------------------------------
// Category 9: Schema / Structured Data
// ---------------------------------------------------------------------------

export interface SchemaItem {
  type: string;
  properties: Record<string, unknown>;
  isValid: boolean;
  missingRequired: string[];
}

export interface SchemaResult {
  score: number;
  findings: AuditFinding[];
  data: {
    jsonLdBlocks: SchemaItem[];
    typesFound: string[];
    hasOrganization: boolean;
    hasLocalBusiness: boolean;
    hasArticle: boolean;
    hasFAQPage: boolean;
    hasBreadcrumbList: boolean;
    hasPerson: boolean;
    hasMedicalOrganization: boolean;
    totalSchemas: number;
  };
}

// ---------------------------------------------------------------------------
// Category 10: Performance (PageSpeed Insights)
// ---------------------------------------------------------------------------

export interface CoreWebVitals {
  lcp: number;
  cls: number;
  tbt: number;
  fcp: number;
  si: number;
  tti: number;
}

export interface LighthouseScores {
  performance: number;
  accessibility: number;
  bestPractices: number;
  seo: number;
}

export interface PageSpeedResult {
  score: number;
  findings: AuditFinding[];
  data: {
    mobile: {
      cwv: CoreWebVitals;
      fieldCwv?: CoreWebVitals;
      dataSource?: "field" | "lab";
      scores: LighthouseScores;
    } | null;
    desktop: {
      cwv: CoreWebVitals;
      fieldCwv?: CoreWebVitals;
      dataSource?: "field" | "lab";
      scores: LighthouseScores;
    } | null;
    renderBlockingResources: number;
    unusedCssBytes: number;
    unusedJsBytes: number;
    domSize: number;
    cacheIssues: number;
    imageOptimization: number;
  };
}

// ---------------------------------------------------------------------------
// Category 11: GEO
// ---------------------------------------------------------------------------

export interface GeoResult {
  score: number;
  findings: AuditFinding[];
  data: {
    blufReadiness: {
      score: number;
      hasDirectAnswer: boolean;
      summaryExcerpt: string;
    };
    citationReadiness: {
      score: number;
      hasStatistics: boolean;
      hasExpertQuotes: boolean;
      quantitativeDataCount: number;
    };
    contentInterpretability: {
      score: number;
      clearHierarchy: boolean;
      shortParagraphs: boolean;
      usesLists: boolean;
    };
    faqPresence: boolean;
    comparisonContent: boolean;
    eeatSignals: {
      hasAuthorBio: boolean;
      hasAboutPage: boolean;
      hasCredentials: boolean;
      hasMethodology: boolean;
    };
    entityPresence: {
      hasOrgSchema: boolean;
      hasConsistentNap: boolean;
    };
    freshnessSignals: {
      hasLastModified: boolean;
      hasPublicationDate: boolean;
    };
    snippetEligibility: {
      eligible: boolean;
      blockedByNosnippet: boolean;
      blockedByNoindex: boolean;
    };
    aiCrawlerAccess: {
      gptBot: boolean;
      perplexityBot: boolean;
      googleExtended: boolean;
    };
    contentDepth: {
      avgWordCountPerPage: number;
      subheadingFrequency: number;
    };
    conversationalRelevance: {
      questionBasedHeadings: number;
      totalHeadings: number;
    };
    aiAnalysis: string;
    llmsTxt?: {
      exists: boolean;
      url: string;
      hasFormattingIssues?: boolean;
    };
    semanticHtmlRatio?: number;
  };
}

// ---------------------------------------------------------------------------
// Category: Site Architecture
// ---------------------------------------------------------------------------

export interface NavItem {
  text: string;
  href: string;
  depth: number;
}

export interface SiteArchitectureResult {
  score: number;
  findings: AuditFinding[];
  data: {
    navigation: {
      items: NavItem[];
      maxDepth: number;
    };
    header: {
      hasLogo: boolean;
      hasCta: boolean;
      hasPhone: boolean;
      hasSearch: boolean;
    };
    footer: {
      links: { text: string; href: string }[];
      hasSocial: boolean;
      hasLegal: boolean;
      hasSitemapLink: boolean;
    };
    trust?: {
      hasTestimonials: boolean;
    };
    crawlDepth: { url: string; depth: number }[];
    orphanPages: string[];
    maxCrawlDepth: number;
    totalInternalLinks: number;
  };
}

// ---------------------------------------------------------------------------
// Category: Keyword Research
// ---------------------------------------------------------------------------

export interface KeywordRecommendation {
  keyword: string;
  difficulty: "low" | "medium" | "high";
  intent: "informational" | "transactional" | "navigational" | "commercial";
  reasoning: string;
  suggestedPage: string;
  topicCluster: string;
}

export interface KeywordAnalysisResult {
  score: number;
  findings: AuditFinding[];
  data: {
    recommendations: KeywordRecommendation[];
    topicClusters: { name: string; keywords: string[] }[];
    competitorInsights: string;
    aiAnalysis: string;
  };
}

// ---------------------------------------------------------------------------
// Category: Duplicate Content (from DataForSEO On-Page)
// ---------------------------------------------------------------------------

export interface DuplicateContentResult {
  score: number;
  findings: AuditFinding[];
  data: {
    duplicateContentPairs: {
      url1: string;
      url2: string;
      similarity: number;
    }[];
    duplicateTitles: {
      title: string;
      pages: string[];
    }[];
    duplicateDescriptions: {
      description: string;
      pages: string[];
    }[];
    totalDuplicateContentPages: number;
    totalDuplicateTitlePages: number;
    totalDuplicateDescriptionPages: number;
  };
}

// ---------------------------------------------------------------------------
// Audit data sources (for enhanced audits)
// ---------------------------------------------------------------------------

export type AuditDataSource = "link" | "ga" | "sc";

export interface AnalyticsInsightsResult {
  data: {
    totalOrganicSessions: number;
    totalAISessions: number;
    aiTrafficBreakdown: { platform: string; sessions: number }[];
    topPagesByTraffic: { path: string; sessions: number; pageViews: number }[];
    engagementMetrics: { avgSessionDuration?: number; bounceRate?: number };
    dateRange: { start: string; end: string };
  };
}

export interface SearchConsoleInsightsResult {
  data: {
    topQueries: { query: string; clicks: number; impressions: number; ctr: number; position: number }[];
    topPages: { page: string; clicks: number; impressions: number; ctr: number; position: number }[];
    totalClicks: number;
    totalImpressions: number;
    avgCTR: number;
    avgPosition: number;
    dateRange: { start: string; end: string };
  };
}

export interface DomainAssetsResult {
  score: number;
  findings: AuditFinding[];
  data: {
    images: ImageInventoryItem[];
    pdfs: PdfLinkItem[];
  };
}

// ---------------------------------------------------------------------------
// Action item
// ---------------------------------------------------------------------------

export interface ActionItem {
  priority: FindingPriority;
  category: AuditCategory;
  title: string;
  description: string;
  technicalDetails?: string;
}

// ---------------------------------------------------------------------------
// Full audit report
// ---------------------------------------------------------------------------

export interface AuditReport {
  version: string;
  generatedAt: string;
  url: string;
  pagesCrawled: number;
  crawledUrls?: string[];
  crawlMeta?: CrawlMeta;

  overallScore: number;

  sections: {
    technicalSeo: TechnicalSeoResult;
    onPage: OnPageResult;
    links: LinksResult;
    schema: SchemaResult;
    performance: PageSpeedResult;
    geo: GeoResult;
    architecture: SiteArchitectureResult;
    keywords: KeywordAnalysisResult;
    duplicateContent?: DuplicateContentResult;
    businessProfile?: unknown;
    analyticsInsights?: AnalyticsInsightsResult;
    searchConsoleInsights?: SearchConsoleInsightsResult;
    domainAssets?: DomainAssetsResult;
  };

  dataSources?: AuditDataSource[];

  actionItems: ActionItem[];

  summary: {
    issuesCount: number;
    warningsCount: number;
    opportunitiesCount: number;
    topIssues: string[];
  };

  crawlDepthUsed?: number;
  crawlDepthFallback?: boolean;
}
