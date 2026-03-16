const STRIP_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
  "fbclid", "gclid", "gclsrc", "dclid", "msclkid",
  "mc_cid", "mc_eid", "_ga", "_gl", "ref", "source",
]);

export function normalizeUrl(raw: string, base?: string): string | null {
  try {
    const url = new URL(raw, base);

    if (url.protocol !== "http:" && url.protocol !== "https:") return null;

    url.hash = "";

    // Strip tracking params
    for (const key of [...url.searchParams.keys()]) {
      if (STRIP_PARAMS.has(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();

    // Normalize trailing slash (keep root slash, remove from paths)
    let pathname = url.pathname.replace(/\/+/g, "/");
    if (pathname.length > 1 && pathname.endsWith("/")) {
      pathname = pathname.slice(0, -1);
    }
    url.pathname = pathname;

    // Lowercase hostname
    url.hostname = url.hostname.toLowerCase();

    return url.toString();
  } catch {
    return null;
  }
}

export function isSameDomain(url: string, baseUrl: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(baseUrl);
    const domA = a.hostname.replace(/^www\./, "");
    const domB = b.hostname.replace(/^www\./, "");
    return domA === domB;
  } catch {
    return false;
  }
}

export function ensureAbsoluteUrl(raw: string): string {
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw.replace(/^\/\//, "")}`;
}
