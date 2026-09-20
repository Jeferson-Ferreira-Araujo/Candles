import { describe, expect, it } from 'vitest';
import type { Candle, CandleColor } from '@polarium12c/shared';
import { TWELVE_CANDLES_PATTERN } from '@polarium12c/shared';
import { TwelveCandlesEngine } from '../src/strategy/twelveCandlesEngine.js';

const ACTIVE = 81;
const SIZE = 60;
const BASE = 1_800_000_000;

function green(from: number): Candle {
  return { activeId: ACTIVE, size: SIZE, from, to: from + SIZE, open: 1, close: 2, high: 2, low: 1, isClosed: true };
}

/** Vela vermelha "neutra": pavio inferior 0% — usada nas posicoes onde o pavio nao importa. */
function red(from: number): Candle {
  return { activeId: ACTIVE, size: SIZE, from, to: from + SIZE, open: 2, close: 1, high: 2, low: 1, isClosed: true };
}

/** Vela vermelha com pavio inferior controlavel (fracao 0..1) — usada na 11a posicao. */
function redWithWick(from: number, wickFraction: number): Candle {
  const low = 0;
  const high = 100;
  const close = wickFraction * 100; // min(open, close) - low = close - 0 = wickFraction * range
  const open = 100;
  return { activeId: ACTIVE, size: SIZE, from, to: from + SIZE, open, close, high, low, isClosed: true };
}

function zeroRangeRed(from: number): Candle {
  return { activeId: ACTIVE, size: SIZE, from, to: from + SIZE, open: 5, close: 5, high: 5, low: 5, isClosed: true };
}

function colorFactory(color: CandleColor, from: number): Candle {
  return color === 'G' ? green(from) : red(from);
}

/** Gera as velas da regra (hoje 13), com a 11a controlada por `wick11Fraction`. */
function buildFullPattern(baseFrom: number, wick11Fraction: number): Candle[] {
  return TWELVE_CANDLES_PATTERN.map((color, i) => {
    const from = baseFrom + i * SIZE;
    if (i === 10) return redWithWick(from, wick11Fraction);
    return colorFactory(color, from);
  });
}

function feed(engine: TwelveCandlesEngine, candles: Candle[]) {
  return candles.map((c) => engine.onCandleClosed(ACTIVE, c));
}

