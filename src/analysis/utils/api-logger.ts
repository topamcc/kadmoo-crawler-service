/**
 * Console-only API usage logger for crawler analysis.
 * No Supabase - just logs to console for cost tracking visibility.
 */

export async function logApiUsage(_params: {
  provider: string;
  serviceType: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  siteId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  // Fire-and-forget: no-op in crawler, just for API compatibility
}

/** Gemini 2.0 Flash: ~$0.10/1M input, ~$0.40/1M output */
export function geminiCostFromTokens(inputTokens: number, outputTokens: number): number {
  return (inputTokens * 0.1) / 1e6 + (outputTokens * 0.4) / 1e6;
}
