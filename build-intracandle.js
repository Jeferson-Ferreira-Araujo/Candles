// Gera m1_intracandle.csv a partir de um CSV de candles de 5 segundos já coletado
// (candles_5s.csv, gerado por `collect.js --size=5`).
//
// Este script NÃO acessa a rede nem o SDK da Quadcode — só lê o CSV local e calcula
// estatísticas. Não implementa estratégia, sinal de CALL/PUT, indicador nem execução de
// ordens: apenas monta o dataset intravela para análise posterior.
//
// IMPORTANTE (anti data-leakage): as colunas next_m1_* são o TARGET (o que aconteceu na
// M1 seguinte) e nunca são usadas para calcular as features da própria M1 atual.

import { readFile, writeFile } from 'node:fs/promises';

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

const INPUT_FILE = CLI.in ?? 'candles_5s.csv';
const OUTPUT_FILE = CLI.out ?? 'm1_intracandle.csv';

// Os 12 sub-candles de 5s dentro de cada minuto: segundo inicial de cada slot.
const SLOTS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

function slotField(sec) {
  return `s${String(sec).padStart(2, '0')}`;
}

// ============================================================================
// LEITURA DO CSV DE 5 SEGUNDOS
// ============================================================================

async function readCandles5s(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    console.error(`Não foi possível ler ${path}: ${err && err.message ? err.message : err}`);
    console.error('Gere esse arquivo antes com: node collect.js --size=5 --days=1 (ou --days=30)');
    process.exit(1);
  }

  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const header = lines[0];
  if (!header || !header.startsWith('active_id,timestamp,date,open,high,low,close')) {
    console.error(`Formato inesperado em ${path}. Esperado header: active_id,timestamp,date,open,high,low,close`);
    process.exit(1);
  }

  const candles = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length < 7) continue;
    const activeId = Number(parts[0]);
    const from = Number(parts[1]);
    const open = Number(parts[3]);
    const high = Number(parts[4]);
    const low = Number(parts[5]);
    const close = Number(parts[6]);
    if (![activeId, from, open, high, low, close].every(Number.isFinite)) continue;
    candles.push({ activeId, from, open, high, low, close });
  }

  candles.sort((a, b) => (a.activeId - b.activeId) || (a.from - b.from));
  return candles;
}

// ============================================================================
// AGRUPAMENTO POR MINUTO M1
// ============================================================================

function groupByMinute(candles5s) {
  // Agrupa por (activeId, minuto) — minutos de ativos diferentes NUNCA se misturam.
  const minutes = new Map(); // `${activeId}_${m1Timestamp}` -> { activeId, m1Timestamp, slots: Map(sec->candle) }

  for (const c of candles5s) {
    const m1Timestamp = c.from - (c.from % 60);
    const secInMinute = c.from % 60;
    if (!SLOTS.includes(secInMinute)) continue; // candle não alinhado a um slot de 5s esperado

    const key = `${c.activeId}_${m1Timestamp}`;
    if (!minutes.has(key)) {
      minutes.set(key, { activeId: c.activeId, m1Timestamp, slots: new Map() });
    }
    minutes.get(key).slots.set(secInMinute, c);
  }

  return Array.from(minutes.values()).sort((a, b) => (a.activeId - b.activeId) || (a.m1Timestamp - b.m1Timestamp));
}

// ============================================================================
// DERIVAÇÃO DE FEATURES DE UM MINUTO (usa somente dados do próprio minuto)
// ============================================================================

function direction(open, close) {
  if (!Number.isFinite(open) || !Number.isFinite(close)) return '';
  if (close > open) return 'UP';
  if (close < open) return 'DOWN';
  return 'FLAT';
}

function rangeOf(slots, secs) {
  let high = -Infinity;
  let low = Infinity;
  let any = false;
  for (const s of secs) {
    const c = slots.get(s);
    if (!c) continue;
    any = true;
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
  }
  return any ? high - low : '';
}

function returnOverWindow(slots, startSec, endSecExclusive) {
  const openSlot = slots.get(startSec);
  const closeSlotSec = endSecExclusive - 5;
  const closeSlot = slots.get(closeSlotSec);
  if (!openSlot || !closeSlot || openSlot.open === 0 || !Number.isFinite(openSlot.open)) return '';
  return (closeSlot.close - openSlot.open) / openSlot.open;
}

function dirFromReturn(ret) {
  if (ret === '' || !Number.isFinite(ret)) return '';
  if (ret > 0) return 'UP';
  if (ret < 0) return 'DOWN';
  return 'FLAT';
}

