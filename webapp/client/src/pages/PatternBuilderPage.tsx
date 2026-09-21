import { useEffect, useState } from 'react';
import type { AssetInfo, CandleColor, CustomPattern } from '@polarium12c/shared';
import { entryDirectionOf } from '@polarium12c/shared';
import { api } from '../api.js';
import { AssetBadgePicker } from '../components/AssetBadgePicker.js';
import { AutoAnalysisCard, type AutoAnalysisState } from '../components/AutoAnalysisCard.js';
import { runAutoAnalysisScan } from '../lib/autoAnalysis.js';

const MIN_SLOTS = 2;
const MAX_SLOTS = 20;
const DEFAULT_SLOTS = 6;

function emptySlots(n: number): (CandleColor | null)[] {
  return Array.from({ length: n }, () => null);
}

/**
 * Tela de edicao de padrao: o usuario monta o proprio padrao de velas clicando em verde/vermelho
 * em cada casa (nunca digitando texto). A penultima casa e o sinal de confirmacao; a ultima e a
 * vela de entrada — a cor dela define a direcao (vermelha = PUT, verde = CALL). Ao salvar, o
 * padrao fica disponivel para "Rodar análise" (mesmo scan consolidado + Gale 1 do Monitor,
 * restrito a este padrao) e para ativar como a regra usada pelo monitor ao vivo.
 */
