import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type CandlestickData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle } from '@polarium12c/shared';

export interface ActiveOrderLine {
  /** signalId da ordem — identifica a linha entre renders (podem existir 2+ simultaneas). */
  id: string;
  /** Preco no momento da entrada — onde a linha tracejada e desenhada. */
  entryPrice: number;
  /** 'WIN' | 'LOSS' | 'DOJI' colore a linha pelo resultado final; null = ainda em aberto. */
  result: 'WIN' | 'LOSS' | 'DOJI' | null;
}

export interface SRLevelLine {
  price: number;
  type: 'support' | 'resistance';
  touches: number;
}

export interface ChartMarker {
  time: number; // epoch seconds (candle.from do candle marcado)
  position: 'aboveBar' | 'belowBar';
  color: string;
  shape: 'arrowUp' | 'arrowDown' | 'circle';
  text?: string;
}

interface Props {
  /** Historico carregado — so deve mudar quando o usuario troca de ativo/periodo e recarrega. */
  candles: Candle[];
  /** Tick mais recente (fechado ou ainda em formacao) — atualiza so a ultima vela, sem resetar zoom/posicao. */
  liveCandle?: Candle | null;
  markers?: ChartMarker[];
  /** Entradas em aberto/recem-resolvidas — uma linha tracejada por entrada, no respectivo preco.
   * Suporta 2+ simultaneas (cliques repetidos em Comprar/Vender), nao so uma por vez. */
  activeOrders?: ActiveOrderLine[];
  /** Niveis de Suporte/Resistencia validados (2+ toques) pro ativo atual — linhas horizontais
   * continuas, so pra referencia visual (nao reagem a clique nem mudam de cor). */
  srLevels?: SRLevelLine[];
  /** Altura fixa em px — ignorado quando `fill` esta ligado. */
  height?: number;
  /** Em vez de uma altura fixa, ocupa 100% do container pai (que precisa ter altura propria,
   * ex.: via classe h-[...vh]) — usado na tela "Grafico" pra ocupar a tela toda, estilo corretora. */
  fill?: boolean;
}

export interface CandleChartHandle {
  /** Rola ate a ponta mais recente (agora) — usado pelo botao "Ir para agora". */
  goToRealTime: () => void;
  /** Centraliza a visao num intervalo de tempo especifico (epoch seconds) — usado pela
   * navegacao entre ocorrencias WIN/LOSS, pra "voltar no tempo" ate um sinal passado. */
  setVisibleRange: (from: number, to: number) => void;
}

// Quantas velas ficam visiveis quando o grafico abre (ou recarrega um ativo novo) — nao o
// historico inteiro buscado (que pode ser 1+ dia de M1, centenas/milhares de velas).
const INITIAL_VISIBLE_CANDLES = 80;

function toCandlestickData(c: Candle): CandlestickData<Time> {
  return { time: c.from as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close };
}

/**
 * Grafico de candlestick real usando lightweight-charts. `candles` (o historico) so e
 * redesenhado do zero quando o ARRAY muda de referencia (ou seja, quando a tela troca de
 * ativo/periodo e busca um novo historico) — cada tick ao vivo chega via `liveCandle` e usa
 * `series.update()`, que atualiza so a ultima barra. `shiftVisibleRangeOnNewBar` e desligado
 * de proposito: por padrao a lib tenta "seguir" o preco e rolar a visao sozinha a cada tick
 * novo, o que brigava com o usuario tentando arrastar manualmente pra ver outra parte do
 * grafico — agora a visao SO muda quando o usuario mexe nela ou aperta "Ir para agora".
 */
