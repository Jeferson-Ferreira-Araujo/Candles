// Coletor de candles históricos (M1, 5s, 1s, etc.) da Polarium Broker via SDK oficial
// da Quadcode. Suporta um ou vários ativos ao mesmo tempo, saindo tudo em um único CSV
// (com coluna active_id para diferenciar).
//
// NÃO é um robô de operações: este script apenas lê candles históricos (fetchCandles) e
// grava CSVs. Nenhum método de abertura de ordens (CALL/PUT, digital options, etc.) é
// chamado em nenhum momento.

import { ClientSdk, SsidAuthMethod } from '@quadcode-tech/client-sdk-js';
import { writeFile, appendFile } from 'node:fs/promises';

// ============================================================================
// ARGUMENTOS DE LINHA DE COMANDO
// ============================================================================
//
// Suporta tanto `--flag valor` quanto `--flag=valor`. Qualquer parâmetro também pode
// vir por variável de ambiente (a flag de linha de comando tem prioridade).
//
//   node collect.js --size=60 --days=30
//   node collect.js --size=5  --days=1
//   node collect.js --size=5  --days=30
//   node collect.js --size=1  --hours=1
//   node collect.js --active=81,76,2298 --size=60 --days=30   (múltiplos ativos, 1 CSV)
//
// NOTA (ambiente deste projeto): em alguns terminais PowerShell, `npm run collect --
// --flag valor` não repassa as flags corretamente para o script. Se isso acontecer,
// prefira as variáveis de ambiente equivalentes (ver README.md).
//
// Use `npm run list-actives` para descobrir o ACTIVE_ID de qualquer par (inclusive OTC).

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const eqIdx = token.indexOf('=');
    if (eqIdx !== -1) {
      args[token.slice(2, eqIdx)] = token.slice(eqIdx + 1);
    } else {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = 'true';
      }
    }
  }
  return args;
}

const CLI = parseArgs(process.argv.slice(2));

// ============================================================================
// CONFIGURAÇÃO
// ============================================================================

// Um ou vários IDs de ativo na Quadcode/Polarium, separados por vírgula.
// 2298 é apenas um valor inicial de exemplo: CONFIRME o(s) ID(s) correto(s) com
// `npm run list-actives` antes de usar para coletas reais (OTC e digital options têm
// IDs próprios).
const ACTIVE_IDS_RAW = CLI.active ?? process.env.POLARIUM_ACTIVE_ID ?? '2298';
const ACTIVE_IDS = String(ACTIVE_IDS_RAW)
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0)
  .map(Number);

// Tamanho do candle em segundos (60 = M1, 5 = M0.083, 1 = tick-candle de 1s).
const CANDLE_SIZE = Number(CLI.size ?? process.env.POLARIUM_CANDLE_SIZE ?? 60);

// Período: em HORAS (para testes curtos, ex. candleSize=1) ou em DIAS (padrão).
// Se --hours/POLARIUM_HOURS for informado, ele tem prioridade sobre --days.
const HOURS_RAW = CLI.hours ?? process.env.POLARIUM_HOURS;
const HOURS = HOURS_RAW !== undefined ? Number(HOURS_RAW) : undefined;
const DAYS = Number(CLI.days ?? process.env.POLARIUM_DAYS ?? 3);

const RANGE_SECONDS = HOURS !== undefined ? HOURS * 60 * 60 : DAYS * 24 * 60 * 60;

// Endpoint WebSocket da Polarium informado pelo usuário.
const WS_URL = 'wss://ws.trade.polariumbroker.com/echo/websocket';

// platformId exigido pela assinatura ClientSdk.create(apiUrl, platformId, authMethod, options?).
// A documentação oficial do SDK (README do repositório quadcode/client-sdk-js) usa o valor
// 82 em todos os exemplos, sem detalhar se esse número é específico da IQ Option ou um valor
// genérico de plataforma. Para um broker white-label como a Polarium, esse número PRECISA
// ser confirmado com o suporte/documentação da própria Polarium ou da Quadcode.
const PLATFORM_ID = Number(process.env.POLARIUM_PLATFORM_ID ?? 82);

// Limite de candles por requisição documentado pelo SDK (RealTimeChartDataLayer).
const MAX_CANDLES_PER_REQUEST = 1000;

