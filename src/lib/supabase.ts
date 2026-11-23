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
  receipt_id?: string | null;
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
  /** Parts (nozzle, plate, ...) this print used; joined client-side from print_part_usages. */
  part_ids?: string[];
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

export const PART_CATEGORIES = [
  'nozzle',
  'hotend',
  'ptfe_tube',
  'build_plate',
  'ams_part',
  'maintenance',
  'other',
] as const;
export type PartCategory = (typeof PART_CATEGORIES)[number];

/** Kinds of parts picked per print (their cost is split by the print time they were used for). */
export const TRACKED_PART_CATEGORIES: PartCategory[] = ['nozzle', 'build_plate', 'hotend', 'ptfe_tube', 'ams_part'];

export const PART_CATEGORY_LABELS: Record<PartCategory, string> = {
  nozzle: 'Nozzle',
  hotend: 'Hotend',
  ptfe_tube: 'PTFE tube',
  build_plate: 'Build plate',
  ams_part: 'AMS part',
  maintenance: 'Maintenance',
  other: 'Other item',
};

/** A printer part or upkeep purchase. Its cost is split by each person's print time since purchase. */
export interface Part {
  id: string;
  name: string;
  category: PartCategory;
  price: number;
  paid_by_user_id: string;
  purchased_at: string; // YYYY-MM-DD
  note?: string | null;
  receipt_id?: string | null;
  /** How the price is shared; missing on databases without add-receipts.sql (treated as 'default'). */
  split_mode?: SplitMode;
  personal_user_id?: string | null;
  /** For 'custom': the share (0..1) the buyer covers; the other person owes the rest. */
  payer_share?: number | null;
  /** Legacy install date (usage now comes from the prints that used the part). */
  installed_at?: string | null;
  /** YYYY-MM-DD; set when replaced -> the split (by print time of prints that used it) is charged. */
  retired_at?: string | null;

  created_at: string;
}

/**
 * default  = by print time since purchase (locked at the next settle-up)
 * even     = 50/50
 * personal = only for personal_user_id
 * custom   = buyer covers payer_share, the other person the rest
 */
export type SplitMode = 'default' | 'even' | 'personal' | 'custom';

/** A saved receipt: who paid, when, and the original file in the "receipts" storage bucket. */
export interface ReceiptRecord {
  id: string;
  vendor: string;
  purchased_at: string; // YYYY-MM-DD
  paid_by_user_id: string;
  total: number;
  file_path?: string | null;
  file_type?: string | null;
  note?: string | null;
  created_at: string;
}
