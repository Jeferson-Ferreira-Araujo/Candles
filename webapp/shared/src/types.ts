// Tipos de dominio compartilhados entre server e client.
// Nenhum tipo aqui deve conter logica de negocio — apenas formas de dados.

export const CANDLE_SIZE_M1 = 60;

/** Candle OHLC. `from`/`to` sao timestamps Unix em segundos (alinhados ao SDK Quadcode). */
export interface Candle {
  activeId: number;
  size: number;
  from: number;
  to: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** false = candle ainda em formacao (nao pode ser usado para confirmar nada). */
  isClosed: boolean;
}

export type CandleColor = 'G' | 'R' | 'DOJI';

export type AssetKind = 'binary' | 'turbo' | 'blitz' | 'digital';

/** Ativo negociavel, para preencher os seletores de busca por nome no lugar do ID cru. */
export interface AssetInfo {
  id: number;
  name: string; // ticker/nome como o SDK devolve, ex.: "GBPUSD-OTC"
  isOtc: boolean;
  kinds: AssetKind[]; // em quais tipos de opcao esse ativo aparece (pode ser mais de um)
}

export function candleColor(c: Pick<Candle, 'open' | 'close'>): CandleColor {
  if (c.close > c.open) return 'G';
  if (c.close < c.open) return 'R';
  return 'DOJI';
}

export type Direction = 'CALL' | 'PUT';

export type TradeResult = 'WIN' | 'LOSS' | 'DOJI';

export type AppMode = 'OBSERVATION' | 'DEMO' | 'REAL';

/**
 * Estado de exibicao do card de monitor, derivado do tamanho do prefixo casado, relativo ao
 * tamanho do padrao customizado ativo. A funcao patternDisplayState() mora em strategyRule.ts
 * (nao aqui) para evitar import circular (strategyRule.ts ja importa este tipo daqui).
 */
export type PatternDisplayState = 'MONITORANDO' | 'ACOMPANHANDO' | 'CONFIRMADO';

/** Progresso ao vivo do padrao customizado ativo para um ativo. */
export interface PatternProgress {
  activeId: number;
  matchedLength: number;
  expected: CandleColor[]; // sempre os elementos do prefixo do padrao ativo
  received: CandleColor[]; // os ultimos `matchedLength` fechados que casam o sufixo
  state: PatternDisplayState;
  lastUpdatedAt: number; // epoch ms
}

/**
 * Uma ocorrencia completa do padrao (ao vivo ou em backtest).
 *
 * Nomes de campo (candle13/candle14, wickPercentage11) mantidos por estabilidade (schema do
 * banco, tipos ja em uso) mesmo com o padrao agora sendo customizavel pelo usuario — na
 * pratica sao a vela de ENTRADA (direcao definida pelo padrao ativo, ver customPattern.ts) e a
 * vela SEGUINTE a ela, usada so para simular o Gale 1. wickPercentage11 nao e mais calculado
 * (regra de pavio retirada) — sempre 1, mantido so por compatibilidade de schema.
 */
export interface PatternOccurrence {
  id: string;
  activeId: number;
  occurredAt: number; // epoch seconds do fechamento da vela de confirmacao
  candles: Candle[]; // as velas do prefixo do padrao, da mais antiga a mais nova
  wickPercentage11: number;
  candle13?: Candle; // a vela de ENTRADA — pode ser ausente em backtest se nao houver dado suficiente
  result?: TradeResult;
  /** Candle seguinte a entrada (candle13) — usado so para simular o Gale 1, nunca para o resultado principal. */
  candle14?: Candle;
  isFirstOfDay: boolean;
}

export type SignalStatus =
  | 'CREATED'
  | 'ORDER_REQUESTED'
  | 'ORDER_CONFIRMED'
  | 'ORDER_UNKNOWN'
  | 'WIN'
  | 'LOSS'
  | 'DOJI'
  | 'INVALIDATED'
  | 'BLOCKED';

export interface Signal {
  id: string; // formato: 12CANDLES-{activeId}-{timestampVelaConfirmacao}-{ENTRY_DIRECTION}
  activeId: number;
  direction: Direction;
  createdAt: number; // epoch ms
  candles: Candle[]; // as 12 velas do padrao
  wickPercentage11: number;
  status: SignalStatus;
}

