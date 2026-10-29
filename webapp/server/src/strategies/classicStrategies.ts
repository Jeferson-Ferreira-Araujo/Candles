import { randomUUID } from 'node:crypto';
import {
  CANDLE_SIZE_M1,
  bollingerBands,
  cci,
  lowerWickPercentage,
  upperWickPercentage,
  zigzagPivots,
  type Candle,
  type ClassicOccurrence,
  type ClassicStrategyConfig,
  type ClassicStrategyResult,
  type Direction,
  type TradeResult,
} from '@polarium12c/shared';
import type { BrokerAdapter } from '../broker/BrokerAdapter.js';
import { computeResultForDirection, oppositeDirection } from '../util/tradeResult.js';

/**
 * Motor de deteccao da (unica) familia de estrategia classica: Suporte e Resistencia. Varre um
 * array de candles FECHADOS e ordenados e devolve, para cada ocorrencia achada, o indice da
 * vela de ENTRADA (a vela seguinte ao setup, cujo resultado sera avaliado) e a janela de velas
 * que formou o setup. Nao confirma nada nem envia ordem — e leitura de historico + calculo
 * local, igual ao backtestRunner do padrao customizado.
 */

interface RawSignal {
  entryIndex: number;
  direction: Direction;
  setupWindow: Candle[];
  /** Percentual (ou razao expressa como percentual) que mede a "forca" da vela de sinal desta ocorrencia. */
  signalMetricValue: number;
}

/** Rotulo do metric de forca do sinal — um so, ja que so existe uma estrategia hoje. */
const SIGNAL_METRIC_LABEL: Record<ClassicStrategyConfig['id'], string> = {
  support_resistance: 'Toques anteriores no nível',
};

// Parametros fixos da estrategia (nao editaveis pelo usuario, igual as demais classicas ja
// removidas) — ajustados pro timeframe M1 das velas usadas pelo app.
const SR_ZIGZAG_THRESHOLD_PCT = 0.05; // 5% de reversao pra confirmar um topo/fundo no zigzag
const SR_LEVEL_TOLERANCE_PCT = 0.0015; // 0.15% — o quao perto um pivo precisa estar de outro pra contar como "o mesmo nivel"
const SR_MIN_TOUCHES = 2; // um nivel so e valido (suporte/resistencia de verdade) se o preco ja reverteu ali pelo menos 2 vezes
const SR_MIN_WICK_PERCENT = 0.3; // pavio de rejeicao minimo na vela de sinal (0..1 do range)
const SR_CCI_PERIOD = 14;
const SR_CCI_THRESHOLD = 100; // |CCI| >= 100 = sobrecomprado/sobrevendido (velocidade exaurida)
const SR_BOLLINGER_PERIOD = 20;
const SR_BOLLINGER_STDDEV = 2;
const SR_BOLLINGER_TOLERANCE = 0.002; // 0.2% de folga pra contar como "perto o suficiente" da banda
const SR_MIN_HISTORY = Math.max(SR_BOLLINGER_PERIOD, SR_CCI_PERIOD) + 10; // velas minimas antes de avaliar qualquer sinal

export interface SRLevel {
  price: number;
  touches: number;
}

/** Agrupa pivos do mesmo tipo que estao a `tolerancePct` de distancia uns dos outros em niveis —
 * so devolve os que foram tocados pelo menos `minTouches` vezes (niveis "validados" pelo mercado). */
function buildLevels(
  pivots: { price: number; type: 'high' | 'low' }[],
  type: 'high' | 'low',
  tolerancePct: number,
  minTouches: number
): SRLevel[] {
  const prices = pivots
    .filter((p) => p.type === type)
    .map((p) => p.price)
    .sort((a, b) => a - b);
  const levels: SRLevel[] = [];
  for (const price of prices) {
    const existing = levels.find((l) => Math.abs(price - l.price) / l.price <= tolerancePct);
    if (existing) {
      existing.price = (existing.price * existing.touches + price) / (existing.touches + 1);
      existing.touches++;
    } else {
      levels.push({ price, touches: 1 });
    }
  }
  return levels.filter((l) => l.touches >= minTouches);
}

