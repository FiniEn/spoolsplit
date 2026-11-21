import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

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
