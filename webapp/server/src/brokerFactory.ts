import { MockBrokerAdapter } from './broker/MockBrokerAdapter.js';
import { PolariumAdapter } from './broker/PolariumAdapter.js';
import { BalanceType } from '@quadcode-tech/client-sdk-js';
import type { BrokerAdapter } from './broker/BrokerAdapter.js';

const WS_URL = 'wss://ws.trade.polariumbroker.com/echo/websocket';

export type BrokerKind = 'mock' | 'polarium';

export function getBrokerKind(): BrokerKind {
  return (process.env.BROKER_ADAPTER ?? 'mock').toLowerCase() === 'polarium' ? 'polarium' : 'mock';
}

/**
 * Dono do ciclo de vida do BrokerAdapter ativo.
 *
 * Em modo "mock", cria o MockBrokerAdapter imediatamente (sem login, sem rede) para manter
 * o desenvolvimento local simples.
 *
 * Em modo "polarium", NAO cria nada ate alguem chamar loginWithSsid() com um SSID valido —
 * o SSID nunca fica fixo em variavel de ambiente nesse modo, so entra pela tela de login e
 * so vive em memoria de servidor. Nenhuma outra rota deve funcionar sem login antes
 * (regra: na duvida, nao operar).
 */
export class BrokerManager {
  private current: BrokerAdapter | null = null;
  private readonly kind: BrokerKind;

  constructor() {
    this.kind = getBrokerKind();
    if (this.kind === 'mock') {
      this.current = new MockBrokerAdapter();
    }
  }

  get requiresLogin(): boolean {
    return this.kind === 'polarium';
  }

  isReady(): boolean {
    return this.current !== null;
  }

  /** Lanca erro se ainda nao houver um broker autenticado — nunca retorna um broker "vazio". */
  get(): BrokerAdapter {
    if (!this.current) {
      throw new Error('Nenhuma sessao da Polarium ativa. Faca login com um SSID valido antes de usar esta rota.');
    }
    return this.current;
  }

  /** Tenta autenticar um novo SSID. Em caso de falha, o broker anterior (se algum) permanece intacto. */
  async loginWithSsid(ssid: string): Promise<void> {
    const platformId = Number(process.env.POLARIUM_PLATFORM_ID ?? 82);
    const candidate = new PolariumAdapter({
      wsUrl: WS_URL,
      platformId,
      ssid,
      balanceType: BalanceType.Demo, // DEMO por padrao — REAL nunca e escolhido automaticamente aqui.
      expirySeconds: 60,
    });
    await candidate.authenticate(); // lanca se o SSID for invalido/expirado

    if (this.current) {
      await this.current.disconnect().catch(() => {});
    }
    this.current = candidate;
  }

  async logout(): Promise<void> {
    if (this.current && this.kind === 'polarium') {
      await this.current.disconnect().catch(() => {});
      this.current = null;
    }
  }
}
