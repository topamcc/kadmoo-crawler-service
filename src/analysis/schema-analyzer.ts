/**
 * Schema / Structured Data analyzer — extracts and validates JSON-LD blocks.
 */

import * as cheerio from "cheerio";
import type { CrawledPage, SchemaResult, SchemaItem, AuditFinding } from "./types.js";

const RECOMMENDED_TYPES = [
  "Organization",
  "LocalBusiness",
  "Article",
  "FAQPage",
  "BreadcrumbList",
  "Person",
  "MedicalOrganization",
];

const REQUIRED_FIELDS: Record<string, string[]> = {
  Organization: ["name", "url"],
  LocalBusiness: ["name", "address", "telephone"],
  Article: ["headline", "author", "datePublished"],
  FAQPage: ["mainEntity"],
  BreadcrumbList: ["itemListElement"],
  Person: ["name"],
  MedicalOrganization: ["name", "address"],
};

function extractJsonLdBlocks(html: string): SchemaItem[] {
  const $ = cheerio.load(html);
  const blocks: SchemaItem[] = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).html();
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : parsed["@graph"] ? parsed["@graph"] : [parsed];

      for (const item of items) {
        const type = item["@type"];
        if (!type) continue;

        const types = Array.isArray(type) ? type : [type];
        for (const t of types) {
          const required = REQUIRED_FIELDS[t] ?? [];
          const missingRequired = required.filter((f) => !item[f]);

          blocks.push({
            type: t,
            properties: item,
            isValid: missingRequired.length === 0,
            missingRequired,
          });
        }
      }
    } catch {
      // Malformed JSON-LD
    }
  });

  return blocks;
}

export function analyseSchema(page: CrawledPage): SchemaResult {
  const findings: AuditFinding[] = [];
  const blocks = extractJsonLdBlocks(page.html);
  const typesFound = [...new Set(blocks.map((b) => b.type))];

  const has = (type: string) => typesFound.includes(type);

  if (!has("Organization") && !has("LocalBusiness") && !has("MedicalOrganization")) {
    findings.push({
      id: "schema-no-org",
      category: "schema",
      severity: "opportunity",
      priority: "high",
      title: "No Organization / LocalBusiness schema",
      description: "No Organization or LocalBusiness JSON-LD found. This is critical for local SEO and GEO.",
      howToFix: "Add Organization or LocalBusiness JSON-LD with name, address, and contact info.",
    });
  }

  if (!has("BreadcrumbList")) {
    findings.push({
      id: "schema-no-breadcrumb",
      category: "schema",
      severity: "opportunity",
      priority: "medium",
      title: "No BreadcrumbList schema",
      description: "BreadcrumbList helps search engines understand site structure.",
      howToFix: "Add BreadcrumbList JSON-LD that matches the visible breadcrumb navigation.",
    });
  }

  if (!has("FAQPage")) {
    findings.push({
      id: "schema-no-faq",
      category: "schema",
      severity: "opportunity",
      priority: "medium",
      title: "No FAQPage schema",
      description: "FAQPage schema can earn rich results and helps GEO citation readiness.",
      howToFix: "If the page contains FAQ content, wrap it in FAQPage JSON-LD.",
    });
  }

  if (blocks.length === 0) {
    findings.push({
      id: "schema-none-found",
      category: "schema",
      severity: "issue",
      priority: "high",
      title: "No structured data found",
      description: "No JSON-LD structured data was found on the page.",
      howToFix: 'Add relevant JSON-LD schemas (Organization, Article, FAQPage, etc.) in <script type="application/ld+json">.',
    });
  }

  for (const block of blocks) {
    if (!block.isValid) {
      findings.push({
        id: `schema-invalid-${block.type.toLowerCase()}`,
        category: "schema",
        severity: "warning",
        priority: "medium",
        title: `${block.type} schema missing required fields`,
        description: `Missing: ${block.missingRequired.join(", ")}`,
        howToFix: `Add the missing properties to the ${block.type} JSON-LD block.`,
      });
    }
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
      jsonLdBlocks: blocks,
      typesFound,
      hasOrganization: has("Organization"),
      hasLocalBusiness: has("LocalBusiness"),
      hasArticle: has("Article"),
      hasFAQPage: has("FAQPage"),
      hasBreadcrumbList: has("BreadcrumbList"),
      hasPerson: has("Person"),
      hasMedicalOrganization: has("MedicalOrganization"),
      totalSchemas: blocks.length,
    },
  };
}

