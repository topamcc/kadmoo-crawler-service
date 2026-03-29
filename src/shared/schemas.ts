import { z } from "zod";

export const createCrawlJobSchema = z.object({
  auditId: z.string().min(1, "auditId is required"),
  url: z
    .string()
    .min(1, "URL is required")
    .refine(
      (v) => /^https?:\/\/.+/.test(v) || /^[a-zA-Z0-9]/.test(v),
      "Must be a valid URL or domain",
    ),
  siteId: z.string().optional(),
  maxPages: z.number().int().min(1).max(50000).optional(),
  maxDepth: z.number().int().min(1).max(50).optional(),
  maxDurationMinutes: z.number().int().min(1).max(120).optional(),
  concurrency: z.number().int().min(1).max(50).optional(),
  timeoutMs: z.number().int().min(1000).max(60000).optional(),
  respectRobotsTxt: z.boolean().optional(),
  forcePlaywright: z.boolean().optional(),
  includeSubdomains: z.boolean().optional(),
  webhookUrl: z.string().url().optional(),
  idempotencyKey: z.string().max(128).optional(),
});

export type CreateCrawlJobInput = z.infer<typeof createCrawlJobSchema>;

export const homepageSnapshotSchema = z.object({
  url: z
    .string()
    .min(1, "URL is required")
    .refine(
      (v) => /^https?:\/\/.+/.test(v) || /^[a-zA-Z0-9]/.test(v),
      "Must be a valid URL or domain",
    ),
  forcePlaywright: z.boolean().optional(),
});

export type HomepageSnapshotInput = z.infer<typeof homepageSnapshotSchema>;
