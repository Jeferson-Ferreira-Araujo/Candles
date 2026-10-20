import { CANDLE_SIZE_M1, CLASSIC_STRATEGIES, defaultClassicStrategyConfig, type ClassicStrategyId, type Direction } from '@polarium12c/shared';
import type { BrokerAdapter } from '../broker/BrokerAdapter.js';
import { detectPendingSignal, fetchClosedCandles } from '../strategies/classicStrategies.js';

export interface WatchlistAsset {
  activeId: number;
  assetName: string;
}

export interface WatchlistSignalPayload {
  activeId: number;
  assetName: string;
  strategyId: ClassicStrategyId;
  strategyName: string;
  /** null = este par ativo+estrategia NAO tem mais setup pendente — o cliente deve apagar o aviso. */
  direction: Direction | null;
}

const DAYS = 1; // mesmo periodo curto da varredura que tipicamente origina a lista de ativos vigiados
// Velas M1 de ativos diferentes fecham todas perto do mesmo segundo (topo do minuto) — sem um
// limite, uma vigilancia de 100+ ativos dispararia 100+ fetchClosedCandles() simultaneos na
// corretora nesse instante. Uma fila com concorrencia limitada espalha essa carga no tempo.
const CONCURRENCY = 5;

/**
 * Fica de olho, em segundo plano, num conjunto de ativos (hoje: TODOS os disponiveis) — assina
 * as velas ao vivo de cada um e, toda vez que uma fecha, roda `detectPendingSignal` (mesma
 * logica usada pelo aviso "ENTRADA AGORA" da tela do grafico) pra TODAS as 10 estrategias
 * classicas contra o MESMO historico ja buscado (um fetch por ativo, nao um por estrategia).
 *
 * So emite evento quando o estado de um par ativo+estrategia MUDA (comecou a ter sinal pendente
 * ou deixou de ter) — ao contrario de reportar os 10 resultados a cada fechamento de vela, o que
 * inundaria o cliente de eventos quase todos "sem sinal" (a grande maioria das combinacoes nao
 * bate a cada minuto). Guarda o ultimo estado conhecido por par em `activeSignals`.
 */
export class WatchlistWatcher {
  private readonly unsubscribers = new Map<number, () => void>();
  private readonly assets = new Map<number, WatchlistAsset>();
  private readonly activeSignals = new Map<string, Direction>();
  private readonly queue: number[] = [];
  private inFlight = 0;

  constructor(
    private readonly broker: BrokerAdapter,
    private readonly onSignal: (payload: WatchlistSignalPayload) => void
  ) {}

  /** Troca a lista inteira de ativos vigiados (cancela as assinaturas antigas, assina as novas). */
  async setAssets(assets: WatchlistAsset[]): Promise<void> {
    await this.stop();
    for (const asset of assets) {
      this.assets.set(asset.activeId, asset);
      const unsubscribe = await this.broker.subscribeCandles(asset.activeId, CANDLE_SIZE_M1, (candle) => {
        if (!candle.isClosed) return;
        this.enqueue(asset.activeId);
      });
      this.unsubscribers.set(asset.activeId, unsubscribe);
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
    this.assets.clear();
    this.activeSignals.clear();
    this.queue.length = 0;
    this.inFlight = 0;
  }

  private enqueue(activeId: number): void {
    this.queue.push(activeId);
    this.pump();
  }

  private pump(): void {
    while (this.inFlight < CONCURRENCY && this.queue.length > 0) {
      const activeId = this.queue.shift()!;
      this.inFlight++;
      this.checkAsset(activeId)
        .catch((err) => console.error('[watchlist] falha ao checar ativo', activeId, err instanceof Error ? err.message : err))
        .finally(() => {
          this.inFlight--;
          this.pump();
        });
    }
  }

  private async checkAsset(activeId: number): Promise<void> {
    const asset = this.assets.get(activeId);
    if (!asset) return; // foi removido da lista entre a assinatura e este fechamento
    const candles = await fetchClosedCandles(this.broker, activeId, DAYS);

    for (const info of CLASSIC_STRATEGIES) {
      const key = `${activeId}:${info.id}`;
      const strategy = defaultClassicStrategyConfig(info.id);
      const pending = detectPendingSignal(candles, strategy);
      const wasActive = this.activeSignals.has(key);

      if (pending) {
        this.activeSignals.set(key, pending.direction);
        this.onSignal({ activeId, assetName: asset.assetName, strategyId: info.id, strategyName: info.name, direction: pending.direction });
      } else if (wasActive) {
        this.activeSignals.delete(key);
        this.onSignal({ activeId, assetName: asset.assetName, strategyId: info.id, strategyName: info.name, direction: null });
      }
    }
  }
}