// Tamanho de cada bloco de busca/gravação (em segundos). Buscar e gravar em blocos
// (em vez de tudo de uma vez) evita acumular centenas de milhares de candles em
// memória e permite mostrar progresso durante coletas longas (ex. 30 dias de 5s).
// Para períodos menores que um bloco, usa-se um único bloco (sem fragmentação artificial).
const CHUNK_SECONDS = Math.min(24 * 60 * 60, RANGE_SECONDS);

function sizeLabel(size) {
  if (size === 60) return 'M1';
  if (size > 0 && size % 60 === 0) return `M${size / 60}`;
  return `${size}s`;
}

function defaultOutputFile(size) {
  if (size === 60) return 'candles.csv';
  if (size > 0 && size % 60 === 0) return `candles_M${size / 60}.csv`;
  return `candles_${size}s.csv`;
}

const OUTPUT_FILE = CLI.out ?? process.env.POLARIUM_OUTPUT_FILE ?? defaultOutputFile(CANDLE_SIZE);
const GAPS_FILE = CLI.gapsOut ?? process.env.POLARIUM_GAPS_FILE ??
  (OUTPUT_FILE.startsWith('candles') ? OUTPUT_FILE.replace(/^candles/, 'gaps') : `gaps_${OUTPUT_FILE}`);

// ============================================================================
// VALIDAÇÃO DE CREDENCIAIS E PARÂMETROS
// ============================================================================

const ssid = process.env.POLARIUM_SSID;

if (!ssid) {
  console.error('POLARIUM_SSID não configurado');
  process.exit(1);
}

if (
  ACTIVE_IDS.length === 0 ||
  ACTIVE_IDS.some((id) => !Number.isFinite(id)) ||
  !Number.isFinite(CANDLE_SIZE) ||
  !Number.isFinite(RANGE_SECONDS) ||
  CANDLE_SIZE <= 0 ||
  RANGE_SECONDS <= 0
) {
  console.error('Parâmetros inválidos: verifique --active (um ou vários IDs separados por vírgula), --size e --days/--hours.');
  process.exit(1);
}

// ============================================================================
// VALIDAÇÃO DE UM CANDLE (OHLC nunca undefined/null/NaN)
// ============================================================================

function isValidCandle(c) {
  return (
    c &&
    Number.isFinite(c.from) &&
    Number.isFinite(c.open) &&
    Number.isFinite(c.max) &&
    Number.isFinite(c.min) &&
    Number.isFinite(c.close)
  );
}

// ============================================================================
// BUSCA DE UM BLOCO (paginação para trás dentro de [chunkStart, chunkEnd])
// ============================================================================

async function fetchChunk(chartLayer, chunkStart, chunkEnd, maxIterations) {
  const candlesByFrom = new Map();
  let to = chunkEnd;
  let iterations = 0;
  let invalidDiscarded = 0;

  while (iterations < maxIterations) {
    iterations++;

    let batch;
    try {
      batch = await chartLayer.fetchCandles(to, MAX_CANDLES_PER_REQUEST);
    } catch (err) {
      console.error(`    Erro ao buscar candles (iteração ${iterations}): ${err && err.message ? err.message : err}`);
      break;
    }

    if (!batch || batch.length === 0) break;

    const sizeBefore = candlesByFrom.size;
    let oldestInBatch = Infinity;
    for (const candle of batch) {
      if (!isValidCandle(candle)) {
        invalidDiscarded++;
        continue;
      }
      if (candle.from < chunkStart) continue; // fora do bloco atual
      candlesByFrom.set(candle.from, candle);
      if (candle.from < oldestInBatch) oldestInBatch = candle.from;
    }
    const newCount = candlesByFrom.size - sizeBefore;

    if (oldestInBatch === Infinity || oldestInBatch >= to) break; // sem progresso
    if (newCount === 0 && oldestInBatch <= chunkStart) break;

    if (oldestInBatch <= chunkStart) break; // cobriu o bloco inteiro

    to = oldestInBatch - 1;
  }

  return { candlesByFrom, invalidDiscarded };
}

// ============================================================================
// COLETA DE UM ÚNICO ATIVO (reusa a mesma conexão sdk já autenticada)
// ============================================================================

