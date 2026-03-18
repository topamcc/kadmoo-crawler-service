/**
 * Internal duplicate content detection from crawler data.
 * Replaces DataForSEO for titles, descriptions, and content similarity (SimHash).
 */

import * as cheerio from "cheerio";
import type { DuplicateContentResult, AuditFinding } from "./types.js";

export interface CrawledPageForDuplicate {
  url: string;
  title: string;
  metaDescription: string;
  mainContent: string;
  crawlDepth?: number;
}

const MAX_PAGES_FOR_CONTENT = 3000;
const TIMEOUT_MS = 30000;
const MIN_CONTENT_LENGTH = 50;

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenize(content: string): string[] {
  return content
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

function hash32(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

function simHash(tokens: string[]): number {
  const v = new Array(32).fill(0);
  const seen = new Set<string>();

  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    const h = hash32(t);
    for (let i = 0; i < 32; i++) {
      if ((h >> i) & 1) v[i]++;
      else v[i]--;
    }
  }

  let result = 0;
  for (let i = 0; i < 32; i++) {
    if (v[i] > 0) result |= 1 << i;
  }
  return result >>> 0;
}

function hammingDistance(a: number, b: number): number {
  let d = 0;
  let x = (a ^ b) >>> 0;
  while (x) {
    d++;
    x &= x - 1;
  }
  return d;
}

function distanceToSimilarity(dist: number): number {
  if (dist <= 1) return 10;
  if (dist <= 2) return 9;
  if (dist <= 3) return 8;
  if (dist <= 4) return 7;
  return 6;
}

function groupByTitle(pages: CrawledPageForDuplicate[]) {
  const map = new Map<string, string[]>();
  for (const p of pages) {
    const key = normalize(p.title);
    if (!key) continue;
    const arr = map.get(key) ?? [];
    arr.push(p.url);
    map.set(key, arr);
  }
  const duplicateTitles: { title: string; pages: string[] }[] = [];
  let totalDuplicateTitlePages = 0;
  for (const [title, urls] of map) {
    if (urls.length >= 2) {
      duplicateTitles.push({ title, pages: urls });
      totalDuplicateTitlePages += urls.length;
    }
  }
  return { duplicateTitles, totalDuplicateTitlePages };
}

function groupByDescription(pages: CrawledPageForDuplicate[]) {
  const map = new Map<string, string[]>();
  for (const p of pages) {
    const key = normalize(p.metaDescription);
    if (!key) continue;
    const arr = map.get(key) ?? [];
    arr.push(p.url);
    map.set(key, arr);
  }
  const duplicateDescriptions: { description: string; pages: string[] }[] = [];
  let totalDuplicateDescriptionPages = 0;
  for (const [desc, urls] of map) {
    if (urls.length >= 2) {
      duplicateDescriptions.push({ description: desc, pages: urls });
      totalDuplicateDescriptionPages += urls.length;
    }
  }
  return { duplicateDescriptions, totalDuplicateDescriptionPages };
}

function findContentDuplicates(
  pages: CrawledPageForDuplicate[],
  deadline: number,
): { pairs: { url1: string; url2: string; similarity: number }[]; totalPages: number } {
  const withContent = pages.filter(
    (p) => p.mainContent && p.mainContent.length >= MIN_CONTENT_LENGTH,
  );
  const capped = withContent
    .sort((a, b) => (a.crawlDepth ?? 0) - (b.crawlDepth ?? 0))
    .slice(0, MAX_PAGES_FOR_CONTENT);

  const hashes: { url: string; hash: number }[] = [];
  for (const p of capped) {
    const tokens = tokenize(p.mainContent);
    if (tokens.length < 5) continue;
    hashes.push({ url: p.url, hash: simHash(tokens) });
  }

  const seenPairs = new Set<string>();
  const pairs: { url1: string; url2: string; similarity: number }[] = [];
  let totalDuplicateContentPages = 0;

  for (let i = 0; i < hashes.length; i++) {
    if (Date.now() > deadline) break;
    for (let j = i + 1; j < hashes.length; j++) {
      const dist = hammingDistance(hashes[i].hash, hashes[j].hash);
      if (dist > 5) continue;

      const pairKey = [hashes[i].url, hashes[j].url].sort().join("|");
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);

      const similarity = distanceToSimilarity(dist);
      pairs.push({
        url1: hashes[i].url,
        url2: hashes[j].url,
        similarity,
      });
      totalDuplicateContentPages += 2;
    }
  }

  return { pairs, totalPages: totalDuplicateContentPages };
}