/** Niveis de suporte/resistencia validados (2+ toques) a partir do historico MAIS RECENTE
 * disponivel — para desenhar no grafico (ver GET /api/support-resistance-levels), nao para
 * decidir sinal (essa logica, com o cuidado de nao vazar informacao do futuro, fica em
 * `detectSupportResistance`). Usa TODOS os pivos do historico, ja que aqui so interessa "quais
 * sao os niveis relevantes agora", nao "o que era conhecido num ponto especifico do passado". */
// Num historico longo (1+ dia de M1), ativos mais volateis acumulam muitos niveis validados —
// a maioria longe demais do preco atual pra ser acionavel, so poluindo o grafico. Filtra pelos
// mais PROXIMOS do preco agora e limita a quantidade, mostrando so os mais fortes (mais toques)
// entre esses.
const SR_LEVEL_MAX_DISTANCE_PCT = 0.08; // so niveis a ate 8% do preco atual
const SR_LEVEL_MAX_COUNT = 3; // no maximo 3 suportes + 3 resistencias

export function getCurrentSupportResistanceLevels(candles: Candle[]): { support: SRLevel[]; resistance: SRLevel[] } {
  const pivots = zigzagPivots(candles, SR_ZIGZAG_THRESHOLD_PCT);
  const currentPrice = candles[candles.length - 1]?.close;

  const nearbyAndStrongest = (levels: SRLevel[]): SRLevel[] => {
    const nearby =
      currentPrice === undefined
        ? levels
        : levels.filter((l) => Math.abs(l.price - currentPrice) / currentPrice <= SR_LEVEL_MAX_DISTANCE_PCT);
    return nearby
      .slice()
      .sort((a, b) => b.touches - a.touches)
      .slice(0, SR_LEVEL_MAX_COUNT);
  };

  return {
    support: nearbyAndStrongest(buildLevels(pivots, 'low', SR_LEVEL_TOLERANCE_PCT, SR_MIN_TOUCHES)),
    resistance: nearbyAndStrongest(buildLevels(pivots, 'high', SR_LEVEL_TOLERANCE_PCT, SR_MIN_TOUCHES)),
  };
}

/**
 * Suporte e Resistencia: o preco testa um nivel validado (2+ toques anteriores, achados via
 * zigzag) com rejeicao na propria vela (pavio do lado do nivel), CCI em sobrecompra/sobrevenda
 * (velocidade/momentum esticado) e fechamento perto/alem da Banda de Bollinger (variacao
 * tambem esticada) — tres confirmacoes independentes concordando, nao so o formato de uma vela
 * isolada. Entra na vela seguinte, na direcao da reversao esperada.
 */
function detectSupportResistance(candles: Candle[]): RawSignal[] {
  const out: RawSignal[] = [];
  if (candles.length < SR_MIN_HISTORY + 1) return out;

  // Calculados UMA vez pra todo o array (cada um e O(n)) — bem mais barato que recalcular a
  // cada vela avaliada. `confirmedAt` de cada pivo garante que nenhum nivel usa informacao que
  // so ficou disponivel DEPOIS da vela de sinal (ver zigzagPivots em shared/src/indicators.ts).
  const allPivots = zigzagPivots(candles, SR_ZIGZAG_THRESHOLD_PCT);
  const cciValues = cci(candles, SR_CCI_PERIOD);
  const bands = bollingerBands(candles, SR_BOLLINGER_PERIOD, SR_BOLLINGER_STDDEV);

  for (let i = SR_MIN_HISTORY; i < candles.length - 1; i++) {
    const knownPivots = allPivots.filter((p) => p.confirmedAt < i);
    if (knownPivots.length === 0) continue;

    const cciNow = cciValues[i];
    const band = bands[i];
    if (cciNow == null || !band) continue;

    const signal = candles[i]!;
    const lowerWick = lowerWickPercentage(signal);
    const upperWick = upperWickPercentage(signal);

    // Suporte: toque no fundo (nivel validado) + rejeicao pra cima + CCI sobrevendido +
    // fechamento perto/abaixo da banda inferior.
    const supportLevels = buildLevels(knownPivots, 'low', SR_LEVEL_TOLERANCE_PCT, SR_MIN_TOUCHES);
    const touchedSupport = supportLevels.find(
      (l) => signal.low <= l.price * (1 + SR_LEVEL_TOLERANCE_PCT) && signal.low >= l.price * (1 - SR_LEVEL_TOLERANCE_PCT * 3)
    );
    if (
      touchedSupport &&
      lowerWick !== null &&
      lowerWick >= SR_MIN_WICK_PERCENT &&
      cciNow <= -SR_CCI_THRESHOLD &&
      signal.close <= band.lower * (1 + SR_BOLLINGER_TOLERANCE)
    ) {
      out.push({
        entryIndex: i + 1,
        direction: 'CALL',
        setupWindow: candles.slice(Math.max(0, i - 5), i + 1),
        signalMetricValue: touchedSupport.touches,
      });
      continue;
    }

    // Resistencia: toque no topo (nivel validado) + rejeicao pra baixo + CCI sobrecomprado +
    // fechamento perto/acima da banda superior.
    const resistanceLevels = buildLevels(knownPivots, 'high', SR_LEVEL_TOLERANCE_PCT, SR_MIN_TOUCHES);
    const touchedResistance = resistanceLevels.find(
      (l) => signal.high >= l.price * (1 - SR_LEVEL_TOLERANCE_PCT) && signal.high <= l.price * (1 + SR_LEVEL_TOLERANCE_PCT * 3)
    );
    if (
      touchedResistance &&
      upperWick !== null &&
      upperWick >= SR_MIN_WICK_PERCENT &&
      cciNow >= SR_CCI_THRESHOLD &&
      signal.close >= band.upper * (1 - SR_BOLLINGER_TOLERANCE)
    ) {
      out.push({
        entryIndex: i + 1,
        direction: 'PUT',
        setupWindow: candles.slice(Math.max(0, i - 5), i + 1),
        signalMetricValue: touchedResistance.touches,
      });
    }
  }

  return out;
}

