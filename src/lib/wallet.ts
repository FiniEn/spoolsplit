import type { Part, PrintJob, Settlement, Spool, User } from './supabase';
import { formatMinutes } from './split';

/**
 * Wallet model: whoever buys something pays from their own pocket. When you use something the
 * other person bought, you owe them for it; using your own purchases costs nothing ("you pay
 * yourself"). Everything nets out to at most one payment between the two people.
 *
 * Sign convention: positive balance / delta = users[0] owes users[1].
 */

export type EntryKind = 'spool' | 'part' | 'print' | 'payment';

export interface WalletEntry {
  key: string;
  when: string; // ISO timestamp (parts: purchase date at 00:00 UTC)
  kind: EntryKind;
  title: string;
  detail: string;
  /** Change to the balance (positive = users[0] owes users[1] more). 0 for purchases that move no money. */
  delta: number;
  /** Balance right after this entry. */
  runningBalance: number;
  /** Purchase price or payment amount, for display. */
  amount?: number;
  printId?: string;
  settlementId?: string;
  partId?: string;
}

export interface WalletPeriod {
  /** The payment that settled the balance and closed this period; undefined for the open period. */
  closedBy?: Settlement;
  /** Entries oldest → newest. */
  entries: WalletEntry[];
}

export interface PersonSummary {
  userId: string;
  boughtSpools: number;
  boughtParts: number;
  /** Cost of filament they used from their own spools (no transfer needed). */
  usedOwn: number;
  /** Cost of filament they used from the other person's spools (owed to them). */
  usedOther: number;
  /** Their print-time share of parts the other person bought. */
  partsShareOwed: number;
  sent: number;
  received: number;
}

export interface PartSplitInfo {
  shares: Record<string, number>;
  frozen: boolean;
  /** True when the split was chosen by hand (50/50, personal or custom). */
  manual?: boolean;
}

export interface WalletResult {
  balance: number;
  amount: number;
  debtorId: string;
  creditorId: string;
  /** Newest first: the open period, then closed periods. */
  periods: WalletPeriod[];
  partSplit: Map<string, PartSplitInfo>;
  /** Totals for the open period (since the last settle-up). */
  summary: PersonSummary[];
}

const SETTLED_EPSILON = 0.01;

type Ev =
  | { ts: string; order: number; kind: 'spool'; spool: Spool }
  | { ts: string; order: number; kind: 'part'; part: Part }
  | { ts: string; order: number; kind: 'print'; print: PrintJob }
  | { ts: string; order: number; kind: 'payment'; st: Settlement };

interface OpenPart {
  part: Part;
  minutes: Record<string, number>;
  entry: WalletEntry;
}

