import { chromium } from 'playwright';

const LOGIN_URL = 'https://trade.polariumbroker.com/en/login';
const NAV_TIMEOUT_MS = 30_000;
const SSID_WAIT_TIMEOUT_MS = 20_000;

/**
 * Faz o login de verdade na tela oficial da Polarium num Chromium headless e intercepta o
 * SSID exatamente como se faria manualmente pelo DevTools: a pagina deles abre uma conexao
 * WebSocket logo apos o login e manda uma mensagem {"name":"authenticate","msg":{"ssid":...}}
 * — e essa mensagem que capturamos aqui, sem nunca persistir a senha do usuario em lugar
 * nenhum (ela so existe na memoria deste processo, pelo tempo do login).
 */
export async function loginWithCredentials(email: string, password: string): Promise<string> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    const ssidPromise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Tempo esgotado esperando a Polarium autenticar a sessao.')), SSID_WAIT_TIMEOUT_MS);

      page.on('websocket', (ws) => {
        const handleFrame = ({ payload }: { payload: string | Buffer }) => {
          if (typeof payload !== 'string') return;
          try {
            const data = JSON.parse(payload) as { name?: string; msg?: { ssid?: string } };
            const ssid = data.name === 'authenticate' ? data.msg?.ssid : undefined;
            if (ssid) {
              clearTimeout(timer);
              resolve(ssid);
            }
          } catch {
            // frame nao-JSON ou sem o formato esperado — ignora
          }
        };
        ws.on('framesent', handleFrame);
        ws.on('framereceived', handleFrame);
      });
    });
    ssidPromise.catch(() => {});

    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="identifier"]', email);
    await page.fill('input[name="password"]', password);
    await page.click('[data-test-id="login-submit-button"]');

    // A Polarium mostra um erro inline (sem navegar) quando a credencial esta errada — corre
    // contra o ssid pra devolver essa mensagem de verdade, em vez de so estourar o timeout.
    const errorPromise = page
      .waitForSelector('[data-test-id="login-error-block"]', { timeout: SSID_WAIT_TIMEOUT_MS })
      .then(async (el) => {
        const text = (await el.textContent())?.trim();
        throw new Error(text || 'Credenciais invalidas.');
      });
    // Evita "unhandled rejection" quando o OUTRO lado da corrida e quem resolve primeiro
    // (ex.: ssid chega antes do elemento de erro sequer aparecer, e o waitForSelector
    // acaba rejeitando sozinho pelo timeout dele, sem mais ninguem ouvindo).
    errorPromise.catch(() => {});

    return await Promise.race([ssidPromise, errorPromise]);
  } finally {
    await browser.close();
  }
}
