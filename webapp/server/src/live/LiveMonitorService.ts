import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Db } from '../db/db.js';
import { CANDLE_SIZE_M1, type AppEvent, type Candle, type PatternProgress } from '@polarium12c/shared';
import type { BrokerAdapter } from '../broker/BrokerAdapter.js';
import { TwelveCandlesEngine } from '../strategy/twelveCandlesEngine.js';
import { insertEvent, saveCandle } from '../db/repositories.js';

/**
 * Liga um BrokerAdapter (real ou mock) ao StrategyEngine em tempo real: assina candles de
 * cada ativo selecionado, alimenta o motor a cada fechamento, persiste candles/eventos, e
 * emite eventos para quem quiser mostrar isso ao vivo (ex.: camada WebSocket).
 *
 * NAO envia nenhuma ordem — isso e responsabilidade de uma camada futura (SafetyGate +
 * OrderService) que vai OUVIR o evento PATTERN_CONFIRMED emitido aqui, nunca do proprio
 * monitor.
 */
export class LiveMonitorService extends EventEmitter {
  private readonly engine = new TwelveCandlesEngine();
  private unsubscribers: Array<() => void> = [];
  private started = false;
  // Uma fila (Promise encadeada) por ativo: com Postgres real, salvar cada candle envolve
  // I/O de rede com latencia variavel — sem serializar por ativo, dois handleCandle()
  // concorrentes do MESMO ativo poderiam terminar fora de ordem e alimentar o
  // TwelveCandlesEngine (que exige ordem estrita) com as velas trocadas, corrompendo o
  // casamento do padrao. Cada candle so comeca a ser processado depois que o anterior
  // do MESMO ativo terminou.
  private queues = new Map<number, Promise<void>>();

  constructor(
    private readonly db: Db,
    private readonly broker: BrokerAdapter,
    private readonly activeIds: number[],
    private readonly candleSize: number = CANDLE_SIZE_M1
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    for (const activeId of this.activeIds) {
      const unsubscribe = await this.broker.subscribeCandles(activeId, this.candleSize, (candle) => {
        this.enqueueCandle(activeId, candle);
      });
      this.unsubscribers.push(unsubscribe);
    }
  }

  stop(): void {
    // unsub() e tipado como sincrono (void), mas na pratica pode devolver uma Promise que
    // rejeita quando o WebSocket da corretora ja esta fechando (ex.: login novo substituindo
    // a sessao anterior). Sem este try/catch + tratamento de rejeicao, essa excecao nao tem
    // dono e derruba o processo inteiro (unhandled rejection) — cancelar a inscricao aqui e
    // so um "best effort" de limpeza, nunca deve poder crashar o servidor.
    for (const unsub of this.unsubscribers) {
      try {
        const maybePromise = unsub() as unknown;
        if (maybePromise && typeof (maybePromise as Promise<unknown>).catch === 'function') {
          (maybePromise as Promise<unknown>).catch((err) =>
            console.error('[live] falha ao cancelar inscricao de candles (ignorada):', err)
          );
        }
      } catch (err) {
        console.error('[live] falha ao cancelar inscricao de candles (ignorada):', err);
      }
    }
    this.unsubscribers = [];
    this.started = false;
  }

  getProgress(activeId: number): PatternProgress {
    return this.engine.getProgress(activeId);
  }

  private enqueueCandle(activeId: number, candle: Candle): void {
    const previous = this.queues.get(activeId) ?? Promise.resolve();
    const next = previous
      .then(() => this.handleCandle(activeId, candle))
      .catch((err) => console.error('[live] erro ao processar candle:', err));
    this.queues.set(activeId, next);
  }

  private async handleCandle(activeId: number, candle: Candle): Promise<void> {
    if (!candle.isClosed) {
      // Candle ainda se formando: so serve para o preview em tempo real do pavio da 11a
      // (quando aplicavel). Nunca alimenta o engine de confirmacao — "nunca confirmar
      // usando candle ainda aberto".
      const preview = this.engine.previewEleventh(activeId, candle);
      if (preview) {
        const progress = this.engine.getProgress(activeId);
        this.emitEvent('PATTERN_PROGRESS', activeId, { progress: { ...progress, wick11: { ...preview, candleClosed: false } } });
      }
      return;
    }

    await saveCandle(this.db, candle, 'live');
    this.emitEvent('CANDLE_CLOSED', activeId, { candle });

    const tick = this.engine.onCandleClosed(activeId, candle);

    if (tick.kind === 'PROGRESS') {
      this.emitEvent('PATTERN_PROGRESS', activeId, { progress: tick.progress });
      return;
    }

    if (tick.kind === 'INVALIDATED') {
      this.emitEvent('PATTERN_INVALIDATED', activeId, {
        progress: tick.progress,
        reason: tick.reason,
        wickPercentage11: tick.wickPercentage11,
        window: tick.window,
      });
      return;
    }

    // CONFIRMED — este e o unico ponto que uma futura camada de ordens deve escutar.
    this.emitEvent('PATTERN_CONFIRMED', activeId, {
      progress: tick.progress,
      window: tick.window,
      wickPercentage11: tick.wickPercentage11,
    });
  }

  private emitEvent(type: AppEvent['type'], activeId: number, payload: Record<string, unknown>): void {
    const event: AppEvent = { id: randomUUID(), type, activeId, payload, createdAt: Date.now() };
    insertEvent(this.db, event).catch((err) => console.error('[live] falha ao persistir evento:', err));
    this.emit('event', event);
  }
}
