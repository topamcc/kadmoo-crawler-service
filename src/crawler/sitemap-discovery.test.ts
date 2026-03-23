import { describe, expect, it } from "vitest";
import { extractLocUrlsFromSitemapXml } from "./sitemap-discovery.js";

describe("extractLocUrlsFromSitemapXml", () => {
  it("parses urlset loc entries", () => {
    const xml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/a</loc></url>
  <url><loc> https://example.com/b?x=1 </loc></url>
</urlset>`;
    expect(extractLocUrlsFromSitemapXml(xml)).toEqual([
      "https://example.com/a",
      "https://example.com/b?x=1",
    ]);
  });

  it("parses sitemap index loc entries", () => {
    const xml = `<sitemapindex>
<sitemap><loc>https://example.com/s1.xml</loc></sitemap>
</sitemapindex>`;
    expect(extractLocUrlsFromSitemapXml(xml)).toEqual([
      "https://example.com/s1.xml",
    ]);
  });
});

const PDF_PATTERN = /\.pdf(\?|#|$)/i;

describe("PDF URL pattern (mirrors result-converter)", () => {
  it("matches common PDF href shapes", () => {
    expect(PDF_PATTERN.test("https://x.com/doc.pdf")).toBe(true);
    expect(PDF_PATTERN.test("https://x.com/doc.PDF?q=1")).toBe(true);
    expect(PDF_PATTERN.test("https://x.com/doc.pdf#page=1")).toBe(true);
    expect(PDF_PATTERN.test("https://x.com/doc.php")).toBe(false);
  });
});
