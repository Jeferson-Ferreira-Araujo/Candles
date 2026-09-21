import type { Candle, Direction, TradeResult } from './types.js';

/** Restringe em quais direcoes a estrategia deve gerar sinal — util para testar so o lado CALL ou so o PUT de uma familia. */
export type DirectionFilter = 'BOTH' | 'CALL_ONLY' | 'PUT_ONLY';

export interface SequenceReversalParams {
  /** Quantas velas consecutivas da MESMA cor precisam vir antes da vela de reversao. */
  sequenceLength: number;
  /** Corpo da vela de reversao, como fracao do proprio range (0..1) — filtra reversoes "fracas". */
  minReversalBodyPercent: number;
  /** Pavio do lado OPOSTO a entrada, como fracao do range da vela de reversao (0..1) — limite maximo. */
  maxReversalOppositeWickPercent: number;
  direction: DirectionFilter;
}

export interface EngulfingParams {
  /** Corpo da vela atual precisa ser pelo menos essa vezes o corpo da vela anterior (ex.: 1.5). */
  minBodyRatio: number;
  /** Pavio do lado oposto a entrada, como fracao do range da vela de engolfo (0..1) — limite maximo. */
  maxOppositeWickPercent: number;
  direction: DirectionFilter;
}

export interface PinBarParams {
  /** Pavio (inferior para CALL, superior para PUT) minimo, como fracao do range (0..1). */
  minWickPercent: number;
  /** Corpo maximo, como fracao do range (0..1) — pin bar precisa ter corpo pequeno. */
  maxBodyPercent: number;
  /** Posicao minima do fechamento dentro do range, do lado da entrada (0..1 — 1 = fechou exatamente no extremo). */
  minClosePositionPercent: number;
  direction: DirectionFilter;
}

export interface ImpulsePullbackParams {
  /** Quantas velas anteriores usar para calcular o range mediano de referencia. */
  medianLookback: number;
  /** Range do candle de impulso precisa ser pelo menos essa vezes a mediana (ex.: 1.5). */
  minImpulseRangeMultiplier: number;
  /** O pullback nao pode devolver mais que essa fracao do corpo do impulso (0..1). */
  maxPullbackRetracePercent: number;
  direction: DirectionFilter;
}

export interface CompressionBreakoutParams {
  /** Quantas velas formam o bloco de compressao. */
  compressionLength: number;
  /** Quantas velas anteriores usar para calcular o range mediano de referencia. */
  medianLookback: number;
  /** Cada vela do bloco de compressao precisa ter range <= mediana * essa fracao (ex.: 1.0 = abaixo da mediana). */
  maxCompressionRangeRatio: number;
  direction: DirectionFilter;
}

export type ClassicStrategyId =
  | 'sequence_reversal'
  | 'engulfing'
  | 'pin_bar'
  | 'impulse_pullback'
  | 'compression_breakout'
  | 'inside_bar_breakout'
  | 'fakeout'
  | 'three_soldiers'
  | 'impulse_pullback_50'
  | 'double_rejection';

/**
 * As 5 estrategias abaixo (inside_bar_breakout .. double_rejection) nao tem params: seguem
 * sempre a definicao classica/padrao da familia, sem nenhum ajuste exposto ao usuario — por
 * pedido explicito, ao contrario das 5 primeiras (que mantiveram os params internamente,
 * mesmo sem UI de edicao, por estabilidade de tipo/teste).
 */
export type ClassicStrategyConfig =
  | { id: 'sequence_reversal'; params: SequenceReversalParams }
  | { id: 'engulfing'; params: EngulfingParams }
  | { id: 'pin_bar'; params: PinBarParams }
  | { id: 'impulse_pullback'; params: ImpulsePullbackParams }
  | { id: 'compression_breakout'; params: CompressionBreakoutParams }
  | { id: 'inside_bar_breakout' }
  | { id: 'fakeout' }
  | { id: 'three_soldiers' }
  | { id: 'impulse_pullback_50' }
  | { id: 'double_rejection' };

