import { randomUUID } from 'node:crypto';
import type { Db } from '../db/db.js';
import {
  CANDLE_SIZE_M1,
  ENTRY_DIRECTION,
  type BacktestDaySummary,
  type BacktestRun,
  type BacktestSummary,
  type Candle,
  type Direction,
  type PatternOccurrence,
  type TradeResult,
} from '@polarium12c/shared';
import type { BrokerAdapter } from '../broker/BrokerAdapter.js';
import { TwelveCandlesEngine } from '../strategy/twelveCandlesEngine.js';
import { finishBacktest, insertBacktest, insertBacktestOccurrence } from '../db/repositories.js';

export interface BacktestResult {
  run: BacktestRun;
  occurrences: PatternOccurrence[];
  summary: BacktestSummary;
}

function isoDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/** Ganha quando o candle fecha ACIMA da abertura — resultado de uma entrada CALL nesse candle. */
function computeResultForCall(candle: Candle): TradeResult {
  if (candle.close > candle.open) return 'WIN';
  if (candle.close < candle.open) return 'LOSS';
  return 'DOJI';
}

/** Ganha quando o candle fecha ABAIXO da abertura — resultado de uma entrada PUT nesse candle. */
function computeResultForPut(candle: Candle): TradeResult {
  if (candle.close < candle.open) return 'WIN';
  if (candle.close > candle.open) return 'LOSS';
  return 'DOJI';
}

function computeResultForDirection(candle: Candle, direction: Direction): TradeResult {
  return direction === 'CALL' ? computeResultForCall(candle) : computeResultForPut(candle);
}

function oppositeDirection(direction: Direction): Direction {
  return direction === 'CALL' ? 'PUT' : 'CALL';
}

function tallyResults(results: TradeResult[]): { wins: number; losses: number; dojis: number } {
  let wins = 0;
  let losses = 0;
  let dojis = 0;
  for (const r of results) {
    if (r === 'WIN') wins++;
    else if (r === 'LOSS') losses++;
    else dojis++;
  }
  return { wins, losses, dojis };
}

/**
 * Resultado FINAL de cada ocorrencia assumindo Gale 1: WIN direto se a 1a entrada ja ganhou;
 * se perdeu, o resultado passa a ser o da reentrada no candle seguinte (candle14) na direcao
 * pedida. Ocorrencias sem candle13 (sem 1a entrada avaliavel) ou cujo LOSS nao tem candle14
 * disponivel (fim do periodo) ficam de fora — nao da pra simular o gale para elas.
 */
function combineWithGale1(occurrences: PatternOccurrence[], reentryDirection: 'CALL' | 'PUT'): TradeResult[] {
  const results: TradeResult[] = [];
  for (const o of occurrences) {
    if (o.result === undefined) continue;
    if (o.result !== 'LOSS') {
      results.push(o.result);
      continue;
    }
    if (!o.candle14) continue;
    results.push(reentryDirection === 'CALL' ? computeResultForCall(o.candle14) : computeResultForPut(o.candle14));
  }
  return results;
}

function tally(occs: PatternOccurrence[]): { wins: number; losses: number; dojis: number } {
  let wins = 0;
  let losses = 0;
  let dojis = 0;
  for (const o of occs) {
    if (o.result === 'WIN') wins++;
    else if (o.result === 'LOSS') losses++;
    else if (o.result === 'DOJI') dojis++;
  }
  return { wins, losses, dojis };
}