function buildMinuteRow(minute) {
  const { activeId, m1Timestamp, slots } = minute;
  const subcandlesCount = slots.size;

  const row = {
    active_id: activeId,
    m1_timestamp: m1Timestamp,
    m1_date: new Date(m1Timestamp * 1000).toISOString(),
  };

  // Colunas s00_open..s55_close (vazias quando o slot não existe).
  for (const sec of SLOTS) {
    const c = slots.get(sec);
    const f = slotField(sec);
    row[`${f}_open`] = c ? c.open : '';
    row[`${f}_high`] = c ? c.high : '';
    row[`${f}_low`] = c ? c.low : '';
    row[`${f}_close`] = c ? c.close : '';
  }

  row.subcandles_count = subcandlesCount;

  // OHLC agregado do M1, derivado dos sub-candles de 5s presentes (não busca outra API).
  const presentSlots = SLOTS.map((s) => slots.get(s)).filter(Boolean);
  const m1Open = presentSlots.length > 0 ? presentSlots[0].open : null;
  const m1Close = presentSlots.length > 0 ? presentSlots[presentSlots.length - 1].close : null;
  const m1High = presentSlots.length > 0 ? Math.max(...presentSlots.map((c) => c.high)) : null;
  const m1Low = presentSlots.length > 0 ? Math.min(...presentSlots.map((c) => c.low)) : null;

  // Features de retorno em janelas.
  row.first_30s_return = returnOverWindow(slots, 0, 30);
  row.last_30s_return = returnOverWindow(slots, 30, 60);
  row.first_15s_return = returnOverWindow(slots, 0, 15);
  row.last_15s_return = returnOverWindow(slots, 45, 60);
  row.last_10s_return = returnOverWindow(slots, 50, 60);

  row.range_first_30s = rangeOf(slots, [0, 5, 10, 15, 20, 25]);
  row.range_last_30s = rangeOf(slots, [30, 35, 40, 45, 50, 55]);
  row.range_first_15s = rangeOf(slots, [0, 5, 10]);
  row.range_last_15s = rangeOf(slots, [45, 50, 55]);

  // Contagem de cor dos sub-candles de 5s presentes.
  let green = 0;
  let red = 0;
  let doji = 0;
  for (const c of presentSlots) {
    if (c.close > c.open) green++;
    else if (c.close < c.open) red++;
    else doji++;
  }
  row.green_5s_count = green;
  row.red_5s_count = red;
  row.doji_5s_count = doji;

  // Direção dos últimos 3 sub-candles de 5s disponíveis, em ordem cronológica (ex.: "UP|DOWN|UP").
  // Usa "|" (não vírgula) como separador interno para não quebrar o parsing do CSV.
  const lastThree = presentSlots.slice(-3);
  row.last_3_direction = lastThree.map((c) => direction(c.open, c.close)).join('|');

  // Momento (segundo) do maior high / menor low do minuto.
  if (presentSlots.length > 0 && Number.isFinite(m1High) && Number.isFinite(m1Low)) {
    let highTime = null;
    let lowTime = null;
    for (const sec of SLOTS) {
      const c = slots.get(sec);
      if (!c) continue;
      if (highTime === null && c.high === m1High) highTime = sec;
      if (lowTime === null && c.low === m1Low) lowTime = sec;
    }
    row.high_time = highTime;
    row.low_time = lowTime;
  } else {
    row.high_time = '';
    row.low_time = '';
  }

  // close_position = (close - low) / (high - low), só quando high != low.
  if (Number.isFinite(m1High) && Number.isFinite(m1Low) && Number.isFinite(m1Close) && m1High !== m1Low) {
    row.close_position = (m1Close - m1Low) / (m1High - m1Low);
  } else {
    row.close_position = '';
  }

  // Aceleração final: return_00_30, return_30_45, return_45_55.
  const return_00_30 = returnOverWindow(slots, 0, 30);
  const return_30_45 = returnOverWindow(slots, 30, 45);
  const return_45_55 = returnOverWindow(slots, 45, 55);
  row.return_00_30 = return_00_30;
  row.return_30_45 = return_30_45;
  row.return_45_55 = return_45_55;

  const previousReturns = [return_00_30, return_30_45].filter((r) => r !== '' && Number.isFinite(r)).map(Math.abs);
  const meanPrevious = previousReturns.length > 0 ? previousReturns.reduce((a, b) => a + b, 0) / previousReturns.length : 0;
  if (meanPrevious === 0 || return_45_55 === '' || !Number.isFinite(return_45_55)) {
    row.acceleration = '';
  } else {
    row.acceleration = Math.abs(return_45_55) / meanPrevious;
  }

  row.last_5s_direction = presentSlots.length > 0 ? direction(presentSlots[presentSlots.length - 1].open, presentSlots[presentSlots.length - 1].close) : '';
  row.last_10s_direction = dirFromReturn(row.last_10s_return);
  row.last_15s_direction = dirFromReturn(row.last_15s_return);
  row.last_30s_direction = dirFromReturn(row.last_30s_return);

  // Guarda valores agregados do próprio M1 para uso como target da M1 anterior (não como feature própria).
  row._m1Open = m1Open;
  row._m1Close = m1Close;
  row._isComplete = subcandlesCount === 12;

  return row;
}