export function computeWallet(input: {
  users: User[];
  spools: Spool[];
  prints: PrintJob[];
  parts: Part[];
  settlements: Settlement[];
}): WalletResult {
  const { users, spools, prints, parts, settlements } = input;
  const empty: WalletResult = {
    balance: 0,
    amount: 0,
    debtorId: '',
    creditorId: '',
    periods: [{ entries: [] }],
    partSplit: new Map(),
    summary: users.map((u) => newSummary(u.id)),
  };
  if (users.length < 2) return empty;

  const [A, B] = [users[0].id, users[1].id];
  const name = (id: string | null | undefined) => users.find((u) => u.id === id)?.name || 'Someone';
  const spoolById = new Map(spools.map((s) => [s.id, s]));
  const spoolLabel = (s: Spool) => `${s.material} ${s.color_name}`.trim();

  // --- Build the timeline ---------------------------------------------------------------------
  const events: Ev[] = [
    ...spools.map((spool): Ev => ({ ts: spool.created_at, order: 0, kind: 'spool', spool })),
    ...parts.map((part): Ev => ({ ts: `${part.purchased_at.slice(0, 10)}T00:00:00.000Z`, order: 0, kind: 'part', part })),
    ...prints.map((print): Ev => ({ ts: print.created_at, order: 1, kind: 'print', print })),
    ...settlements.map((st): Ev => ({ ts: st.settled_at, order: 2, kind: 'payment', st })),
  ];
  events.sort((x, y) => {
    const tx = Date.parse(x.ts) || 0;
    const ty = Date.parse(y.ts) || 0;
    return tx - ty || x.order - y.order;
  });

  // --- Replay ---------------------------------------------------------------------------------
  let fixed = 0; // everything except still-open parts
  let open: OpenPart[] = [];
  const partSplit = new Map<string, PartSplitInfo>();
  const periods: WalletPeriod[] = [];
  let current: WalletEntry[] = [];
  let summary = { [A]: newSummary(A), [B]: newSummary(B) };

  const sharesOf = (m: Record<string, number>) => {
    const total = m[A] + m[B];
    return total > 0 ? { [A]: m[A] / total, [B]: m[B] / total } : { [A]: 0.5, [B]: 0.5 };
  };
  /** How much A owes B for this part, given its print-time split. */
  const partValue = (part: Part, shares: Record<string, number>) => {
    const price = Number(part.price || 0);
    if (part.paid_by_user_id === B) return price * shares[A];
    if (part.paid_by_user_id === A) return -price * shares[B];
    return 0;
  };
  const openValue = () => open.reduce((sum, op) => sum + partValue(op.part, sharesOf(op.minutes)), 0);
  const pct = (shares: Record<string, number>) =>
    `${name(A)} ${Math.round(shares[A] * 100)}% / ${name(B)} ${Math.round(shares[B] * 100)}%`;

  /** Value every open part with its current split and write the numbers into its entry. */
  const settleOpenParts = (freeze: boolean) => {
    for (const op of open) {
      const shares = sharesOf(op.minutes);
      const value = partValue(op.part, shares);
      op.entry.delta = value;
      op.entry.detail = `${money(Number(op.part.price))} • split by print time: ${pct(shares)}${freeze ? ' (locked)' : ' (so far)'}`;
      partSplit.set(op.part.id, { shares, frozen: freeze });
      const payer = op.part.paid_by_user_id;
      const other = payer === A ? B : payer === B ? A : '';
      if (other) summary[other].partsShareOwed += Number(op.part.price || 0) * shares[other];
      if (freeze) fixed += value;
    }
    if (freeze) open = [];
  };

  for (const ev of events) {
    if (ev.kind === 'spool') {
      const s = ev.spool;
      const payer = s.paid_by_user_id;
      if (summary[payer]) summary[payer].boughtSpools += Number(s.purchase_price || 0);
      current.push({
        key: `spool-${s.id}`,
        when: ev.ts,
        kind: 'spool',
        title: `${name(payer)} bought ${s.brand} ${spoolLabel(s)}`,
        detail: `${Number(s.initial_weight_g).toFixed(0)} g • paid from own wallet, no transfer yet`,
        delta: 0,
        runningBalance: 0,
        amount: Number(s.purchase_price || 0),
      });
    } else if (ev.kind === 'part') {
      const part = ev.part;
      if (summary[part.paid_by_user_id]) summary[part.paid_by_user_id].boughtParts += Number(part.price || 0);
      const entry: WalletEntry = {
        key: `part-${part.id}`,
        when: ev.ts,
        kind: 'part',
        title: `${name(part.paid_by_user_id)} bought ${part.name}`,
        detail: '',
        delta: 0,
        runningBalance: 0,
        amount: Number(part.price || 0),
        partId: part.id,
      };
      const manual = manualShares(part, A, B, name);
      if (manual) {
        // Split chosen by hand: charged in full right away, print time doesn't matter.
        const value = partValue(part, manual.shares);
        entry.delta = value;
        entry.detail = `${money(Number(part.price))} • ${manual.label}`;
        fixed += value;
        partSplit.set(part.id, { shares: manual.shares, frozen: true, manual: true });
        const other = part.paid_by_user_id === A ? B : part.paid_by_user_id === B ? A : '';
        if (other) summary[other].partsShareOwed += Number(part.price || 0) * manual.shares[other];
      } else {
        open.push({ part, minutes: { [A]: 0, [B]: 0 }, entry });
      }
      current.push(entry);
    } else if (ev.kind === 'print') {
      const p = ev.print;
      let delta = 0;
      const pieces: string[] = [];
      for (const u of p.print_spool_usages || []) {
        const spool = spoolById.get(u.spool_id);
        const cost = Number(u.calculated_cost || 0);
        if (!spool) continue;
        const owner = spool.paid_by_user_id;
        const ownerName = name(owner);
        const grams = `${Number(u.grams_used).toFixed(0)} g of ${ownerName}'s ${spoolLabel(spool)} (${money(cost)})`;
        pieces.push(grams);
        if (owner !== A && owner !== B) continue;
        const other = owner === A ? B : A;
        if (p.is_shared_print) {
          summary[owner].usedOwn += cost / 2;
          summary[other].usedOther += cost / 2;
          delta += owner === B ? cost / 2 : -cost / 2;
        } else if (p.printed_by_user_id === owner) {
          summary[owner].usedOwn += cost;
        } else if (p.printed_by_user_id === other) {
          summary[other].usedOther += cost;
          delta += owner === B ? cost : -cost;
        }
      }
      // Print time feeds the split of every part that is still open
      const minutes = Math.max(0, Number(p.duration_minutes || 0));
      for (const op of open) {
        if (p.is_shared_print) {
          op.minutes[A] += minutes / 2;
          op.minutes[B] += minutes / 2;
        } else if (p.printed_by_user_id === A || p.printed_by_user_id === B) {
          op.minutes[p.printed_by_user_id] += minutes;
        }
      }
      fixed += delta;
      const who = p.is_shared_print ? 'Shared print' : `${name(p.printed_by_user_id)} printed`;
      const ownOnly = delta === 0 && pieces.length > 0 && !p.is_shared_print;
      current.push({
        key: `print-${p.id}`,
        when: ev.ts,
        kind: 'print',
        title: `${who} “${p.title}”`,
        detail:
          [pieces.join(', '), minutes ? formatMinutes(minutes) : ''].filter(Boolean).join(' • ') +
          (ownOnly ? ' • own filament, no transfer needed' : ''),
        delta,
        runningBalance: 0,
        amount: Number(p.total_cost || 0),
        printId: p.id,
      });
    } else {
      const st = ev.st;
      const amt = Number(st.amount || 0);
      let delta = 0;
      if (st.from_user_id === A && st.to_user_id === B) delta = -amt;
      else if (st.from_user_id === B && st.to_user_id === A) delta = amt;
      if (summary[st.from_user_id]) summary[st.from_user_id].sent += amt;
      if (summary[st.to_user_id]) summary[st.to_user_id].received += amt;
      fixed += delta;
      current.push({
        key: `payment-${st.id}`,
        when: ev.ts,
        kind: 'payment',
        title: `${name(st.from_user_id)} paid ${name(st.to_user_id)}`,
        detail: [st.method, st.note].filter(Boolean).join(' • '),
        delta,
        runningBalance: 0,
        amount: amt,
        settlementId: st.id,
      });
      // A payment that brings the balance to zero is a settle-up: close the books.
      if (delta !== 0 && Math.abs(fixed + openValue()) < SETTLED_EPSILON) {
        settleOpenParts(true);
        fixed = 0; // settled: drop any sub-cent rounding
        periods.push({ closedBy: st, entries: current });
        current = [];
        summary = { [A]: newSummary(A), [B]: newSummary(B) };
      }
    }
  }
  settleOpenParts(false);
  periods.push({ entries: current });

  // Running balances: plain sums of the rows, so the history always adds up to the balance.
  let running = 0;
  for (const period of periods) {
    for (const e of period.entries) {
      running += e.delta;
      e.runningBalance = Math.abs(running) < 0.005 ? 0 : running;
    }
    if (period.closedBy) running = 0; // settled (any sub-cent rounding is dropped)
  }

  const balance = Math.abs(running) < SETTLED_EPSILON ? 0 : running;
  const [debtorId, creditorId] = balance > 0 ? [A, B] : balance < 0 ? [B, A] : ['', ''];
  return {
    balance,
    amount: Math.abs(balance),
    debtorId,
    creditorId,
    periods: periods.reverse(),
    partSplit,
    summary: [summary[A], summary[B]],
  };
}

