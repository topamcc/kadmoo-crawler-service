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

export function isSameDomain(
  url: string,
  baseUrl: string,
  includeSubdomains = false,
): boolean {
  try {
    const a = new URL(url);
    const b = new URL(baseUrl);
    const domA = a.hostname.replace(/^www\./, "");
    const domB = b.hostname.replace(/^www\./, "");
    if (domA === domB) return true;
    if (!includeSubdomains) return false;
    return domA.endsWith(`.${domB}`) || domB.endsWith(`.${domA}`);
  } catch {
    return false;
  }
}

export function ensureAbsoluteUrl(raw: string): string {
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw.replace(/^\/\//, "")}`;
}

/** Extensions that CheerioCrawler cannot parse (only text/html, xhtml, xml, json allowed) */
const NON_HTML_EXTENSIONS = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "jpg", "jpeg", "png", "gif", "webp", "svg", "ico", "bmp", "tiff",
  "zip", "rar", "7z", "tar", "gz", "exe", "dmg", "mp3", "mp4", "avi", "mov",
  "woff", "woff2", "ttf", "eot", "otf",
]);

/** Returns true if URL points to a non-HTML resource that CheerioCrawler will reject */
export function isNonHtmlResource(url: string): boolean {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    const ext = path.split(".").pop()?.split("?")[0] ?? "";
    if (NON_HTML_EXTENSIONS.has(ext)) return true;
    // Common upload paths that typically serve binaries
    if (path.includes("/uploads/") || path.includes("/wp-content/uploads/")) {
      if (/\.(pdf|doc|xls|jpg|jpeg|png|gif|webp|svg|xlsx|docx|pptx)$/i.test(path)) return true;
    }
    return false;
  } catch {
    return false;
  }
}
