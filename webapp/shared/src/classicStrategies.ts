import type { Candle, Direction, TradeResult } from './types.js';

/**
 * So existe UMA familia de estrategia classica hoje: Suporte e Resistencia, confirmada por
 * indicadores (zigzag pra achar os niveis, CCI pra velocidade/momentum, Bandas de Bollinger pra
 * variacao/volatilidade) em vez de so o formato de uma vela isolada — decisao explicita do
 * usuario depois de observar que estrategias de "uma vela pra outra" (engolfo, pin bar, etc.)
 * nao eram assertivas o suficiente. Ver server/src/strategies/classicStrategies.ts para a
 * deteccao real (usa shared/src/indicators.ts).
 */
export type ClassicStrategyId = 'support_resistance';

export type ClassicStrategyConfig = { id: 'support_resistance' };

export function defaultClassicStrategyConfig(id: ClassicStrategyId): ClassicStrategyConfig {
  switch (id) {
    case 'support_resistance':
      return { id };
  }
}

export interface ClassicStrategyInfo {
  id: ClassicStrategyId;
  name: string;
  description: string;
}

export const CLASSIC_STRATEGIES: ClassicStrategyInfo[] = [
  {
    id: 'support_resistance',
    name: 'Suporte e Resistência',
    description:
      'Preço testa um nível de suporte/resistência validado (2+ toques anteriores, via zigzag), com rejeição na vela, CCI em sobrecompra/sobrevenda e fechamento perto da Banda de Bollinger — entra na vela seguinte.',
  },
];

/** Uma ocorrencia detectada de uma estrategia classica (ao rodar contra o historico de um ativo). */
export interface ClassicOccurrence {
  id: string;
  activeId: number;
  occurredAt: number; // epoch seconds do fechamento da ultima vela do setup (o "sinal")
  setupWindow: Candle[]; // as velas que formaram o setup, da mais antiga a mais nova (a ultima e a vela de sinal)
  direction: Direction;
  entryCandle?: Candle; // vela seguinte ao setup — pode faltar se for o ultimo candle do periodo
  result?: TradeResult;
  /** Candle seguinte a entryCandle — usado so para simular o Gale 1, nunca para o resultado principal. */
  reentryCandle?: Candle;
  /** Percentual (ou razao expressa como percentual) que mede a forca da vela de sinal desta ocorrencia especifica — ver ClassicStrategyResult.signalMetricLabel para o que ele significa nesta estrategia. */
  signalMetricValue: number;
}

export interface ClassicStrategyResult {
  activeId: number;
  days: number;
  strategy: ClassicStrategyConfig;
  occurrences: ClassicOccurrence[];
  summary: { wins: number; losses: number; dojis: number };
  /** O que signalMetricValue mede nesta estrategia (ex.: "Pavio da vela de sinal", "Corpo atual vs. anterior"). */
  signalMetricLabel: string;
  /** Media de signalMetricValue entre todas as ocorrencias — de olho nisso pra saber se as entradas tem sido "seguras" ou fracas. */
  avgSignalMetricValue: number;
  /**
   * Gale 1 (sempre calculado, nao depende de nenhum toggle) — mesma logica/limitacoes do
   * Gale 1 do padrao customizado (ver BacktestSummary.reentry): combined* MISTURA os wins
   * diretos da 1a entrada com a reentrada (sempre parece melhor do que a reentrada sozinha
   * realmente e); reentryOnly* isola SO quem perdeu a 1a entrada — esse e o numero real de
   * "se eu sempre reentrar depois de perder, qual minha chance real".
   */
  reentry: {
    combinedSameDirection: { wins: number; losses: number; dojis: number }; // 1a entrada, e se perder, gale repetindo a direcao original de cada ocorrencia
    combinedOppositeDirection: { wins: number; losses: number; dojis: number }; // idem, mas gale invertendo a direcao
    reentryOnlySameDirection: { wins: number; losses: number; dojis: number };
    reentryOnlyOppositeDirection: { wins: number; losses: number; dojis: number };
    consideredLosses: number; // quantas ocorrencias perderam a 1a entrada
    missingReentryCandle: number; // dessas, quantas nao tinham candle seguinte disponivel (fim do periodo)
  };
}