function detectSignals(candles: Candle[], strategy: ClassicStrategyConfig): RawSignal[] {
  switch (strategy.id) {
    case 'support_resistance':
      return detectSupportResistance(candles);
  }
}

/**
 * Verifica se o setup da estrategia ACABOU de se completar na ultima vela fechada — ou seja,
 * se a vela que esta se formando agora e a entrada (compra/venda). Reaproveita os mesmos
 * detectores de `runClassicStrategy` sem duplicar logica: cada detector so olha pra tras do
 * indice de entrada pra casar o setup (o candle de entrada em si so e lido DEPOIS, so pra
 * classificar WIN/LOSS) — entao basta um candle "dummy" no fim (nunca lido pelo matching) pra
 * satisfazer o `candles[entryIndex]` que os loops exigem, e filtrar pelas ocorrencias cujo
 * entryIndex caia EXATAMENTE nesse dummy (ou seja, a entrada ainda nao aconteceu de verdade).
 */
export function detectPendingSignal(
  closedCandles: Candle[],
  strategy: ClassicStrategyConfig
): { direction: Direction; signalMetricValue: number } | null {
  if (closedCandles.length === 0) return null;
  const last = closedCandles[closedCandles.length - 1]!;
  const dummy: Candle = { ...last, from: last.to, to: last.to + (last.to - last.from), isClosed: false };
  const withDummy = [...closedCandles, dummy];

  const signals = detectSignals(withDummy, strategy);
  const pending = signals.find((s) => s.entryIndex === closedCandles.length);
  if (!pending) return null;
  return { direction: pending.direction, signalMetricValue: pending.signalMetricValue };
}

/** So o fetch (parte lenta, de rede) — separado do calculo pra poder buscar o historico UMA
 * vez e rodar varias estrategias em cima do mesmo array (ver runAllClassicStrategiesForAsset). */
export async function fetchClosedCandles(broker: BrokerAdapter, activeId: number, days: number): Promise<Candle[]> {
  const now = Math.floor(Date.now() / 1000);
  const from = now - days * 24 * 60 * 60;
  return (await broker.getHistoricalCandles(activeId, CANDLE_SIZE_M1, from, now))
    .filter((c) => c.isClosed)
    .sort((a, b) => a.from - b.from);
}

