import { useEffect, useRef, useState } from 'react';
import { CANDLE_SIZE_M1, CANDLE_SIZE_M5, CANDLE_SIZE_M15, type Candle, type Direction, type TradeResult } from '@polarium12c/shared';
import { api } from '../api.js';
import { CandleChart, type ActiveOrderLine, type CandleChartHandle, type ChartMarker } from './CandleChart.js';

/** Dados de UMA posicao do historico REAL (corretora) necessarios pra desenhar a entrada no
 * grafico — ver OperationsPage (aba "Real (corretora)", clique numa linha). */
export interface HistoricalEntryTarget {
  activeId: number;
  direction: Direction;
  openTime: number; // epoch ms
  closeTime: number; // epoch ms
  openQuote: number;
  closeQuote: number;
  result: TradeResult | null;
  pnlRealized: number | null;
  invest: number | null;
  currency: string | null;
}

const TIMEFRAMES: { size: number; label: string }[] = [
  { size: CANDLE_SIZE_M1, label: '1 min' },
  { size: CANDLE_SIZE_M5, label: '5 min' },
  { size: CANDLE_SIZE_M15, label: '15 min' },
];

function formatByCurrency(value: number, currency: string | null): string {
  if (!currency) return value.toFixed(2);
  try {
    return value.toLocaleString('pt-BR', { style: 'currency', currency });
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

interface Props {
  target: HistoricalEntryTarget;
  assetName: string;
  onClose: () => void;
}

/**
 * Modal "ver no grafico" pra uma entrada do historico real — abre SEM sair da tela de Operacoes
 * (pedido explicito: nao precisa trocar de aba). So mostra o grafico de velas + a linha de
 * entrada/marcador de resultado, sem nada da tela "Grafico" (sem seletor de estrategia, sem
 * ranking, sem lista de vigilancia) — foco total na entrada especifica que o usuario quer revisar.
 *
 * Timeframe: comeca sempre em M1 (pedido explicito — e o tempo em que as entradas sao feitas),
 * mas deixa trocar pra M5/M15 pra avaliar se, numa janela maior/menor, apareceriam mais velas a
 * favor ou contra o lado entrado — nenhuma estrategia roda nesses timeframes, e so visualizacao.
 */
export function HistoricalEntryModal({ target, assetName, onClose }: Props) {
  const [size, setSize] = useState(CANDLE_SIZE_M1);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chartRef = useRef<CandleChartHandle>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const daysNeeded = Math.min(90, Math.max(1, Math.ceil((Date.now() - target.openTime) / (24 * 60 * 60 * 1000)) + 2));
    api
      .getCandles(target.activeId, daysNeeded, size)
      .then((data) => {
        if (cancelled) return;
        setCandles(data);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, target.activeId]);

  // Centraliza o grafico no momento da entrada assim que as velas (desse timeframe) chegarem —
  // mesmo padrao usado na tela "Grafico" pra navegar entre ocorrencias WIN/LOSS passadas.
  useEffect(() => {
    if (candles.length === 0 || !chartRef.current) return;
    const openSec = Math.floor(target.openTime / 1000);
    const centerIdx = candles.findIndex((c) => c.from >= openSec);
    if (centerIdx === -1) return;
    const fromCandle = candles[Math.max(0, centerIdx - 20)]!;
    const toCandle = candles[Math.min(candles.length - 1, centerIdx + 10)]!;
    chartRef.current.setVisibleRange(fromCandle.from, toCandle.to);
  }, [candles, target.openTime]);

  const openSec = Math.floor(target.openTime / 1000);
  const closeSec = Math.floor(target.closeTime / 1000);
  const activeOrders: ActiveOrderLine[] = [{ id: 'hist', entryPrice: target.openQuote, result: target.result }];
  const pnlText =
    target.pnlRealized !== null ? ` ${target.pnlRealized >= 0 ? '+' : ''}${formatByCurrency(target.pnlRealized, target.currency)}` : '';
  // Acha a vela que REALMENTE contem cada horario, no timeframe atual — nao da pra so assumir
  // "fechamento menos 60s" pra achar a vela de entrada, porque isso so bate pro M1; trocando pra
  // M5/M15 a vela de entrada e outra (o marcador tem que casar com uma vela de verdade do array,
  // senao a biblioteca do grafico pode rejeitar TODOS os marcadores, nao so esse).
  function candleTimeContaining(epochSec: number): number | null {
    const found = candles.find((c) => c.from <= epochSec && epochSec < c.to) ?? candles.find((c) => c.from >= epochSec);
    return found?.from ?? null;
  }
  const openCandleTime = candleTimeContaining(openSec);
  const closeCandleTime = candleTimeContaining(closeSec);
  const markers: ChartMarker[] = [];
  if (openCandleTime !== null) {
    markers.push({
      time: openCandleTime,
      position: target.direction === 'CALL' ? 'belowBar' : 'aboveBar',
      color: '#fbbf24',
      shape: 'circle',
      text: 'Entrada',
    });
  }
  if (closeCandleTime !== null) {
    markers.push({
      time: closeCandleTime,
      position: target.direction === 'CALL' ? 'belowBar' : 'aboveBar',
      color: target.result === 'WIN' ? '#22c55e' : target.result === 'LOSS' ? '#f43f5e' : '#94a3b8',
      shape: target.result === 'WIN' ? 'arrowUp' : target.result === 'LOSS' ? 'arrowDown' : 'circle',
      text: `${target.result ?? '—'}${pnlText}`,
    });
  }
  markers.sort((a, b) => a.time - b.time);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3" role="dialog" aria-modal="true">
      {/* `h-[85vh]` (nao so max-h) e proposital: um filho `flex-1` (ver div do grafico abaixo) so
          cresce de verdade quando o PAI tem uma altura definida — com so max-h, o modal encolhe
          pro tamanho do conteudo e o `flex-1` do grafico vira 0px (foi exatamente o bug visto:
          grafico em branco, so os eixos e os marcadores sem nenhuma vela desenhada). */}
      <div className="w-full max-w-4xl h-[85vh] rounded-xl border border-slate-800 bg-slate-950 flex flex-col">
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-slate-800">
          <div>
            <div className="font-semibold">{assetName}</div>
            <div className="text-xs text-slate-400">
              {new Date(target.openTime).toLocaleString('pt-BR')} · {target.direction}
              {target.invest !== null && ` · ${formatByCurrency(target.invest, target.currency)}`}
              {target.result && (
                <span className={`ml-1 font-semibold ${target.result === 'WIN' ? 'text-emerald-400' : target.result === 'LOSS' ? 'text-rose-400' : 'text-slate-400'}`}>
                  · {target.result}
                  {pnlText}
                </span>
              )}
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-md px-2.5 py-1 text-sm text-slate-400 hover:bg-slate-900 hover:text-slate-200">
            ✕ Fechar
          </button>
        </div>

        <div className="flex items-center gap-1 px-4 py-2 border-b border-slate-800">
          <span className="text-xs text-slate-400 mr-1">Timeframe:</span>
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.size}
              type="button"
              onClick={() => setSize(tf.size)}
              className={`rounded-md px-2.5 py-1 text-xs border ${
                size === tf.size ? 'bg-sky-700 border-sky-500 text-white' : 'border-slate-700 text-slate-400 hover:bg-slate-900'
              }`}
            >
              {tf.label}
            </button>
          ))}
        </div>

        <div className="flex-1 min-h-[360px] p-2">
          {error ? (
            <div className="h-full flex items-center justify-center text-sm text-rose-400 px-4 text-center">{error}</div>
          ) : loading && candles.length === 0 ? (
            <div className="h-full flex items-center justify-center text-sm text-slate-500">Carregando velas...</div>
          ) : (
            <CandleChart ref={chartRef} candles={candles} markers={markers} activeOrders={activeOrders} fill />
          )}
        </div>
      </div>
    </div>
  );
}