const MAX_SCHEMA_PAGES = 2500;
const MAX_SCHEMA_BLOCKS = 500;

export function analyseSchemaMulti(pages: CrawledPage[]): SchemaResult {
  const allFindings: AuditFinding[] = [];
  const allBlocks: SchemaItem[] = [];
  const typesByPage = new Map<string, Set<string>>();
  const pagesWithNoSchema: string[] = [];

  const pagesToAnalyse = pages.length > MAX_SCHEMA_PAGES ? pages.slice(0, MAX_SCHEMA_PAGES) : pages;
  for (const page of pagesToAnalyse) {
    if (!page.html || page.statusCode >= 400) continue;
    const blocks = extractJsonLdBlocks(page.html);
    const pageTypes = new Set(blocks.map((b) => b.type));
    typesByPage.set(page.url, pageTypes);

    if (blocks.length === 0) {
      pagesWithNoSchema.push(page.url);
    }

    for (const block of blocks) {
      if (allBlocks.length < MAX_SCHEMA_BLOCKS) {
        allBlocks.push(block);
      }
      if (!block.isValid) {
        allFindings.push({
          id: `schema-invalid-${block.type.toLowerCase()}@${page.url}`,
          category: "schema",
          severity: "warning",
          priority: "medium",
          title: `${block.type} schema missing required fields`,
          description: `Missing: ${block.missingRequired.join(", ")}`,
          howToFix: `Add the missing properties to the ${block.type} JSON-LD block.`,
          affectedUrls: [page.url],
        });
      }
    }
  }

  const allTypesFound = [...new Set(allBlocks.map((b) => b.type))];
  const has = (type: string) => allTypesFound.includes(type);

  if (!has("Organization") && !has("LocalBusiness") && !has("MedicalOrganization")) {
    allFindings.push({
      id: "schema-no-org",
      category: "schema",
      severity: "opportunity",
      priority: "high",
      title: "No Organization / LocalBusiness schema across the site",
      description: "No Organization or LocalBusiness JSON-LD found on any page.",
      howToFix: "Add Organization or LocalBusiness JSON-LD with name, address, and contact info.",
    });
  }

  if (!has("BreadcrumbList")) {
    allFindings.push({
      id: "schema-no-breadcrumb",
      category: "schema",
      severity: "opportunity",
      priority: "medium",
      title: "No BreadcrumbList schema on any page",
      description: "BreadcrumbList helps search engines understand site structure.",
      howToFix: "Add BreadcrumbList JSON-LD that matches the visible breadcrumb navigation.",
    });
  }

  if (pagesWithNoSchema.length > 0) {
    allFindings.push({
      id: "schema-pages-missing",
      category: "schema",
      severity: "warning",
      priority: "medium",
      title: `${pagesWithNoSchema.length} page(s) have no structured data`,
      description: "These pages are missing JSON-LD structured data entirely.",
      howToFix: "Add relevant schema markup to each page.",
      affectedUrls: pagesWithNoSchema.slice(0, 20),
    });
  }

  let deductions = 0;
  for (const f of allFindings) {
    if (f.severity === "issue") deductions += f.priority === "critical" ? 20 : 12;
    else if (f.severity === "warning") deductions += f.priority === "high" ? 8 : 5;
    else deductions += 2;
  }
  const score = Math.max(0, 100 - deductions);

  return {
    score,
    findings: allFindings,
    data: {
      jsonLdBlocks: allBlocks.slice(0, 100),
      typesFound: allTypesFound,
      hasOrganization: has("Organization"),
      hasLocalBusiness: has("LocalBusiness"),
      hasArticle: has("Article"),
      hasFAQPage: has("FAQPage"),
      hasBreadcrumbList: has("BreadcrumbList"),
      hasPerson: has("Person"),
      hasMedicalOrganization: has("MedicalOrganization"),
      totalSchemas: allBlocks.length,
    },
  };
}