/** So o calculo, a partir de candles ja buscados (ver fetchClosedCandles). */
export function computeClassicStrategyResult(
  candles: Candle[],
  activeId: number,
  days: number,
  strategy: ClassicStrategyConfig
): ClassicStrategyResult {
  const rawSignals = detectSignals(candles, strategy);

  const occurrences: ClassicOccurrence[] = rawSignals.map((s) => {
    const setupLast = s.setupWindow[s.setupWindow.length - 1]!;
    const entryCandle = candles[s.entryIndex];
    const reentryCandle = candles[s.entryIndex + 1];
    return {
      id: `classic-${strategy.id}-${activeId}-${setupLast.to}-${randomUUID()}`,
      activeId,
      occurredAt: setupLast.to,
      setupWindow: s.setupWindow,
      direction: s.direction,
      entryCandle,
      result: entryCandle ? computeResultForDirection(entryCandle, s.direction) : undefined,
      reentryCandle,
      signalMetricValue: s.signalMetricValue,
    };
  });

  let wins = 0;
  let losses = 0;
  let dojis = 0;
  let metricSum = 0;
  for (const o of occurrences) {
    if (o.result === 'WIN') wins++;
    else if (o.result === 'LOSS') losses++;
    else if (o.result === 'DOJI') dojis++;
    metricSum += o.signalMetricValue;
  }

  return {
    activeId,
    days,
    strategy,
    occurrences,
    summary: { wins, losses, dojis },
    signalMetricLabel: SIGNAL_METRIC_LABEL[strategy.id],
    avgSignalMetricValue: occurrences.length > 0 ? metricSum / occurrences.length : 0,
    reentry: buildReentrySummary(occurrences),
  };
}

export async function runClassicStrategy(
  broker: BrokerAdapter,
  activeId: number,
  days: number,
  strategy: ClassicStrategyConfig
): Promise<ClassicStrategyResult> {
  const candles = await fetchClosedCandles(broker, activeId, days);
  return computeClassicStrategyResult(candles, activeId, days, strategy);
}

/** Roda todas as estrategias classicas (hoje: so uma) pra um ativo, buscando o historico UMA unica vez. */
export async function runAllClassicStrategiesForAsset(
  broker: BrokerAdapter,
  activeId: number,
  days: number,
  strategies: ClassicStrategyConfig[]
): Promise<ClassicStrategyResult[]> {
  const candles = await fetchClosedCandles(broker, activeId, days);
  return strategies.map((strategy) => computeClassicStrategyResult(candles, activeId, days, strategy));
}

/**
 * Gale 1 (mesma logica do padrao customizado, ver backtestRunner.ts): WIN direto se a 1a
 * entrada ja ganhou; se perdeu, o resultado passa a ser o da reentrada no candle seguinte,
 * simulada nas duas direcoes possiveis. Aqui cada ocorrencia tem sua PROPRIA direcao (nao uma
 * unica direcao fixa para toda a corrida), entao "mesma direcao"/"oposta" sao relativas a
 * direcao daquela ocorrencia especifica.
 */
function buildReentrySummary(occurrences: ClassicOccurrence[]): ClassicStrategyResult['reentry'] {
  const tally = (results: TradeResult[]) => {
    let wins = 0;
    let losses = 0;
    let dojis = 0;
    for (const r of results) {
      if (r === 'WIN') wins++;
      else if (r === 'LOSS') losses++;
      else dojis++;
    }
    return { wins, losses, dojis };
  };

  const combinedSame: TradeResult[] = [];
  const combinedOpposite: TradeResult[] = [];
  const reentryOnlySame: TradeResult[] = [];
  const reentryOnlyOpposite: TradeResult[] = [];
  let consideredLosses = 0;
  let missingReentryCandle = 0;

  for (const o of occurrences) {
    if (o.result === undefined) continue;
    if (o.result !== 'LOSS') {
      combinedSame.push(o.result);
      combinedOpposite.push(o.result);
      continue;
    }
    consideredLosses++;
    if (!o.reentryCandle) {
      missingReentryCandle++;
      continue;
    }
    const opposite = oppositeDirection(o.direction);
    const sameResult = computeResultForDirection(o.reentryCandle, o.direction);
    const oppositeResult = computeResultForDirection(o.reentryCandle, opposite);
    combinedSame.push(sameResult);
    combinedOpposite.push(oppositeResult);
    reentryOnlySame.push(sameResult);
    reentryOnlyOpposite.push(oppositeResult);
  }

  return {
    combinedSameDirection: tally(combinedSame),
    combinedOppositeDirection: tally(combinedOpposite),
    reentryOnlySameDirection: tally(reentryOnlySame),
    reentryOnlyOppositeDirection: tally(reentryOnlyOpposite),
    consideredLosses,
    missingReentryCandle,
  };
}
