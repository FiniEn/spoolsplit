import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

/** False when the Supabase env vars were missing at build time (e.g. not enabled for Vercel Preview). */
export const supabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);
export const missingSupabaseVars = [
  !supabaseUrl && 'the Supabase URL (NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL)',
  !supabaseAnonKey &&
    'the Supabase anon/publishable key (NEXT_PUBLIC_SUPABASE_ANON_KEY or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)',
].filter(Boolean) as string[];

// Fall back to a dummy client so the build doesn't crash; the page shows a clear message instead.
export const supabase = createClient(
  supabaseUrl || 'https://supabase-not-configured.invalid',
  supabaseAnonKey || 'missing-anon-key'
);

export interface User {
  id: string;
  name: string;
  avatar_color: string;
}

export interface Spool {
  id: string;
  brand: string;
  material: string;
  color_name: string;
  color_hex: string;
  initial_weight_g: number;
  remaining_weight_g: number;
  purchase_price: number;
  cost_per_gram: number;
  paid_by_user_id: string;
  is_shared_split: boolean;
  receipt_url?: string | null;
  is_archived: boolean;
  created_at: string;
}

export interface PrintSpoolUsage {
  id?: string;
  print_id?: string;
  spool_id: string;
  grams_used: number;
  calculated_cost: number;
}

export interface PrintJob {
  id: string;
  title: string;
  printed_by_user_id: string | null;
  is_shared_print: boolean;
  duration_minutes?: number | null;
  source_type: 'screenshot' | 'url' | 'manual';
  source_url?: string | null;
  total_grams: number;
  total_cost: number;
  created_at: string;
  print_spool_usages?: PrintSpoolUsage[];
}

export interface Settlement {
  id: string;
  from_user_id: string;
  to_user_id: string;
  amount: number;
  method: string;
  note?: string | null;
  settled_at: string;
}
