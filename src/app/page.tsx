'use client';

import React, { useEffect, useState, useMemo } from 'react';
import {
  supabase,
  supabaseConfigured,
  missingSupabaseVars,
  User,
  PrintSpoolUsage,
  Spool,
  PrintJob,
  Settlement,
  Part,
  PartCategory,
  ReceiptRecord,
  SplitMode,
  PART_CATEGORIES,
  PART_CATEGORY_LABELS,
} from '@/lib/supabase';
import { formatMinutes, printMinutesByUser } from '@/lib/split';
import { computeWallet, manualShares, WalletEntry } from '@/lib/wallet';
import {
  Disc,
  Printer,
  Receipt,
  Download,
  Sparkles,
  Trash2,
  Loader2,
  Upload,
  Archive,
  X,
  HandCoins,
  Wrench,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  FileText,
  Lock,
} from 'lucide-react';

type StagedSpool = {
  brand: string;
  material: string;
  color_name: string;
  color_hex: string;
  initial_weight_g: number | string;
  purchase_price: number | string;
};

type StagedPart = {
  name: string;
  category: PartCategory;
  price: number | string;
  split: SplitChoice;
};

/**
 * How one receipt item is shared, as the picker shows it. Custom is stored as the first user's
 * percentage here and converted to the buyer's share (payer_share) when saved.
 */
type SplitChoice = { mode: SplitMode; personalUserId: string | null; firstUserPct: number };
const DEFAULT_SPLIT: SplitChoice = { mode: 'default', personalUserId: null, firstUserPct: 50 };

/** Picker value → database columns for a part bought by `payerId`. */
function splitToColumns(split: SplitChoice, payerId: string, users: User[]) {
  const firstIsPayer = users[0]?.id === payerId;
  const pct = Math.min(100, Math.max(0, Number(split.firstUserPct) || 0)) / 100;
  return {
    split_mode: split.mode,
    personal_user_id: split.mode === 'personal' ? split.personalUserId : null,
    payer_share: split.mode === 'custom' ? Number((firstIsPayer ? pct : 1 - pct).toFixed(4)) : null,
  };
}

/** Database columns → picker value. */
function columnsToSplit(part: Part, users: User[]): SplitChoice {
  const mode = part.split_mode || 'default';
  let firstUserPct = 50;
  if (mode === 'custom' && part.payer_share != null) {
    const payerShare = Number(part.payer_share);
    firstUserPct = Math.round((users[0]?.id === part.paid_by_user_id ? payerShare : 1 - payerShare) * 100);
  }
  return { mode, personalUserId: part.personal_user_id || null, firstUserPct };
}

/** Dropdown (+ percentage box for custom) to choose how one item is shared. */
function SplitPicker({
  value,
  users,
  onChange,
  compact,
}: {
  value: SplitChoice;
  users: User[];
  onChange: (next: SplitChoice) => void;
  compact?: boolean;
}) {
  const selectValue = value.mode === 'personal' ? `personal:${value.personalUserId}` : value.mode;
  const [pctDraft, setPctDraft] = useState(String(value.firstUserPct));
  useEffect(() => setPctDraft(String(value.firstUserPct)), [value.firstUserPct]);
  const commitPct = () => {
    const n = Math.min(100, Math.max(0, Math.round(Number(pctDraft) || 0)));
    setPctDraft(String(n));
    if (n !== value.firstUserPct) onChange({ ...value, firstUserPct: n });
  };
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <select
        value={selectValue}
        onChange={(e) => {
          const v = e.target.value;
          if (v.startsWith('personal:')) onChange({ ...value, mode: 'personal', personalUserId: v.slice(9) });
          else onChange({ ...value, mode: v as SplitMode });
        }}
        className={`bg-slate-900 border border-slate-800 rounded p-1.5 min-w-0 ${compact ? 'text-[11px]' : 'text-xs'}`}
        aria-label="How to split this item"
      >
        <option value="default">By print time (default)</option>
        <option value="even">Split 50/50</option>
        {users.map((u) => (
          <option key={u.id} value={`personal:${u.id}`}>
            Only for {u.name}
          </option>
        ))}
        <option value="custom">Custom %</option>
      </select>
      {value.mode === 'custom' && users.length >= 2 && (
        <label className="flex items-center gap-1 text-[11px] text-slate-400 shrink-0">
          {users[0].name}
          <input
            type="number"
            min="0"
            max="100"
            value={pctDraft}
            onChange={(e) => setPctDraft(e.target.value)}
            onBlur={commitPct}
            onKeyDown={(e) => e.key === 'Enter' && commitPct()}
            className="w-12 bg-slate-900 border border-slate-800 rounded p-1"
            aria-label={`${users[0].name}'s percentage`}
          />
          % / {users[1].name} {100 - (Math.min(100, Math.max(0, Number(pctDraft) || 0)))}%
        </label>
      )}
    </div>
  );
}

type UsageDraft = { spool_id: string; grams_used: number };

const newStagedPart = (overrides: Partial<StagedPart> = {}): StagedPart => ({
  name: '',
  category: 'nozzle',
  price: '',
  split: DEFAULT_SPLIT,
  ...overrides,
});

/** Today's date as YYYY-MM-DD in the viewer's time zone. */
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const newStagedSpool = (overrides: Partial<StagedSpool> = {}): StagedSpool => ({
  brand: 'Bambu Lab',
  material: 'PLA Basic',
  color_name: 'Black',
  color_hex: '#000000',
  initial_weight_g: 1000,
  purchase_price: 19.99,
  ...overrides,
});

const money = (n: number) => `$${n.toFixed(2)}`;

/** Throws if a Supabase call returned an error, so callers can surface it. */
function check<T extends { error: { message: string } | null }>(res: T): T {
  if (res.error) throw new Error(res.error.message);
  return res;
}

/** Calls one of our AI routes and throws a readable error on failure. */
async function callAi(path: string, body: unknown) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    // fall through to the status check below
  }
  if (!res.ok || data?.error) {
    throw new Error(data?.error || `AI request failed (${res.status})`);
  }
  return data;
}

