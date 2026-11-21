'use client';

import React, { useEffect, useState, useMemo } from 'react';
import { supabase, User, Spool, PrintJob, Settlement } from '@/lib/supabase';
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
} from 'lucide-react';

export default function SpoolSplitApp() {
  const [users, setUsers] = useState<User[]>([]);
  const [activeUserId, setActiveUserId] = useState<string>('');
  const [spools, setSpools] = useState<Spool[]>([]);
  const [prints, setPrints] = useState<PrintJob[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [splitMode, setSplitMode] = useState<'usage' | 'pool'>('usage');
  const [activeTab, setActiveTab] = useState<'prints' | 'spools' | 'settle'>('prints');

  // Modals
  const [showReceiptModal, setShowReceiptModal] = useState(false);
  const [showPrintModal, setShowPrintModal] = useState(false);

  // Receipt AI State
  const [aiLoading, setAiLoading] = useState(false);
  const [receiptPaidBy, setReceiptPaidBy] = useState<string>('');
  const [receiptText, setReceiptText] = useState('');
  const [stagedSpools, setStagedSpools] = useState<any[]>([]);

  // Print Logger State
  const [printTitle, setPrintTitle] = useState('');
  const [printedBy, setPrintedBy] = useState<string>('');
  const [isSharedPrint, setIsSharedPrint] = useState(false);
  const [printDuration, setPrintDuration] = useState<number>(60);
  const [printNoteOrUrl, setPrintNoteOrUrl] = useState('');
  const [usages, setUsages] = useState<{ spool_id: string; grams_used: number }[]>([]);

  // Settlement Form State
  const [settleFrom, setSettleFrom] = useState('');
  const [settleTo, setSettleTo] = useState('');
  const [settleAmount, setSettleAmount] = useState('');
  const [settleMethod, setSettleMethod] = useState('Venmo');

  const fetchAllData = async () => {
    const [{ data: u }, { data: s }, { data: p }, { data: st }] = await Promise.all([
      supabase.from('users').select('*').order('name'),
      supabase.from('spools').select('*').eq('is_archived', false).order('created_at', { ascending: false }),
      supabase.from('prints').select('*, print_spool_usages(*)').order('created_at', { ascending: false }),
      supabase.from('settlements').select('*').order('settled_at', { ascending: false }),
    ]);

    if (u && u.length > 0) {
      setUsers(u);
      if (!activeUserId) {
        setActiveUserId(u[0].id);
        setReceiptPaidBy(u[0].id);
        setPrintedBy(u[0].id);
        setSettleFrom(u[0].id);
        setSettleTo(u[1]?.id || u[0].id);
      }
    }
    if (s) setSpools(s);
    if (p) setPrints(p);
    if (st) setSettlements(st);
  };

  useEffect(() => {
    fetchAllData();
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

  const ledger = useMemo(() => {
    if (users.length < 2) return { text: 'Setting up users...', amount: 0 };
    const [userA, userB] = users;
    let userAOwesUserB = 0;

    if (splitMode === 'usage') {
      prints.forEach((p) => {
        (p.print_spool_usages || []).forEach((u) => {
          const spool = spools.find((s) => s.id === u.spool_id);
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
      spools.forEach((s) => {
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
    if (absAmount < 0.01) return { text: 'All settled up!', amount: 0 };
    if (userAOwesUserB > 0) {
      return { text: `${userA.name} owes ${userB.name}`, amount: absAmount };
    } else {
      return { text: `${userB.name} owes ${userA.name}`, amount: absAmount };
    }
  }, [users, spools, prints, settlements, splitMode]);

  const handleReceiptParse = async (file?: File) => {
    setAiLoading(true);
    try {
      let fileBase64 = undefined;
      let mimeType = undefined;
      if (file) {
        fileBase64 = await fileToBase64(file);
        mimeType = file.type;
      }
      const res = await fetch('/api/ai/parse-receipt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileBase64, mimeType, rawText: receiptText }),
      });
      const data = await res.json();
      if (data.spools) {
        const expanded: any[] = [];
        data.spools.forEach((s: any) => {
          const qty = s.quantity || 1;
          for (let i = 0; i < qty; i++) {
            expanded.push({
              brand: s.brand || 'Bambu Lab',
              material: s.material || 'PLA Basic',
              color_name: s.color_name || 'Black',
              color_hex: s.estimated_color_hex || '#10b981',
              initial_weight_g: s.weight_grams || 1000,
              purchase_price: Number(s.unit_landed_cost || 20).toFixed(2),
            });
          }
        });
        setStagedSpools(expanded);
      }
    } finally {
      setAiLoading(false);
    }
  };

  const saveStagedSpools = async () => {
    if (stagedSpools.length === 0) return;
    const rows = stagedSpools.map((s) => ({
      brand: s.brand,
      material: s.material,
      color_name: s.color_name,
      color_hex: s.color_hex,
      initial_weight_g: Number(s.initial_weight_g),
      remaining_weight_g: Number(s.initial_weight_g),
      purchase_price: Number(s.purchase_price),
      paid_by_user_id: receiptPaidBy || activeUserId,
    }));
    await supabase.from('spools').insert(rows);
    setStagedSpools([]);
    setReceiptText('');
    setShowReceiptModal(false);
    fetchAllData();
  };

  const handlePrintParse = async (file?: File) => {
    setAiLoading(true);
    try {
      let fileBase64 = undefined;
      let mimeType = undefined;
      if (file) {
        fileBase64 = await fileToBase64(file);
        mimeType = file.type;
      }
      const res = await fetch('/api/ai/parse-print', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileBase64,
          mimeType,
          rawText: printNoteOrUrl,
          activeSpools: spools,
        }),
      });
      const data = await res.json();
      if (data.title) setPrintTitle(data.title);
      if (data.duration_minutes) setPrintDuration(data.duration_minutes);
      if (data.filament_usages && data.filament_usages.length > 0) {
        setUsages(
          data.filament_usages.map((u: any) => ({
            spool_id: u.matched_spool_id || spools[0]?.id || '',
            grams_used: Number(u.grams_used || 0),
          }))
        );
      }
    } finally {
      setAiLoading(false);
    }
  };

  const savePrintJob = async () => {
    if (!printTitle || usages.length === 0) return;
    let totalGrams = 0;
    let totalCost = 0;

    const preparedUsages = usages.map((u) => {
      const spool = spools.find((s) => s.id === u.spool_id);
      const cpg = spool ? Number(spool.cost_per_gram) : 0.02;
      const cost = Number(u.grams_used) * cpg;
      totalGrams += Number(u.grams_used);
      totalCost += cost;
      return {
        spool_id: u.spool_id,
        grams_used: Number(u.grams_used),
        calculated_cost: Number(cost.toFixed(2)),
      };
    });

    const { data: newPrint } = await supabase
      .from('prints')
      .insert({
        title: printTitle,
        printed_by_user_id: isSharedPrint ? null : printedBy || activeUserId,
        is_shared_print: isSharedPrint,
        duration_minutes: Number(printDuration || 0),
        source_type: printNoteOrUrl ? 'url' : 'manual',
        source_url: printNoteOrUrl || null,
        total_grams: Number(totalGrams.toFixed(2)),
        total_cost: Number(totalCost.toFixed(2)),
      })
      .select()
      .single();

    if (newPrint) {
      await supabase.from('print_spool_usages').insert(
        preparedUsages.map((u) => ({
          ...u,
          print_id: newPrint.id,
        }))
      );
    }

    setPrintTitle('');
    setPrintNoteOrUrl('');
    setUsages([]);
    setShowPrintModal(false);
    fetchAllData();
  };

  const deletePrint = async (id: string) => {
    await supabase.from('prints').delete().eq('id', id);
    fetchAllData();
  };

  const handleSettleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settleAmount || Number(settleAmount) <= 0) return;
    await supabase.from('settlements').insert({
      from_user_id: settleFrom,
      to_user_id: settleTo,
      amount: Number(settleAmount),
      method: settleMethod,
    });
    setSettleAmount('');
    fetchAllData();
  };

  const exportCsv = () => {
    const rows = [
      ['Date', 'Print Title', 'Printed By', 'Total Grams', 'Total Cost ($)'],
      ...prints.map((p) => {
        const uName = p.is_shared_print
          ? 'Shared (50/50)'
          : users.find((u) => u.id === p.printed_by_user_id)?.name || '';
        return [
          new Date(p.created_at).toLocaleDateString(),
          `"${p.title}"`,
          uName,
          p.total_grams,
          p.total_cost,
        ];
      }),
    ];
    const csvContent = 'data:text/csv;charset=utf-8,' + rows.map((e) => e.join(',')).join('\n');
    const link = document.createElement('a');
    link.setAttribute('href', encodeURI(csvContent));
    link.setAttribute('download', 'spoolsplit_ledger.csv');
    document.body.appendChild(link);
    link.click();
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
            <p className="text-3xl font-extrabold text-emerald-400 mt-0.5">
              ${ledger.amount.toFixed(2)}
            </p>
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
            setStagedSpools([
              {
                brand: 'Bambu Lab',
                material: 'PLA Basic',
                color_name: 'Jade White',
                color_hex: '#ffffff',
                initial_weight_g: 1000,
                purchase_price: 19.99,
              },
            ]);
            setShowReceiptModal(true);
          }}
          className="flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-100 font-semibold py-3.5 px-4 rounded-xl border border-slate-700 transition"
        >
          <Receipt className="w-4 h-4 text-emerald-400" />
          Scan Bill / Add Spool
        </button>
      </div>

      <div className="flex border-b border-slate-800 mb-4 text-sm font-medium">
        <button
          onClick={() => setActiveTab('prints')}
          className={`pb-3 px-4 border-b-2 transition ${
            activeTab === 'prints'
              ? 'border-emerald-500 text-emerald-400'
              : 'border-transparent text-slate-400'
          }`}
        >
          Print History ({prints.length})
        </button>
        <button
          onClick={() => setActiveTab('spools')}
          className={`pb-3 px-4 border-b-2 transition ${
            activeTab === 'spools'
              ? 'border-emerald-500 text-emerald-400'
              : 'border-transparent text-slate-400'
          }`}
        >
          Spool Rack ({spools.length})
        </button>
        <button
          onClick={() => setActiveTab('settle')}
          className={`pb-3 px-4 border-b-2 transition ${
            activeTab === 'settle'
              ? 'border-emerald-500 text-emerald-400'
              : 'border-transparent text-slate-400'
          }`}
        >
          Settlements ({settlements.length})
        </button>
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
            prints.map((p) => {
              const printerUser = users.find((u) => u.id === p.printed_by_user_id);
              return (
                <div
                  key={p.id}
                  className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex items-center justify-between"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm">{p.title}</span>
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-300">
                        {p.is_shared_print ? 'Shared 50/50' : printerUser?.name || 'User'}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mt-1">
                      {Number(p.total_grams).toFixed(0)}g used •{' '}
                      {new Date(p.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-bold text-emerald-400">
                      ${Number(p.total_cost).toFixed(2)}
                    </span>
                    <button
                      onClick={() => deletePrint(p.id)}
                      className="text-slate-500 hover:text-rose-400 p-1"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {activeTab === 'spools' && (
        <div className="space-y-3">
          {spools.map((s) => {
            const buyer = users.find((u) => u.id === s.paid_by_user_id);
            const pct = Math.max(
              0,
              Math.min(100, (Number(s.remaining_weight_g) / Number(s.initial_weight_g)) * 100)
            );
            return (
              <div key={s.id} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                <div className="flex items-center justify-between mb-2">
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
                        Paid by {buyer?.name} (${Number(s.purchase_price).toFixed(2)} • $
                        {(Number(s.cost_per_gram) * 1000).toFixed(2)}/kg)
                      </p>
                    </div>
                  </div>
                  <span className="text-xs font-mono text-slate-300">
                    {Number(s.remaining_weight_g).toFixed(0)}g / {Number(s.initial_weight_g).toFixed(0)}g
                  </span>
                </div>
                <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {activeTab === 'settle' && (
        <div className="space-y-5">
          <form
            onSubmit={handleSettleSubmit}
            className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3"
          >
            <h3 className="text-sm font-semibold">Record a Payment (Venmo / Zelle / Cash)</h3>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-slate-400">From</label>
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
                <label className="text-xs text-slate-400">To</label>
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
              </select>
            </div>
            <button
              type="submit"
              className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-semibold py-2.5 rounded-lg text-sm"
            >
              Save Payment
            </button>
          </form>
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
                  }}
                />
              </label>
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
                  className="grid grid-cols-4 gap-1.5 bg-slate-950 p-2 rounded-lg border border-slate-800 text-xs"
                >
                  <input
                    value={sp.material}
                    onChange={(e) => {
                      const copy = [...stagedSpools];
                      copy[idx].material = e.target.value;
                      setStagedSpools(copy);
                    }}
                    placeholder="PLA Basic"
                    className="bg-slate-900 p-1.5 rounded"
                  />
                  <input
                    value={sp.color_name}
                    onChange={(e) => {
                      const copy = [...stagedSpools];
                      copy[idx].color_name = e.target.value;
                      setStagedSpools(copy);
                    }}
                    placeholder="Color"
                    className="bg-slate-900 p-1.5 rounded"
                  />
                  <input
                    type="number"
                    value={sp.initial_weight_g}
                    onChange={(e) => {
                      const copy = [...stagedSpools];
                      copy[idx].initial_weight_g = e.target.value;
                      setStagedSpools(copy);
                    }}
                    placeholder="1000g"
                    className="bg-slate-900 p-1.5 rounded"
                  />
                  <input
                    type="number"
                    step="0.01"
                    value={sp.purchase_price}
                    onChange={(e) => {
                      const copy = [...stagedSpools];
                      copy[idx].purchase_price = e.target.value;
                      setStagedSpools(copy);
                    }}
                    placeholder="$ Price"
                    className="bg-slate-900 p-1.5 rounded"
                  />
                </div>
              ))}
            </div>

            <button
              onClick={() =>
                setStagedSpools([
                  ...stagedSpools,
                  {
                    brand: 'Bambu Lab',
                    material: 'PLA Basic',
                    color_name: 'Black',
                    color_hex: '#10b981',
                    initial_weight_g: 1000,
                    purchase_price: 19.99,
                  },
                ])
              }
              className="text-xs text-emerald-400 font-medium"
            >
              + Add Another Spool Row
            </button>

            <button
              onClick={saveStagedSpools}
              className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-semibold py-3 rounded-xl text-sm"
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
                  }}
                />
              </label>
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
              {usages.map((u, idx) => (
                <div key={idx} className="flex gap-2">
                  <select
                    value={u.spool_id}
                    onChange={(e) => {
                      const copy = [...usages];
                      copy[idx].spool_id = e.target.value;
                      setUsages(copy);
                    }}
                    className="flex-1 bg-slate-950 border border-slate-800 rounded-lg p-2 text-xs"
                  >
                    {spools.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.color_name} ({s.material}) — {Number(s.remaining_weight_g).toFixed(0)}g left
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    value={u.grams_used}
                    onChange={(e) => {
                      const copy = [...usages];
                      copy[idx].grams_used = Number(e.target.value);
                      setUsages(copy);
                    }}
                    placeholder="Grams"
                    className="w-24 bg-slate-950 border border-slate-800 rounded-lg p-2 text-xs"
                  />
                </div>
              ))}
              <button
                onClick={() =>
                  setUsages([...usages, { spool_id: spools[0]?.id || '', grams_used: 10 }])
                }
                className="text-xs text-emerald-400 font-medium"
              >
                + Add Another AMS Color Slot
              </button>
            </div>

            <button
              onClick={savePrintJob}
              className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-semibold py-3 rounded-xl text-sm"
            >
              Save Print & Deduct Filament
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
