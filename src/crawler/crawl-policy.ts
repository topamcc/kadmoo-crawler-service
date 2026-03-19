export interface CrawlPolicy {
  maxConcurrency: number;
  maxRequestsPerMinute: number;
  useHttp1: boolean;
  /** Override request timeout (ms). Defensive sites may need longer. */
  requestTimeoutMs?: number;
}

const DEFENSIVE_DOMAINS = new Set([
  "davita.com",
  "healthcare.gov",
]);

export function getCrawlPolicy(
  url: string,
  defaults: {
    concurrency: number;
    maxRequestsPerMinute: number;
    timeoutMs?: number;
  },
): CrawlPolicy {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return {
      maxConcurrency: defaults.concurrency,
      maxRequestsPerMinute: defaults.maxRequestsPerMinute,
      useHttp1: false,
    };
  }
  if (DEFENSIVE_DOMAINS.has(host) || host.endsWith(".gov")) {
    return {
      maxConcurrency: 3,
      maxRequestsPerMinute: 120,
      useHttp1: true,
      requestTimeoutMs: 45000,
    };
  }
  return {
    maxConcurrency: defaults.concurrency,
    maxRequestsPerMinute: defaults.maxRequestsPerMinute,
    useHttp1: false,
  };
}