async function collectOneAsset(sdk, activeId, start, now) {
  const stats = {
    activeId,
    totalReceivedRaw: 0,
    totalUnique: 0,
    totalInvalidDiscarded: 0,
    totalGaps: 0,
    maxGapSeconds: 0,
    firstCandleFrom: null,
    lastCandleFrom: null,
    candleSizeConfirmedByServer: false,
  };

  let chartLayer;
  try {
    chartLayer = await sdk.realTimeChartDataLayer(activeId, CANDLE_SIZE);
  } catch (err) {
    console.error(`  Erro ao abrir o chart layer para activeId=${activeId}, candleSize=${CANDLE_SIZE}: ${err && err.message ? err.message : err}`);
    console.error(`  A Polarium/Quadcode pode não suportar candleSize=${CANDLE_SIZE} historicamente para este ativo.`);
    return stats;
  }

  let previousFrom = null;
  const totalChunks = Math.ceil((now - start) / CHUNK_SECONDS);

  for (let i = 0; i < totalChunks; i++) {
    const chunkStart = start + i * CHUNK_SECONDS;
    const chunkEnd = Math.min(start + (i + 1) * CHUNK_SECONDS - 1, now);
    const chunkCandlesExpected = Math.ceil((chunkEnd - chunkStart + 1) / CANDLE_SIZE);
    const maxIterations = Math.ceil(chunkCandlesExpected / MAX_CANDLES_PER_REQUEST) + 3;

    const label = new Date(chunkStart * 1000).toISOString().slice(0, 10);
    process.stdout.write(`  Buscando bloco ${i + 1}/${totalChunks} (${label})... `);

    const { candlesByFrom, invalidDiscarded } = await fetchChunk(chartLayer, chunkStart, chunkEnd, maxIterations);
    stats.totalInvalidDiscarded += invalidDiscarded;

    if (candlesByFrom.size > 0) stats.candleSizeConfirmedByServer = true;

    const chunkCandles = Array.from(candlesByFrom.values()).sort((a, b) => a.from - b.from);

    console.log(`${chunkCandles.length} candles`);

    if (chunkCandles.length === 0) continue;

    stats.totalReceivedRaw += chunkCandles.length;

    // Gap contra o último candle do bloco anterior.
    if (previousFrom !== null) {
      const diff = chunkCandles[0].from - previousFrom;
      if (diff > CANDLE_SIZE) {
        stats.totalGaps++;
        if (diff > stats.maxGapSeconds) stats.maxGapSeconds = diff;
        await appendFile(GAPS_FILE, `${activeId},${previousFrom},${chunkCandles[0].from},${diff},${Math.round(diff / CANDLE_SIZE) - 1}\n`, 'utf8');
      }
    }

    // Gaps dentro do bloco + montagem das linhas do CSV.
    const rows = [];
    for (let j = 0; j < chunkCandles.length; j++) {
      const c = chunkCandles[j];
      if (j > 0) {
        const diff = c.from - chunkCandles[j - 1].from;
        if (diff > CANDLE_SIZE) {
          stats.totalGaps++;
          if (diff > stats.maxGapSeconds) stats.maxGapSeconds = diff;
          await appendFile(GAPS_FILE, `${activeId},${chunkCandles[j - 1].from},${c.from},${diff},${Math.round(diff / CANDLE_SIZE) - 1}\n`, 'utf8');
        }
      }
      const date = new Date(c.from * 1000).toISOString();
      rows.push(`${activeId},${c.from},${date},${c.open},${c.max},${c.min},${c.close}`);
    }

    await appendFile(OUTPUT_FILE, rows.join('\n') + '\n', 'utf8');

    stats.totalUnique += chunkCandles.length;
    if (stats.firstCandleFrom === null) stats.firstCandleFrom = chunkCandles[0].from;
    stats.lastCandleFrom = chunkCandles[chunkCandles.length - 1].from;
    previousFrom = stats.lastCandleFrom;
  }

  if (!stats.candleSizeConfirmedByServer) {
    console.error(`  ATENÇÃO: nenhum candle foi retornado para activeId=${activeId}, candleSize=${CANDLE_SIZE}.`);
    console.error('  Isso pode significar que a Polarium/Quadcode não disponibiliza histórico');
    console.error('  nessa granularidade para este ativo, ou que o período pedido não tem dados');
    console.error('  (ativo fechado, ID errado, etc). Nenhum dado foi inventado.');
  }

  return stats;
}

