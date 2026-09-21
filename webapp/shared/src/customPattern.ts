import type { CandleColor, Direction } from './types.js';

/**
 * Um padrao definido pelo usuario (tela de edicao de padrao), substituindo a antiga regra fixa
 * no codigo. `candles` guarda TODAS as casas preenchidas, da mais antiga para a mais nova — a
 * ULTIMA e a vela de ENTRADA (sua cor define a direcao: 'R' aposta que a proxima vela tambem
 * fecha vermelha = PUT, 'G' aposta em verde = CALL), e as demais formam o prefixo que precisa
 * casar no historico/tempo real antes de confirmar. Minimo 2 casas.
 */
export interface CustomPattern {
  id: string;
  name: string;
  candles: CandleColor[];
  isActive: boolean;
  createdAt: number;
}

/** As casas que precisam casar antes de confirmar — todas menos a ultima (a vela de entrada). */
export function confirmPrefix(candles: readonly CandleColor[]): CandleColor[] {
  return candles.slice(0, -1);
}

/** Direcao da entrada, derivada da cor da ultima casa preenchida pelo usuario. */
export function entryDirectionOf(candles: readonly CandleColor[]): Direction {
  return candles[candles.length - 1] === 'R' ? 'PUT' : 'CALL';
}

export function validatePatternCandles(candles: unknown): candles is CandleColor[] {
  return Array.isArray(candles) && candles.length >= 2 && candles.every((c) => c === 'G' || c === 'R');
}
