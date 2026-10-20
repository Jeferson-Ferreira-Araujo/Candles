import { describe, expect, it, vi } from 'vitest';
import type { Candle } from '@polarium12c/shared';
import { CLASSIC_STRATEGIES, defaultClassicStrategyConfig } from '@polarium12c/shared';
import { MockBrokerAdapter } from '../src/broker/MockBrokerAdapter.js';
import { runClassicStrategy, runAllClassicStrategiesForAsset, detectPendingSignal } from '../src/strategies/classicStrategies.js';

const ACTIVE = 81;
const SIZE = 60;
// Ancorado relativo a Date.now() (nunca um literal fixo) — runClassicStrategy busca historico
// com `to = now` real, entao um timestamp fixo no passado pode acabar no FUTURO relativo ao
// momento em que o teste roda. 6h atras fica sempre dentro da janela de 30 dias usada aqui.
const BASE = Math.floor(Date.now() / 1000) - 6 * 60 * 60;

function candle(from: number, open: number, high: number, low: number, close: number): Candle {
  return { activeId: ACTIVE, size: SIZE, from, to: from + SIZE, open, high, low, close, isClosed: true };
}

function flat(from: number, price: number): Candle {
  return candle(from, price, price + 0.05, price - 0.05, price);
}

async function run(candles: Candle[]) {
  const broker = new MockBrokerAdapter();
  await broker.authenticate();
  broker.seedCandles(ACTIVE, candles);
  return runClassicStrategy(broker, ACTIVE, 30, defaultClassicStrategyConfig('support_resistance'));
}

/**
 * Monta uma sequencia de candles com um SUPORTE (nivel 90) validado por DOIS toques via
 * zigzag, uma janela calma depois (pra Bollinger/CCI ficarem "normais"), e uma vela final que
 * testa o nivel de novo com rejeicao forte, CCI esticado e fechamento alem da banda — as 3
 * confirmacoes que detectSupportResistance exige. Cada numero foi conferido rodando os
 * indicadores de verdade (zigzagPivots/cci/bollingerBands) sobre esta mesma sequencia.
 */
function buildSupportTouchCandles(): Candle[] {
  let from = BASE;
  const candles: Candle[] = [];
  const push = (open: number, high: number, low: number, close: number) => {
    candles.push(candle(from, open, high, low, close));
    from += SIZE;
  };

  for (let i = 0; i < 10; i++) push(100, 100.3, 99.7, 100 + (i % 2 === 0 ? 0.1 : -0.1)); // filler estavel
  push(100, 100, 90, 91); // 1o toque: cai pra 90 (-10%), trend vira 'down'
  push(91, 96, 91, 95); // confirma o fundo em 90 (+6.7% bate o limiar de 5%)
  for (let i = 0; i < 8; i++) push(94, 95.5, 93, 94.5); // janela intermediaria, sempre abaixo do extremo (96)
  push(94, 95.5, 90, 91); // 2o toque: rompe o piso (90 <= 96*0.95), confirma topo intermediario
  push(91, 96, 91, 95); // confirma o 2o fundo em 90 — nivel agora validado (2 toques)
  for (let i = 0; i < 20; i++) push(101.8 + (i % 2) * 0.4, 102.3, 101.5, 101.8 + (i % 2) * 0.4); // janela calma
  push(92, 93, 90, 92.8); // SINAL: testa o nivel 90 de novo, rejeicao forte, CCI/Bollinger esticados
  push(93, 98, 93, 97); // ENTRADA: fecha em alta -> WIN para CALL

  return candles;
}

/** Espelho estrutural (nao por negacao de preco — isso quebraria os limiares percentuais) do
 * cenario acima pro lado RESISTENCIA/PUT: nivel 110 tocado 2x, janela calma abaixo dele, vela
 * de sinal rompe pra cima com rejeicao (fecha perto do fundo do proprio range). */
function buildResistanceTouchCandles(): Candle[] {
  let from = BASE;
  const candles: Candle[] = [];
  const push = (open: number, high: number, low: number, close: number) => {
    candles.push(candle(from, open, high, low, close));
    from += SIZE;
  };

  for (let i = 0; i < 10; i++) push(100, 100.3, 99.7, 100 + (i % 2 === 0 ? 0.1 : -0.1)); // filler estavel
  push(100, 110, 100, 108); // 1o toque: sobe pra 110 (+10%), trend vira 'up'
  push(108, 108, 103, 104); // confirma o topo em 110 (-6.4% bate o limiar de 5%)
  for (let i = 0; i < 8; i++) push(105, 106, 104, 105); // janela intermediaria, sempre acima do extremo (103)
  push(105, 110, 104, 109); // 2o toque: rompe o teto (110 >= 103*1.05), confirma fundo intermediario
  push(109, 108, 104, 105); // confirma o 2o topo em 110 — nivel agora validado (2 toques)
  for (let i = 0; i < 20; i++) push(97.8 + (i % 2) * 0.4, 98.3, 97.5, 97.8 + (i % 2) * 0.4); // janela calma
  push(108, 110, 107, 107.2); // SINAL: testa o nivel 110 de novo, rejeicao forte, CCI/Bollinger esticados
  push(107, 108, 100, 101); // ENTRADA: fecha em baixa -> WIN para PUT

  return candles;
}

