import { useEffect, useRef, useState } from 'react';
import type {
  AssetInfo,
  ClassicStrategyConfig,
  ClassicStrategyId,
  CompressionBreakoutParams,
  DirectionFilter,
  EngulfingParams,
  ImpulsePullbackParams,
  PinBarParams,
  SequenceReversalParams,
} from '@polarium12c/shared';
import { CLASSIC_STRATEGIES, defaultClassicStrategyConfig } from '@polarium12c/shared';
import { api } from '../api.js';
import { AssetBadgePicker } from '../components/AssetBadgePicker.js';
import { ClassicStrategyResults, type ClassicScanState } from '../components/ClassicStrategyResults.js';
import { runClassicStrategyScan } from '../lib/classicStrategyScan.js';

const DEFAULT_DAYS = 7;

/** Number input que trabalha em percentual (0-100) na tela, mas guarda fracao (0-1) no estado. */
function PercentField({ label, value, onChange, step = 5 }: { label: string; value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <label className="block">
      <span className="block text-xs text-slate-400 mb-1">{label}</span>
      <div className="flex items-center gap-1">
        <input
          type="number"
          min={0}
          max={100}
          step={step}
          value={Math.round(value * 100)}
          onChange={(e) => onChange(Math.max(0, Math.min(100, Number(e.target.value))) / 100)}
          className="bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-sm w-20"
        />
        <span className="text-xs text-slate-500">%</span>
      </div>
    </label>
  );
}

function NumberField({ label, value, onChange, min = 1, step = 1 }: { label: string; value: number; onChange: (v: number) => void; min?: number; step?: number }) {
  return (
    <label className="block">
      <span className="block text-xs text-slate-400 mb-1">{label}</span>
      <input
        type="number"
        min={min}
        step={step}
        value={value}
        onChange={(e) => onChange(Math.max(min, Number(e.target.value)))}
        className="bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-sm w-24"
      />
    </label>
  );
}

function DirectionField({ value, onChange }: { value: DirectionFilter; onChange: (v: DirectionFilter) => void }) {
  return (
    <label className="block">
      <span className="block text-xs text-slate-400 mb-1">Direção</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as DirectionFilter)}
        className="bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-sm"
      >
        <option value="BOTH">Ambas</option>
        <option value="CALL_ONLY">Só CALL</option>
        <option value="PUT_ONLY">Só PUT</option>
      </select>
    </label>
  );
}

function SequenceReversalForm({ params, onChange }: { params: SequenceReversalParams; onChange: (p: SequenceReversalParams) => void }) {
  return (
    <div className="flex flex-wrap gap-4">
      <NumberField label="Qtd. velas na sequência" value={params.sequenceLength} min={2} onChange={(v) => onChange({ ...params, sequenceLength: v })} />
      <PercentField label="Corpo mín. da reversão" value={params.minReversalBodyPercent} onChange={(v) => onChange({ ...params, minReversalBodyPercent: v })} />
      <PercentField label="Pavio oposto máx." value={params.maxReversalOppositeWickPercent} onChange={(v) => onChange({ ...params, maxReversalOppositeWickPercent: v })} />
      <DirectionField value={params.direction} onChange={(v) => onChange({ ...params, direction: v })} />
    </div>
  );
}

function EngulfingForm({ params, onChange }: { params: EngulfingParams; onChange: (p: EngulfingParams) => void }) {
  return (
    <div className="flex flex-wrap gap-4">
      <NumberField label="Corpo mín. (x anterior)" value={params.minBodyRatio} min={1} step={0.1} onChange={(v) => onChange({ ...params, minBodyRatio: v })} />
      <PercentField label="Pavio oposto máx." value={params.maxOppositeWickPercent} onChange={(v) => onChange({ ...params, maxOppositeWickPercent: v })} />
      <DirectionField value={params.direction} onChange={(v) => onChange({ ...params, direction: v })} />
    </div>
  );
}

function PinBarForm({ params, onChange }: { params: PinBarParams; onChange: (p: PinBarParams) => void }) {
  return (
    <div className="flex flex-wrap gap-4">
      <PercentField label="Pavio mín." value={params.minWickPercent} onChange={(v) => onChange({ ...params, minWickPercent: v })} />
      <PercentField label="Corpo máx." value={params.maxBodyPercent} onChange={(v) => onChange({ ...params, maxBodyPercent: v })} />
      <PercentField label="Fechamento mín. no extremo" value={params.minClosePositionPercent} onChange={(v) => onChange({ ...params, minClosePositionPercent: v })} />
      <DirectionField value={params.direction} onChange={(v) => onChange({ ...params, direction: v })} />
    </div>
  );
}

function ImpulsePullbackForm({ params, onChange }: { params: ImpulsePullbackParams; onChange: (p: ImpulsePullbackParams) => void }) {
  return (
    <div className="flex flex-wrap gap-4">
      <NumberField label="Velas p/ mediana" value={params.medianLookback} min={2} onChange={(v) => onChange({ ...params, medianLookback: v })} />
      <NumberField label="Impulso mín. (x mediana)" value={params.minImpulseRangeMultiplier} min={1} step={0.1} onChange={(v) => onChange({ ...params, minImpulseRangeMultiplier: v })} />
      <PercentField label="Retração máx. do pullback" value={params.maxPullbackRetracePercent} onChange={(v) => onChange({ ...params, maxPullbackRetracePercent: v })} />
      <DirectionField value={params.direction} onChange={(v) => onChange({ ...params, direction: v })} />
    </div>
  );
}

