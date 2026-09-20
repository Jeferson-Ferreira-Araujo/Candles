import {
  ClientSdk,
  SsidAuthMethod,
  DigitalOptionsDirection,
  BalanceType,
  type Candle as SdkCandle,
} from '@quadcode-tech/client-sdk-js';
import type { Candle, Direction } from '@polarium12c/shared';
import {
  NotImplementedError,
  type BrokerAdapter,
  type BrokerBalance,
  type BrokerOrderInfo,
  type BrokerOrderResolution,
  type PlaceOrderAck,
  type PlaceOrderParams,
} from './BrokerAdapter.js';

/**
 * Adapter real da Polarium, construido SOMENTE com metodos confirmados lendo o
 * codigo-fonte instalado de @quadcode-tech/client-sdk-js (nao apenas a documentacao).
 * Onde algo nao pode ser confirmado sem uma sessao real, o metodo lanca
 * `NotImplementedError` explicando exatamente o que falta confirmar — nunca inventa
 * comportamento.
 *
 * platformId: os exemplos oficiais do SDK usam 82 sem documentar o significado para
 * brokers white-label como a Polarium. Ver README para instrucoes de confirmacao.
 */
export interface PolariumAdapterConfig {
  wsUrl: string;
  platformId: number;
  ssid: string;
  /** Qual tipo de saldo usar para negociar (demo ou real). REAL deve ficar bloqueado na camada de aplicacao, nao aqui. */
  balanceType: BalanceType;
  /** Duracao padrao da expiracao digital, em segundos. M1 = 60. */
  expirySeconds: number;
}

function sdkCandleToShared(activeId: number, size: number, c: SdkCandle, nowSeconds: number): Candle {
  return {
    activeId,
    size,
    from: c.from,
    to: c.to,
    open: c.open,
    high: c.max,
    low: c.min,
    close: c.close,
    // O SDK nao expoe um campo isClosed explicito no DTO de Candle (from/to/open/close/min/max/volume/at).
    // Heuristica documentada: um candle e considerado fechado quando o tempo do servidor ja
    // ultrapassou seu `to`. Isso e uma inferencia deliberada, nao um campo oficial do SDK.
    isClosed: nowSeconds >= c.to,
  };
}

function toSdkDirection(direction: Direction): DigitalOptionsDirection {
  if (direction === 'CALL') return DigitalOptionsDirection.Call;
  return DigitalOptionsDirection.Put;
}

export class PolariumAdapter implements BrokerAdapter {
  private sdk: ClientSdk | null = null;
  private readonly config: PolariumAdapterConfig;

  constructor(config: PolariumAdapterConfig) {
    this.config = config;
  }

  async authenticate(): Promise<void> {
    // Identico ao fluxo ja validado em collect.js desta mesma base de codigo — nao alterado.
    this.sdk = await ClientSdk.create(this.config.wsUrl, this.config.platformId, new SsidAuthMethod(this.config.ssid));
  }

  private requireSdk(): ClientSdk {
    if (!this.sdk) throw new Error('PolariumAdapter: chame authenticate() antes de usar.');
    return this.sdk;
  }

  async getBalances(): Promise<BrokerBalance[]> {
    const sdk = this.requireSdk();
    const balances = await sdk.balances();
    return balances.getBalances().map((b) => ({
      id: String(b.id),
      type: b.type ?? 'unknown',
      amount: b.amount,
      currency: b.currency,
    }));
  }

  private async getTradingBalance() {
    const sdk = this.requireSdk();
    const balances = await sdk.balances();
    const balance = balances.getBalances().find((b) => b.type === this.config.balanceType);
    if (!balance) {
      throw new Error(
        `Nenhum saldo do tipo ${this.config.balanceType} encontrado na conta. Nao operar (regra: na duvida, nao operar).`
      );
    }
    return balance;
  }

  async getHistoricalCandles(activeId: number, size: number, from: number, to: number): Promise<Candle[]> {
    const sdk = this.requireSdk();
    const chartLayer = await sdk.realTimeChartDataLayer(activeId, size);
    const nowSeconds = Math.floor(sdk.currentTime().getTime() / 1000);

    // Paginacao para tras identica em espirito ao collect.js: o SDK limita a 1000 candles
    // por chamada de fetchCandles(to, countBack).
    const MAX_PER_REQUEST = 1000;
    const byFrom = new Map<number, SdkCandle>();
    let cursor = to;
    let iterations = 0;
    const maxIterations = Math.ceil(((to - from) / size + 1) / MAX_PER_REQUEST) + 5;

    while (iterations < maxIterations) {
      iterations++;
      const batch = await chartLayer.fetchCandles(cursor, MAX_PER_REQUEST);
      if (!batch || batch.length === 0) break;
      let oldest = Infinity;
      for (const c of batch) {
        if (c.from < from) continue;
        byFrom.set(c.from, c);
        if (c.from < oldest) oldest = c.from;
      }
      if (oldest === Infinity || oldest >= cursor || oldest <= from) break;
      cursor = oldest - 1;
    }

    return Array.from(byFrom.values())
      .sort((a, b) => a.from - b.from)
      .map((c) => sdkCandleToShared(activeId, size, c, nowSeconds));
  }