export function PatternBuilderPage() {
  const [slots, setSlots] = useState<(CandleColor | null)[]>(() => emptySlots(DEFAULT_SLOTS));
  const [name, setName] = useState('');
  const [patterns, setPatterns] = useState<CustomPattern[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assets, setAssets] = useState<AssetInfo[]>([]);
  const [analysisDays, setAnalysisDays] = useState(7);
  const [testAllAssets, setTestAllAssets] = useState(true);
  const [selectedAssetIds, setSelectedAssetIds] = useState<number[]>([]);
  const [analyzingPatternId, setAnalyzingPatternId] = useState<string | null>(null);
  const [analyzingPattern, setAnalyzingPattern] = useState<CustomPattern | null>(null);
  const [autoAnalysis, setAutoAnalysis] = useState<AutoAnalysisState>({ status: 'idle' });
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  useEffect(() => {
    refreshPatterns();
    api.getAssets().then(setAssets).catch(() => {});
  }, []);

  function refreshPatterns() {
    api.listPatterns().then(setPatterns).catch(() => {});
  }

  function setSlotColor(i: number, color: CandleColor) {
    setSlots((prev) => prev.map((c, idx) => (idx === i ? color : c)));
  }
  function clearSlot(i: number) {
    setSlots((prev) => prev.map((c, idx) => (idx === i ? null : c)));
  }
  function addSlot() {
    setSlots((prev) => (prev.length < MAX_SLOTS ? [...prev, null] : prev));
  }
  function removeSlot() {
    setSlots((prev) => (prev.length > MIN_SLOTS ? prev.slice(0, -1) : prev));
  }

  const allFilled = slots.every((c) => c !== null);

  async function save() {
    setError(null);
    if (!name.trim()) {
      setError('Informe um nome para o padrão.');
      return;
    }
    if (!allFilled) {
      setError('Preencha todas as casas (verde ou vermelha) antes de salvar.');
      return;
    }
    setSaving(true);
    try {
      await api.createPattern({ name: name.trim(), candles: slots as CandleColor[] });
      setName('');
      setSlots(emptySlots(DEFAULT_SLOTS));
      refreshPatterns();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function activate(id: string) {
    await api.activatePattern(id);
    refreshPatterns();
  }

  async function remove(id: string) {
    if (!confirm('Excluir este padrão?')) return;
    try {
      await api.deletePattern(id);
      refreshPatterns();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }

  async function runAnalysis(pattern: CustomPattern, assetsOverride?: AssetInfo[], daysOverride?: number) {
    const targetAssets = assetsOverride ?? (testAllAssets ? assets : assets.filter((a) => selectedAssetIds.includes(a.id)));
    if (targetAssets.length === 0) {
      setAnalysisError('Selecione pelo menos um ativo (ou marque "Testar todos os ativos") antes de rodar a análise.');
      return;
    }
    setAnalysisError(null);
    setAnalyzingPatternId(pattern.id);
    setAnalyzingPattern(pattern);
    const direction = entryDirectionOf(pattern.candles);
    const result = await runAutoAnalysisScan(targetAssets, daysOverride ?? analysisDays, pattern.id, direction, setAutoAnalysis);
    setAutoAnalysis(result);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold">Padrão</h1>
        <p className="text-slate-400 text-sm">
          Monte seu próprio padrão de velas clicando em verde ou vermelho em cada casa. A penúltima casa é o sinal de
          confirmação; a última é a vela de entrada — a cor dela define a direção (vermelha = PUT, verde = CALL).
        </p>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-4">
        <div className="flex items-end gap-2 flex-wrap">
          {slots.map((color, i) => {
            const isLast = i === slots.length - 1;
            return (
              <div key={i} className="flex flex-col items-center gap-1">
                <div
                  className={`h-10 w-10 rounded-lg flex items-center justify-center text-sm font-bold border-2 ${
                    color === 'G'
                      ? 'bg-emerald-600 border-emerald-400'
                      : color === 'R'
                        ? 'bg-rose-600 border-rose-400'
                        : 'bg-slate-800 border-dashed border-slate-600 text-slate-600'
                  } ${isLast ? 'ring-2 ring-sky-400' : ''}`}
                >
                  {color ?? '?'}
                </div>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => setSlotColor(i, 'G')}
                    className="h-5 w-5 rounded bg-emerald-700 hover:bg-emerald-600"
                    title="Verde"
                    aria-label={`Casa ${i + 1}: verde`}
                  />
                  <button
                    type="button"
                    onClick={() => setSlotColor(i, 'R')}
                    className="h-5 w-5 rounded bg-rose-700 hover:bg-rose-600"
                    title="Vermelho"
                    aria-label={`Casa ${i + 1}: vermelho`}
                  />
                  {color && (
                    <button
                      type="button"
                      onClick={() => clearSlot(i)}
                      className="h-5 w-5 rounded bg-slate-700 hover:bg-slate-600 text-[10px] leading-none"
                      title="Limpar"
                      aria-label={`Casa ${i + 1}: limpar`}
                    >
                      ×
                    </button>
                  )}
                </div>
                <span className="text-[10px] text-slate-500">{isLast ? 'Entrada' : i + 1}</span>
              </div>
            );
          })}
          <div className="flex flex-col items-center gap-1 ml-2">
            <button
              type="button"
              onClick={addSlot}
              disabled={slots.length >= MAX_SLOTS}
              className="h-10 w-10 rounded-lg border border-dashed border-slate-600 text-slate-400 hover:bg-slate-800 disabled:opacity-40"
              title="Adicionar casa"
            >
              +
            </button>
            <button
              type="button"
              onClick={removeSlot}
              disabled={slots.length <= MIN_SLOTS}
              className="h-6 w-10 rounded-lg border border-slate-700 text-slate-500 hover:bg-slate-800 disabled:opacity-40 text-xs"
              title="Remover última casa"
            >
              −
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs text-slate-400 mb-1">Nome do padrão</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ex.: Padrão A"
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <button
            onClick={save}
            disabled={saving || !allFilled || !name.trim()}
            className="rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 text-sm font-semibold"
          >
            {saving ? 'Salvando...' : 'Salvar padrão'}
          </button>
        </div>
        {error && <div className="text-sm text-rose-400">{error}</div>}
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="font-semibold text-sm">Padrões salvos</div>
          <label className="text-xs text-slate-500">
            Dias da análise:
            <input
              type="number"
              min={1}
              value={analysisDays}
              onChange={(e) => setAnalysisDays(Math.max(1, Number(e.target.value)))}
              className="w-16 ml-1 bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-xs text-slate-200"
            />
          </label>
        </div>

        <div className="rounded-lg bg-slate-950/40 border border-slate-800 p-3 space-y-2">
          <div className="text-xs text-slate-500">
            Ativos usados em "Rodar análise" — teste com poucos ativos primeiro e depois expanda para todos.
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={testAllAssets}
              onChange={(e) => setTestAllAssets(e.target.checked)}
              className="accent-sky-500"
            />
            Testar todos os ativos OTC digital
          </label>
          {!testAllAssets && <AssetBadgePicker assets={assets} value={selectedAssetIds} onChange={setSelectedAssetIds} />}
          {analysisError && <div className="text-xs text-rose-400">{analysisError}</div>}
        </div>

        {patterns.length === 0 ? (
          <div className="text-sm text-slate-500">Nenhum padrão salvo ainda.</div>
        ) : (
          <div className="space-y-2">
            {patterns.map((p) => (
              <div key={p.id} className="rounded-lg bg-slate-950/40 border border-slate-800 p-3 flex items-center gap-3 flex-wrap">
                <div className="flex gap-1">
                  {p.candles.map((c, i) => (
                    <span
                      key={i}
                      className={`h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                        c === 'G' ? 'bg-emerald-600' : 'bg-rose-600'
                      } ${i === p.candles.length - 1 ? 'ring-2 ring-sky-400' : ''}`}
                    >
                      {c}
                    </span>
                  ))}
                </div>
                <div className="flex-1 min-w-[100px]">
                  <div className="text-sm font-medium">{p.name}</div>
                  <div className="text-[11px] text-slate-500">
                    {p.candles.length - 1} velas + entrada {entryDirectionOf(p.candles)}
                  </div>
                </div>
                {p.isActive ? (
                  <span className="text-xs font-semibold text-emerald-400 px-2 py-1 rounded bg-emerald-950/60 border border-emerald-800">
                    Ativo
                  </span>
                ) : (
                  <button
                    onClick={() => activate(p.id)}
                    className="text-xs rounded-lg border border-emerald-700 text-emerald-300 hover:bg-emerald-950/60 px-2 py-1"
                  >
                    Ativar
                  </button>
                )}
                <button
                  onClick={() => runAnalysis(p)}
                  disabled={autoAnalysis.status === 'loading'}
                  className="text-xs rounded-lg border border-sky-700 text-sky-300 hover:bg-sky-950/60 disabled:opacity-50 px-2 py-1"
                >
                  {analyzingPatternId === p.id && autoAnalysis.status === 'loading'
                    ? 'Analisando...'
                    : `Rodar análise (${testAllAssets ? 'todos' : `${selectedAssetIds.length} ativo(s)`})`}
                </button>
                <button
                  onClick={() => remove(p.id)}
                  disabled={p.isActive}
                  className="text-xs rounded-lg border border-rose-800 text-rose-300 hover:bg-rose-950/60 disabled:opacity-30 disabled:cursor-not-allowed px-2 py-1"
                  title={p.isActive ? 'Ative outro padrão antes de excluir este' : undefined}
                >
                  Excluir
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {analyzingPatternId && analyzingPattern && (
        <AutoAnalysisCard
          state={autoAnalysis}
          onAnalyzeSingleAsset={(asset, days) => runAnalysis(analyzingPattern, [asset], days)}
        />
      )}
    </div>
  );
}