describe('TwelveCandlesEngine', () => {
  it('confirma o padrao correto quando o pavio da 11a e >= 25%', () => {
    const engine = new TwelveCandlesEngine();
    const candles = buildFullPattern(BASE, 0.5);
    const ticks = feed(engine, candles);
    const last = ticks[ticks.length - 1]!;
    expect(last.kind).toBe('CONFIRMED');
    if (last.kind === 'CONFIRMED') {
      expect(last.window).toHaveLength(TWELVE_CANDLES_PATTERN.length);
      expect(last.wickPercentage11).toBeCloseTo(0.5, 10);
      expect(last.progress.matchedLength).toBe(TWELVE_CANDLES_PATTERN.length);
      expect(last.progress.state).toBe('CONFIRMADO');
    }
  });

  it('confirma quando o pavio e EXATAMENTE 25% (limite inclusivo)', () => {
    const engine = new TwelveCandlesEngine();
    const candles = buildFullPattern(BASE, 0.25);
    const ticks = feed(engine, candles);
    const last = ticks[ticks.length - 1]!;
    expect(last.kind).toBe('CONFIRMED');
  });

  it('invalida quando o pavio e 24.99% (abaixo do minimo)', () => {
    const engine = new TwelveCandlesEngine();
    const candles = buildFullPattern(BASE, 0.2499);
    const ticks = feed(engine, candles);
    const last = ticks[ticks.length - 1]!;
    expect(last.kind).toBe('INVALIDATED');
    if (last.kind === 'INVALIDATED') {
      expect(last.reason).toBe('WICK_BELOW_MINIMUM');
      expect(last.progress.matchedLength).toBe(10); // volta para ATENCAO
      expect(last.progress.state).toBe('ATENCAO');
    }
  });

  it('invalida quando high === low na 11a vela (range zero) — detectado assim que a 11a fecha, sem esperar a 12a', () => {
    const engine = new TwelveCandlesEngine();
    const candles = buildFullPattern(BASE, 0.5);
    candles[10] = zeroRangeRed(candles[10]!.from);
    const ticks = feed(engine, candles);
    const last = ticks[10]!; // tick da propria 11a vela — nao precisa esperar a 12a fechar
    expect(last.kind).toBe('INVALIDATED');
    if (last.kind === 'INVALIDATED') {
      expect(last.reason).toBe('ZERO_RANGE');
      expect(last.wickPercentage11).toBeNull();
    }
    // A 12a vela nunca deve confirmar depois de uma 11a invalidada.
    expect(ticks.some((t) => t.kind === 'CONFIRMED')).toBe(false);
  });

  it('cor incorreta no meio da sequencia zera o progresso quando nao ha sufixo aproveitavel', () => {
    const engine = new TwelveCandlesEngine();
    // G R G R R G R R R R R G esperado; troca a 4a (index 3, deveria ser R) por G.
    const candles = buildFullPattern(BASE, 0.5);
    candles[3] = green(candles[3]!.from); // quebra a sequencia bem cedo
    const ticks = feed(engine, candles);
    // apos a quebra, o progresso deve refletir o novo maior prefixo valido a partir dali,
    // nunca continuar como se nada tivesse acontecido.
    const tickAtBreak = ticks[3]!;
    expect(tickAtBreak.kind).toBe('PROGRESS');
    if (tickAtBreak.kind === 'PROGRESS') {
      // G(match pos0) R(pos1) G(pos2) G(nao é R, mas é G — bate com pos0 de novo) => maior prefixo = 1
      expect(tickAtBreak.progress.matchedLength).toBe(1);
    }
  });

  it('gap entre candles invalida a continuidade e reinicia a contagem', () => {
    const engine = new TwelveCandlesEngine();
    const candles = buildFullPattern(BASE, 0.5);
    // Introduz um gap entre a 5a e a 6a vela (pula 120s em vez de 60s).
    for (let i = 5; i < candles.length; i++) {
      candles[i] = { ...candles[i]!, from: candles[i]!.from + 60, to: candles[i]!.to + 60 };
    }
    const ticks = feed(engine, candles);
    const tickAfterGap = ticks[5]!; // a vela que veio logo apos o gap (6a da sequencia, cor G)
    expect(tickAfterGap.kind).toBe('PROGRESS');
    if (tickAfterGap.kind === 'PROGRESS') {
      // Buffer reiniciado com so essa vela: cor G bate com pos0 => matchedLength = 1
      expect(tickAfterGap.progress.matchedLength).toBe(1);
    }
    // E o padrao completo nao deve ter sido confirmado.
    expect(ticks.some((t) => t.kind === 'CONFIRMED')).toBe(false);
  });

  it('nunca aceita um candle ainda aberto', () => {
    const engine = new TwelveCandlesEngine();
    const openCandle: Candle = { ...green(BASE), isClosed: false };
    expect(() => engine.onCandleClosed(ACTIVE, openCandle)).toThrow();
  });

  it('suporta padroes sobrepostos: uma vela apos a confirmacao pode iniciar um novo casamento parcial', () => {
    const engine = new TwelveCandlesEngine();
    const first = buildFullPattern(BASE, 0.5);
    feed(engine, first);

    // Nao confirma de novo imediatamente so porque o buffer ainda guarda o final do padrao
    // anterior — o motor deve continuar em PROGRESS, nunca preso ou travado.
    const nextFrom = first[first.length - 1]!.to;
    const progressAfterNext = engine.onCandleClosed(ACTIVE, green(nextFrom));
    expect(progressAfterNext.kind).toBe('PROGRESS');
    if (progressAfterNext.kind === 'PROGRESS') {
      expect(progressAfterNext.progress.matchedLength).toBeGreaterThanOrEqual(1);
      expect(progressAfterNext.progress.matchedLength).toBeLessThan(TWELVE_CANDLES_PATTERN.length);
    }
  });

  it('preview do pavio da 11a e visivel apenas enquanto a 11a esta se formando, e nao confirma nada', () => {
    const engine = new TwelveCandlesEngine();
    const tenClosed = buildFullPattern(BASE, 0.5).slice(0, 10);
    feed(engine, tenClosed);

    const forming: Candle = {
      activeId: ACTIVE,
      size: SIZE,
      from: tenClosed[9]!.to,
      to: tenClosed[9]!.to + SIZE,
      open: 100,
      close: 10,
      high: 100,
      low: 0,
      isClosed: false,
    };

    const preview = engine.previewEleventh(ACTIVE, forming);
    expect(preview).not.toBeNull();
    expect(preview!.currentPercentage).toBeCloseTo(0.1, 10);
    expect(preview!.requiredPercentage).toBe(0.25);

    // O preview nao deve ter alterado o estado interno (matchedLength continua 10).
    expect(engine.getProgress(ACTIVE).matchedLength).toBe(10);
  });
});
