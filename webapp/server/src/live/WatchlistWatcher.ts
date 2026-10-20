import { CANDLE_SIZE_M1, defaultClassicStrategyConfig, type ClassicStrategyId, type Direction } from '@polarium12c/shared';
import type { BrokerAdapter } from '../broker/BrokerAdapter.js';
import { detectPendingSignal, fetchClosedCandles } from '../strategies/classicStrategies.js';

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
  /** null = nao tem setup pendente agora (o cliente deve apagar o aviso antigo deste ativo). */
  direction: Direction | null;
}

const DAYS = 1; // mesmo periodo curto da varredura que tipicamente origina a watchlist

/**
 * Fica de olho, em segundo plano, num punhado de ativos (tipicamente os 3 melhores da ultima
 * varredura) — assina as velas ao vivo de cada um e, toda vez que uma fecha, roda
 * detectPendingSignal (mesma logica usada pelo aviso "ENTRADA AGORA" da tela do grafico) pra
 * saber se o setup da estrategia atribuida aquele ativo acabou de se completar. Chama
 * `onSignal` a cada fechamento de vela de um ativo assistido (mesmo quando nao ha sinal — com
 * direction=null — pra o cliente saber apagar um aviso antigo que nao se confirmou).
 */
export class WatchlistWatcher {
  private readonly unsubscribers = new Map<number, () => void>();
  private readonly entries = new Map<number, WatchlistEntry>();

  constructor(
    private readonly broker: BrokerAdapter,
    private readonly onSignal: (payload: WatchlistSignalPayload) => void
  ) {}

  /** Troca a lista inteira (cancela as assinaturas antigas, assina as novas). */
  async setEntries(entries: WatchlistEntry[]): Promise<void> {
    await this.stop();
    for (const entry of entries) {
      this.entries.set(entry.activeId, entry);
      const unsubscribe = await this.broker.subscribeCandles(entry.activeId, CANDLE_SIZE_M1, (candle) => {
        if (!candle.isClosed) return;
        this.checkEntry(entry.activeId).catch((err) =>
          console.error('[watchlist] falha ao checar ativo', entry.activeId, err instanceof Error ? err.message : err)
        );
      });
      this.unsubscribers.set(entry.activeId, unsubscribe);
    }
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
    this.entries.clear();
  }

  private async checkEntry(activeId: number): Promise<void> {
    const entry = this.entries.get(activeId);
    if (!entry) return; // foi removido da lista entre a assinatura e este fechamento
    const candles = await fetchClosedCandles(this.broker, activeId, DAYS);
    const strategy = defaultClassicStrategyConfig(entry.strategyId);
    const pending = detectPendingSignal(candles, strategy);
    this.onSignal({
      activeId: entry.activeId,
      assetName: entry.assetName,
      strategyId: entry.strategyId,
      strategyName: entry.strategyName,
      direction: pending?.direction ?? null,
    });
  }
}