// ============================================================================
// TARGET: next_m1_open / next_m1_close / next_m1_direction (sem vazar dados futuros
// nas features da própria linha — usado só como coluna de target).
// ============================================================================

function attachNextM1Target(rows) {
  for (let i = 0; i < rows.length; i++) {
    const next = rows[i + 1];
    const sameAsset = next && next.active_id === rows[i].active_id;
    const isContiguous = sameAsset && next.m1_timestamp - rows[i].m1_timestamp === 60;

    if (next && isContiguous && next._m1Open !== null && next._m1Close !== null) {
      rows[i].next_m1_open = next._m1Open;
      rows[i].next_m1_close = next._m1Close;
      rows[i].next_m1_direction =
        next._m1Close > next._m1Open ? 'CALL' : next._m1Close < next._m1Open ? 'PUT' : 'DOJI';
    } else {
      rows[i].next_m1_open = '';
      rows[i].next_m1_close = '';
      rows[i].next_m1_direction = '';
    }
  }
}

// ============================================================================
// CSV
// ============================================================================

function buildHeader() {
  const cols = ['active_id', 'm1_timestamp', 'm1_date'];
  for (const sec of SLOTS) {
    const f = slotField(sec);
    cols.push(`${f}_open`, `${f}_high`, `${f}_low`, `${f}_close`);
  }
  cols.push(
    'subcandles_count',
    'first_30s_return', 'last_30s_return',
    'first_15s_return', 'last_15s_return',
    'last_10s_return',
    'range_first_30s', 'range_last_30s',
    'range_first_15s', 'range_last_15s',
    'green_5s_count', 'red_5s_count', 'doji_5s_count',
    'last_3_direction',
    'high_time', 'low_time',
    'close_position',
    'return_00_30', 'return_30_45', 'return_45_55',
    'acceleration',
    'last_5s_direction', 'last_10s_direction', 'last_15s_direction', 'last_30s_direction',
    'next_m1_open', 'next_m1_close', 'next_m1_direction'
  );
  return cols;
}

function rowToCsvLine(row, cols) {
  return cols.map((c) => (row[c] === undefined ? '' : row[c])).join(',');
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const candles5s = await readCandles5s(INPUT_FILE);

  if (candles5s.length === 0) {
    console.error(`Nenhum candle válido encontrado em ${INPUT_FILE}.`);
    process.exit(1);
  }

  const minutes = groupByMinute(candles5s);
  const rows = minutes.map(buildMinuteRow);
  attachNextM1Target(rows);

  const cols = buildHeader();
  const lines = [cols.join(','), ...rows.map((r) => rowToCsvLine(r, cols))];
  await writeFile(OUTPUT_FILE, lines.join('\n') + '\n', 'utf8');

  const complete = rows.filter((r) => r._isComplete).length;
  const incomplete = rows.length - complete;

  const byAsset = new Map();
  for (const r of rows) {
    if (!byAsset.has(r.active_id)) byAsset.set(r.active_id, { total: 0, complete: 0 });
    const b = byAsset.get(r.active_id);
    b.total++;
    if (r._isComplete) b.complete++;
  }

  console.log('=== M1 INTRACANDLE GERADO ===');
  console.log('');
  console.log(`Entrada: ${INPUT_FILE} (${candles5s.length} candles de 5s, ${byAsset.size} ativo(s))`);
  console.log(`Minutos M1 reconstruídos: ${rows.length}`);
  console.log(`M1 completos (12/12 sub-candles): ${complete}`);
  console.log(`M1 incompletos: ${incomplete}`);
  console.log('');
  for (const [activeId, b] of byAsset) {
    console.log(`  Ativo ${activeId}: ${b.total} minutos (${b.complete} completos, ${b.total - b.complete} incompletos)`);
  }
  console.log('');
  console.log('Arquivo:');
  console.log(OUTPUT_FILE);
}

main().catch((err) => {
  console.error('Erro inesperado ao gerar m1_intracandle.csv:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