export const DEFAULT_SEQUENCE_REVERSAL_PARAMS: SequenceReversalParams = {
  sequenceLength: 4,
  minReversalBodyPercent: 0.5,
  maxReversalOppositeWickPercent: 0.35,
  direction: 'BOTH',
};

export const DEFAULT_ENGULFING_PARAMS: EngulfingParams = {
  minBodyRatio: 1.2,
  maxOppositeWickPercent: 0.35,
  direction: 'BOTH',
};

export const DEFAULT_PIN_BAR_PARAMS: PinBarParams = {
  minWickPercent: 0.6,
  maxBodyPercent: 0.3,
  minClosePositionPercent: 0.7,
  direction: 'BOTH',
};

export const DEFAULT_IMPULSE_PULLBACK_PARAMS: ImpulsePullbackParams = {
  medianLookback: 10,
  minImpulseRangeMultiplier: 1.5,
  maxPullbackRetracePercent: 0.5,
  direction: 'BOTH',
};

export const DEFAULT_COMPRESSION_BREAKOUT_PARAMS: CompressionBreakoutParams = {
  compressionLength: 4,
  medianLookback: 20,
  maxCompressionRangeRatio: 1.0,
  direction: 'BOTH',
};

export function defaultClassicStrategyConfig(id: ClassicStrategyId): ClassicStrategyConfig {
  switch (id) {
    case 'sequence_reversal':
      return { id, params: DEFAULT_SEQUENCE_REVERSAL_PARAMS };
    case 'engulfing':
      return { id, params: DEFAULT_ENGULFING_PARAMS };
    case 'pin_bar':
      return { id, params: DEFAULT_PIN_BAR_PARAMS };
    case 'impulse_pullback':
      return { id, params: DEFAULT_IMPULSE_PULLBACK_PARAMS };
    case 'compression_breakout':
      return { id, params: DEFAULT_COMPRESSION_BREAKOUT_PARAMS };
    case 'inside_bar_breakout':
    case 'fakeout':
    case 'three_soldiers':
    case 'impulse_pullback_50':
    case 'double_rejection':
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
    id: 'sequence_reversal',
    name: 'Reversão após sequência',
    description: 'N velas seguidas da mesma cor, seguidas de uma vela de reversão — entra na vela seguinte.',
  },
  {
    id: 'engulfing',
    name: 'Engolfo (Engulfing)',
    description: 'O corpo da vela atual engolfa o corpo da anterior, com cores opostas — entra na vela seguinte.',
  },
  {
    id: 'pin_bar',
    name: 'Pin Bar / Rejeição',
    description: 'Corpo pequeno + pavio grande de um lado + fechamento perto do extremo oposto — entra na vela seguinte.',
  },
  {
    id: 'impulse_pullback',
    name: 'Impulso → Pullback → Continuação',
    description: 'Vela de impulso anormalmente grande, seguida de correção pequena — entra na vela seguinte.',
  },
  {
    id: 'compression_breakout',
    name: 'Compressão → Breakout',
    description: 'Bloco de velas pequenas seguido de um rompimento do range — entra na vela seguinte.',
  },
  {
    id: 'inside_bar_breakout',
    name: 'Inside Bar + Rompimento',
    description: 'Uma ou mais velas dentro do range da vela-mãe, seguidas de rompimento — entra na vela seguinte.',
  },
  {
    id: 'fakeout',
    name: 'Falso Rompimento (Fakeout)',
    description: 'Rompe a máxima/mínima das últimas 5 velas mas fecha de volta dentro do range — entra na vela seguinte.',
  },
  {
    id: 'three_soldiers',
    name: 'Três Candles de Impulso',
    description: '3 velas da mesma cor com corpos fortes e progressão de preço — testa continuação na 4ª vela.',
  },
  {
    id: 'impulse_pullback_50',
    name: 'Pullback 50% do Impulso',
    description: 'Impulso grande seguido de correção de 30–50% que fica contida na vela de impulso — entra na vela seguinte.',
  },
  {
    id: 'double_rejection',
    name: 'Dupla Rejeição de Nível',
    description: 'Duas tentativas de romper quase o mesmo nível, ambas rejeitadas — entra na vela seguinte.',
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
