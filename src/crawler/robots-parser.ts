import { logger } from "../logger/index.js";

interface RobotsRules {
  disallowed: string[];
  crawlDelay: number | null;
  sitemapUrls: string[];
}

export async function fetchRobotsRules(baseUrl: string): Promise<RobotsRules> {
  const result: RobotsRules = { disallowed: [], crawlDelay: null, sitemapUrls: [] };

  try {
    const origin = new URL(baseUrl).origin;
    const res = await fetch(`${origin}/robots.txt`, {
      signal: AbortSignal.timeout(10000),
      headers: { "User-Agent": "KadmooBot/1.0" },
    });

    if (!res.ok) return result;

    const text = await res.text();
    let inUserAgentBlock = false;
    let isRelevantBlock = false;

    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;

      const [directive, ...valueParts] = line.split(":");
      const key = directive.trim().toLowerCase();
      const value = valueParts.join(":").trim();

      if (key === "user-agent") {
        inUserAgentBlock = true;
        isRelevantBlock = value === "*" || value.toLowerCase().includes("kadmoo");
      } else if (inUserAgentBlock && isRelevantBlock) {
        if (key === "disallow" && value) {
          result.disallowed.push(value);
        } else if (key === "crawl-delay") {
          const delay = parseFloat(value);
          if (!Number.isNaN(delay)) result.crawlDelay = delay;
        }
      }

      if (key === "sitemap" && value) {
        result.sitemapUrls.push(value);
      }
    }
  } catch (err) {
    logger.warn({ err, baseUrl }, "Failed to fetch robots.txt");
  }

  return result;
}

export function isUrlAllowed(url: string, disallowed: string[]): boolean {
  try {
    const pathname = new URL(url).pathname;
    return !disallowed.some((rule) => {
      if (rule.endsWith("*")) {
        return pathname.startsWith(rule.slice(0, -1));
      }
      return pathname === rule || pathname.startsWith(rule);
    });
  } catch {
    return true;
  }
}
