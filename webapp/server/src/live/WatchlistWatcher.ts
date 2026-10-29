import { CANDLE_SIZE_M1, defaultClassicStrategyConfig, type ClassicStrategyId, type Direction } from '@polarium12c/shared';
import type { BrokerAdapter } from '../broker/BrokerAdapter.js';
import { detectStrategyProgress, fetchClosedCandles, type StrategyProgress } from '../strategies/classicStrategies.js';

export interface WatchlistEntry {
  activeId: number;
  assetName: string;
  strategyId: ClassicStrategyId;
  strategyName: string;
}

export interface WatchlistSignalPayload {
  activeId: number;
  assetName: string;
  strategyId: ClassicStrategyId;
  strategyName: string;
  /** null = nada em andamento pra este par agora (nem parcial) — o cliente tira da lista. */
  progress: StrategyProgress | null;
}

const DAYS = 1; // mesmo periodo curto da varredura que tipicamente origina a lista de pares vigiados
// Velas M1 de ativos diferentes fecham todas perto do mesmo segundo (topo do minuto) — mesmo
// com poucos pares vigiados, uma fila com concorrencia limitada evita rajadas na corretora.
const CONCURRENCY = 5;
// Folga antes de reconsultar o historico depois de um fechamento de vela — da tempo da
// corretora indexar a vela que acabou de fechar na API de historico antes de perguntarmos por
// ela de novo (ver enqueueAfterCandleClose).
const CANDLE_CLOSE_SETTLE_DELAY_MS = 2000;

function sameProgress(a: StrategyProgress | null, b: StrategyProgress | null): boolean {
  if (a === null || b === null) return a === b;
  // setupCandleTimes PRECISA entrar na comparacao: uma estrategia pode continuar "pronta" (mesmo
  // stage/totalStages/direction) minuto apos minuto enquanto o preco segue na mesma direcao, mas
  // cada minuto e um setup DIFERENTE (velas diferentes contadas). Sem comparar os horarios, o
  // evento nunca era reemitido (nada "mudava" aos olhos do sameProgress antigo) e o cliente ficava
  // preso exibindo o aviso de "pronta pra entrar" da PRIMEIRA vez pra sempre — so o contador
  // regressivo (que e so relogio de parede, sem relacao com o servidor) continuava parecendo
  // "vivo", dando a falsa impressao de um sinal novo mesmo depois de ja ter sido usado.
  if (a.setupCandleTimes.length !== b.setupCandleTimes.length) return false;
  for (let i = 0; i < a.setupCandleTimes.length; i++) {
    if (a.setupCandleTimes[i] !== b.setupCandleTimes[i]) return false;
  }
  return a.stage === b.stage && a.totalStages === b.totalStages && a.readyNow === b.readyNow && a.direction === b.direction;
}

// So aparece na lista quando faltam no MAXIMO 2 confirmacoes pra completar (incluindo a que
// fica pronta) — decisao explicita do usuario: a 1a confirmacao sozinha "sempre parece que vai
// comecar uma coisa" e e ruido demais numa estrategia de 5 estagios, por exemplo so entra na
// lista a partir da 3a (5-2); ja uma de 2 estagios mostra desde a 1a, porque 2-2=0 ja cobre
// tudo. O GRAFICO aberto continua mostrando TODAS as velas contadas, desde a 1a — esse limite e
// so pra essa lista de vigilancia, que precisa ser "bem certeira", nao pro grafico em si.
const MAX_REMAINING_STAGES_TO_SHOW = 2;

// Pedido explicito: pra "Tres Candles de Impulso" (3_soldiers), a 1a confirmacao sozinha ainda e
// comum demais (qualquer vela isolada pode comecar um trio) — so deve aparecer na lista quando a
// 2a confirmacao JA estiver formada, i.e. enquanto a 3a (a de entrada) esta se formando. As demais
// estrategias seguem a regra geral (remaining <= 2, ver isVisibleInWatchlist).
const STRATEGY_MIN_CONFIRMED_STAGE: Partial<Record<ClassicStrategyId, number>> = {
  three_soldiers: 2,
};

function isVisibleInWatchlist(progress: StrategyProgress | null, strategyId: ClassicStrategyId): progress is StrategyProgress {
  if (progress === null) return false;
  const minConfirmedStage = STRATEGY_MIN_CONFIRMED_STAGE[strategyId] ?? progress.totalStages - MAX_REMAINING_STAGES_TO_SHOW;
  return progress.stage >= minConfirmedStage;
}

/**
 * Fica de olho, em segundo plano, num punhado de pares ATIVO+ESTRATEGIA especificos (hoje: os
 * do ranking da ultima verificacao, ver POST /api/watchlist) — assina as velas ao vivo de cada
 * ATIVO envolvido (uma assinatura por ativo, mesmo que ele apareca com 2+ estrategias) e, toda
 * vez que uma vela fecha, roda `detectStrategyProgress` (mesma logica do aviso "ENTRADA AGORA"
 * da tela do grafico, so que expondo tambem o progresso PARCIAL — ex.: "2 de 3 velas do setup
 * ja em pe") SO para a(s) estrategia(s) registrada(s) daquele ativo — nao todas as 11, ja que o
 * pedido e "esse mesmo cenario do ranking esta se repetindo?", nao uma varredura geral.
 *
 * Emite um snapshot inicial assim que `setEntries` troca a lista (pra tela nunca ficar vazia
 * esperando o proximo fechamento de vela) e, dali em diante, so quando o progresso de um par
 * MUDA — pra nao inundar o cliente de eventos repetidos a cada fechamento de vela.
 */