  async subscribeCandles(activeId: number, size: number, onCandle: (candle: Candle) => void): Promise<() => void> {
    const sdk = this.requireSdk();
    const chartLayer = await sdk.realTimeChartDataLayer(activeId, size);

    const handler = (c: SdkCandle) => {
      const nowSeconds = Math.floor(sdk.currentTime().getTime() / 1000);
      onCandle(sdkCandleToShared(activeId, size, c, nowSeconds));
    };

    chartLayer.subscribeOnLastCandleChanged(handler);
    return () => chartLayer.unsubscribeOnLastCandleChanged(handler);
  }

  async getServerTime(): Promise<Date> {
    const sdk = this.requireSdk();
    return sdk.currentTime();
  }

  async getPayout(activeId: number, amount: number): Promise<number | null> {
    const sdk = this.requireSdk();
    const digital = await sdk.digitalOptions();
    const now = sdk.currentTime();
    const underlying = digital.getUnderlyingsAvailableForTradingAt(now).find((u) => u.activeId === activeId);
    if (!underlying) return null;

    const instruments = await underlying.instruments();
    // Escolhe o instrumento cujo periodo (segundos ate expiracao) bate com a expiracao configurada (M1 = 60).
    const instrument = instruments
      .getAvailableForBuyAt(now)
      .find((i) => i.period === this.config.expirySeconds);
    if (!instrument) return null;

    // profitPercent() e um metodo real e confirmado da SDK — nao um valor inventado.
    const percent = instrument.profitPercent(amount);
    return Number.isFinite(percent) ? percent : null;
  }

  async placeOrder(params: PlaceOrderParams): Promise<PlaceOrderAck> {
    const sdk = this.requireSdk();
    const digital = await sdk.digitalOptions();
    const now = sdk.currentTime();
    const underlying = digital.getUnderlyingsAvailableForTradingAt(now).find((u) => u.activeId === params.activeId);
    if (!underlying) {
      throw new Error(`Ativo ${params.activeId} nao disponivel para digital options agora. Nao operar.`);
    }
    const instruments = await underlying.instruments();
    const instrument = instruments.getAvailableForBuyAt(now).find((i) => i.period === params.expirySeconds);
    if (!instrument) {
      throw new Error(`Nenhum instrumento digital de ${params.expirySeconds}s disponivel para o ativo ${params.activeId} agora. Nao operar.`);
    }

    const balance = await this.getTradingBalance();
    const order = await digital.buySpotStrike(instrument, toSdkDirection(params.direction), params.amount, balance);
    return { brokerOrderId: String(order.id) };
  }

  async getOrder(brokerOrderId: string): Promise<BrokerOrderInfo | null> {
    const sdk = this.requireSdk();
    const positions = await sdk.positions();
    const orderIdNum = Number(brokerOrderId);

    const open = positions.getOpenedPositions().find((p) => positions.isOrderMatchingPosition(orderIdNum, p));
    if (open) return { brokerOrderId, status: 'OPEN' };

    // TODO(confirmar): getPositionsHistory() existe e e o caminho documentado para posicoes
    // fechadas, mas este projeto ainda nao confirmou em producao a forma exata de consultar
    // essa historia por order id (a classe PositionsHistory nao foi inspecionada em detalhe
    // ainda). Ate confirmar, tratamos "nao esta aberta" como desconhecido em vez de assumir
    // fechada — respeita a regra "na duvida, nao operar"/nao reconciliar erroneamente.
    return { brokerOrderId, status: 'UNKNOWN' };
  }

  async getOrderResult(brokerOrderId: string): Promise<BrokerOrderResolution | null> {
    const sdk = this.requireSdk();
    const positions = await sdk.positions();
    const orderIdNum = Number(brokerOrderId);

    const position = positions.getOpenedPositions().find((p) => positions.isOrderMatchingPosition(orderIdNum, p));
    if (!position) {
      // TODO(confirmar): mesma ressalva do getOrder() — falta confirmar a leitura via
      // getPositionsHistory() para posicoes ja fechadas/expiradas.
      return null;
    }
    if (position.pnlRealized === undefined) return null; // ainda nao resolvida

    const pnl = position.pnlRealized;
    const result = pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'DOJI';
    return { result, pnl };
  }

  async disconnect(): Promise<void> {
    if (this.sdk) {
      await this.sdk.shutdown();
      this.sdk = null;
    }
  }
}

// Mantido para deixar explicito, no proprio arquivo, o que este adapter conscientemente
// NAO tenta fazer sem confirmacao adicional (chamavel pelos testes de integracao futuros).
export function assertPolariumRealModeRequiresManualReview(): never {
  throw new NotImplementedError(
    'REAL mode',
    'bloqueado deliberadamente na camada de aplicacao (SafetyGate), nao neste adapter.'
  );
}
