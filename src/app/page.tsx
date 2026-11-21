'use client';

import React, { useEffect, useState, useMemo } from 'react';
import { supabase, supabaseConfigured, User, Spool, PrintJob, Settlement } from '@/lib/supabase';
import {
  Disc,
  Printer,
  Receipt,
  ArrowRightLeft,
  Download,
  Sparkles,
  Trash2,
  Loader2,
  Upload,
  Archive,
  X,
  HandCoins,
} from 'lucide-react';

type StagedSpool = {
  brand: string;
  material: string;
  color_name: string;
  color_hex: string;
  initial_weight_g: number | string;
  purchase_price: number | string;
};

type UsageDraft = { spool_id: string; grams_used: number };

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
  const [splitMode, setSplitMode] = useState<'usage' | 'pool'>('usage');
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

  // Print Logger State
  const [printTitle, setPrintTitle] = useState('');
  const [printedBy, setPrintedBy] = useState<string>('');
  const [isSharedPrint, setIsSharedPrint] = useState(false);
  const [printDuration, setPrintDuration] = useState<number>(60);
  const [printNoteOrUrl, setPrintNoteOrUrl] = useState('');
  const [usages, setUsages] = useState<UsageDraft[]>([]);

  // Settlement Form State
  const [settleFrom, setSettleFrom] = useState('');
  const [settleTo, setSettleTo] = useState('');
  const [settleAmount, setSettleAmount] = useState('');
  const [settleMethod, setSettleMethod] = useState('Venmo');
  const [settleNote, setSettleNote] = useState('');

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
        'Supabase is not configured: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY were not set when this version was built. In Vercel, enable them for this environment and redeploy.'
      );
    }
    const [u, s, p, st] = await Promise.all([
      supabase.from('users').select('*').order('name'),
      supabase.from('spools').select('*').order('created_at', { ascending: false }),
      supabase.from('prints').select('*, print_spool_usages(*)').order('created_at', { ascending: false }),
      supabase.from('settlements').select('*').order('settled_at', { ascending: false }),
    ]);
    const firstError = [u, s, p, st].find((r) => r.error)?.error;
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
    setPrints((p.data || []) as PrintJob[]);
    setSettlements((st.data || []) as Settlement[]);
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
   * Running balance between the two users. Positive = userA owes userB.
   * Settlements (payments between the two) are deducted from what is owed.
   */
  const ledger = useMemo(() => {
    if (users.length < 2) {
      return { text: 'Setting up users...', amount: 0, debtorId: '', creditorId: '' };
    }
    const [userA, userB] = users;
    let userAOwesUserB = 0;

    if (splitMode === 'usage') {
      prints.forEach((p) => {
        (p.print_spool_usages || []).forEach((u) => {
          const spool = allSpools.find((s) => s.id === u.spool_id);
          if (!spool) return;
          const cost = Number(u.calculated_cost || 0);

          if (p.is_shared_print) {
            if (spool.paid_by_user_id === userA.id) userAOwesUserB -= cost / 2;
            if (spool.paid_by_user_id === userB.id) userAOwesUserB += cost / 2;
          } else if (p.printed_by_user_id === userA.id && spool.paid_by_user_id === userB.id) {
            userAOwesUserB += cost;
          } else if (p.printed_by_user_id === userB.id && spool.paid_by_user_id === userA.id) {
            userAOwesUserB -= cost;
          }
        });
      });
    } else {
      allSpools.forEach((s) => {
        const price = Number(s.purchase_price || 0);
        if (s.paid_by_user_id === userA.id) userAOwesUserB -= price / 2;
        if (s.paid_by_user_id === userB.id) userAOwesUserB += price / 2;
      });
      prints.forEach((p) => {
        if (p.is_shared_print) return;
        const cost = Number(p.total_cost || 0);
        if (p.printed_by_user_id === userA.id) userAOwesUserB += cost / 2;
        if (p.printed_by_user_id === userB.id) userAOwesUserB -= cost / 2;
      });
    }

    settlements.forEach((st) => {
      const amt = Number(st.amount || 0);
      if (st.from_user_id === userA.id && st.to_user_id === userB.id) {
        userAOwesUserB -= amt;
      } else if (st.from_user_id === userB.id && st.to_user_id === userA.id) {
        userAOwesUserB += amt;
      }
    });

    const absAmount = Math.abs(userAOwesUserB);
    if (absAmount < 0.01) {
      return { text: 'All settled up!', amount: 0, debtorId: '', creditorId: '' };
    }
    const [debtor, creditor] = userAOwesUserB > 0 ? [userA, userB] : [userB, userA];
    return {
      text: `${debtor.name} owes ${creditor.name}`,
      amount: absAmount,
      debtorId: debtor.id,
      creditorId: creditor.id,
    };
  }, [users, allSpools, prints, settlements, splitMode]);

  /**
   * What each person has put in, net of settlements:
   * spools they bought + payments they sent − payments they received.
   */
  const contributions = useMemo(
    () =>
      users.map((u) => {
        const spoolSpend = allSpools
          .filter((s) => s.paid_by_user_id === u.id)
          .reduce((sum, s) => sum + Number(s.purchase_price || 0), 0);
        const sent = settlements
          .filter((st) => st.from_user_id === u.id)
          .reduce((sum, st) => sum + Number(st.amount || 0), 0);
        const received = settlements
          .filter((st) => st.to_user_id === u.id)
          .reduce((sum, st) => sum + Number(st.amount || 0), 0);
        return { user: u, spoolSpend, sent, received, net: spoolSpend + sent - received };
      }),
    [users, allSpools, settlements]
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
        if (!Array.isArray(data.spools) || data.spools.length === 0) {
          throw new Error('No spools were found on that receipt');
        }
        const expanded: StagedSpool[] = [];
        data.spools.forEach((s: any) => {
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

  const saveStagedSpools = () =>
    run(async () => {
      if (stagedSpools.length === 0) return;
      const rows = stagedSpools.map((s) => {
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
          paid_by_user_id: receiptPaidBy || activeUserId,
        };
      });
      setSaving(true);
      try {
        check(await supabase.from('spools').insert(rows));
        setStagedSpools([]);
        setReceiptText('');
        setShowReceiptModal(false);
        await fetchAllData();
      } finally {
        setSaving(false);
      }
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
        if (data.title) setPrintTitle(data.title);
        if (data.duration_minutes) setPrintDuration(data.duration_minutes);
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
    setPrintDuration(60);
    setIsSharedPrint(false);
    setUsages([]);
  };

  const savePrintJob = () =>
    run(async () => {
      if (!printTitle.trim()) throw new Error('Give the print a name');
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
              duration_minutes: Number(printDuration || 0),
              source_type: printNoteOrUrl ? 'url' : 'manual',
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

  const prefillFullSettlement = () => {
    if (!ledger.debtorId) return;
    setSettleFrom(ledger.debtorId);
    setSettleTo(ledger.creditorId);
    setSettleAmount(ledger.amount.toFixed(2));
    setActiveTab('settle');
  };

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
    const rows: unknown[][] = [
      ['Date', 'Type', 'Description', 'Who', 'Grams', 'Amount ($)'],
      ...prints.map((p) => [
        new Date(p.created_at).toLocaleDateString(),
        'Print',
        p.title,
        p.is_shared_print ? 'Shared (50/50)' : userName(p.printed_by_user_id),
        p.total_grams,
        Number(p.total_cost).toFixed(2),
      ]),
      ...settlements.map((st) => [
        new Date(st.settled_at).toLocaleDateString(),
        'Payment',
        [st.method, st.note].filter(Boolean).join(' - '),
        `${userName(st.from_user_id)} -> ${userName(st.to_user_id)}`,
        '',
        Number(st.amount).toFixed(2),
      ]),
    ];
    const csv = rows.map((r) => r.map(esc).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'spoolsplit_ledger.csv';
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
            Live Fair-Split Balance
          </span>
          <button
            onClick={() => setSplitMode(splitMode === 'usage' ? 'pool' : 'usage')}
            className="text-[11px] bg-slate-800 hover:bg-slate-700 text-slate-300 px-2.5 py-1 rounded-full flex items-center gap-1"
          >
            <ArrowRightLeft className="w-3 h-3" />
            Mode: {splitMode === 'usage' ? 'Pay Per Gram Used' : '50/50 Spool Pool'}
          </button>
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
              onClick={() => (ledger.debtorId ? prefillFullSettlement() : setActiveTab('settle'))}
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
            setShowReceiptModal(true);
          }}
          className="flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-100 font-semibold py-3.5 px-4 rounded-xl border border-slate-700 transition"
        >
          <Receipt className="w-4 h-4 text-emerald-400" />
          Scan Bill / Add Spool
        </button>
      </div>

      <div className="flex border-b border-slate-800 mb-4 text-sm font-medium">
        {(
          [
            ['prints', `Print History (${prints.length})`],
            ['spools', `Spool Rack (${spools.length})`],
            ['settle', `Settlements (${settlements.length})`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={`pb-3 px-4 border-b-2 transition ${
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
                No prints logged yet. Tap <strong>Scan Bill / Add Spool</strong> first, then log your first print!
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
                    {Number(p.total_grams).toFixed(0)}g used • {new Date(p.created_at).toLocaleDateString()}
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
          {spools.length === 0 && (
            <div className="text-center py-12 bg-slate-900/40 rounded-2xl border border-slate-800/80 p-6">
              <p className="text-sm text-slate-400">No active spools. Add one with Scan Bill / Add Spool.</p>
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
        </div>
      )}

      {activeTab === 'settle' && (
        <div className="space-y-5">
          {/* Who has put in how much, after payments between you */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <h3 className="text-sm font-semibold mb-3">Money Contributed (after payments)</h3>
            <div className="grid grid-cols-2 gap-3">
              {contributions.map((c) => (
                <div key={c.user.id} className="bg-slate-950 border border-slate-800 rounded-lg p-3 text-xs space-y-1">
                  <p className="text-sm font-semibold">{c.user.name}</p>
                  <p className="flex justify-between text-slate-400">
                    <span>Spools bought</span>
                    <span>{money(c.spoolSpend)}</span>
                  </p>
                  <p className="flex justify-between text-slate-400">
                    <span>+ Paid to other</span>
                    <span>{money(c.sent)}</span>
                  </p>
                  <p className="flex justify-between text-slate-400">
                    <span>− Received</span>
                    <span>{money(c.received)}</span>
                  </p>
                  <p className="flex justify-between border-t border-slate-800 pt-1 font-semibold text-emerald-400">
                    <span>Net contributed</span>
                    <span>{money(c.net)}</span>
                  </p>
                </div>
              ))}
            </div>
          </div>

          {ledger.debtorId && (
            <button
              onClick={prefillFullSettlement}
              className="w-full flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 font-semibold py-2.5 rounded-lg text-sm"
            >
              <HandCoins className="w-4 h-4 text-emerald-400" />
              Fill in full balance: {ledger.text} {money(ledger.amount)}
            </button>
          )}

          <form
            onSubmit={handleSettleSubmit}
            className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3"
          >
            <h3 className="text-sm font-semibold">Record a Payment (Venmo / Zelle / Cash)</h3>
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
              <select
                value={settleMethod}
                onChange={(e) => setSettleMethod(e.target.value)}
                className="bg-slate-950 border border-slate-800 rounded-lg p-2 text-sm"
              >
                <option>Venmo</option>
                <option>Zelle</option>
                <option>Cash</option>
                <option>PayPal</option>
                <option>Bank transfer</option>
              </select>
            </div>
            <input
              value={settleNote}
              onChange={(e) => setSettleNote(e.target.value)}
              placeholder="Note (optional)"
              className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-sm"
            />
            <button
              type="submit"
              disabled={saving}
              className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white font-semibold py-2.5 rounded-lg text-sm"
            >
              Save Payment
            </button>
          </form>

          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Payment History</h3>
            {settlements.length === 0 ? (
              <p className="text-xs text-slate-400">No payments recorded yet.</p>
            ) : (
              settlements.map((st) => (
                <div
                  key={st.id}
                  className="bg-slate-900 border border-slate-800 rounded-xl p-3 flex items-center justify-between"
                >
                  <div>
                    <p className="text-sm">
                      <span className="font-semibold">{userName(st.from_user_id)}</span>
                      <span className="text-slate-400"> paid </span>
                      <span className="font-semibold">{userName(st.to_user_id)}</span>
                    </p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {st.method} • {new Date(st.settled_at).toLocaleDateString()}
                      {st.note ? ` • ${st.note}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-bold text-emerald-400">{money(Number(st.amount))}</span>
                    <button
                      onClick={() => deleteSettlement(st)}
                      className="text-slate-500 hover:text-rose-400 p-1"
                      title="Delete payment"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))
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
                Add Filament Spools (AI Receipt or Manual)
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
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Gemini is extracting spools...
                </p>
              )}
            </div>

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
              + Add Another Spool Row
            </button>

            <button
              onClick={saveStagedSpools}
              disabled={saving || stagedSpools.length === 0}
              className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white font-semibold py-3 rounded-xl text-sm"
            >
              Confirm & Save {stagedSpools.length} Spool(s)
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

            <input
              value={printTitle}
              onChange={(e) => setPrintTitle(e.target.value)}
              placeholder="Model Name (e.g., Gridfinity Bin)"
              className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-sm"
            />

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
