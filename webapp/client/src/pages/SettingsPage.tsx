import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { AppMode, Settings } from '@polarium12c/shared';
import { api } from '../api.js';
import { AssetPicker } from '../components/AssetPicker.js';

interface OutletCtx {
  settings: Settings | null;
  refreshHeader: () => Promise<void>;
}

const MODE_OPTIONS: { value: AppMode; label: string; hint: string }[] = [
  { value: 'OBSERVATION', label: 'OBSERVATION', hint: 'Detecta e registra, sem enviar ordens.' },
  { value: 'DEMO', label: 'DEMO', hint: 'Executa automaticamente na conta de prática (dinheiro fictício da corretora).' },
  { value: 'REAL', label: 'REAL', hint: 'Bloqueado nesta versão.' },
];

export function SettingsPage() {
  const { settings, refreshHeader } = useOutletContext<OutletCtx>();
  const [form, setForm] = useState<Settings | null>(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Layout busca settings de forma assincrona: se esta pagina montar antes disso resolver,
  // form ficaria preso em null para sempre sem este efeito.
  useEffect(() => {
    if (settings && !form) setForm(settings);
  }, [settings, form]);

  if (!form) return <div className="text-slate-400">Carregando...</div>;

  async function save() {
    if (!form) return;
    setError(null);
    setSaving(true);
    try {
      const next = await api.saveSettings(form);
      setForm(next);
      setSavedAt(Date.now());
      await refreshHeader();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold">Configurações</h1>
        <p className="text-slate-400 text-sm">Regras de risco e seleção de ativos. Ao atingir qualquer limite, o robô bloqueia novas operações.</p>
      </div>

      {error && <div className="rounded-lg border border-rose-800 bg-rose-950/50 p-3 text-sm text-rose-300">{error}</div>}

      <section className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-4">
        <h2 className="font-semibold">Modo</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {MODE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              disabled={opt.value === 'REAL'}
              onClick={() => setForm({ ...form, mode: opt.value })}
              className={`text-left rounded-lg border p-3 transition-colors ${
                form.mode === opt.value ? 'border-emerald-600 bg-emerald-950/40' : 'border-slate-700 bg-slate-950'
              } ${opt.value === 'REAL' ? 'opacity-50 cursor-not-allowed' : 'hover:border-slate-500'}`}
            >
              <div className="font-semibold text-sm">{opt.label}</div>
              <div className="text-xs text-slate-400 mt-1">{opt.hint}</div>
            </button>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-4">
        <h2 className="font-semibold">Ativos monitorados</h2>
        <AssetPicker
          value={form.selectedActiveIds}
          onChange={(selectedActiveIds) => setForm({ ...form, selectedActiveIds })}
        />
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-4">
        <h2 className="font-semibold">Entrada e Gale</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="text-sm">
            <span className="block text-slate-400 mb-1">Valor da entrada (mínimo R$5,00)</span>
            <input
              type="number"
              min={5}
              step={1}
              value={form.entryAmount}
              onChange={(e) => setForm({ ...form, entryAmount: Number(e.target.value) })}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2"
            />
          </label>
          <label className="text-sm flex items-end gap-2">
            <input
              type="checkbox"
              checked={form.galeEnabled}
              onChange={(e) => setForm({ ...form, galeEnabled: e.target.checked, galeMaxLevels: e.target.checked ? 1 : 0 })}
            />
            <span>Gale (no máximo 1 nível quando ativado)</span>
          </label>
        </div>
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-4">
        <h2 className="font-semibold">Limites diários</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
          <label>
            <span className="block text-slate-400 mb-1">Stop Win diário</span>
            <input
              type="number"
              value={form.stopWinDaily ?? ''}
              onChange={(e) => setForm({ ...form, stopWinDaily: e.target.value === '' ? null : Number(e.target.value) })}
              placeholder="sem limite"
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2"
            />
          </label>
          <label>
            <span className="block text-slate-400 mb-1">Stop Loss diário</span>
            <input
              type="number"
              value={form.stopLossDaily ?? ''}
              onChange={(e) => setForm({ ...form, stopLossDaily: e.target.value === '' ? null : Number(e.target.value) })}
              placeholder="sem limite"
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2"
            />
          </label>
          <label>
            <span className="block text-slate-400 mb-1">Máx. operações/dia</span>
            <input
              type="number"
              value={form.maxOperationsPerDay ?? ''}
              onChange={(e) => setForm({ ...form, maxOperationsPerDay: e.target.value === '' ? null : Number(e.target.value) })}
              placeholder="sem limite"
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2"
            />
          </label>
        </div>
      </section>

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 px-5 py-2 font-semibold text-sm"
        >
          {saving ? 'Salvando...' : 'Salvar alterações'}
        </button>
        {savedAt && <span className="text-xs text-slate-500">Salvo às {new Date(savedAt).toLocaleTimeString('pt-BR')}</span>}
      </div>
    </div>
  );
}
