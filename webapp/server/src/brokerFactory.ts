import { MockBrokerAdapter } from './broker/MockBrokerAdapter.js';
import { PolariumAdapter } from './broker/PolariumAdapter.js';
import { BalanceType } from '@quadcode-tech/client-sdk-js';
import type { BrokerAdapter } from './broker/BrokerAdapter.js';

const WS_URL = 'wss://ws.trade.polariumbroker.com/echo/websocket';

/**
 * Escolhe a implementacao de BrokerAdapter com base em BROKER_ADAPTER (env). Padrao:
 * "mock" — nunca conecta em nada real a menos que explicitamente configurado.
 */
export function createBrokerAdapter(): BrokerAdapter {
  const kind = (process.env.BROKER_ADAPTER ?? 'mock').toLowerCase();

  if (kind === 'polarium') {
    const ssid = process.env.POLARIUM_SSID;
    if (!ssid) {
      throw new Error('BROKER_ADAPTER=polarium requer POLARIUM_SSID configurado (variavel de ambiente).');
    }
    const platformId = Number(process.env.POLARIUM_PLATFORM_ID ?? 82);
    return new PolariumAdapter({
      wsUrl: WS_URL,
      platformId,
      ssid,
      balanceType: BalanceType.Demo, // DEMO por padrao — REAL nunca e escolhido automaticamente aqui.
      expirySeconds: 60,
    });
  }

  return new MockBrokerAdapter();
}