export type OrderStatus = 'REQUESTED' | 'CONFIRMED' | 'UNKNOWN' | 'FILLED' | 'REJECTED';

export interface OrderRecord {
  id: string;
  signalId: string; // UNIQUE — garante no maximo 1 ordem por sinal
  brokerOrderId?: string;
  activeId: number;
  direction: Direction;
  amount: number;
  status: OrderStatus;
  requestedAt: number;
  confirmedAt?: number;
  resolvedAt?: number;
  result?: TradeResult;
  payoutPercentage?: number;
  pnl?: number;
  mode: AppMode;
}

export interface Settings {
  entryAmount: number; // padrao 5, minimo 5
  galeEnabled: boolean; // padrao false
  galeMaxLevels: 0 | 1; // no maximo 1 quando ativado
  stopWinDaily: number | null;
  stopLossDaily: number | null;
  maxOperationsPerDay: number | null;
  selectedActiveIds: number[];
  mode: AppMode;
  /**
   * Kill switch persistido. Enquanto nao existir um OrderService real, isto so controla a
   * UI e o log de eventos (KILL_SWITCH) — mas qualquer futura logica de envio de ordem
   * DEVE checar este campo antes de operar (regra: na duvida, nao operar).
   */
  robotActive: boolean;
  /** Quantidade de dias que a analise consolidada por ativo (botao no Monitor) olha para tras. */
  analysisDays: number;
}

export const DEFAULT_SETTINGS: Settings = {
  entryAmount: 5,
  galeEnabled: false,
  galeMaxLevels: 0,
  stopWinDaily: null,
  stopLossDaily: null,
  maxOperationsPerDay: null,
  selectedActiveIds: [],
  mode: 'OBSERVATION',
  robotActive: false,
  analysisDays: 7,
};

export interface DailyResult {
  date: string; // YYYY-MM-DD (UTC)
  wins: number;
  losses: number;
  dojis: number;
  pnl: number;
  operationsCount: number;
  stopWinHit: boolean;
  stopLossHit: boolean;
}

export type EventType =
  | 'CANDLE_CLOSED'
  | 'PATTERN_PROGRESS'
  | 'PATTERN_CONFIRMED'
  | 'PATTERN_INVALIDATED'
  | 'SIGNAL_CREATED'
  | 'ORDER_REQUESTED'
  | 'ORDER_CONFIRMED'
  | 'ORDER_UNKNOWN'
  | 'WIN'
  | 'LOSS'
  | 'DOJI'
  | 'STOP_WIN'
  | 'STOP_LOSS'
  | 'MAX_OPERATIONS_REACHED'
  | 'CONNECTION_LOST'
  | 'CONNECTION_RESTORED'
  | 'KILL_SWITCH'
  | 'BLOCKED_BY_SAFETY_CHECK';

export interface AppEvent {
  id: string;
  type: EventType;
  activeId?: number;
  payload: Record<string, unknown>;
  createdAt: number; // epoch ms
}

export interface BacktestRun {
  id: string;
  activeIds: number[];
  days: number;
  startedAt: number;
  finishedAt?: number;
}

export interface BacktestDaySummary {
  date: string;
  perActive: Record<number, number>; // activeId -> occurrence count
  total: number;
  bucket: 'NONE' | 'ONE' | 'TWO' | 'THREE_PLUS';
  multipleInSameActive: boolean;
  multipleDifferentActives: boolean;
}