// ============================================================================
// COLETA PRINCIPAL
// ============================================================================

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const start = now - RANGE_SECONDS;
  const expectedCandlesPerAsset = Math.round(RANGE_SECONDS / CANDLE_SIZE);

  let sdk;

  try {
    sdk = await ClientSdk.create(WS_URL, PLATFORM_ID, new SsidAuthMethod(ssid));
  } catch (err) {
    console.error('Falha ao autenticar/conectar no SDK oficial da Quadcode.');
    console.error(`Erro: ${err && err.message ? err.message : err}`);
    console.error('');
    console.error('Isso pode indicar incompatibilidade entre o endpoint white-label da');
    console.error('Polarium e o método de autenticação do SDK. Verifique/confirme:');
    console.error('  - se o WS_URL está correto para a Polarium:');
    console.error(`      ${WS_URL}`);
    console.error('  - se PLATFORM_ID (atualmente ' + PLATFORM_ID + ') é o valor correto');
    console.error('    para a Polarium (não documentado publicamente; confirmar com suporte);');
    console.error('  - se o SSID em POLARIUM_SSID ainda é válido (sessão não expirada);');
    console.error('  - se a conta possui alguma restrição de acesso via API/WebSocket.');
    console.error('Nenhuma tentativa de contornar autenticação/segurança foi feita.');
    process.exit(1);
  }

  await writeFile(OUTPUT_FILE, 'active_id,timestamp,date,open,high,low,close\n', 'utf8');
  await writeFile(GAPS_FILE, 'active_id,previous_timestamp,current_timestamp,gap_seconds,missing_candles_estimate\n', 'utf8');

  const allStats = [];

  try {
    console.log(`Coletando ${sizeLabel(CANDLE_SIZE)} (${CANDLE_SIZE}s) para ${ACTIVE_IDS.length} ativo(s): ${ACTIVE_IDS.join(', ')}`);
    console.log('');

    for (const activeId of ACTIVE_IDS) {
      console.log(`--- Ativo ${activeId} ---`);
      const stats = await collectOneAsset(sdk, activeId, start, now);
      allStats.push(stats);
      console.log('');
    }
  } finally {
    await sdk.shutdown();
  }

  const grandTotalUnique = allStats.reduce((sum, s) => sum + s.totalUnique, 0);

  if (grandTotalUnique === 0) {
    console.error('Nenhum candle válido foi coletado para nenhum ativo. Encerrando.');
    process.exit(1);
  }

  // ==========================================================================
  // RESUMO
  // ==========================================================================

  console.log('=== COLETA CONCLUÍDA ===');
  console.log('');
  console.log(`Candle size: ${sizeLabel(CANDLE_SIZE)} (${CANDLE_SIZE}s)`);
  console.log(`Período: ${HOURS !== undefined ? `${HOURS} hora(s)` : `${DAYS} dia(s)`}`);
  console.log(`Data inicial: ${new Date(start * 1000).toISOString()}`);
  console.log(`Data final: ${new Date(now * 1000).toISOString()}`);
  console.log('');

  for (const s of allStats) {
    console.log(`Ativo: ${s.activeId}`);
    if (s.totalUnique === 0) {
      console.log('  Nenhum candle coletado.');
      console.log('');
      continue;
    }
    console.log(`  Primeiro candle: ${new Date(s.firstCandleFrom * 1000).toISOString()}`);
    console.log(`  Último candle: ${new Date(s.lastCandleFrom * 1000).toISOString()}`);
    console.log(`  Candles recebidos: ${s.totalReceivedRaw}`);
    console.log(`  Candles esperados aprox.: ${expectedCandlesPerAsset}`);
    console.log(`  Candles únicos gravados: ${s.totalUnique}`);
    if (s.totalInvalidDiscarded > 0) {
      console.log(`  Candles inválidos descartados (OHLC ausente): ${s.totalInvalidDiscarded}`);
    }
    console.log(`  Gaps encontrados: ${s.totalGaps}`);
    console.log(`  Maior gap: ${s.maxGapSeconds} segundos`);
    console.log('');
  }

  console.log(`Total geral de candles únicos gravados: ${grandTotalUnique}`);
  console.log('');
  console.log('Arquivos:');
  console.log(OUTPUT_FILE);
  console.log(GAPS_FILE);
  console.log('');
  console.log('Histórico de ticks/quotes (bid/ask):');
  console.log('NÃO DISPONÍVEL PELO MÉTODO ENCONTRADO — o SDK só expõe cotação atual em');
  console.log('tempo real (sdk.quotes().getCurrentQuoteForActive), sem histórico de ticks.');
  console.log('O objeto Candle também não traz bid/ask, então nada foi estimado ou incluído.');
}

main().catch(async (err) => {
  console.error('Erro inesperado durante a coleta:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
