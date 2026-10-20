import {
  ClientSdk,
  SsidAuthMethod,
  DigitalOptionsDirection,
  BalanceType,
  type Candle as SdkCandle,
} from '@quadcode-tech/client-sdk-js';
import type { AppMode, AssetInfo, AssetKind, Candle, Direction } from '@polarium12c/shared';
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

  /**
   * Lista ativos combinando os 4 catalogos confirmados do SDK (binary/turbo/blitz tem
   * `{id, ticker}`; digital tem `{activeId, name}` via getUnderlyingsAvailableForTradingAt).
   * `isOtc` e inferido do proprio nome/ticker conter "OTC" — convencao ja observada nos
   * dados reais da Polarium nesta mesma base de codigo (ex.: "GBPUSD-OTC"), nao um campo
   * separado do SDK. Cada catalogo e buscado isoladamente: se um tipo de opcao nao estiver
   * disponivel para a conta, os outros ainda aparecem.
   *
   * O app so opera OTC digital (placeOrder() so usa digitalOptions(), e o usuario decidiu
   * restringir o escopo a OTC) — entao o resultado final so inclui ativos que sejam OTC E
   * apareçam no catalogo digital, mesmo que tenham sido encontrados em outro catalogo tambem.
   */
  async listAssets(): Promise<AssetInfo[]> {
    const sdk = this.requireSdk();
    const now = sdk.currentTime();
    const byId = new Map<number, AssetInfo>();

    const addKind = (id: number, name: string, kind: AssetKind) => {
      const existing = byId.get(id);
      if (existing) {
        if (!existing.kinds.includes(kind)) existing.kinds.push(kind);
        return;
      }
      byId.set(id, { id, name, isOtc: name.toUpperCase().includes('OTC'), kinds: [kind] });
    };

    try {
      const binary = await sdk.binaryOptions();
      for (const a of binary.getActives()) addKind(a.id, a.ticker, 'binary');
    } catch {
      // tipo de opcao pode nao estar disponivel para esta conta — segue sem ele
    }

    try {
      const turbo = await sdk.turboOptions();
      for (const a of turbo.getActives()) addKind(a.id, a.ticker, 'turbo');
    } catch {
      // idem
    }

    try {
      const blitz = await sdk.blitzOptions();
      for (const a of blitz.getActives()) addKind(a.id, a.ticker, 'blitz');
    } catch {
      // idem
    }

    try {
      const digital = await sdk.digitalOptions();
      for (const u of digital.getUnderlyingsAvailableForTradingAt(now)) addKind(u.activeId, u.name, 'digital');
    } catch {
      // idem
    }

    return Array.from(byId.values())
      .filter((a) => a.isOtc && a.kinds.includes('digital'))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** `mode` vem de Settings.mode a cada chamada — NUNCA fixo no adapter, pra DEMO/REAL
   * trocarem de verdade a conta usada sem precisar reconectar nem reconstruir o adapter. */
  private async getTradingBalance(mode: AppMode) {
    if (mode === 'OBSERVATION') {
      throw new Error('OBSERVATION nunca opera — nao ha saldo de negociacao para este modo (regra: na duvida, nao operar).');
    }
    const balanceType = mode === 'REAL' ? BalanceType.Real : BalanceType.Demo;
    const sdk = this.requireSdk();
    const balances = await sdk.balances();
    const balance = balances.getBalances().find((b) => b.type === balanceType);
    if (!balance) {
      throw new Error(`Nenhum saldo do tipo ${balanceType} encontrado na conta. Nao operar (regra: na duvida, nao operar).`);
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
    if (!underlying) {
      console.error(`[getPayout] activeId ${activeId} nao esta em getUnderlyingsAvailableForTradingAt(now) agora.`);
      return null;
    }

    const instruments = await underlying.instruments();
    const availableNow = instruments.getAvailableForBuyAt(now);
    // Escolhe o instrumento cujo periodo (segundos ate expiracao) bate com a expiracao configurada (M1 = 60).
    const instrument = availableNow.find((i) => i.period === this.config.expirySeconds);
    if (!instrument) {
      console.error(
        `[getPayout] nenhum instrumento com period=${this.config.expirySeconds}s disponivel para activeId ${activeId} agora. ` +
          `Periodos disponiveis: [${availableNow.map((i) => i.period).join(', ')}]`
      );
      return null;
    }

    // profitPercent() precisa dos precos ask/bid das strikes, que so chegam depois de assinar
    // o canal correspondente — sem isso, profitPercent() lanca "ask/bid prices are undefined".
    await instrument.subscribeOnStrikesAskBidPrices();
    const percent = await this.waitForProfitPercent(instrument, amount);
    if (percent === null) {
      console.error(
        `[getPayout] timeout esperando preco ask/bid (via subscribeOnStrikesAskBidPrices) para activeId ${activeId}.`
      );
      return null;
    }
    // A SDK devolve PONTOS PERCENTUAIS (ex.: 90 = 90%), nao uma fracao — confirmado lendo a
    // implementacao real (profitPercent faz "* 100" na conta). O resto do app (SafetyGate,
    // OrderRecord.payoutPercentage, estimativas de ganho na tela) espera fracao (0.90), entao
    // normaliza aqui, no unico lugar que conhece essa unidade.
    return percent / 100;
  }

  /**
   * profitPercent() lanca erro at'e o primeiro evento de preco ask/bid chegar pelo websocket
   * (assinado por subscribeOnStrikesAskBidPrices). Tenta novamente por um curto periodo em vez
   * de desistir na primeira tentativa.
   */
  private async waitForProfitPercent(
    instrument: { profitPercent(amount: number): number },
    amount: number,
    timeoutMs = 3000,
    intervalMs = 150
  ): Promise<number | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const percent = instrument.profitPercent(amount);
        if (Number.isFinite(percent)) return percent;
      } catch {
        // ask/bid ainda nao chegaram — tenta de novo ate o timeout.
      }
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
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

    // Mesma exigencia da SDK que em getPayout: precos ask/bid precisam estar assinados antes
    // de comprar, senao buySpotStrike pode falhar pelo mesmo motivo (precos indefinidos).
    await instrument.subscribeOnStrikesAskBidPrices();
    await this.waitForProfitPercent(instrument, params.amount);

    const balance = await this.getTradingBalance(params.mode);
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

    const open = positions.getOpenedPositions().find((p) => positions.isOrderMatchingPosition(orderIdNum, p));
    if (open) {
      if (open.pnlRealized === undefined) return null; // ainda aberta, sem resultado
      const pnl = open.pnlRealized;
      return { result: pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'DOJI', pnl };
    }

    // Nao esta mais entre as posicoes ABERTAS — ou ja fechou, ou ainda nao chegou a abrir.
    // getPositionHistory(externalId) e o metodo real e confirmado da SDK pra consultar o
    // historico por ID — usa o mesmo numero que isOrderMatchingPosition casa contra
    // position.orderIds nas posicoes abertas, entao e o mesmo ID aqui.
    let closed;
    try {
      closed = await positions.getPositionsHistory().getPositionHistory(orderIdNum);
    } catch (err) {
      console.error(`[getOrderResult] erro consultando historico de posicoes (orderId ${orderIdNum}):`, err);
      return null;
    }
    if (!closed || closed.pnlRealized === undefined) return null; // ainda nao apareceu no historico

    const pnl = closed.pnlRealized;
    return { result: pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'DOJI', pnl };
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