export const CandleChart = forwardRef<CandleChartHandle, Props>(function CandleChart(
  { candles, liveCandle, markers, activeOrders, srLevels, height = 360, fill = false },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const markersPluginRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const activeOrderLinesRef = useRef<Map<string, IPriceLine>>(new Map());
  const srLevelLinesRef = useRef<IPriceLine[]>([]);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      ...(fill ? { autoSize: true } : { height }),
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#94a3b8' },
      grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: '#334155',
        rightOffset: 5,
        shiftVisibleRangeOnNewBar: false, // nunca rola sozinho quando um tick novo chega — so por acao do usuario
        // Por padrao a biblioteca formata o eixo em UTC, nao no fuso do navegador — o relogio
        // ao vivo da tela (TradePanel, abaixo do grafico) usa hora LOCAL, entao os dois ficavam
        // com uma diferenca fixa (3h no Brasil/UTC-3), fazendo o grafico parecer "errado" ou
        // "faltando vela" quando comparado com o grafico de verdade da corretora (que mostra
        // hora local). Forca o eixo a usar a hora local do navegador tambem, pra bater com o
        // relogio da tela e com a corretora.
        tickMarkFormatter: (time: number) =>
          new Date(time * 1000).toLocaleTimeString('pt-BR', { hour12: false, hour: '2-digit', minute: '2-digit' }),
      },
      localization: {
        timeFormatter: (time: number) =>
          new Date(time * 1000).toLocaleTimeString('pt-BR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      },
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

    // Com `fill`, autoSize ja cuida de largura E altura sozinho — so precisamos do
    // ResizeObserver manual (so largura) no modo de altura fixa (demais telas).
    let resizeObserver: ResizeObserver | null = null;
    if (!fill) {
      resizeObserver = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width;
        if (width) chart.applyOptions({ width });
      });
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      resizeObserver?.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      markersPluginRef.current = null;
      activeOrderLinesRef.current.clear();
      srLevelLinesRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Carga do historico: redesenha tudo e so ENTAO ajusta a visao, mostrando so as ultimas
  // INITIAL_VISIBLE_CANDLES velas (nao o dia INTEIRO espremido na tela) com a ponta mais
  // recente (agora) a direita — acontece so quando `candles` muda de referencia (novo
  // carregamento), nunca a cada tick. scrollToRealTime() sozinho so cuida do PAN (pra onde
  // rolar), nao do ZOOM — sem fixar o range logico aqui, o grafico abre com o auto-fit padrao
  // da lib (todo o historico de uma vez, ex.: o dia inteiro quando Dias=1), que faz o usuario
  // ter que dar zoom manualmente toda vez so pra ver os candles recentes direito.
  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) return;
    seriesRef.current.setData(candles.map(toCandlestickData));
    if (candles.length > 0) {
      const from = Math.max(0, candles.length - INITIAL_VISIBLE_CANDLES);
      chartRef.current.timeScale().setVisibleLogicalRange({ from, to: candles.length - 1 + 5 });
    }
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

  // Uma linha tracejada por entrada em aberto/recem-resolvida — cinza enquanto aberta,
  // verde/vermelha quando o resultado chega. Reconcilia pelo `id` (signalId): remove as que
  // sairam da lista, cria as novas, atualiza a cor das que mudaram de resultado — assim 2+
  // entradas simultaneas (cliques repetidos em Comprar/Vender) aparecem cada uma na sua linha.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const current = activeOrderLinesRef.current;
    const wanted = new Map((activeOrders ?? []).map((o) => [o.id, o]));

    for (const [id, line] of current) {
      if (!wanted.has(id)) {
        series.removePriceLine(line);
        current.delete(id);
      }
    }

    for (const order of wanted.values()) {
      const color = order.result === 'WIN' ? '#22c55e' : order.result === 'LOSS' ? '#f43f5e' : '#facc15';
      const existing = current.get(order.id);
      if (existing) {
        existing.applyOptions({ price: order.entryPrice, color });
      } else {
        current.set(
          order.id,
          series.createPriceLine({
            price: order.entryPrice,
            color,
            lineWidth: 2,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: 'Entrada',
          })
        );
      }
    }
  }, [activeOrders]);

  // Niveis de Suporte/Resistencia validados — linhas continuas (nao tracejadas, pra nao
  // confundir com as linhas de entrada), cor fixa por tipo, so redesenhadas quando a lista
  // muda (troca de ativo ou nova varredura), nunca a cada tick.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    for (const line of srLevelLinesRef.current) series.removePriceLine(line);
    srLevelLinesRef.current = (srLevels ?? []).map((level) =>
      series.createPriceLine({
        price: level.price,
        color: level.type === 'support' ? '#38bdf8' : '#f472b6',
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: `${level.type === 'support' ? 'Suporte' : 'Resistência'} (${level.touches}x)`,
      })
    );
  }, [srLevels]);

  useImperativeHandle(ref, () => ({
    goToRealTime: () => chartRef.current?.timeScale().scrollToRealTime(),
    setVisibleRange: (from, to) =>
      chartRef.current?.timeScale().setVisibleRange({ from: from as UTCTimestamp, to: to as UTCTimestamp }),
  }));

  return <div ref={containerRef} className={fill ? 'w-full h-full' : 'w-full'} />;
});
