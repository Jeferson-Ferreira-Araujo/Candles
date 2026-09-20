import { describe, expect, it } from 'vitest';
import type { Candle, CandleColor } from '@polarium12c/shared';
import { TWELVE_CANDLES_PATTERN, WICK_RULE_APPLIES } from '@polarium12c/shared';
import { TwelveCandlesEngine } from '../src/strategy/twelveCandlesEngine.js';

const ACTIVE = 81;
const SIZE = 60;
const BASE = 1_800_000_000;

function green(from: number): Candle {
  return { activeId: ACTIVE, size: SIZE, from, to: from + SIZE, open: 1, close: 2, high: 2, low: 1, isClosed: true };
}

function red(from: number): Candle {
  return { activeId: ACTIVE, size: SIZE, from, to: from + SIZE, open: 2, close: 1, high: 2, low: 1, isClosed: true };
}

function colorFactory(color: CandleColor, from: number): Candle {
  return color === 'G' ? green(from) : red(from);
}

/** Gera as velas da regra atual (ver TWELVE_CANDLES_PATTERN em strategyRule.ts). */
function buildFullPattern(baseFrom: number): Candle[] {
  return TWELVE_CANDLES_PATTERN.map((color, i) => colorFactory(color, baseFrom + i * SIZE));
}

function feed(engine: TwelveCandlesEngine, candles: Candle[]) {
  return candles.map((c) => engine.onCandleClosed(ACTIVE, c));
}

describe('TwelveCandlesEngine', () => {
  it('confirma o padrao correto quando as cores batem com a regra', () => {
    const engine = new TwelveCandlesEngine();
    const candles = buildFullPattern(BASE);
    const ticks = feed(engine, candles);
    const last = ticks[ticks.length - 1]!;
    expect(last.kind).toBe('CONFIRMED');
    if (last.kind === 'CONFIRMED') {
      expect(last.window).toHaveLength(TWELVE_CANDLES_PATTERN.length);
      expect(last.progress.matchedLength).toBe(TWELVE_CANDLES_PATTERN.length);
      expect(last.progress.state).toBe('CONFIRMADO');
    }
  });

  // A regra atual (ver TWELVE_CANDLES_PATTERN) e curta demais para conter a posicao do
  // pavio da 11a vela — WICK_RULE_APPLIES deve refletir isso, e nenhuma checagem de pavio
  // deve rodar (nem crashar tentando ler uma vela que nao existe na janela).
  it('nao aplica a regra do pavio quando WICK_RULE_APPLIES=false (regra atual)', () => {
    expect(WICK_RULE_APPLIES).toBe(false);

    const engine = new TwelveCandlesEngine();
    const candles = buildFullPattern(BASE);
    const ticks = feed(engine, candles);
    const last = ticks[ticks.length - 1]!;
    expect(last.kind).toBe('CONFIRMED'); // nunca INVALIDATED por pavio, porque a checagem nem roda

    // previewEleventh tambem nunca deve achar que esta "logo antes da 11a", ja que
    // matchedLength nunca alcanca essa posicao com uma regra deste tamanho.
    const forming: Candle = { activeId: ACTIVE, size: SIZE, from: BASE, to: BASE + SIZE, open: 1, close: 1, high: 1, low: 0, isClosed: false };
    expect(engine.previewEleventh(ACTIVE, forming)).toBeNull();
  });

  it('cor incorreta no meio da sequencia zera o progresso quando nao ha sufixo aproveitavel', () => {
    const engine = new TwelveCandlesEngine();
    // Regra: TWELVE_CANDLES_PATTERN[3] deveria ser R; troca por G para quebrar a sequencia cedo.
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
    const engine = new TwelveCandlesEngine();
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
    const engine = new TwelveCandlesEngine();
    const openCandle: Candle = { ...green(BASE), isClosed: false };
    expect(() => engine.onCandleClosed(ACTIVE, openCandle)).toThrow();
  });

  it('suporta padroes sobrepostos: a vela seguinte a confirmacao pode iniciar um novo casamento parcial', () => {
    const engine = new TwelveCandlesEngine();
    const first = buildFullPattern(BASE);
    feed(engine, first);

    // So confere que o motor continua produzindo PROGRESS coerente (nunca travado, nunca
    // confirmando de novo sozinho) — o valor exato de overlap depende da regra vigente.
    const nextFrom = first[first.length - 1]!.to;
    const progressAfterNext = engine.onCandleClosed(ACTIVE, green(nextFrom));
    expect(progressAfterNext.kind).toBe('PROGRESS');
    if (progressAfterNext.kind === 'PROGRESS') {
      expect(progressAfterNext.progress.matchedLength).toBeGreaterThanOrEqual(0);
      expect(progressAfterNext.progress.matchedLength).toBeLessThan(TWELVE_CANDLES_PATTERN.length);
    }
  });
});