function buildFindings(
  duplicateTitles: { title: string; pages: string[] }[],
  duplicateDescriptions: { description: string; pages: string[] }[],
  duplicateContentPairs: { url1: string; url2: string; similarity: number }[],
): AuditFinding[] {
  const findings: AuditFinding[] = [];

  for (const item of duplicateTitles) {
    findings.push({
      id: `dup-title-${item.title.slice(0, 30).replace(/\s/g, "-")}`,
      category: "page_titles",
      severity: "issue",
      priority: "high",
      title: `Duplicate title across ${item.pages.length} pages`,
      description: `The title "${item.title.slice(0, 60)}..." is used on multiple pages.`,
      howToFix: "Give each page a unique, descriptive title.",
      affectedUrls: item.pages,
    });
  }

  for (const item of duplicateDescriptions) {
    findings.push({
      id: `dup-desc-${item.description.slice(0, 20).replace(/\s/g, "-")}`,
      category: "meta_tags",
      severity: "warning",
      priority: "medium",
      title: `Duplicate meta description across ${item.pages.length} pages`,
      description: "The same meta description is used on multiple pages.",
      howToFix: "Write a unique meta description for each page.",
      affectedUrls: item.pages,
    });
  }

  const seenPairs = new Set<string>();
  for (const p of duplicateContentPairs) {
    const pairKey = [p.url1, p.url2].sort().join("|");
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);

    if (p.similarity >= 8) {
      findings.push({
        id: `dup-content-${pairKey.slice(0, 40)}`,
        category: "duplicate_content",
        severity: "issue",
        priority: "critical",
        title: `Near-identical content (${p.similarity}/10 similarity)`,
        description: `Pages have very similar content. URL 1: ${p.url1.slice(0, 80)}... URL 2: ${p.url2.slice(0, 80)}...`,
        howToFix: "Consolidate duplicate pages with 301 redirects or differentiate content significantly.",
        affectedUrls: [p.url1, p.url2],
      });
    } else if (p.similarity >= 6) {
      findings.push({
        id: `dup-content-warn-${pairKey.slice(0, 40)}`,
        category: "duplicate_content",
        severity: "warning",
        priority: "high",
        title: `Similar content (${p.similarity}/10 similarity)`,
        description: `Pages have similar content. Consider consolidating or differentiating.`,
        howToFix: "Add unique content or use canonical tags to indicate the preferred version.",
        affectedUrls: [p.url1, p.url2],
      });
    }
  }

  return findings;
}

function computeScore(findings: AuditFinding[]): number {
  let deductions = 0;
  for (const f of findings) {
    if (f.severity === "issue") deductions += f.priority === "critical" ? 20 : 12;
    else if (f.severity === "warning") deductions += f.priority === "high" ? 8 : 5;
    else deductions += 2;
  }
  return Math.max(0, Math.min(100, 100 - deductions));
}

export function parseHtmlToDuplicateInput(
  url: string,
  html: string,
  crawlDepth?: number,
): CrawledPageForDuplicate {
  const $ = cheerio.load(html);
  const title = $("title").first().text().trim();
  const metaDescription = $('meta[name="description"]').attr("content")?.trim() ?? "";
  let mainContent = "";
  const mainEl = $("main").first();
  if (mainEl.length) {
    mainContent = mainEl.text().replace(/\s+/g, " ").trim();
  } else {
    const articleEl = $("article").first();
    if (articleEl.length) {
      mainContent = articleEl.text().replace(/\s+/g, " ").trim();
    } else {
      mainContent = $("body").text().replace(/\s+/g, " ").trim();
    }
  }
  if (mainContent.length > 50000) mainContent = mainContent.slice(0, 50000);
  return { url, title, metaDescription, mainContent, crawlDepth };
}

export function detectDuplicateContent(
  pages: CrawledPageForDuplicate[],
): DuplicateContentResult {
  const deadline = Date.now() + TIMEOUT_MS;

  const mapped: CrawledPageForDuplicate[] = pages.map((p) => ({
    url: p.url,
    title: p.title ?? "",
    metaDescription: p.metaDescription ?? "",
    mainContent: p.mainContent ?? "",
    crawlDepth: p.crawlDepth,
  }));

  const { duplicateTitles, totalDuplicateTitlePages } = groupByTitle(mapped);
  const { duplicateDescriptions, totalDuplicateDescriptionPages } =
    groupByDescription(mapped);

  const { pairs: duplicateContentPairs, totalPages: totalDuplicateContentPages } =
    findContentDuplicates(mapped, deadline);

  const findings = buildFindings(
    duplicateTitles,
    duplicateDescriptions,
    duplicateContentPairs,
  );
  const score = computeScore(findings);

  return {
    score,
    findings,
    data: {
      duplicateContentPairs,
      duplicateTitles,
      duplicateDescriptions,
      totalDuplicateContentPages,
      totalDuplicateTitlePages,
      totalDuplicateDescriptionPages,
    },
  };
}
