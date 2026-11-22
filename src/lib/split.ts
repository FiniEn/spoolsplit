import type { PrintJob } from './supabase';

/** YYYY-MM-DD of a timestamp (or date string), for comparing print dates with part purchase dates. */
const day = (ts: string) => ts.slice(0, 10);

/**
 * Print minutes per user for prints created on or after `sinceDate` (YYYY-MM-DD; omit for all time).
 * Shared prints count half for each of the two users.
 */
export function printMinutesByUser(
  prints: PrintJob[],
  userIds: [string, string],
  sinceDate?: string
): Record<string, number> {
  const [a, b] = userIds;
  const minutes: Record<string, number> = { [a]: 0, [b]: 0 };
  for (const p of prints) {
    if (sinceDate && day(p.created_at) < sinceDate) continue;
    const m = Math.max(0, Number(p.duration_minutes || 0));
    if (!m) continue;
    if (p.is_shared_print) {
      minutes[a] += m / 2;
      minutes[b] += m / 2;
    } else if (p.printed_by_user_id && p.printed_by_user_id in minutes) {
      minutes[p.printed_by_user_id] += m;
    }
  }
  return minutes;
}

/** "2h 05m" style label for a number of minutes. */
export function formatMinutes(total: number): string {
  const m = Math.round(total);
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (!h) return `${rest}m`;
  return `${h}h ${String(rest).padStart(2, '0')}m`;
}
