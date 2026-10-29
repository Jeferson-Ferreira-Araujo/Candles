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

function sameProgress(a: StrategyProgress | null, b: StrategyProgress | null): boolean {
  if (a === null || b === null) return a === b;
  return a.stage === b.stage && a.totalStages === b.totalStages && a.readyNow === b.readyNow && a.direction === b.direction;
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
        this.enqueue(entry.activeId);
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
  }

  /** So MARCA o ativo como "precisa checar" — se ja estiver rodando uma checagem dele agora,
   * essa marca so faz ele rodar de novo (com dado fresco) assim que a atual terminar, nunca em
   * paralelo com ela. */
  private enqueue(activeId: number): void {
    this.pendingAssets.add(activeId);
    this.pump();
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
      const progress = detectStrategyProgress(candles, strategy);
      const last = this.lastProgress.get(key);
      const isFirstCheck = !this.lastProgress.has(key);

      if (isFirstCheck || !sameProgress(progress, last ?? null)) {
        this.lastProgress.set(key, progress);
        this.onSignal({ activeId, assetName: entry.assetName, strategyId: entry.strategyId, strategyName: entry.strategyName, progress });
      }
    }
  }
}
