import type { AssetInfo, Candle } from '@polarium12c/shared';
import type {
  BrokerAdapter,
  BrokerBalance,
  BrokerOrderInfo,
  BrokerOrderResolution,
  PlaceOrderAck,
  PlaceOrderParams,
} from './BrokerAdapter.js';

interface MockOrderState {
  activeId: number;
  direction: PlaceOrderParams['direction'];
  amount: number;
  openCandle: Candle | null; // candle vigente no momento da compra (para achar a de resolucao depois)
  resolution: BrokerOrderResolution | null;
}

export interface MockBrokerConfig {
  /** Payout fixo simulado (fracao). Nao deve ser usado como fonte de verdade para a Polarium real. */
  payout: number;
  initialBalance: number;
  assets: AssetInfo[];
}

const DEFAULT_MOCK_ASSETS: AssetInfo[] = [
  { id: 81, name: 'GBPUSD-OTC', isOtc: true, kinds: ['digital'] },
  { id: 76, name: 'EURUSD-OTC', isOtc: true, kinds: ['digital', 'binary'] },
  { id: 1, name: 'EURUSD', isOtc: false, kinds: ['binary', 'turbo'] },
  { id: 2298, name: 'EXEMPLO-OTC', isOtc: true, kinds: ['digital'] },
];

/**
 * Broker fake para desenvolvimento/teste, sem nenhuma chamada de rede.
 * Permite "replay" de uma lista de candles historicos como se fossem tempo real
 * (usado pelo backtest e pelos testes do StrategyEngine/SafetyGate).
 */
export class MockBrokerAdapter implements BrokerAdapter {
  private balance: number;
  private readonly config: MockBrokerConfig;
  private candlesByActive = new Map<number, Candle[]>();
  private subscribers = new Map<number, Set<(c: Candle) => void>>();
  private orders = new Map<string, MockOrderState>();
  private nextOrderId = 1;
  private connected = false;

  constructor(config: Partial<MockBrokerConfig> = {}) {
    this.config = {
      payout: config.payout ?? 0.85,
      initialBalance: config.initialBalance ?? 1000,
      assets: config.assets ?? DEFAULT_MOCK_ASSETS,
    };
    this.balance = this.config.initialBalance;
  }

  /** Carrega candles historicos que `getHistoricalCandles` e o replay irao servir. */
  seedCandles(activeId: number, candles: Candle[]): void {
    this.candlesByActive.set(activeId, [...candles].sort((a, b) => a.from - b.from));
  }

  /** Empurra um candle "ao vivo" para os assinantes de um ativo (usado pelo replay/testes). */
  pushLiveCandle(activeId: number, candle: Candle): void {
    const list = this.candlesByActive.get(activeId) ?? [];
    list.push(candle);
    this.candlesByActive.set(activeId, list);

    for (const cb of this.subscribers.get(activeId) ?? []) cb(candle);

    if (candle.isClosed) this.resolveOrdersWaitingOn(activeId, candle);
  }

  private resolveOrdersWaitingOn(activeId: number, closedCandle: Candle): void {
    for (const [orderId, order] of this.orders) {
      if (order.resolution || order.activeId !== activeId || !order.openCandle) continue;
      // A ordem resolve no PRIMEIRO candle fechado que comeca IMEDIATAMENTE apos o candle vigente na compra.
      if (closedCandle.from === order.openCandle.to) {
        const pnl =
          closedCandle.close > closedCandle.open
            ? order.amount * this.config.payout
            : closedCandle.close < closedCandle.open
              ? -order.amount
              : 0;
        const result = closedCandle.close > closedCandle.open ? 'WIN' : closedCandle.close < closedCandle.open ? 'LOSS' : 'DOJI';
        order.resolution = { result, pnl, payoutPercentage: this.config.payout };
        this.balance += pnl;
        this.orders.set(orderId, order);
      }
    }
  }

  async authenticate(): Promise<void> {
    this.connected = true;
  }

  async getBalances(): Promise<BrokerBalance[]> {
    this.assertConnected();
    return [{ id: 'mock-demo', type: 'demo', amount: this.balance, currency: 'USD' }];
  }

  async listAssets(): Promise<AssetInfo[]> {
    this.assertConnected();
    return this.config.assets;
  }

  async getHistoricalCandles(activeId: number, size: number, from: number, to: number): Promise<Candle[]> {
    this.assertConnected();
    const list = this.candlesByActive.get(activeId) ?? [];
    return list.filter((c) => c.size === size && c.from >= from && c.from <= to);
  }

  async subscribeCandles(activeId: number, _size: number, onCandle: (candle: Candle) => void): Promise<() => void> {
    this.assertConnected();
    const set = this.subscribers.get(activeId) ?? new Set();
    set.add(onCandle);
    this.subscribers.set(activeId, set);
    return () => {
      this.subscribers.get(activeId)?.delete(onCandle);
    };
  }

  async getServerTime(): Promise<Date> {
    return new Date();
  }

  async getPayout(_activeId: number, _amount: number): Promise<number | null> {
    this.assertConnected();
    return this.config.payout;
  }

  async placeOrder(params: PlaceOrderParams): Promise<PlaceOrderAck> {
    this.assertConnected();
    const brokerOrderId = `mock-${this.nextOrderId++}`;
    const currentCandles = this.candlesByActive.get(params.activeId) ?? [];
    const openCandle = currentCandles.length > 0 ? currentCandles[currentCandles.length - 1]! : null;
    this.orders.set(brokerOrderId, {
      activeId: params.activeId,
      direction: params.direction,
      amount: params.amount,
      openCandle,
      resolution: null,
    });
    this.balance -= params.amount;
    return { brokerOrderId };
  }

  async getOrder(brokerOrderId: string): Promise<BrokerOrderInfo | null> {
    const order = this.orders.get(brokerOrderId);
    if (!order) return null;
    return { brokerOrderId, status: order.resolution ? 'CLOSED' : 'OPEN' };
  }

  async getOrderResult(brokerOrderId: string): Promise<BrokerOrderResolution | null> {
    const order = this.orders.get(brokerOrderId);
    if (!order) return null;
    return order.resolution;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  private assertConnected(): void {
    if (!this.connected) throw new Error('MockBrokerAdapter: chame authenticate() antes de usar.');
  }
}
