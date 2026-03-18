/**
 * Supabase client for audit analysis.
 * Uses service role key for site_audits updates.
 */

import { createClient } from "@supabase/supabase-js";
import { config } from "../config/index.js";

let supabaseInstance: ReturnType<typeof createClient> | null = null;

export function getSupabaseClient() {
  if (!supabaseInstance) {
    if (!config.supabaseUrl || !config.supabaseServiceKey) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY for analysis");
    }
    supabaseInstance = createClient(config.supabaseUrl, config.supabaseServiceKey);
  }
  return supabaseInstance;
}