/** Enumera todas as datas (UTC, YYYY-MM-DD) entre dois timestamps, inclusive. */
function enumerateDays(fromEpochSeconds: number, toEpochSeconds: number): string[] {
  const days: string[] = [];
  const start = Date.parse(`${isoDate(fromEpochSeconds)}T00:00:00.000Z`);
  const end = Date.parse(`${isoDate(toEpochSeconds)}T00:00:00.000Z`);
  for (let t = start; t <= end; t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

function buildSummary(
  runId: string,
  activeIds: number[],
  from: number,
  to: number,
  occurrences: PatternOccurrence[]
): BacktestSummary {
  const occByDayActive = new Map<string, Map<number, number>>();
  for (const occ of occurrences) {
    const day = isoDate(occ.occurredAt);
    if (!occByDayActive.has(day)) occByDayActive.set(day, new Map());
    const m = occByDayActive.get(day)!;
    m.set(occ.activeId, (m.get(occ.activeId) ?? 0) + 1);
  }

  const perDay: BacktestDaySummary[] = enumerateDays(from, to).map((day) => {
    const perActive: Record<number, number> = {};
    let total = 0;
    for (const activeId of activeIds) {
      const count = occByDayActive.get(day)?.get(activeId) ?? 0;
      perActive[activeId] = count;
      total += count;
    }
    const distinctActivesWithSignal = activeIds.filter((a) => (perActive[a] ?? 0) > 0).length;
    const multipleInSameActive = activeIds.some((a) => (perActive[a] ?? 0) >= 2);
    const bucket: BacktestDaySummary['bucket'] = total === 0 ? 'NONE' : total === 1 ? 'ONE' : total === 2 ? 'TWO' : 'THREE_PLUS';
    return {
      date: day,
      perActive,
      total,
      bucket,
      multipleInSameActive,
      multipleDifferentActives: distinctActivesWithSignal >= 2,
    };
  });

  const perAsset: BacktestSummary['perAsset'] = {};
  for (const activeId of activeIds) {
    perAsset[activeId] = tally(occurrences.filter((o) => o.activeId === activeId));
  }

  const lossOccurrences = occurrences.filter((o) => o.result === 'LOSS');
  const lossesWithCandle14 = lossOccurrences.filter((o) => o.candle14);
  // "Mesma direcao" no gale repete ENTRY_DIRECTION; "contraria" inverte para a outra.
  const reentry: BacktestSummary['reentry'] = {
    combinedSameDirection: tallyResults(combineWithGale1(occurrences, ENTRY_DIRECTION)),
    combinedOppositeDirection: tallyResults(combineWithGale1(occurrences, oppositeDirection(ENTRY_DIRECTION))),
    consideredLosses: lossOccurrences.length,
    missingCandle14: lossOccurrences.length - lossesWithCandle14.length,
  };

  return {
    runId,
    allOccurrences: tally(occurrences),
    firstOfDayOnly: tally(occurrences.filter((o) => o.isFirstOfDay)),
    perDay,
    perAsset,
    reentry,
  };
}

/**
 * Roda a estrategia "12 Candles" (regra congelada — ver strategy/twelveCandlesEngine.ts)
 * contra o historico M1 dos ativos informados, registra TODAS as ocorrencias e devolve o
 * resumo (todas as ocorrencias vs somente a primeira de cada dia, contagem por dia/ativo).
 *
 * Nao envia nenhuma ordem — e leitura de historico + calculo local.
 */
export async function runBacktest(
  db: Db,
  broker: BrokerAdapter,
  activeIds: number[],
  days: number
): Promise<BacktestResult> {
  const id = `backtest-${randomUUID()}`;
  const startedAt = Date.now();
  await insertBacktest(db, { id, activeIds, days, startedAt });

  const now = Math.floor(Date.now() / 1000);
  const from = now - days * 24 * 60 * 60;

  const allOccurrences: PatternOccurrence[] = [];

  for (const activeId of activeIds) {
    const candles = (await broker.getHistoricalCandles(activeId, CANDLE_SIZE_M1, from, now))
      .filter((c) => c.isClosed)
      .sort((a, b) => a.from - b.from);

    const engine = new TwelveCandlesEngine();

    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i]!;
      const tick = engine.onCandleClosed(activeId, candle);

      if (tick.kind === 'CONFIRMED') {
        // candle13 = a entrada de verdade (hoje a 14a vela real, ver ENTRY_DIRECTION em
        // strategyRule.ts) — nome do campo mantido por estabilidade de schema/tipos.
        const candle13 = candles[i + 1]; // pode ser undefined se for o ultimo candle do periodo
        const candle14 = candles[i + 2]; // candle seguinte a entrada — so usado para simular o Gale 1
        allOccurrences.push({
          // Prefixado com o id da propria rodada do backtest: sem isso, rodar o MESMO
          // backtest (mesmo ativo/periodo) duas vezes gerava o mesmo id de novo (baseado
          // so em activeId + horario da vela de confirmacao), violando o UNIQUE global da tabela.
          id: `${id}-12CANDLES-${activeId}-${candle.to}-${ENTRY_DIRECTION}`,
          activeId,
          occurredAt: candle.to,
          candles: tick.window,
          wickPercentage11: tick.wickPercentage11,
          candle13,
          candle14,
          result: candle13 ? computeResultForDirection(candle13, ENTRY_DIRECTION) : undefined,
          isFirstOfDay: false, // marcado abaixo, apos ordenar globalmente
        });
      }
    }
  }

  allOccurrences.sort((a, b) => a.occurredAt - b.occurredAt);

  const seenDays = new Set<string>();
  for (const occ of allOccurrences) {
    const day = isoDate(occ.occurredAt);
    if (!seenDays.has(day)) {
      occ.isFirstOfDay = true;
      seenDays.add(day);
    }
  }

  for (const occ of allOccurrences) await insertBacktestOccurrence(db, id, occ);

  const finishedAt = Date.now();
  await finishBacktest(db, id, finishedAt);

  const summary = buildSummary(id, activeIds, from, now, allOccurrences);

  return { run: { id, activeIds, days, startedAt, finishedAt }, occurrences: allOccurrences, summary };
}