export class WatchlistWatcher {
  private readonly unsubscribers = new Map<number, () => void>();
  private readonly entriesByAsset = new Map<number, WatchlistEntry[]>();
  private readonly lastProgress = new Map<string, StrategyProgress | null>();
  // Fila SERIALIZADA por ativo: nunca roda 2 checkAsset(mesmoAtivo) em paralelo. Sem isso, um
  // fechamento de vela podia enfileirar outra checagem do mesmo ativo enquanto a anterior ainda
  // buscava historico na corretora — se a mais NOVA terminasse primeiro (rede mais rapida) e a
  // mais VELHA (com dado desatualizado) terminasse depois, ela sobrescrevia o progresso real com
  // um estagio mais antigo (ex.: a lista voltava de "2a confirmacao" pra "1a confirmacao" sozinha).
  private readonly pendingAssets = new Set<number>();
  private readonly inFlightAssets = new Set<number>();
  private readonly pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly broker: BrokerAdapter,
    private readonly onSignal: (payload: WatchlistSignalPayload) => void
  ) {}

  /** Troca a lista inteira de pares vigiados (cancela as assinaturas antigas, assina as novas,
   * e ja roda uma checagem inicial de cada ativo pra popular a tela na hora). Agrupa por
   * ativo — se o mesmo ativo aparecer com 2+ estrategias, assina so UMA vez. */
  async setEntries(entries: WatchlistEntry[]): Promise<void> {
    await this.stop();
    for (const entry of entries) {
      const list = this.entriesByAsset.get(entry.activeId);
      if (list) {
        list.push(entry);
        continue; // ja existe assinatura de vela pra este ativo
      }
      this.entriesByAsset.set(entry.activeId, [entry]);
      const unsubscribe = await this.broker.subscribeCandles(entry.activeId, CANDLE_SIZE_M1, (candle) => {
        if (!candle.isClosed) return;
        this.enqueueAfterCandleClose(entry.activeId);
      });
      this.unsubscribers.set(entry.activeId, unsubscribe);
    }
    for (const activeId of this.entriesByAsset.keys()) this.enqueue(activeId);
  }

  async stop(): Promise<void> {
    for (const unsubscribe of this.unsubscribers.values()) {
      try {
        unsubscribe();
      } catch (err) {
        console.error('[watchlist] falha ao cancelar assinatura (ignorada):', err);
      }
    }
    this.unsubscribers.clear();
    this.entriesByAsset.clear();
    this.lastProgress.clear();
    this.pendingAssets.clear();
    this.inFlightAssets.clear();
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
  }

  /** So MARCA o ativo como "precisa checar" — se ja estiver rodando uma checagem dele agora,
   * essa marca so faz ele rodar de novo (com dado fresco) assim que a atual terminar, nunca em
   * paralelo com ela. */
  private enqueue(activeId: number): void {
    this.pendingAssets.add(activeId);
    this.pump();
  }

  /** Mesma coisa que `enqueue`, mas com uma folga antes de checar — a corretora leva um
   * instante pra disponibilizar a vela que ACABOU de fechar na API de historico (confirmado:
   * sem essa folga, a vigilancia ficava sistematicamente 1 vela atrasada em relacao ao que o
   * proprio grafico aberto, que reage ao mesmo fechamento por outro caminho, ja mostrava). */
  private enqueueAfterCandleClose(activeId: number): void {
    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer);
      this.enqueue(activeId);
    }, CANDLE_CLOSE_SETTLE_DELAY_MS);
    this.pendingTimers.add(timer);
  }

  private pump(): void {
    if (this.inFlightAssets.size >= CONCURRENCY) return;
    for (const activeId of this.pendingAssets) {
      if (this.inFlightAssets.size >= CONCURRENCY) break;
      if (this.inFlightAssets.has(activeId)) continue; // ja rodando — a marca em pendingAssets garante outra rodada depois
      this.pendingAssets.delete(activeId);
      this.inFlightAssets.add(activeId);
      this.checkAsset(activeId)
        .catch((err) => console.error('[watchlist] falha ao checar ativo', activeId, err instanceof Error ? err.message : err))
        .finally(() => {
          this.inFlightAssets.delete(activeId);
          this.pump();
        });
    }
  }

  private async checkAsset(activeId: number): Promise<void> {
    const entries = this.entriesByAsset.get(activeId);
    if (!entries || entries.length === 0) return; // foi removido da lista entre a assinatura e este fechamento
    const candles = await fetchClosedCandles(this.broker, activeId, DAYS);

    for (const entry of entries) {
      const key = `${activeId}:${entry.strategyId}`;
      const strategy = defaultClassicStrategyConfig(entry.strategyId);
      const rawProgress = detectStrategyProgress(candles, strategy);
      // Abaixo do limiar de visibilidade conta como "nada" PRA ESSA LISTA — fica so no detector
      // de verdade (chart) e no `lastProgress` interno, nunca chega a avisar o cliente.
      const progress = isVisibleInWatchlist(rawProgress, entry.strategyId) ? rawProgress : null;
      const last = this.lastProgress.get(key);
      const isFirstCheck = !this.lastProgress.has(key);

      if (isFirstCheck || !sameProgress(progress, last ?? null)) {
        this.lastProgress.set(key, progress);
        this.onSignal({ activeId, assetName: entry.assetName, strategyId: entry.strategyId, strategyName: entry.strategyName, progress });
      }
    }
  }
}
