import type { Part, PrintJob } from './supabase';

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

/**
 * Each user's share (0..1) of a part's cost: their print time since the part was bought,
 * divided by everyone's print time since then. 50/50 while nobody has printed since.
 */
export function partShares(
  part: Pick<Part, 'purchased_at'>,
  prints: PrintJob[],
  userIds: [string, string]
): Record<string, number> {
  const [a, b] = userIds;
  const minutes = printMinutesByUser(prints, userIds, day(part.purchased_at));
  const total = minutes[a] + minutes[b];
  if (total <= 0) return { [a]: 0.5, [b]: 0.5 };
  return { [a]: minutes[a] / total, [b]: minutes[b] / total };
}

/**
 * How much user A owes user B because of parts (negative = B owes A).
 * The person who didn't pay owes the payer their share of the price.
 */
export function partsBalanceAOwesB(parts: Part[], prints: PrintJob[], userIds: [string, string]): number {
  const [a, b] = userIds;
  let aOwesB = 0;
  for (const part of parts) {
    const price = Number(part.price || 0);
    const shares = partShares(part, prints, userIds);
    if (part.paid_by_user_id === b) aOwesB += price * shares[a];
    else if (part.paid_by_user_id === a) aOwesB -= price * shares[b];
  }
  return aOwesB;
}

/** "2h 05m" style label for a number of minutes. */
export function formatMinutes(total: number): string {
  const m = Math.round(total);
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (!h) return `${rest}m`;
  return `${h}h ${String(rest).padStart(2, '0')}m`;
}