function CompressionBreakoutForm({ params, onChange }: { params: CompressionBreakoutParams; onChange: (p: CompressionBreakoutParams) => void }) {
  return (
    <div className="flex flex-wrap gap-4">
      <NumberField label="Velas na compressão" value={params.compressionLength} min={2} onChange={(v) => onChange({ ...params, compressionLength: v })} />
      <NumberField label="Velas p/ mediana" value={params.medianLookback} min={2} onChange={(v) => onChange({ ...params, medianLookback: v })} />
      <NumberField label="Range máx. (x mediana)" value={params.maxCompressionRangeRatio} min={0.1} step={0.1} onChange={(v) => onChange({ ...params, maxCompressionRangeRatio: v })} />
      <DirectionField value={params.direction} onChange={(v) => onChange({ ...params, direction: v })} />
    </div>
  );
}

/**
 * Tela "Estratégias Clássicas": deixa escolher uma de 5 familias classicas de setup (reversao
 * apos sequencia, engolfo, pin bar, impulso+pullback, compressao+breakout), ajustar os
 * parametros de cada uma, e rodar contra um ou varios ativos (ou todos) para ver quantas vezes
 * aconteceu e o resultado real.
 */
export function ClassicStrategiesPage() {
  const [strategyId, setStrategyId] = useState<ClassicStrategyId>('sequence_reversal');
  const [config, setConfig] = useState<ClassicStrategyConfig>(() => defaultClassicStrategyConfig('sequence_reversal'));
  const [assets, setAssets] = useState<AssetInfo[]>([]);
  const [testAllAssets, setTestAllAssets] = useState(true);
  const [selectedAssetIds, setSelectedAssetIds] = useState<number[]>([]);
  const [days, setDays] = useState(DEFAULT_DAYS);
  const [scan, setScan] = useState<ClassicScanState>({ status: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const startedAt = useRef<number | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.getAssets().then(setAssets).catch(() => {});
  }, []);

  useEffect(() => {
    if (scan.status !== 'loading') return;
    const interval = setInterval(() => {
      setScan((prev) => (prev.status === 'loading' && startedAt.current !== null ? { ...prev, elapsedMs: Date.now() - startedAt.current } : prev));
    }, 1000);
    return () => clearInterval(interval);
  }, [scan.status]);

  function selectStrategy(id: ClassicStrategyId) {
    setStrategyId(id);
    setConfig(defaultClassicStrategyConfig(id));
  }

  async function run() {
    const targetAssets = testAllAssets ? assets : assets.filter((a) => selectedAssetIds.includes(a.id));
    if (targetAssets.length === 0) {
      setError('Selecione pelo menos um ativo (ou marque "Testar todos os ativos") antes de rodar.');
      return;
    }
    setError(null);
    startedAt.current = Date.now();
    const result = await runClassicStrategyScan(targetAssets, days, config, setScan);
    setScan(result);
    resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  const info = CLASSIC_STRATEGIES.find((s) => s.id === strategyId)!;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold">Estratégias Clássicas</h1>
        <p className="text-slate-400 text-sm">
          Escolha uma família de setup clássico, ajuste os parâmetros e teste contra o histórico real dos ativos.
        </p>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-3">
        <div className="text-xs text-slate-500">Estratégia</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {CLASSIC_STRATEGIES.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => selectStrategy(s.id)}
              className={`text-left rounded-lg border p-3 transition-colors ${
                strategyId === s.id ? 'border-sky-500 bg-sky-950/40' : 'border-slate-800 bg-slate-950/40 hover:border-slate-700'
              }`}
            >
              <div className="text-sm font-semibold">{s.name}</div>
              <div className="text-[11px] text-slate-500 mt-0.5">{s.description}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-4">
        <div>
          <div className="font-semibold text-sm">{info.name} — parâmetros</div>
          <p className="text-xs text-slate-500 mt-0.5">A entrada é sempre testada na vela seguinte ao setup detectado.</p>
        </div>

        {config.id === 'sequence_reversal' && <SequenceReversalForm params={config.params} onChange={(params) => setConfig({ id: 'sequence_reversal', params })} />}
        {config.id === 'engulfing' && <EngulfingForm params={config.params} onChange={(params) => setConfig({ id: 'engulfing', params })} />}
        {config.id === 'pin_bar' && <PinBarForm params={config.params} onChange={(params) => setConfig({ id: 'pin_bar', params })} />}
        {config.id === 'impulse_pullback' && <ImpulsePullbackForm params={config.params} onChange={(params) => setConfig({ id: 'impulse_pullback', params })} />}
        {config.id === 'compression_breakout' && (
          <CompressionBreakoutForm params={config.params} onChange={(params) => setConfig({ id: 'compression_breakout', params })} />
        )}
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-3">
        <div className="rounded-lg bg-slate-950/40 border border-slate-800 p-3 space-y-2">
          <div className="text-xs text-slate-500">Ativos a testar</div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={testAllAssets} onChange={(e) => setTestAllAssets(e.target.checked)} className="accent-sky-500" />
            Testar todos os ativos OTC digital
          </label>
          {!testAllAssets && <AssetBadgePicker assets={assets} value={selectedAssetIds} onChange={setSelectedAssetIds} />}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-slate-400 mb-1">Dias</label>
            <input
              type="number"
              min={1}
              value={days}
              onChange={(e) => setDays(Math.max(1, Number(e.target.value)))}
              className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm w-24"
            />
          </div>
          <button
            onClick={run}
            disabled={scan.status === 'loading'}
            className="rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 text-sm font-semibold"
          >
            {scan.status === 'loading' ? 'Testando...' : `Testar (${testAllAssets ? 'todos' : `${selectedAssetIds.length} ativo(s)`})`}
          </button>
        </div>
        {error && <div className="text-xs text-rose-400">{error}</div>}
      </div>

      <div ref={resultsRef}>
        <ClassicStrategyResults state={scan} />
      </div>
    </div>
  );
}
