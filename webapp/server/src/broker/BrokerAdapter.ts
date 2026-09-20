import type { Candle, Direction, TradeResult } from '@polarium12c/shared';

/**
 * Contrato unico entre a aplicacao e qualquer corretora. Tudo que a aplicacao sabe sobre
 * "como falar com a Polarium" passa por aqui — o restante do sistema (StrategyEngine,
 * SafetyGate, rotas HTTP/WS) nunca importa nada especifico de uma corretora.
 *
 * Qualquer metodo que dependa de algo ainda nao confirmado no SDK oficial deve lancar
 * `NotImplementedError` com uma mensagem clara, em vez de inventar um comportamento.
 */
export interface BrokerBalance {
  id: string;
  type: string; // ex.: 'real' | 'demo' — string livre, o SDK decide os valores
  amount: number;
  currency?: string;
}

export interface PlaceOrderParams {
  activeId: number;
  direction: Direction;
  amount: number;
  /** Duracao da expiracao em segundos (M1 = 60). */
  expirySeconds: number;
}

export interface PlaceOrderAck {
  /** ID retornado pela corretora IMEDIATAMENTE apos o pedido (pode nao significar execucao confirmada). */
  brokerOrderId: string;
}

export type BrokerOrderStatus = 'OPEN' | 'CLOSED' | 'UNKNOWN';

export interface BrokerOrderInfo {
  brokerOrderId: string;
  status: BrokerOrderStatus;
}

export interface BrokerOrderResolution {
  result: TradeResult;
  pnl: number;
  payoutPercentage?: number;
}

export class NotImplementedError extends Error {
  constructor(method: string, reason: string) {
    super(`BrokerAdapter.${method} nao implementado: ${reason}`);
    this.name = 'NotImplementedError';
  }
}

export interface BrokerAdapter {
  authenticate(): Promise<void>;

  getBalances(): Promise<BrokerBalance[]>;

  getHistoricalCandles(activeId: number, size: number, from: number, to: number): Promise<Candle[]>;

  /** Retorna uma funcao de cancelamento da inscricao. */
  subscribeCandles(activeId: number, size: number, onCandle: (candle: Candle) => void): Promise<() => void>;

  getServerTime(): Promise<Date>;

  /**
   * Payout esperado (fracao, ex.: 0.85 = 85%) para o valor de entrada informado.
   * Deve retornar `null` quando a corretora nao informar um payout confiavel — chamadores
   * devem tratar `null` como "nao operar" (regra: na duvida, nao operar).
   */
  getPayout(activeId: number, amount: number): Promise<number | null>;

  /** Envia o pedido de compra. NAO deve ser chamado duas vezes para o mesmo signalId — isso e responsabilidade do SafetyGate/OrderService, nao do adapter. */
  placeOrder(params: PlaceOrderParams): Promise<PlaceOrderAck>;

  getOrder(brokerOrderId: string): Promise<BrokerOrderInfo | null>;

  /** Retorna a resolucao (WIN/LOSS/DOJI + pnl) ou `null` se a posicao ainda nao fechou/nao foi encontrada. */
  getOrderResult(brokerOrderId: string): Promise<BrokerOrderResolution | null>;

  disconnect(): Promise<void>;
}
