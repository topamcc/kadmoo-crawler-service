/**
 * Synchronous homepage fetch for first-time registration fallback.
 * Tries HTTP fetch first, then Playwright when the response looks blocked or is an error status.
 */

import { PlaywrightCrawler, RequestQueue } from "crawlee";
import { config } from "../config/index.js";
import { logger } from "../logger/index.js";
import { ensureAbsoluteUrl } from "./url-normalizer.js";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 25_000;
const MAX_HTML_BYTES = 1_500_000;

export type HomepageSnapshotErrorCode =
  | "INVALID_URL"
  | "FETCH_FAILED"
  | "PLAYWRIGHT_DISABLED"
  | "PLAYWRIGHT_FAILED"
  | "EMPTY_BODY"
  | "HTTP_ERROR";

export type HomepageSnapshotOk = {
  ok: true;
  html: string;
  statusCode: number;
  finalUrl: string;
  source: "fetch" | "playwright";
};

export type HomepageSnapshotErr = {
  ok: false;
  code: HomepageSnapshotErrorCode;
  message: string;
  httpStatus?: number;
};

export type HomepageSnapshotResult = HomepageSnapshotOk | HomepageSnapshotErr;

function looksLikeBotChallenge(html: string): boolean {
  const slice = html.slice(0, 14_000).toLowerCase();
  return (
    slice.includes("cf-browser-verification") ||
    slice.includes("__cf_chl") ||
    slice.includes("checking your browser") ||
    slice.includes("just a moment") ||
    slice.includes("attention required") ||
    (slice.includes("enable javascript") && slice.includes("cloudflare"))
  );
}

function truncateHtml(html: string): string {
  const buf = Buffer.byteLength(html, "utf-8");
  if (buf <= MAX_HTML_BYTES) return html;
  let end = html.length;
  while (end > 0 && Buffer.byteLength(html.slice(0, end), "utf-8") > MAX_HTML_BYTES) {
    end -= 5000;
  }
  return html.slice(0, Math.max(0, end));
}

async function tryFetch(url: string): Promise<{ html: string; statusCode: number; finalUrl: string } | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
      },
    });
    clearTimeout(timer);
    const html = await res.text();
    return { html, statusCode: res.status, finalUrl: res.url || url };
  } catch {
    return null;
  }
}

async function tryPlaywright(url: string): Promise<{ html: string; statusCode: number; finalUrl: string } | null> {
  const log = logger.child({ url });
  /** Box so TS knows the handler may assign before run() resolves */
  const box: {
    payload: { html: string; statusCode: number; finalUrl: string } | null;
  } = { payload: null };

  try {
    const queue = await RequestQueue.open(`hp-snap-${Date.now()}` as any);
    await queue.addRequest({ url });

    const crawler = new PlaywrightCrawler({
      requestQueue: queue,
      maxRequestsPerCrawl: 1,
      maxConcurrency: 1,
      requestHandlerTimeoutSecs: 95,
      maxRequestRetries: 1,
      launchContext: {
        launchOptions: {
          headless: true,
          args: ["--no-sandbox", "--disable-dev-shm-usage"],
        },
      },
      preNavigationHooks: [
        async ({ page }) => {
          await page.setExtraHTTPHeaders({
            "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
          });
        },
      ],
      requestHandler: async ({ page, response }) => {
        const status = response?.status() ?? 200;
        const html = await page.content();
        box.payload = { html, statusCode: status, finalUrl: page.url() };
      },
      failedRequestHandler: async ({ request, error }) => {
        const errMsg = error instanceof Error ? error.message : String(error);
        log.warn({ err: errMsg, u: request.url }, "Playwright snapshot request failed");
      },
    });

    await crawler.run();
  } catch (err) {
    log.error({ err }, "Playwright snapshot crawler error");
    return null;
  }

  const out = box.payload;
  if (out == null) {
    return null;
  }
  if (out.html.length < 40) {
    return null;
  }
  return out;
}

function okResult(
  html: string,
  statusCode: number,
  finalUrl: string,
  source: "fetch" | "playwright",
): HomepageSnapshotOk {
  return {
    ok: true,
    html: truncateHtml(html),
    statusCode,
    finalUrl,
    source,
  };
}

/**
 * Fetch homepage HTML for FTR when the app server's plain fetch fails or is blocked.
 */
export async function fetchHomepageSnapshot(
  rawUrl: string,
  options: { forcePlaywright?: boolean } = {},
): Promise<HomepageSnapshotResult> {
  const trimmed = rawUrl?.trim() ?? "";
  if (!trimmed) {
    return { ok: false, code: "INVALID_URL", message: "URL is required" };
  }

  let url: string;
  try {
    url = ensureAbsoluteUrl(trimmed);
    new URL(url);
  } catch {
    return { ok: false, code: "INVALID_URL", message: "Invalid URL" };
  }

  const forcePlaywright = options.forcePlaywright === true;

  if (!forcePlaywright) {
    const fetched = await tryFetch(url);
    if (fetched) {
      const { html, statusCode, finalUrl } = fetched;

      if (statusCode >= 200 && statusCode < 400 && html.length > 200 && !looksLikeBotChallenge(html)) {
        return okResult(html, statusCode, finalUrl, "fetch");
      }

      const softBlocked = statusCode === 401 || statusCode === 403 || statusCode === 429 || statusCode === 503;
      if (statusCode >= 200 && statusCode < 400 && looksLikeBotChallenge(html)) {
        // fall through to Playwright
      } else if (!softBlocked && statusCode >= 400) {
        return {
          ok: false,
          code: "HTTP_ERROR",
          message: `HTTP ${statusCode}`,
          httpStatus: statusCode,
        };
      }
    }
  }

  if (!config.playwrightEnabled) {
    return {
      ok: false,
      code: "PLAYWRIGHT_DISABLED",
      message: "Playwright is disabled on this crawler instance",
    };
  }

  const pw = await tryPlaywright(url);
  if (!pw) {
    return {
      ok: false,
      code: "PLAYWRIGHT_FAILED",
      message: "Browser-based fetch did not return a page",
    };
  }

  if (pw.statusCode >= 400) {
    return {
      ok: false,
      code: "HTTP_ERROR",
      message: `HTTP ${pw.statusCode}`,
      httpStatus: pw.statusCode,
    };
  }

  if (pw.html.length < 200) {
    return { ok: false, code: "EMPTY_BODY", message: "Homepage body too small" };
  }

  return okResult(pw.html, pw.statusCode, pw.finalUrl, "playwright");
}