export default function SpoolSplitApp() {
  const [users, setUsers] = useState<User[]>([]);
  const [activeUserId, setActiveUserId] = useState<string>('');
  // All spools, including archived ones: archived spools still matter for the money.
  const [allSpools, setAllSpools] = useState<Spool[]>([]);
  const [prints, setPrints] = useState<PrintJob[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [parts, setParts] = useState<Part[]>([]);
  const [receipts, setReceipts] = useState<ReceiptRecord[]>([]);
  const [openReceiptId, setOpenReceiptId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'prints' | 'spools' | 'settle'>('prints');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Modals
  const [showReceiptModal, setShowReceiptModal] = useState(false);
  const [showPrintModal, setShowPrintModal] = useState(false);

  // Receipt AI State
  const [aiLoading, setAiLoading] = useState(false);
  const [receiptPaidBy, setReceiptPaidBy] = useState<string>('');
  const [receiptText, setReceiptText] = useState('');
  const [stagedSpools, setStagedSpools] = useState<StagedSpool[]>([]);
  const [stagedParts, setStagedParts] = useState<StagedPart[]>([]);
  const [receiptDate, setReceiptDate] = useState(todayIso());
  const [receiptVendor, setReceiptVendor] = useState('');
  const [receiptTotal, setReceiptTotal] = useState<number | null>(null);
  const [receiptFile, setReceiptFile] = useState<File | null>(null);

  // Print Logger State
  const [printTitle, setPrintTitle] = useState('');
  const [printedBy, setPrintedBy] = useState<string>('');
  const [isSharedPrint, setIsSharedPrint] = useState(false);
  const [printHours, setPrintHours] = useState('');
  const [printMins, setPrintMins] = useState('');
  const [printNoteOrUrl, setPrintNoteOrUrl] = useState('');
  const [printSource, setPrintSource] = useState<'manual' | 'url' | 'screenshot'>('manual');
  const [printHint, setPrintHint] = useState<string | null>(null);
  const [usages, setUsages] = useState<UsageDraft[]>([]);

  // Settlement Form State
  const [settleFrom, setSettleFrom] = useState('');
  const [settleTo, setSettleTo] = useState('');
  const [settleAmount, setSettleAmount] = useState('');
  const [settleMethod, setSettleMethod] = useState('Venmo');
  const [settleNote, setSettleNote] = useState('');
  const [showOtherAmount, setShowOtherAmount] = useState(false);

  const spools = useMemo(() => allSpools.filter((s) => !s.is_archived), [allSpools]);
  const userName = (id: string | null | undefined) =>
    users.find((u) => u.id === id)?.name || 'Unknown';

  /** Runs an async action and shows any error in the banner instead of failing silently. */
  const run = async (fn: () => Promise<void>) => {
    setErrorMsg(null);
    try {
      await fn();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Something went wrong');
    }
  };

  const fetchAllData = async () => {
    if (!supabaseConfigured) {
      throw new Error(
        `Supabase is not configured. Missing when this version was built: ${missingSupabaseVars.join(
          ' and '
        )}. Check the variable names in Vercel (Settings → Environment Variables), then redeploy.`
      );
    }
    // Prints and their filament rows are loaded separately and joined here, so this works even if
    // the database has no foreign key between print_spool_usages.print_id and prints.id.
    const [u, s, p, pu, st, pa, rc] = await Promise.all([
      supabase.from('users').select('*').order('name'),
      supabase.from('spools').select('*').order('created_at', { ascending: false }),
      supabase.from('prints').select('*').order('created_at', { ascending: false }),
      supabase.from('print_spool_usages').select('*'),
      supabase.from('settlements').select('*').order('settled_at', { ascending: false }),
      supabase.from('parts').select('*').order('purchased_at', { ascending: false }),
      supabase.from('receipts').select('*').order('purchased_at', { ascending: false }),
    ]);
    if (pa.error && /parts/.test(pa.error.message)) {
      throw new Error(
        `Could not load data: the "parts" table is missing. Run supabase/add-parts.sql once in the Supabase SQL Editor. (${pa.error.message})`
      );
    }
    if (rc.error && /receipts/.test(rc.error.message)) {
      throw new Error(
        `Could not load data: the "receipts" table is missing. Run supabase/add-receipts.sql once in the Supabase SQL Editor. (${rc.error.message})`
      );
    }
    const firstError = [u, s, p, pu, st, pa, rc].find((r) => r.error)?.error;
    if (firstError) throw new Error(`Could not load data: ${firstError.message}`);

    const userRows = (u.data || []) as User[];
    if (userRows.length > 0) {
      setUsers(userRows);
      if (!activeUserId) {
        setActiveUserId(userRows[0].id);
        setReceiptPaidBy(userRows[0].id);
        setPrintedBy(userRows[0].id);
        setSettleFrom(userRows[0].id);
        setSettleTo(userRows[1]?.id || userRows[0].id);
      }
    }
    setAllSpools((s.data || []) as Spool[]);
    const usagesByPrint = new Map<string, PrintSpoolUsage[]>();
    ((pu.data || []) as PrintSpoolUsage[]).forEach((row) => {
      if (!row.print_id) return;
      const list = usagesByPrint.get(row.print_id) || [];
      list.push(row);
      usagesByPrint.set(row.print_id, list);
    });
    setPrints(
      ((p.data || []) as PrintJob[]).map((pr) => ({
        ...pr,
        print_spool_usages: usagesByPrint.get(pr.id) || [],
      }))
    );
    setSettlements((st.data || []) as Settlement[]);
    setParts((pa.data || []) as Part[]);
    setReceipts((rc.data || []) as ReceiptRecord[]);
  };

  useEffect(() => {
    run(fetchAllData);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fileToBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        const result = reader.result as string;
        resolve(result.split(',')[1]);
      };
      reader.onerror = reject;
    });

  /**
   * Wallet: replays every purchase, print and payment. Using your own purchases costs nothing;
   * using the other person's means you owe them. Nets to at most one payment between the two.
   */
  const wallet = useMemo(
    () => computeWallet({ users, spools: allSpools, prints, parts, settlements }),
    [users, allSpools, prints, parts, settlements]
  );
  const ledger = {
    text:
      users.length < 2
        ? 'Setting up users...'
        : wallet.debtorId
          ? `${userName(wallet.debtorId)} owes ${userName(wallet.creditorId)}`
          : 'All settled up!',
    amount: wallet.amount,
    debtorId: wallet.debtorId,
    creditorId: wallet.creditorId,
  };

  /** Short label for what a history entry did to the balance. */
  const entryBadge = (e: WalletEntry) => {
    if (e.kind === 'payment') return { text: `paid ${money(e.amount || 0)}`, tone: 'pay' as const };
    if (Math.abs(e.delta) < 0.005) return { text: 'no transfer', tone: 'none' as const };
    const credited = e.delta > 0 ? users[1] : users[0];
    return { text: `${credited?.name} +${money(Math.abs(e.delta))}`, tone: 'owe' as const };
  };
  const runningLabel = (v: number) => {
    if (users.length < 2 || Math.abs(v) < 0.005) return 'even';
    return v > 0
      ? `${users[0].name} owes ${users[1].name} ${money(v)}`
      : `${users[1].name} owes ${users[0].name} ${money(-v)}`;
  };

  /** All-time print minutes per person (shared prints count half each). */
  const printTimeTotals = useMemo(
    () => (users.length >= 2 ? printMinutesByUser(prints, [users[0].id, users[1].id]) : {}),
    [users, prints]
  );

  const handleReceiptParse = (file?: File) =>
    run(async () => {
      setAiLoading(true);
      try {
        let fileBase64: string | undefined;
        let mimeType: string | undefined;
        if (file) {
          fileBase64 = await fileToBase64(file);
          mimeType = file.type;
        }
        const data = await callAi('/api/ai/parse-receipt', {
          fileBase64,
          mimeType,
          rawText: receiptText,
        });
        const foundSpools: any[] = Array.isArray(data.spools) ? data.spools : [];
        const foundParts: any[] = Array.isArray(data.parts) ? data.parts : [];
        if (foundSpools.length === 0 && foundParts.length === 0) {
          throw new Error('No spools or parts were found on that receipt');
        }
        if (typeof data.order_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.order_date)) {
          setReceiptDate(data.order_date);
        }
        if (file) setReceiptFile(file);
        if (typeof data.vendor === 'string') setReceiptVendor(data.vendor);
        setReceiptTotal(Number(data.grand_total) > 0 ? Number(data.grand_total) : null);
        const expandedParts: StagedPart[] = [];
        foundParts.forEach((pt: any) => {
          const qty = Math.max(1, Math.min(50, Number(pt.quantity) || 1));
          const category: PartCategory = PART_CATEGORIES.includes(pt.category) ? pt.category : 'other';
          for (let i = 0; i < qty; i++) {
            expandedParts.push(
              newStagedPart({
                name: pt.name || PART_CATEGORY_LABELS[category],
                category,
                price: Number(pt.unit_landed_cost || 0).toFixed(2),
              })
            );
          }
        });
        setStagedParts(expandedParts);
        const expanded: StagedSpool[] = [];
        foundSpools.forEach((s: any) => {
          const qty = Math.max(1, Math.min(50, Number(s.quantity) || 1));
          for (let i = 0; i < qty; i++) {
            expanded.push(
              newStagedSpool({
                brand: s.brand || 'Bambu Lab',
                material: s.material || 'PLA Basic',
                color_name: s.color_name || 'Black',
                color_hex: s.estimated_color_hex || '#000000',
                initial_weight_g: s.weight_grams || 1000,
                purchase_price: Number(s.unit_landed_cost || 20).toFixed(2),
              })
            );
          }
        });
        setStagedSpools(expanded);
      } finally {
        setAiLoading(false);
      }
    });

  const updateStaged = (idx: number, patch: Partial<StagedSpool>) =>
    setStagedSpools((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));

  const updateStagedPart = (idx: number, patch: Partial<StagedPart>) =>
    setStagedParts((prev) => prev.map((pt, i) => (i === idx ? { ...pt, ...patch } : pt)));

  const saveStagedPurchase = () =>
    run(async () => {
      if (stagedSpools.length === 0 && stagedParts.length === 0) return;
      const paidBy = receiptPaidBy || activeUserId;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(receiptDate)) throw new Error('Pick the purchase date');
      const spoolRows = stagedSpools.map((s) => {
        const weight = Number(s.initial_weight_g);
        const price = Number(s.purchase_price);
        if (!(weight > 0)) throw new Error(`Spool "${s.color_name}" needs a weight above 0 g`);
        if (!(price >= 0)) throw new Error(`Spool "${s.color_name}" needs a valid price`);
        return {
          brand: s.brand,
          material: s.material,
          color_name: s.color_name,
          color_hex: s.color_hex,
          initial_weight_g: weight,
          remaining_weight_g: weight,
          purchase_price: price,
          paid_by_user_id: paidBy,
        };
      });
      const partRows = stagedParts.map((pt) => {
        const price = Number(pt.price);
        if (!pt.name.trim()) throw new Error('Every part needs a name');
        if (pt.price === '' || !(price >= 0)) throw new Error(`Part "${pt.name}" needs a valid price`);
        if (pt.split.mode === 'personal' && !pt.split.personalUserId) throw new Error(`Pick who "${pt.name}" is for`);
        return {
          name: pt.name.trim(),
          category: pt.category,
          price: Number(price.toFixed(2)),
          paid_by_user_id: paidBy,
          purchased_at: receiptDate,
          ...splitToColumns(pt.split, paidBy, users),
        };
      });
      const itemsTotal =
        spoolRows.reduce((sum, r) => sum + r.purchase_price, 0) + partRows.reduce((sum, r) => sum + r.price, 0);
      setSaving(true);
      try {
        // 1. The receipt itself
        const { data: receipt } = check(
          await supabase
            .from('receipts')
            .insert({
              vendor: receiptVendor.trim(),
              purchased_at: receiptDate,
              paid_by_user_id: paidBy,
              total: Number((receiptTotal ?? itemsTotal).toFixed(2)),
            })
            .select()
            .single()
        );
        const undo = async (spoolIds: string[]) => {
          if (spoolIds.length > 0) await supabase.from('spools').delete().in('id', spoolIds);
          await supabase.from('receipts').delete().eq('id', receipt.id);
        };
        // 2. The original file (optional: a failed upload doesn't lose the purchase)
        let uploadWarning: string | null = null;
        if (receiptFile) {
          const ext = (receiptFile.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
          const path = `${receipt.id}.${ext}`;
          const up = await supabase.storage.from('receipts').upload(path, receiptFile, {
            contentType: receiptFile.type || undefined,
            upsert: true,
          });
          if (up.error) uploadWarning = `Saved, but the receipt file could not be stored: ${up.error.message}`;
          else await supabase.from('receipts').update({ file_path: path, file_type: receiptFile.type || null }).eq('id', receipt.id);
        }
        // 3. Its items
        let insertedSpoolIds: string[] = [];
        if (spoolRows.length > 0) {
          const res = await supabase
            .from('spools')
            .insert(spoolRows.map((r) => ({ ...r, receipt_id: receipt.id })))
            .select('id');
          if (res.error) {
            await undo([]);
            throw new Error(res.error.message);
          }
          insertedSpoolIds = (res.data || []).map((r: { id: string }) => r.id);
        }
        if (partRows.length > 0) {
          const partRes = await supabase.from('parts').insert(partRows.map((r) => ({ ...r, receipt_id: receipt.id })));
          if (partRes.error) {
            // Keep the purchase all-or-nothing so a retry doesn't duplicate anything
            await undo(insertedSpoolIds);
            throw new Error(partRes.error.message);
          }
        }
        setStagedSpools([]);
        setStagedParts([]);
        setReceiptText('');
        setReceiptFile(null);
        setReceiptVendor('');
        setReceiptTotal(null);
        if (uploadWarning) setErrorMsg(uploadWarning);
        setShowReceiptModal(false);
        await fetchAllData();
      } finally {
        setSaving(false);
      }
    });

  const updatePartSplit = (part: Part, split: SplitChoice) =>
    run(async () => {
      if (split.mode === 'personal' && !split.personalUserId) return;
      check(await supabase.from('parts').update(splitToColumns(split, part.paid_by_user_id, users)).eq('id', part.id));
      await fetchAllData();
    });

  const viewReceiptFile = (rec: ReceiptRecord) =>
    run(async () => {
      if (!rec.file_path) return;
      // Open the tab right away (before awaiting) so phones don't block it as a pop-up
      const win = window.open('', '_blank');
      const { data, error } = await supabase.storage.from('receipts').createSignedUrl(rec.file_path, 60 * 10);
      if (error || !data?.signedUrl) {
        win?.close();
        throw new Error(`Could not open the receipt file: ${error?.message || 'no link returned'}`);
      }
      if (win) win.location.href = data.signedUrl;
      else window.location.href = data.signedUrl;
    });

  const deletePart = (part: Part) =>
    run(async () => {
      if (!confirm(`Delete "${part.name}" (${money(Number(part.price))})? Its cost will be removed from the balance.`))
        return;
      check(await supabase.from('parts').delete().eq('id', part.id));
      await fetchAllData();
    });

  const archiveSpool = (id: string) =>
    run(async () => {
      check(await supabase.from('spools').update({ is_archived: true }).eq('id', id));
      await fetchAllData();
    });

  const handlePrintParse = (file?: File) =>
    run(async () => {
      setAiLoading(true);
      try {
        let fileBase64: string | undefined;
        let mimeType: string | undefined;
        if (file) {
          fileBase64 = await fileToBase64(file);
          mimeType = file.type;
        }
        const data = await callAi('/api/ai/parse-print', {
          fileBase64,
          mimeType,
          rawText: printNoteOrUrl,
          activeSpools: spools,
        });
        const title = typeof data.title === 'string' ? data.title.trim() : '';
        if (title) {
          setPrintTitle(title);
          setPrintHint(null);
        } else {
          setPrintHint("Couldn't read the print's name — please type it.");
        }
        const minutes = Math.round(Number(data.duration_minutes) || 0);
        if (minutes > 0) {
          setPrintHours(String(Math.floor(minutes / 60)));
          setPrintMins(String(minutes % 60));
        }
        setPrintSource(file ? 'screenshot' : 'url');
        if (Array.isArray(data.filament_usages) && data.filament_usages.length > 0) {
          setUsages(
            data.filament_usages.map((u: any) => ({
              // Only accept an id that really is one of our spools
              spool_id: spools.some((s) => s.id === u.matched_spool_id)
                ? u.matched_spool_id
                : spools[0]?.id || '',
              grams_used: Number(u.grams_used || 0),
            }))
          );
        }
      } finally {
        setAiLoading(false);
      }
    });

  const updateUsage = (idx: number, patch: Partial<UsageDraft>) =>
    setUsages((prev) => prev.map((u, i) => (i === idx ? { ...u, ...patch } : u)));

  const resetPrintForm = () => {
    setPrintTitle('');
    setPrintNoteOrUrl('');
    setPrintHours('');
    setPrintMins('');
    setPrintSource('manual');
    setPrintHint(null);
    setIsSharedPrint(false);
    setUsages([]);
  };

  const savePrintJob = () =>
    run(async () => {
      if (!printTitle.trim()) throw new Error('Give the print a name');
      const durationMinutes = Math.round(Number(printHours || 0) * 60 + Number(printMins || 0));
      if (!(durationMinutes > 0)) throw new Error('Enter the print time (hours and minutes)');
      if (usages.length === 0) throw new Error('Add at least one filament slot');
      for (const u of usages) {
        if (!spools.some((s) => s.id === u.spool_id)) throw new Error('Pick a spool for every slot');
        if (!(Number(u.grams_used) > 0)) throw new Error('Grams used must be above 0 for every slot');
      }

      let totalGrams = 0;
      let totalCost = 0;
      const preparedUsages = usages.map((u) => {
        const spool = allSpools.find((s) => s.id === u.spool_id)!;
        const grams = Number(u.grams_used);
        const cost = grams * Number(spool.cost_per_gram || 0);
        totalGrams += grams;
        totalCost += cost;
        return {
          spool_id: u.spool_id,
          grams_used: grams,
          calculated_cost: Number(cost.toFixed(2)),
        };
      });

      setSaving(true);
      try {
        const { data: newPrint } = check(
          await supabase
            .from('prints')
            .insert({
              title: printTitle.trim(),
              printed_by_user_id: isSharedPrint ? null : printedBy || activeUserId,
              is_shared_print: isSharedPrint,
              duration_minutes: durationMinutes,
              source_type: printSource === 'screenshot' ? 'screenshot' : printNoteOrUrl ? 'url' : 'manual',
              source_url: printNoteOrUrl || null,
              total_grams: Number(totalGrams.toFixed(2)),
              total_cost: Number(totalCost.toFixed(2)),
            })
            .select()
            .single()
        );

        const usageRes = await supabase
          .from('print_spool_usages')
          .insert(preparedUsages.map((u) => ({ ...u, print_id: newPrint.id })));
        if (usageRes.error) {
          // Don't leave a print with no filament rows behind
          await supabase.from('prints').delete().eq('id', newPrint.id);
          throw new Error(usageRes.error.message);
        }

        resetPrintForm();
        setShowPrintModal(false);
        await fetchAllData();
      } finally {
        setSaving(false);
      }
    });

  const deletePrint = (print: PrintJob) =>
    run(async () => {
      if (!confirm(`Delete "${print.title}"? Its cost will be removed from the balance.`)) return;
      check(await supabase.from('print_spool_usages').delete().eq('print_id', print.id));
      check(await supabase.from('prints').delete().eq('id', print.id));
      await fetchAllData();
    });

  const openOtherAmount = () => {
    if (ledger.debtorId) {
      setSettleFrom(ledger.debtorId);
      setSettleTo(ledger.creditorId);
    }
    setSettleAmount('');
    setShowOtherAmount(true);
  };

  /** Records one payment of the full balance, which closes the period ("settle up"). */
  const recordFullSettlement = () =>
    run(async () => {
      if (!ledger.debtorId || !(ledger.amount > 0)) return;
      if (
        !confirm(`Record that ${userName(ledger.debtorId)} paid ${userName(ledger.creditorId)} ${money(ledger.amount)} via ${settleMethod}?`)
      )
        return;
      setSaving(true);
      try {
        check(
          await supabase.from('settlements').insert({
            from_user_id: ledger.debtorId,
            to_user_id: ledger.creditorId,
            amount: Number(ledger.amount.toFixed(2)),
            method: settleMethod,
            note: settleNote.trim() || null,
          })
        );
        setSettleNote('');
        await fetchAllData();
      } finally {
        setSaving(false);
      }
    });

  const handleSettleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      const amount = Number(settleAmount);
      if (!(amount > 0)) throw new Error('Enter an amount above 0');
      if (settleFrom === settleTo) throw new Error('A payment needs two different people');
      setSaving(true);
      try {
        check(
          await supabase.from('settlements').insert({
            from_user_id: settleFrom,
            to_user_id: settleTo,
            amount: Number(amount.toFixed(2)),
            method: settleMethod,
            note: settleNote.trim() || null,
          })
        );
        setSettleAmount('');
        setSettleNote('');
        setShowOtherAmount(false);
        await fetchAllData();
      } finally {
        setSaving(false);
      }
    });
  };

  const deleteSettlement = (st: Settlement) =>
    run(async () => {
      if (
        !confirm(
          `Delete the ${money(Number(st.amount))} payment from ${userName(st.from_user_id)} to ${userName(st.to_user_id)}?`
        )
      )
        return;
      check(await supabase.from('settlements').delete().eq('id', st.id));
      await fetchAllData();
    });

  const exportCsv = () => {
    const esc = (v: unknown) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const periodsOldestFirst = [...wallet.periods].reverse();
    const rows: unknown[][] = [
      ['Date', 'Type', 'Description', 'Details', 'Price / paid ($)', 'Change', 'Balance after', 'Period'],
      ...periodsOldestFirst.flatMap((period, i) =>
        period.entries.map((e) => [
          new Date(e.when).toLocaleDateString(),
          e.kind,
          e.title,
          e.detail,
          e.amount != null ? e.amount.toFixed(2) : '',
          entryBadge(e).text,
          runningLabel(e.runningBalance),
          period.closedBy ? `Settled ${new Date(period.closedBy.settled_at).toLocaleDateString()}` : i === periodsOldestFirst.length - 1 ? 'Open' : '',
        ])
      ),
    ];
    const csv = rows.map((r) => r.map(esc).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'spoolsplit_wallet_history.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 pb-24 max-w-2xl mx-auto px-4 pt-5">
      <header className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2.5">
          <div className="p-2.5 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <Disc className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight">SpoolSplit</h1>
            <p className="text-xs text-slate-400">Fini & Mike • Bambu Lab Tracker</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
        <div className="flex items-center bg-slate-900 p-1 rounded-xl border border-slate-800">
          {users.map((u) => (
            <button
              key={u.id}
              onClick={() => {
                setActiveUserId(u.id);
                setPrintedBy(u.id);
                setReceiptPaidBy(u.id);
              }}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                activeUserId === u.id
                  ? 'bg-emerald-600 text-white shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {u.name}
            </button>
          ))}
        </div>
          <button
            onClick={async () => {
              await fetch('/api/pin', { method: 'DELETE' }).catch(() => undefined);
              window.location.href = '/pin';
            }}
            className="p-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200"
            title="Lock this device (asks for the PIN again)"
            aria-label="Lock"
          >
            <Lock className="w-4 h-4" />
          </button>
        </div>
      </header>

      {errorMsg && (
        <div className="fixed top-3 inset-x-3 z-[60] mx-auto max-w-2xl flex items-start justify-between gap-3 rounded-xl border border-rose-500/50 bg-rose-950 p-3 text-sm text-rose-100 shadow-lg">
          <span>{errorMsg}</span>
          <button onClick={() => setErrorMsg(null)} className="text-rose-300 hover:text-rose-100" title="Dismiss">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="bg-gradient-to-br from-slate-900 to-slate-900/60 border border-slate-800 rounded-2xl p-5 mb-5 shadow-lg">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs uppercase tracking-wider text-slate-400 font-semibold">
            Wallet Balance
          </span>
          <span className="hidden sm:inline text-[11px] text-slate-400">You pay for what you use of the other's stuff</span>
        </div>

        <div className="flex items-baseline justify-between">
          <div>
            <p className="text-sm text-slate-300">{ledger.text}</p>
            <p className="text-3xl font-extrabold text-emerald-400 mt-0.5">{money(ledger.amount)}</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={exportCsv}
              className="p-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300"
              title="Export CSV"
            >
              <Download className="w-4 h-4" />
            </button>
            <button
              onClick={() => setActiveTab('settle')}
              className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold px-4 py-2.5 rounded-xl transition"
            >
              Settle Up
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-6">
        <button
          onClick={() => {
            if (usages.length === 0 && spools[0]) {
              setUsages([{ spool_id: spools[0].id, grams_used: 25 }]);
            }
            setShowPrintModal(true);
          }}
          className="flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold py-3.5 px-4 rounded-xl shadow-lg transition"
        >
          <Printer className="w-4 h-4" />
          Log Print Job
        </button>
        <button
          onClick={() => {
            setStagedSpools([newStagedSpool({ color_name: 'Jade White', color_hex: '#ffffff' })]);
            setStagedParts([]);
            setReceiptDate(todayIso());
            setReceiptVendor('');
            setReceiptTotal(null);
            setReceiptFile(null);
            setShowReceiptModal(true);
          }}
          className="flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-100 font-semibold py-3.5 px-4 rounded-xl border border-slate-700 transition"
        >
          <Receipt className="w-4 h-4 text-emerald-400" />
          Scan Bill / Add Purchase
        </button>
      </div>

      <div className="flex border-b border-slate-800 mb-4 text-sm font-medium overflow-x-auto whitespace-nowrap">
        {(
          [
            ['prints', `Print History (${prints.length})`],
            ['spools', `Purchases (${receipts.length})`],
            ['settle', 'Wallet'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={`pb-3 px-3 sm:px-4 border-b-2 transition ${
              activeTab === key ? 'border-emerald-500 text-emerald-400' : 'border-transparent text-slate-400'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'prints' && (
        <div className="space-y-3">
          {prints.length === 0 ? (
            <div className="text-center py-12 bg-slate-900/40 rounded-2xl border border-slate-800/80 p-6">
              <p className="text-sm text-slate-400">
                No prints logged yet. Tap <strong>Scan Bill / Add Purchase</strong> first, then log your first print!
              </p>
            </div>
          ) : (
            prints.map((p) => (
              <div
                key={p.id}
                className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex items-center justify-between"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm">{p.title}</span>
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-300">
                      {p.is_shared_print ? 'Shared 50/50' : userName(p.printed_by_user_id)}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 mt-1">
                    {Number(p.total_grams).toFixed(0)}g used
                    {Number(p.duration_minutes) > 0 ? ` • ${formatMinutes(Number(p.duration_minutes))}` : ''} •{' '}
                    {new Date(p.created_at).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-bold text-emerald-400">{money(Number(p.total_cost))}</span>
                  <button
                    onClick={() => deletePrint(p)}
                    className="text-slate-500 hover:text-rose-400 p-1"
                    title="Delete print"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {activeTab === 'spools' && (
        <div className="space-y-3">
          {/* Receipts: every item on each bill, with how it's split */}
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-emerald-400" />
            <h3 className="text-sm font-semibold">Receipts</h3>
          </div>
          {receipts.length === 0 ? (
            <div className="text-center py-6 bg-slate-900/40 rounded-xl border border-slate-800/80 p-4">
              <p className="text-xs text-slate-400">
                No receipts yet. Purchases you add with Scan Bill / Add Purchase are kept here with every item.
              </p>
            </div>
          ) : (
            receipts.map((rec) => {
              const recSpools = allSpools.filter((sp) => sp.receipt_id === rec.id);
              const recParts = parts.filter((pt) => pt.receipt_id === rec.id);
              const isOpen = openReceiptId === rec.id;
              const itemsTotal =
                recSpools.reduce((sum, sp) => sum + Number(sp.purchase_price || 0), 0) +
                recParts.reduce((sum, pt) => sum + Number(pt.price || 0), 0);
              return (
                <div key={rec.id} className="bg-slate-900 border border-slate-800 rounded-xl">
                  <button
                    onClick={() => setOpenReceiptId(isOpen ? null : rec.id)}
                    className="w-full p-4 flex items-center justify-between gap-3 text-left"
                    aria-expanded={isOpen}
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate">{rec.vendor || 'Receipt'}</p>
                      <p className="text-xs text-slate-400 mt-0.5">
                        {new Date(`${rec.purchased_at}T00:00:00`).toLocaleDateString()} • paid by{' '}
                        {userName(rec.paid_by_user_id)} • {recSpools.length + recParts.length} item(s)
                        {rec.file_path ? ' • file kept' : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-sm font-bold text-emerald-400">{money(Number(rec.total))}</span>
                      <ChevronDown className={`w-4 h-4 text-slate-400 transition ${isOpen ? 'rotate-180' : ''}`} />
                    </div>
                  </button>
                  {isOpen && (
                    <div className="border-t border-slate-800 p-3 space-y-2">
                      {recSpools.map((sp) => (
                        <div key={sp.id} className="bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-xs">
                          <div className="flex items-center justify-between gap-2">
                            <span className="flex items-center gap-2 min-w-0">
                              <span
                                className="w-3 h-3 rounded-full border border-white/20 shrink-0"
                                style={{ backgroundColor: sp.color_hex }}
                              />
                              <span className="truncate">
                                {sp.brand} {sp.material} — {sp.color_name} ({Number(sp.initial_weight_g).toFixed(0)} g)
                              </span>
                            </span>
                            <span className="font-semibold shrink-0">{money(Number(sp.purchase_price))}</span>
                          </div>
                          <p className="text-[11px] text-slate-500 mt-1">Pay per use — each person pays for what they print</p>
                        </div>
                      ))}
                      {recParts.map((pt) => (
                        <div key={pt.id} className="bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-xs space-y-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate">
                              {pt.name}{' '}
                              <span className="text-slate-500">({PART_CATEGORY_LABELS[pt.category] || pt.category})</span>
                            </span>
                            <span className="font-semibold shrink-0">{money(Number(pt.price))}</span>
                          </div>
                          <SplitPicker
                            value={columnsToSplit(pt, users)}
                            users={users}
                            compact
                            onChange={(split) => updatePartSplit(pt, split)}
                          />
                        </div>
                      ))}
                      {recSpools.length + recParts.length === 0 && (
                        <p className="text-xs text-slate-400">The items on this receipt were deleted.</p>
                      )}
                      <div className="flex items-center justify-between pt-1">
                        <span className="text-[11px] text-slate-500">
                          Items {money(itemsTotal)} (tax & shipping spread over items)
                        </span>
                        {rec.file_path && (
                          <button
                            onClick={() => viewReceiptFile(rec)}
                            className="flex items-center gap-1 text-xs text-emerald-400 font-medium"
                          >
                            <ExternalLink className="w-3.5 h-3.5" /> View original
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}

          <div className="flex items-center gap-2 pt-4">
            <Disc className="w-4 h-4 text-emerald-400" />
            <h3 className="text-sm font-semibold">Spool Rack</h3>
          </div>
          {spools.length === 0 && (
            <div className="text-center py-12 bg-slate-900/40 rounded-2xl border border-slate-800/80 p-6">
              <p className="text-sm text-slate-400">No active spools. Add one with Scan Bill / Add Purchase.</p>
            </div>
          )}
          {spools.map((s) => {
            return (
              <div key={s.id} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <span
                      className="w-4 h-4 rounded-full border border-white/20"
                      style={{ backgroundColor: s.color_hex }}
                    />
                    <div>
                      <h3 className="text-sm font-semibold">
                        {s.brand} {s.material} — {s.color_name}
                      </h3>
                      <p className="text-xs text-slate-400">
                        Paid by {userName(s.paid_by_user_id)} ({money(Number(s.purchase_price))} •{' '}
                        {money(Number(s.cost_per_gram) * 1000)}/kg)
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-slate-300">
                      {Number(s.initial_weight_g).toFixed(0)}g spool
                    </span>
                    <button
                      onClick={() => archiveSpool(s.id)}
                      className="text-slate-500 hover:text-amber-300 p-1"
                      title="Archive spool (hides it from the list; it still counts toward the balance)"
                    >
                      <Archive className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}

          <div className="pt-4 space-y-3">
            <div className="flex items-center gap-2">
              <Wrench className="w-4 h-4 text-emerald-400" />
              <h3 className="text-sm font-semibold">Parts & Upkeep</h3>
            </div>
            <p className="text-xs text-slate-400">
              By default, nozzles, tubes, plates and other parts are split by print time: each person pays their
              share of the hours printed since the part was bought, until the next settle-up locks it. You can
              change any item to 50/50, personal, or a custom %. All-time print
              time:{' '}
              {users
                .map((u) => `${u.name} ${formatMinutes(printTimeTotals[u.id] || 0)}`)
                .join(' • ')}
            </p>
            {parts.length === 0 ? (
              <div className="text-center py-6 bg-slate-900/40 rounded-xl border border-slate-800/80 p-4">
                <p className="text-xs text-slate-400">
                  No parts yet. Add them with Scan Bill / Add Purchase — receipts with nozzles or tubes are picked up
                  automatically.
                </p>
              </div>
            ) : (
              parts.map((pt) => {
                const split = wallet.partSplit.get(pt.id);
                const shares = split?.shares || ({} as Record<string, number>);
                return (
                  <div
                    key={pt.id}
                    className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm truncate">{pt.name}</span>
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 shrink-0">
                          {PART_CATEGORY_LABELS[pt.category] || pt.category}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 mt-1">
                        Paid by {userName(pt.paid_by_user_id)} • {new Date(`${pt.purchased_at}T00:00:00`).toLocaleDateString()}
                      </p>
                      {users.length >= 2 && (
                        <div className="mt-1.5">
                          <SplitPicker
                            value={columnsToSplit(pt, users)}
                            users={users}
                            compact
                            onChange={(next) => updatePartSplit(pt, next)}
                          />
                        </div>
                      )}
                      {users.length >= 2 && (
                        <p className="text-xs text-slate-500 mt-0.5">
                          {split?.manual ? 'Split:' : split?.frozen ? 'Split (locked at settle-up):' : 'Split so far:'}{' '}
                          {users
                            .slice(0, 2)
                            .map((u) => `${u.name} ${Math.round((shares[u.id] || 0) * 100)}%`)
                            .join(' / ')}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-sm font-bold text-emerald-400">{money(Number(pt.price))}</span>
                      <button
                        onClick={() => deletePart(pt)}
                        className="text-slate-500 hover:text-rose-400 p-1"
                        title="Delete part"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {activeTab === 'settle' && (
        <div className="space-y-5">
          {/* 1. Settle up: always at most one payment */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
            {ledger.debtorId ? (
              <>
                <div>
                  <p className="text-xs uppercase tracking-wider text-slate-400 font-semibold">To settle up</p>
                  <p className="text-lg font-bold mt-1">
                    {userName(ledger.debtorId)} pays {userName(ledger.creditorId)}{' '}
                    <span className="text-emerald-400">{money(ledger.amount)}</span>
                  </p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    One payment covers everything since the last settle-up. What each of you used of your own
                    purchases needs no transfer.
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <select
                    value={settleMethod}
                    onChange={(e) => setSettleMethod(e.target.value)}
                    className="bg-slate-950 border border-slate-800 rounded-lg p-2 text-sm"
                    aria-label="Payment method"
                  >
                    <option>Venmo</option>
                    <option>Zelle</option>
                    <option>Cash</option>
                    <option>PayPal</option>
                    <option>Bank transfer</option>
                  </select>
                  <input
                    value={settleNote}
                    onChange={(e) => setSettleNote(e.target.value)}
                    placeholder="Note (optional)"
                    className="bg-slate-950 border border-slate-800 rounded-lg p-2 text-sm"
                  />
                </div>
                <button
                  onClick={recordFullSettlement}
                  disabled={saving}
                  className="w-full flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white font-semibold py-2.5 rounded-lg text-sm"
                >
                  <HandCoins className="w-4 h-4" />
                  Record payment of {money(ledger.amount)}
                </button>
              </>
            ) : (
              <div className="flex items-center gap-2 text-sm">
                <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                <span className="font-semibold">All settled up</span>
                <span className="text-slate-400">— nobody owes anything right now.</span>
              </div>
            )}
            {!showOtherAmount ? (
              <button onClick={openOtherAmount} className="text-xs text-emerald-400 font-medium">
                Record a different amount…
              </button>
            ) : (
              <form onSubmit={handleSettleSubmit} className="border-t border-slate-800 pt-3 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-slate-400">Who paid</label>
                    <select
                      value={settleFrom}
                      onChange={(e) => setSettleFrom(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-sm mt-1"
                    >
                      {users.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-slate-400">Paid to</label>
                    <select
                      value={settleTo}
                      onChange={(e) => setSettleTo(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-sm mt-1"
                    >
                      {users.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    placeholder="Amount ($)"
                    value={settleAmount}
                    onChange={(e) => setSettleAmount(e.target.value)}
                    className="bg-slate-950 border border-slate-800 rounded-lg p-2 text-sm"
                    required
                  />
                  <button
                    type="submit"
                    disabled={saving}
                    className="bg-slate-800 hover:bg-slate-700 disabled:opacity-60 text-white font-semibold rounded-lg text-sm"
                  >
                    Save payment
                  </button>
                </div>
                <p className="text-[11px] text-slate-500">
                  Uses the method and note above. A payment only closes the period when it brings the balance to $0.
                </p>
              </form>
            )}
          </div>

          {/* 2. This period, per person */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <h3 className="text-sm font-semibold mb-3">Since the last settle-up</h3>
            <div className="grid grid-cols-2 gap-3">
              {wallet.summary.map((c) => (
                <div key={c.userId} className="bg-slate-950 border border-slate-800 rounded-lg p-3 text-xs space-y-1">
                  <p className="text-sm font-semibold">{userName(c.userId)}</p>
                  <p className="flex justify-between text-slate-400">
                    <span>Bought (own wallet)</span>
                    <span>{money(c.boughtSpools + c.boughtParts)}</span>
                  </p>
                  <p className="flex justify-between text-slate-400">
                    <span>Used own filament</span>
                    <span>{money(c.usedOwn)}</span>
                  </p>
                  <p className="flex justify-between text-slate-300">
                    <span>Used other's filament</span>
                    <span>{money(c.usedOther)}</span>
                  </p>
                  <p className="flex justify-between text-slate-300">
                    <span>Share of other's parts</span>
                    <span>{money(c.partsShareOwed)}</span>
                  </p>
                  <p className="flex justify-between text-slate-400">
                    <span>Paid / received</span>
                    <span>
                      {money(c.sent)} / {money(c.received)}
                    </span>
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* 3. Full history, grouped by settle-up */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold">History</h3>
            {wallet.periods.every((pd) => pd.entries.length === 0) && (
              <p className="text-xs text-slate-400">Nothing yet. Purchases, prints and payments will show up here.</p>
            )}
            {wallet.periods.map((period, pi) =>
              period.entries.length === 0 ? null : (
                <div key={period.closedBy?.id || 'open'} className="space-y-2">
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    {period.closedBy
                      ? `Settled on ${new Date(period.closedBy.settled_at).toLocaleDateString()} — ${userName(
                          period.closedBy.from_user_id
                        )} paid ${userName(period.closedBy.to_user_id)} ${money(Number(period.closedBy.amount))}`
                      : pi === 0
                        ? 'Current period (not settled yet)'
                        : ''}
                  </p>
                  {[...period.entries].reverse().map((e) => {
                    const badge = entryBadge(e);
                    const Icon =
                      e.kind === 'print' ? Printer : e.kind === 'part' ? Wrench : e.kind === 'payment' ? HandCoins : Disc;
                    const st = e.settlementId ? settlements.find((x) => x.id === e.settlementId) : undefined;
                    const pr = e.printId ? prints.find((x) => x.id === e.printId) : undefined;
                    return (
                      <div
                        key={e.key}
                        className="bg-slate-900 border border-slate-800 rounded-xl p-3 flex items-start justify-between gap-3"
                      >
                        <div className="flex items-start gap-2.5 min-w-0">
                          <Icon className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                          <div className="min-w-0">
                            <p className="text-sm font-medium">{e.title}</p>
                            {e.detail && <p className="text-xs text-slate-400 mt-0.5">{e.detail}</p>}
                            <p className="text-[11px] text-slate-500 mt-0.5">
                              {new Date(e.when).toLocaleDateString()}
                              {e.kind !== 'payment' && e.amount != null && e.amount > 0 ? ` • ${money(e.amount)}` : ''}
                              {' • after: '}
                              {runningLabel(e.runningBalance)}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span
                            className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                              badge.tone === 'pay'
                                ? 'bg-emerald-500/15 text-emerald-300'
                                : badge.tone === 'owe'
                                  ? 'bg-amber-500/15 text-amber-300'
                                  : 'bg-slate-800 text-slate-400'
                            }`}
                          >
                            {badge.text}
                          </span>
                          {(st || pr) && (
                            <button
                              onClick={() => (st ? deleteSettlement(st) : deletePrint(pr!))}
                              className="text-slate-500 hover:text-rose-400 p-1"
                              title={st ? 'Delete payment' : 'Delete print'}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )
            )}
          </div>
        </div>
      )}

      {showReceiptModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50 overflow-y-auto">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 w-full max-w-lg space-y-4">
            <div className="flex justify-between items-center">
              <h2 className="text-base font-bold flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-emerald-400" />
                Add Purchase (Spools & Parts)
              </h2>
              <button onClick={() => setShowReceiptModal(false)} className="text-slate-400 text-sm">
                Close
              </button>
            </div>

            <div className="bg-slate-950 border border-dashed border-slate-700 rounded-xl p-3 text-center">
              <label className="cursor-pointer flex flex-col items-center gap-1">
                <Upload className="w-5 h-5 text-emerald-400" />
                <span className="text-xs font-medium text-slate-300">
                  Upload Receipt Screenshot / PDF to Auto-Fill
                </span>
                <input
                  type="file"
                  accept="image/*,application/pdf"
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files?.[0]) handleReceiptParse(e.target.files[0]);
                    e.target.value = '';
                  }}
                />
              </label>
              <div className="flex gap-2 mt-2">
                <textarea
                  value={receiptText}
                  onChange={(e) => setReceiptText(e.target.value)}
                  placeholder="…or paste the order email text"
                  rows={2}
                  className="flex-1 bg-slate-900 border border-slate-800 rounded-lg p-2 text-xs"
                />
                <button
                  onClick={() => handleReceiptParse()}
                  disabled={aiLoading || !receiptText.trim()}
                  className="text-xs bg-slate-800 hover:bg-slate-700 disabled:opacity-50 px-3 rounded-lg"
                >
                  Parse
                </button>
              </div>
              {aiLoading && (
                <p className="text-xs text-emerald-400 mt-2 flex items-center justify-center gap-1">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Gemini is reading the receipt...
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-slate-400">Who paid this bill?</label>
                <select
                  value={receiptPaidBy}
                  onChange={(e) => setReceiptPaidBy(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-sm mt-1"
                >
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-400">Purchase date</label>
                <input
                  type="date"
                  value={receiptDate}
                  onChange={(e) => setReceiptDate(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-sm mt-1"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input
                value={receiptVendor}
                onChange={(e) => setReceiptVendor(e.target.value)}
                placeholder="Store (e.g. Bambu Lab Store)"
                className="bg-slate-950 border border-slate-800 rounded-lg p-2 text-sm"
              />
              <p className="text-[11px] text-slate-400 self-center flex items-center gap-1 min-w-0">
                <FileText className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">
                  {receiptFile ? `File kept: ${receiptFile.name}` : 'No file — upload one above to keep it'}
                </span>
              </p>
            </div>

            <h3 className="text-xs font-semibold text-slate-300">
              Filament spools <span className="font-normal text-slate-500">(pay per use — you pay for what you print)</span>
            </h3>
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {stagedSpools.map((sp, idx) => (
                <div
                  key={idx}
                  className="grid grid-cols-[auto_1fr_1fr_1fr_1fr_auto] items-center gap-1.5 bg-slate-950 p-2 rounded-lg border border-slate-800 text-xs"
                >
                  <input
                    type="color"
                    value={/^#[0-9a-fA-F]{6}$/.test(sp.color_hex) ? sp.color_hex : '#000000'}
                    onChange={(e) => updateStaged(idx, { color_hex: e.target.value })}
                    className="w-6 h-6 bg-transparent"
                    title="Color"
                  />
                  <input
                    value={sp.material}
                    onChange={(e) => updateStaged(idx, { material: e.target.value })}
                    placeholder="PLA Basic"
                    className="bg-slate-900 p-1.5 rounded min-w-0"
                  />
                  <input
                    value={sp.color_name}
                    onChange={(e) => updateStaged(idx, { color_name: e.target.value })}
                    placeholder="Color"
                    className="bg-slate-900 p-1.5 rounded min-w-0"
                  />
                  <input
                    type="number"
                    value={sp.initial_weight_g}
                    onChange={(e) => updateStaged(idx, { initial_weight_g: e.target.value })}
                    placeholder="1000g"
                    className="bg-slate-900 p-1.5 rounded min-w-0"
                  />
                  <input
                    type="number"
                    step="0.01"
                    value={sp.purchase_price}
                    onChange={(e) => updateStaged(idx, { purchase_price: e.target.value })}
                    placeholder="$ Price"
                    className="bg-slate-900 p-1.5 rounded min-w-0"
                  />
                  <button
                    onClick={() => setStagedSpools((prev) => prev.filter((_, i) => i !== idx))}
                    className="text-slate-500 hover:text-rose-400 p-1"
                    title="Remove row"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>

            <button
              onClick={() => setStagedSpools([...stagedSpools, newStagedSpool()])}
              className="text-xs text-emerald-400 font-medium"
            >
              + Add Spool Row
            </button>

            <div className="space-y-2">
              <h3 className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                <Wrench className="w-3.5 h-3.5 text-emerald-400" />
                Parts & other items <span className="font-normal text-slate-500">(choose how each is split)</span>
              </h3>
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {stagedParts.map((pt, idx) => (
                  <div key={idx} className="bg-slate-950 p-2 rounded-lg border border-slate-800 text-xs space-y-1.5">
                  <div className="grid grid-cols-[2fr_1.3fr_1fr_auto] items-center gap-1.5">
                    <input
                      value={pt.name}
                      onChange={(e) => updateStagedPart(idx, { name: e.target.value })}
                      placeholder="e.g. 0.4mm nozzle"
                      className="bg-slate-900 p-1.5 rounded min-w-0"
                    />
                    <select
                      value={pt.category}
                      onChange={(e) => updateStagedPart(idx, { category: e.target.value as PartCategory })}
                      className="bg-slate-900 p-1.5 rounded min-w-0"
                    >
                      {PART_CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {PART_CATEGORY_LABELS[c]}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={pt.price}
                      onChange={(e) => updateStagedPart(idx, { price: e.target.value })}
                      placeholder="$ Price"
                      className="bg-slate-900 p-1.5 rounded min-w-0"
                    />
                    <button
                      onClick={() => setStagedParts((prev) => prev.filter((_, i) => i !== idx))}
                      className="text-slate-500 hover:text-rose-400 p-1"
                      title="Remove part"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <SplitPicker
                    value={pt.split}
                    users={users}
                    onChange={(split) => updateStagedPart(idx, { split })}
                  />
                  </div>
                ))}
              </div>
              <button
                onClick={() => setStagedParts([...stagedParts, newStagedPart()])}
                className="text-xs text-emerald-400 font-medium"
              >
                + Add Part Row
              </button>
            </div>

            <button
              onClick={saveStagedPurchase}
              disabled={saving || (stagedSpools.length === 0 && stagedParts.length === 0)}
              className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white font-semibold py-3 rounded-xl text-sm"
            >
              Confirm & Save {stagedSpools.length} Spool(s)
              {stagedParts.length > 0 ? ` + ${stagedParts.length} Part(s)` : ''}
            </button>
          </div>
        </div>
      )}

      {showPrintModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50 overflow-y-auto">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 w-full max-w-lg space-y-4">
            <div className="flex justify-between items-center">
              <h2 className="text-base font-bold flex items-center gap-2">
                <Printer className="w-4 h-4 text-emerald-400" />
                Log a 3D Print Job
              </h2>
              <button onClick={() => setShowPrintModal(false)} className="text-slate-400 text-sm">
                Close
              </button>
            </div>

            <div className="bg-slate-950 border border-dashed border-slate-700 rounded-xl p-3 text-center">
              <label className="cursor-pointer flex flex-col items-center gap-1">
                <Upload className="w-5 h-5 text-emerald-400" />
                <span className="text-xs font-medium text-slate-300">
                  Upload Bambu Handy Screenshot to Auto-Fill
                </span>
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files?.[0]) handlePrintParse(e.target.files[0]);
                    e.target.value = '';
                  }}
                />
              </label>
              <div className="flex gap-2 mt-2">
                <input
                  value={printNoteOrUrl}
                  onChange={(e) => setPrintNoteOrUrl(e.target.value)}
                  placeholder="…or paste a MakerWorld link / print details"
                  className="flex-1 bg-slate-900 border border-slate-800 rounded-lg p-2 text-xs"
                />
                <button
                  onClick={() => handlePrintParse()}
                  disabled={aiLoading || !printNoteOrUrl.trim()}
                  className="text-xs bg-slate-800 hover:bg-slate-700 disabled:opacity-50 px-3 rounded-lg"
                >
                  Parse
                </button>
              </div>
              {aiLoading && (
                <p className="text-xs text-emerald-400 mt-2 flex items-center justify-center gap-1">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Matching print colors to spools...
                </p>
              )}
            </div>

            <div>
              <input
                value={printTitle}
                onChange={(e) => {
                  setPrintTitle(e.target.value);
                  setPrintHint(null);
                }}
                placeholder="Model Name (e.g., Gridfinity Bin)"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-sm"
              />
              {printHint && <p className="text-xs text-amber-300 mt-1">{printHint}</p>}
            </div>

            <div>
              <label className="text-xs text-slate-400">Print time (used to split parts like nozzles)</label>
              <div className="flex items-center gap-2 mt-1">
                <input
                  type="number"
                  min="0"
                  inputMode="numeric"
                  value={printHours}
                  onChange={(e) => setPrintHours(e.target.value)}
                  placeholder="0"
                  aria-label="Hours"
                  className="w-20 bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-sm"
                />
                <span className="text-xs text-slate-400">h</span>
                <input
                  type="number"
                  min="0"
                  max="59"
                  inputMode="numeric"
                  value={printMins}
                  onChange={(e) => setPrintMins(e.target.value)}
                  placeholder="0"
                  aria-label="Minutes"
                  className="w-20 bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-sm"
                />
                <span className="text-xs text-slate-400">min</span>
              </div>
            </div>

            <select
              value={isSharedPrint ? 'shared' : printedBy}
              onChange={(e) => {
                if (e.target.value === 'shared') {
                  setIsSharedPrint(true);
                } else {
                  setIsSharedPrint(false);
                  setPrintedBy(e.target.value);
                }
              }}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-sm"
            >
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  Printed by {u.name} (100%)
                </option>
              ))}
              <option value="shared">Shared Printer Upgrade (Split 50/50)</option>
            </select>

            <div className="space-y-2">
              <label className="text-xs text-slate-400">Filament Used (Grams per Spool)</label>
              {spools.length === 0 && (
                <p className="text-xs text-amber-300">Add a spool first — there is nothing to deduct from yet.</p>
              )}
              {usages.map((u, idx) => (
                <div key={idx} className="flex gap-2">
                  <select
                    value={u.spool_id}
                    onChange={(e) => updateUsage(idx, { spool_id: e.target.value })}
                    className="flex-1 bg-slate-950 border border-slate-800 rounded-lg p-2 text-xs"
                  >
                    {spools.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.color_name} ({s.material}) — paid by {userName(s.paid_by_user_id)}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min="0"
                    value={u.grams_used}
                    onChange={(e) => updateUsage(idx, { grams_used: Number(e.target.value) })}
                    placeholder="Grams"
                    className="w-24 bg-slate-950 border border-slate-800 rounded-lg p-2 text-xs"
                  />
                  <button
                    onClick={() => setUsages((prev) => prev.filter((_, i) => i !== idx))}
                    className="text-slate-500 hover:text-rose-400 p-1"
                    title="Remove slot"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
              <button
                onClick={() => setUsages([...usages, { spool_id: spools[0]?.id || '', grams_used: 10 }])}
                disabled={spools.length === 0}
                className="text-xs text-emerald-400 font-medium disabled:opacity-50"
              >
                + Add Another AMS Color Slot
              </button>
            </div>

            <button
              onClick={savePrintJob}
              disabled={saving}
              className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white font-semibold py-3 rounded-xl text-sm"
            >
              Save Print
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