/**
 * Shares (0..1 per user) for a part whose split was chosen by hand, or null for the default
 * print-time split. `name` is only used to build the label.
 */
export function manualShares(
  part: Pick<Part, 'split_mode' | 'personal_user_id' | 'payer_share' | 'paid_by_user_id'>,
  A: string,
  B: string,
  name: (id: string) => string = (id) => id
): { shares: Record<string, number>; label: string } | null {
  const mode = part.split_mode || 'default';
  if (mode === 'even') return { shares: { [A]: 0.5, [B]: 0.5 }, label: 'split 50/50' };
  if (mode === 'personal' && (part.personal_user_id === A || part.personal_user_id === B)) {
    const who = part.personal_user_id;
    return {
      shares: { [A]: who === A ? 1 : 0, [B]: who === B ? 1 : 0 },
      label: `only for ${name(who)} (personal)`,
    };
  }
  if (mode === 'custom' && part.payer_share != null && (part.paid_by_user_id === A || part.paid_by_user_id === B)) {
    const payerShare = Math.min(1, Math.max(0, Number(part.payer_share)));
    const payer = part.paid_by_user_id;
    const other = payer === A ? B : A;
    const shares = { [payer]: payerShare, [other]: 1 - payerShare };
    return {
      shares,
      label: `custom split: ${name(A)} ${Math.round(shares[A] * 100)}% / ${name(B)} ${Math.round(shares[B] * 100)}%`,
    };
  }
  return null;
}

function newSummary(userId: string): PersonSummary {
  return { userId, boughtSpools: 0, boughtParts: 0, usedOwn: 0, usedOther: 0, partsShareOwed: 0, sent: 0, received: 0 };
}

function money(n: number) {
  return `$${n.toFixed(2)}`;
}
