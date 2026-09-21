import { describe, expect, it } from 'vitest';
import type { Candle, CandleColor } from '@polarium12c/shared';
import { TwelveCandlesEngine } from '../src/strategy/twelveCandlesEngine.js';

const ACTIVE = 81;
const SIZE = 60;
const BASE = 1_800_000_000;

/** Padrao de teste (prefixo de confirmacao, NAO inclui a vela de entrada). */
const CONFIRM_PATTERN: CandleColor[] = ['G', 'R', 'G', 'R', 'R', 'G', 'R', 'R'];

function green(from: number): Candle {
  return { activeId: ACTIVE, size: SIZE, from, to: from + SIZE, open: 1, close: 2, high: 2, low: 1, isClosed: true };
}

function red(from: number): Candle {
  return { activeId: ACTIVE, size: SIZE, from, to: from + SIZE, open: 2, close: 1, high: 2, low: 1, isClosed: true };
}

/** Vela vermelha com pavio inferior controlado (fracao do range, 0..1) — usada para a vela de sinal. */
function redWithWick(from: number, wickFraction: number): Candle {
  return { activeId: ACTIVE, size: SIZE, from, to: from + SIZE, open: 100, close: wickFraction * 100, high: 100, low: 0, isClosed: true };
}

/** Vela verde com pavio inferior controlado (fracao do range, 0..1) — usada para a vela de sinal. */
function greenWithWick(from: number, wickFraction: number): Candle {
  return { activeId: ACTIVE, size: SIZE, from, to: from + SIZE, open: wickFraction * 100, close: 100, high: 100, low: 0, isClosed: true };
}

function colorFactory(color: CandleColor, from: number): Candle {
  return color === 'G' ? green(from) : red(from);
}

/**
 * Gera as velas do padrao de teste (CONFIRM_PATTERN). A ULTIMA vela (a de sinal) sempre leva
 * um pavio de 50% (bem acima do minimo de 25%), para nao reprovar a regra do pavio por
 * padrao em testes que nao estao testando essa regra especificamente.
 */
function buildFullPattern(baseFrom: number): Candle[] {
  return CONFIRM_PATTERN.map((color, i) => {
    const from = baseFrom + i * SIZE;
    const isSignal = i === CONFIRM_PATTERN.length - 1;
    if (isSignal) return color === 'G' ? greenWithWick(from, 0.5) : redWithWick(from, 0.5);
    return colorFactory(color, from);
  });
}

function feed(engine: TwelveCandlesEngine, candles: Candle[]) {
  return candles.map((c) => engine.onCandleClosed(ACTIVE, c));
}

describe('TwelveCandlesEngine', () => {
  it('confirma o padrao correto quando as cores batem com o padrao e o pavio da vela de sinal e suficiente', () => {
    const engine = new TwelveCandlesEngine(CONFIRM_PATTERN);
    const candles = buildFullPattern(BASE);
    const ticks = feed(engine, candles);
    const last = ticks[ticks.length - 1]!;
    expect(last.kind).toBe('CONFIRMED');
    if (last.kind === 'CONFIRMED') {
      expect(last.window).toHaveLength(CONFIRM_PATTERN.length);
      expect(last.progress.matchedLength).toBe(CONFIRM_PATTERN.length);
      expect(last.progress.state).toBe('CONFIRMADO');
      expect(last.wickPercentage11).toBeCloseTo(0.5);
    }
  });

  it('invalida (nao confirma) quando o prefixo bate mas o pavio da vela de sinal e menor que 25%', () => {
    const engine = new TwelveCandlesEngine(CONFIRM_PATTERN);
    const candles = buildFullPattern(BASE);
    const lastIndex = candles.length - 1;
    const lastColor = CONFIRM_PATTERN[lastIndex]!;
    // Pavio de so 10% — abaixo do minimo de 25% exigido pela regra final.
    candles[lastIndex] =
      lastColor === 'G' ? greenWithWick(candles[lastIndex]!.from, 0.1) : redWithWick(candles[lastIndex]!.from, 0.1);

    const ticks = feed(engine, candles);
    const last = ticks[ticks.length - 1]!;
    expect(last.kind).toBe('INVALIDATED');
    if (last.kind === 'INVALIDATED') {
      expect(last.reason).toBe('WICK_BELOW_MINIMUM');
      expect(last.wickPercentage11).toBeCloseTo(0.1);
    }
  });

  it('cor incorreta no meio da sequencia zera o progresso quando nao ha sufixo aproveitavel', () => {
    const engine = new TwelveCandlesEngine(CONFIRM_PATTERN);
    // CONFIRM_PATTERN[3] deveria ser R; troca por G para quebrar a sequencia cedo.
    const candles = buildFullPattern(BASE);
    candles[3] = green(candles[3]!.from);
    const ticks = feed(engine, candles);
    const tickAtBreak = ticks[3]!;
    expect(tickAtBreak.kind).toBe('PROGRESS');
    if (tickAtBreak.kind === 'PROGRESS') {
      // G(pos0) R(pos1) G(pos2) G(nao é R, mas é G — bate com pos0 de novo) => maior prefixo = 1
      expect(tickAtBreak.progress.matchedLength).toBe(1);
    }
  });

  it('gap entre candles invalida a continuidade e reinicia a contagem', () => {
    const engine = new TwelveCandlesEngine(CONFIRM_PATTERN);
    const candles = buildFullPattern(BASE);
    // Introduz um gap a partir da 3a vela (pula 120s em vez de 60s).
    for (let i = 2; i < candles.length; i++) {
      candles[i] = { ...candles[i]!, from: candles[i]!.from + 60, to: candles[i]!.to + 60 };
    }
    const ticks = feed(engine, candles);
    const tickAfterGap = ticks[2]!;
    expect(tickAfterGap.kind).toBe('PROGRESS');
    if (tickAfterGap.kind === 'PROGRESS') {
      // Buffer reiniciado com so essa vela: cor G bate com pos0 => matchedLength = 1
      expect(tickAfterGap.progress.matchedLength).toBe(1);
    }
    expect(ticks.some((t) => t.kind === 'CONFIRMED')).toBe(false);
  });

  it('nunca aceita um candle ainda aberto', () => {
    const engine = new TwelveCandlesEngine(CONFIRM_PATTERN);
    const openCandle: Candle = { ...green(BASE), isClosed: false };
    expect(() => engine.onCandleClosed(ACTIVE, openCandle)).toThrow();
  });

  it('suporta padroes sobrepostos: a vela seguinte a confirmacao pode iniciar um novo casamento parcial', () => {
    const engine = new TwelveCandlesEngine(CONFIRM_PATTERN);
    const first = buildFullPattern(BASE);
    feed(engine, first);

    // So confere que o motor continua produzindo PROGRESS coerente (nunca travado, nunca
    // confirmando de novo sozinho) — o valor exato de overlap depende do padrao vigente.
    const nextFrom = first[first.length - 1]!.to;
    const progressAfterNext = engine.onCandleClosed(ACTIVE, green(nextFrom));
    expect(progressAfterNext.kind).toBe('PROGRESS');
    if (progressAfterNext.kind === 'PROGRESS') {
      expect(progressAfterNext.progress.matchedLength).toBeGreaterThanOrEqual(0);
      expect(progressAfterNext.progress.matchedLength).toBeLessThan(CONFIRM_PATTERN.length);
    }
  });
});
