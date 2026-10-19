import { useEffect, useRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle } from '@polarium12c/shared';

export interface ChartMarker {
  time: number; // epoch seconds (candle.from do candle marcado)
  position: 'aboveBar' | 'belowBar';
  color: string;
  shape: 'arrowUp' | 'arrowDown';
  text?: string;
}

interface Props {
  /** Historico carregado — so deve mudar quando o usuario troca de ativo/periodo e recarrega. */
  candles: Candle[];
  /** Tick mais recente (fechado ou ainda em formacao) — atualiza so a ultima vela, sem resetar zoom/posicao. */
  liveCandle?: Candle | null;
  markers?: ChartMarker[];
  height?: number;
}

function toCandlestickData(c: Candle): CandlestickData<Time> {
  return { time: c.from as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close };
}

/**
 * Grafico de candlestick real usando lightweight-charts. `candles` (o historico) so e
 * redesenhado do zero quando o ARRAY muda de referencia (ou seja, quando a tela troca de
 * ativo/periodo e busca um novo historico) — cada tick ao vivo chega via `liveCandle` e usa
 * `series.update()`, que atualiza so a ultima barra sem re-ajustar o zoom nem recentralizar o
 * grafico, deixando o usuario livre pra rolar/dar zoom sem ser "puxado de volta" a cada tick.
 */
export function CandleChart({ candles, liveCandle, markers, height = 360 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const markersPluginRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      height,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#94a3b8' },
      grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#334155', rightOffset: 5 },
      rightPriceScale: { borderColor: '#334155' },
      crosshair: { mode: 0 },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#16a34a',
      downColor: '#dc2626',
      borderVisible: false,
      wickUpColor: '#16a34a',
      wickDownColor: '#dc2626',
    });
    const markersPlugin = createSeriesMarkers(series, []);

    chartRef.current = chart;
    seriesRef.current = series;
    markersPluginRef.current = markersPlugin;

    const resizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) chart.applyOptions({ width });
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      markersPluginRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Carga do historico: redesenha tudo e so ENTAO ajusta a visao, mostrando a ponta mais
  // recente (horario atual) a direita — acontece so quando `candles` muda de referencia
  // (novo carregamento), nunca a cada tick.
  useEffect(() => {
    if (!seriesRef.current) return;
    seriesRef.current.setData(candles.map(toCandlestickData));
    chartRef.current?.timeScale().scrollToRealTime();
  }, [candles]);

  // Tick ao vivo: atualiza so a ultima barra (ou acrescenta uma nova, se for um periodo novo)
  // sem nunca re-ajustar o zoom — e assim que lightweight-charts recomenda refletir dados ao
  // vivo sem "puxar" o grafico de volta toda hora.
  useEffect(() => {
    if (!seriesRef.current || !liveCandle) return;
    seriesRef.current.update(toCandlestickData(liveCandle));
  }, [liveCandle]);

  useEffect(() => {
    if (!markersPluginRef.current) return;
    const seriesMarkers: SeriesMarker<Time>[] = (markers ?? []).map((m) => ({
      time: m.time as UTCTimestamp,
      position: m.position,
      color: m.color,
      shape: m.shape,
      text: m.text,
    }));
    markersPluginRef.current.setMarkers(seriesMarkers);
  }, [markers]);

  return <div ref={containerRef} className="w-full" />;
}
