import "dotenv/config";

function env(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (value === undefined) throw new Error(`Missing env: ${key}`);
  return value;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key]?.toLowerCase();
  if (!raw) return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
}

export const config = {
  port: envInt("PORT", 4000),
  host: env("HOST", "0.0.0.0"),
  nodeEnv: env("NODE_ENV", "development"),
  isDev: env("NODE_ENV", "development") === "development",

  crawlerApiKey: env("CRAWLER_API_KEY", "dev-key-change-me"),
  webhookHmacSecret: env("WEBHOOK_HMAC_SECRET", "dev-hmac-change-me"),

  redisUrl: env("REDIS_URL", "redis://127.0.0.1:6379"),

  webAppBaseUrl: env("WEB_APP_BASE_URL", "http://localhost:3000"),

  s3: {
    endpoint: process.env.S3_ENDPOINT ?? "",
    region: env("S3_REGION", "nyc3"),
    bucket: env("S3_BUCKET", "kadmoo-crawl-artifacts"),
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
    get enabled() {
      return !!(this.endpoint && this.accessKeyId && this.secretAccessKey);
    },
  },

  crawl: {
    defaultMaxPages: envInt("DEFAULT_MAX_PAGES", 200),
    defaultMaxDepth: envInt("DEFAULT_MAX_DEPTH", 10),
    defaultConcurrency: envInt("DEFAULT_CONCURRENCY", 8),
    defaultTimeoutMs: envInt("DEFAULT_TIMEOUT_MS", 15000),
    defaultMaxDurationMinutes: envInt("DEFAULT_MAX_DURATION_MINUTES", 30),
  },

  budget: {
    maxConcurrentJobs: envInt("MAX_CONCURRENT_JOBS", 5),
    maxPagesPerSiteDaily: envInt("MAX_PAGES_PER_SITE_DAILY", 50000),
  },

  playwrightEnabled: envBool("PLAYWRIGHT_ENABLED", true),
} as const;
