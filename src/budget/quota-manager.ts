import IORedis from "ioredis";
import { getRedisConnection as getRedisUrl } from "../queue/crawl-queue.js";
import { config } from "../config/index.js";
import { logger } from "../logger/index.js";

interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
}

class QuotaManager {
  private _redis: IORedis | null = null;

  private redis(): IORedis {
    if (!this._redis) {
      this._redis = new IORedis(getRedisUrl(), {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      });
    }
    return this._redis;
  }

  async checkBudget(siteId?: string): Promise<BudgetCheckResult> {
    const redis = this.redis();

    // Global concurrency check
    const activeJobs = await redis.get("crawler:active_jobs");
    if (activeJobs && parseInt(activeJobs, 10) >= config.budget.maxConcurrentJobs) {
      return { allowed: false, reason: "Max concurrent jobs reached. Try again later." };
    }

    // Per-site daily page budget (disabled when maxPagesPerSiteDaily <= 0)
    if (siteId && config.budget.maxPagesPerSiteDaily > 0) {
      const today = new Date().toISOString().slice(0, 10);
      const key = `crawler:daily_pages:${siteId}:${today}`;
      const usedRaw = await redis.get(key);
      const used = usedRaw ? parseInt(usedRaw, 10) : 0;

      if (used >= config.budget.maxPagesPerSiteDaily) {
        return {
          allowed: false,
          reason: `Daily page budget exceeded for site (${used}/${config.budget.maxPagesPerSiteDaily})`,
        };
      }
    }

    return { allowed: true };
  }

  async recordJobStart(siteId: string | undefined, maxPages: number): Promise<void> {
    const redis = this.redis();

    await redis.incr("crawler:active_jobs");

    if (siteId && config.budget.maxPagesPerSiteDaily > 0) {
      const today = new Date().toISOString().slice(0, 10);
      const key = `crawler:daily_pages:${siteId}:${today}`;
      await redis.incrby(key, maxPages);
      await redis.expire(key, 86400 * 2);
    }
  }

  async recordJobEnd(): Promise<void> {
    const lua = `
      local v = tonumber(redis.call('get', KEYS[1]) or '0')
      if v > 0 then redis.call('decr', KEYS[1]) end
      return v
    `;
    await this.redis().eval(lua, 1, "crawler:active_jobs");
  }

  /** Reset active_jobs to 0 on worker startup to clear stale counters from previous runs. */
  async resetActiveJobsOnStartup(): Promise<void> {
    await this.redis().set("crawler:active_jobs", "0");
  }

  async getJobByIdempotencyKey(key: string): Promise<string | null> {
    return this.redis().get(`crawler:idempotency:${key}`);
  }

  async registerIdempotencyKey(key: string, jobId: string): Promise<void> {
    await this.redis().set(`crawler:idempotency:${key}`, jobId, "EX", 86400);
  }
}

export const quotaManager = new QuotaManager();
