// Lista ativos disponíveis (binary options e digital options, incluindo OTC) com seus
// respectivos ACTIVE_ID, para você descobrir qual valor usar em `collect.js`.
//
// Este script é somente leitura: não abre operações, não envia ordens.

import { ClientSdk, SsidAuthMethod } from '@quadcode-tech/client-sdk-js';

const WS_URL = 'wss://ws.trade.polariumbroker.com/echo/websocket';
const PLATFORM_ID = Number(process.env.POLARIUM_PLATFORM_ID ?? 82);

const ssid = process.env.POLARIUM_SSID;

if (!ssid) {
  console.error('POLARIUM_SSID não configurado');
  process.exit(1);
}

function filterArg() {
  const idx = process.argv.indexOf('--filter');
  if (idx === -1) return null;
  return (process.argv[idx + 1] ?? '').toLowerCase();
}

async function main() {
  const filter = filterArg();
  const sdk = await ClientSdk.create(WS_URL, PLATFORM_ID, new SsidAuthMethod(ssid));

  try {
    console.log('=== Binary Options ===');
    const binary = await sdk.binaryOptions();
    const binaryActives = binary
      .getActives()
      .map((a) => ({ id: a.id, ticker: a.ticker }))
      .filter((a) => !filter || a.ticker.toLowerCase().includes(filter))
      .sort((a, b) => a.ticker.localeCompare(b.ticker));

    for (const a of binaryActives) {
      console.log(`${a.id}\t${a.ticker}`);
    }

    console.log('');
    console.log('=== Digital Options (underlyings disponíveis agora) ===');
    const digital = await sdk.digitalOptions();
    const digitalUnderlyings = digital
      .getUnderlyingsAvailableForTradingAt(new Date())
      .map((u) => ({ id: u.activeId, name: u.name, suspended: u.isSuspended }))
      .filter((u) => !filter || u.name.toLowerCase().includes(filter))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const u of digitalUnderlyings) {
      console.log(`${u.id}\t${u.name}${u.suspended ? '\t(suspenso agora)' : ''}`);
    }

    console.log('');
    console.log('Use o valor da coluna ID como POLARIUM_ACTIVE_ID / --active no collect.js.');
  } finally {
    await sdk.shutdown();
  }
}

main().catch((err) => {
  console.error('Erro ao listar ativos:', err && err.message ? err.message : err);
  process.exit(1);
});
