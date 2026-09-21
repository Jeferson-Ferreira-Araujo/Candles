import type { Candle, Direction, TradeResult } from '@polarium12c/shared';

/** Ganha quando o candle fecha ACIMA da abertura — resultado de uma entrada CALL nesse candle. */
export function computeResultForCall(candle: Candle): TradeResult {
  if (candle.close > candle.open) return 'WIN';
  if (candle.close < candle.open) return 'LOSS';
  return 'DOJI';
}

/** Ganha quando o candle fecha ABAIXO da abertura — resultado de uma entrada PUT nesse candle. */
export function computeResultForPut(candle: Candle): TradeResult {
  if (candle.close < candle.open) return 'WIN';
  if (candle.close > candle.open) return 'LOSS';
  return 'DOJI';
}

export function computeResultForDirection(candle: Candle, direction: Direction): TradeResult {
  return direction === 'CALL' ? computeResultForCall(candle) : computeResultForPut(candle);
}

export function oppositeDirection(direction: Direction): Direction {
  return direction === 'CALL' ? 'PUT' : 'CALL';
}
