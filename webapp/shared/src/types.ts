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

export function candleColor(c: Pick<Candle, 'open' | 'close'>): CandleColor {
  if (c.close > c.open) return 'G';
  if (c.close < c.open) return 'R';
  return 'DOJI';
}

export type Direction = 'CALL' | 'PUT';

export type TradeResult = 'WIN' | 'LOSS' | 'DOJI';

export type AppMode = 'OBSERVATION' | 'DEMO' | 'REAL';

/**
 * Estado de exibicao do card de monitor, derivado do tamanho do prefixo casado (0-12).
 * Ver STRATEGY_12_CANDLES_PATTERN em strategy/twelveCandles para a sequencia completa.
 */
export type PatternDisplayState =
  | 'MONITORANDO' // 0-8
  | 'ACOMPANHANDO' // 9
  | 'ATENCAO' // 10
  | 'PRE_SINAL' // 11
  | 'CONFIRMADO'; // 12

export function patternDisplayState(matchedLength: number): PatternDisplayState {
  if (matchedLength >= 12) return 'CONFIRMADO';
  if (matchedLength === 11) return 'PRE_SINAL';
  if (matchedLength === 10) return 'ATENCAO';
  if (matchedLength === 9) return 'ACOMPANHANDO';
  return 'MONITORANDO';
}

/** Progresso ao vivo do padrao 12 Candles para um ativo. */
export interface PatternProgress {
  activeId: number;
  matchedLength: number; // 0..12
  expected: CandleColor[]; // sempre os 12 elementos da regra
  received: CandleColor[]; // os ultimos `matchedLength` fechados que casam o sufixo
  state: PatternDisplayState;
  /** Somente presente quando a 11a vela (posicao 10) esta se formando ou ja fechou dentro da janela casada. */
  wick11?: {
    currentPercentage: number;
    requiredPercentage: number;
    candleClosed: boolean;
  };
  lastUpdatedAt: number; // epoch ms
}

/** Uma ocorrencia completa do padrao (ao vivo ou em backtest). */
export interface PatternOccurrence {
  id: string;
  activeId: number;
  occurredAt: number; // epoch seconds do fechamento da 12a vela
  candles: Candle[]; // as 12 velas do padrao, da mais antiga a mais nova
  wickPercentage11: number;
  candle13?: Candle; // pode ser ausente em backtest se nao houver dado suficiente
  result?: TradeResult;
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
  id: string; // formato: 12CANDLES-{activeId}-{timestampCandle12}-CALL
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