describe('runClassicStrategy — support_resistance', () => {
  it('detecta toque validado em suporte (2 toques via zigzag) com CCI/Bollinger confirmando e sinaliza CALL', async () => {
    const result = await run(buildSupportTouchCandles());
    expect(result.occurrences.length).toBeGreaterThanOrEqual(1);
    const occ = result.occurrences[result.occurrences.length - 1]!;
    expect(occ.direction).toBe('CALL');
    expect(occ.result).toBe('WIN');
    expect(occ.signalMetricValue).toBeGreaterThanOrEqual(2); // numero de toques no nivel
  });

  it('detecta toque validado em resistencia e sinaliza PUT', async () => {
    const result = await run(buildResistanceTouchCandles());
    expect(result.occurrences.length).toBeGreaterThanOrEqual(1);
    const occ = result.occurrences[result.occurrences.length - 1]!;
    expect(occ.direction).toBe('PUT');
    expect(occ.result).toBe('WIN');
  });

  it('nao detecta nada num historico estavel, sem nenhum nivel validado nem CCI/Bollinger esticados', async () => {
    let from = BASE;
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      candles.push(flat(from, 100 + (i % 3) * 0.1));
      from += SIZE;
    }
    const result = await run(candles);
    expect(result.occurrences).toHaveLength(0);
  });

  it('nao detecta quando so houve UM toque no nivel (nao validado)', async () => {
    // Mesma construcao, mas sem o 2o toque — so 1 pivo no nivel 90, abaixo de SR_MIN_TOUCHES.
    let from = BASE;
    const candles: Candle[] = [];
    const push = (open: number, high: number, low: number, close: number) => {
      candles.push(candle(from, open, high, low, close));
      from += SIZE;
    };
    for (let i = 0; i < 10; i++) push(100, 100.3, 99.7, 100 + (i % 2 === 0 ? 0.1 : -0.1));
    push(100, 100, 90, 91); // unico toque em 90
    push(91, 96, 91, 95);
    for (let i = 0; i < 28; i++) push(101.8 + (i % 2) * 0.4, 102.3, 101.5, 101.8 + (i % 2) * 0.4);
    push(92, 93, 90, 92.8); // testaria o nivel de novo, mas ele nunca foi validado (so 1 toque antes)
    push(93, 98, 93, 97);

    const result = await run(candles);
    expect(result.occurrences).toHaveLength(0);
  });
});

describe('runAllClassicStrategiesForAsset', () => {
  it('busca o historico UMA unica vez e devolve um resultado por estrategia', async () => {
    const broker = new MockBrokerAdapter();
    await broker.authenticate();
    broker.seedCandles(ACTIVE, buildSupportTouchCandles());
    const spy = vi.spyOn(broker, 'getHistoricalCandles');

    const configs = CLASSIC_STRATEGIES.map((s) => defaultClassicStrategyConfig(s.id));
    const results = await runAllClassicStrategiesForAsset(broker, ACTIVE, 30, configs);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(CLASSIC_STRATEGIES.length);
    expect(results.map((r) => r.strategy.id)).toEqual(CLASSIC_STRATEGIES.map((s) => s.id));
  });
});

describe('detectPendingSignal — support_resistance', () => {
  it('acusa sinal pendente quando o setup acabou de se completar na ultima vela FECHADA', () => {
    const all = buildSupportTouchCandles();
    const withoutEntry = all.slice(0, -1); // tira a vela de entrada — o setup "acabou de completar" agora
    const strategy = defaultClassicStrategyConfig('support_resistance');
    const pending = detectPendingSignal(withoutEntry, strategy);
    expect(pending).not.toBeNull();
    expect(pending!.direction).toBe('CALL');
  });

  it('nao acusa nada num historico estavel', () => {
    let from = BASE;
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      candles.push(flat(from, 100 + (i % 3) * 0.1));
      from += SIZE;
    }
    const strategy = defaultClassicStrategyConfig('support_resistance');
    expect(detectPendingSignal(candles, strategy)).toBeNull();
  });

  it('para de acusar depois que a entrada de verdade ja aconteceu (nao fica preso no passado)', () => {
    const all = buildSupportTouchCandles(); // ja inclui a vela de entrada
    const strategy = defaultClassicStrategyConfig('support_resistance');
    expect(detectPendingSignal(all, strategy)).toBeNull();
  });
});