export interface BacktestSummary {
  runId: string;
  allOccurrences: { wins: number; losses: number; dojis: number };
  firstOfDayOnly: { wins: number; losses: number; dojis: number };
  perDay: BacktestDaySummary[];
  /** Consolidado por ativo (todas as ocorrencias, nao so a 1a do dia) — para ranquear os melhores ativos. */
  perAsset: Record<number, { wins: number; losses: number; dojis: number }>;
  /**
   * Sempre calculado, em toda execucao (nao depende de nenhum toggle): resultado FINAL de
   * cada ocorrencia assumindo Gale 1 — se a 1a entrada (candle13, sempre a direcao do padrao
   * ativo) ja ganhou, conta como WIN direto; se perdeu, o resultado passa a ser o da reentrada
   * no candle seguinte (candle14), simulada nas duas direcoes possiveis (repetindo a mesma
   * direcao ou invertendo para a contraria).
   *
   * IMPORTANTE — "combined" vs "reentryOnly": os campos combined* MISTURAM duas populacoes
   * (as ocorrencias que ja ganharam direto na 1a entrada + as que perderam e foram resgatadas
   * pela reentrada), entao a taxa deles SEMPRE parece melhor do que a reentrada sozinha
   * realmente e — nao da pra ler "combinedOppositeDirection = 79%" como "a reentrada acerta
   * 79%". Os campos reentryOnly* isolam SO a populacao que perdeu a 1a entrada (consideredLosses)
   * e mostram o resultado real de reentrar nela — esse e o numero que responde "se eu sempre
   * reentrar depois de perder, qual e minha chance real".
   */
  reentry: {
    combinedSameDirection: { wins: number; losses: number; dojis: number }; // 1a entrada, e se perder, gale repetindo a mesma direcao — MISTURA populacoes, ver comentario acima
    combinedOppositeDirection: { wins: number; losses: number; dojis: number }; // 1a entrada, e se perder, gale invertendo para a direcao contraria — MISTURA populacoes, ver comentario acima
    /** Taxa ISOLADA da reentrada (repetindo a direcao da 1a entrada), so entre quem perdeu a 1a entrada — nao inclui os wins diretos. */
    reentryOnlySameDirection: { wins: number; losses: number; dojis: number };
    /** Taxa ISOLADA da reentrada (invertendo a direcao), so entre quem perdeu a 1a entrada — nao inclui os wins diretos. */
    reentryOnlyOppositeDirection: { wins: number; losses: number; dojis: number };
    consideredLosses: number; // quantas ocorrencias perderam a 1a entrada (candidatas ao gale) — total da populacao usada nos reentryOnly*
    missingCandle14: number; // dessas, quantas nao tinham candle14 disponivel (fim do periodo) — excluidas de todos os campos acima
  };
}

/**
 * Uma sequencia de cores (G/R) que se repetiu no historico com frequencia notavel — achada
 * pela tela "Descobrir Padrões", que varre o historico procurando por sequencias que se
 * repetem, para depois recriar manualmente na tela de Padrão. `sequence` mapeia direto para
 * as casas do editor de padrao (a ultima e a vela de entrada; as demais sao o prefixo de
 * confirmacao). `avgSignalWickPercentage`/`validSignalWickShare` sao sobre a PENULTIMA vela
 * da sequencia (a vela de sinal) — mesma regra de pavio (SIGNAL_WICK_MIN_LOWER_PERCENTAGE)
 * usada pelo motor ao vivo, para o usuario avaliar se a sequencia encontrada tende a produzir
 * sinais validos ou nao.
 */
export interface DiscoveredPattern {
  sequence: CandleColor[];
  length: number;
  totalOccurrences: number;
  bestDay: string; // YYYY-MM-DD (UTC) — dia com mais repeticoes
  bestDayCount: number; // quantas vezes essa sequencia ocorreu nesse dia
  avgSignalWickPercentage: number; // media do pavio inferior da penultima vela, entre 0 e 1
  validSignalWickShare: number; // fracao das ocorrencias cuja penultima vela respeita a regra do pavio (0..1)
}

export interface PatternDiscoveryResult {
  activeId: number;
  days: number;
  candleCount: number;
  patterns: DiscoveredPattern[];
}

/** Payload da conexao/broker exibido no cabecalho da aplicacao. */
export interface ConnectionStatus {
  connected: boolean;
  brokerName: string;
  lastError?: string;
  serverTimeOffsetMs?: number; // diferenca entre relogio local e servidor, para checagem de sincronismo
}

export interface HeaderState {
  connection: ConnectionStatus;
  mode: AppMode;
  robotActive: boolean;
  balance: number | null;
  dailyResult: DailyResult | null;
  operationsToday: number;
}
