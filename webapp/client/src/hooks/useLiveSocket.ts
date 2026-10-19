import { useEffect, useRef, useState } from 'react';
import type { AppEvent, Candle } from '@polarium12c/shared';

export interface LiveSocketState {
  connected: boolean;
  events: AppEvent[];
  /** Ultimo tick de vela em formacao recebido (ver CANDLE_UPDATED) — fica de fora do ring buffer
   * `events` de proposito, ja que chega varias vezes por minuto e nao e um "evento de negocio"
   * (sinais, ordens, resultados) como os demais; so serve pra UI ao vivo tipo o grafico. */
  lastCandleUpdate: { activeId: number; candle: Candle } | null;
}

const MAX_EVENTS = 200;

/** Conecta ao WebSocket do servidor e acumula os ultimos eventos recebidos. */
export function useLiveSocket(): LiveSocketState {
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [lastCandleUpdate, setLastCandleUpdate] = useState<{ activeId: number; candle: Candle } | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    // Em dev local, VITE_API_BASE_URL fica vazio e usamos o proxy do Vite (mesma origem).
    // Em producao, client (Vercel) e server (Render) ficam em dominios diferentes, entao
    // o WS precisa apontar explicitamente para o host do backend, nao para o do frontend.
    const apiBase = import.meta.env.VITE_API_BASE_URL;
    const wsUrl = apiBase
      ? `${apiBase.replace(/^http/, 'ws')}/ws`
      : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;
    const socket = new WebSocket(wsUrl);
    socketRef.current = socket;

    socket.onopen = () => setConnected(true);
    socket.onclose = () => setConnected(false);
    socket.onerror = () => setConnected(false);

    socket.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data) as { type: string; payload: unknown };
        if (data.type !== 'APP_EVENT') return;
        const event = data.payload as AppEvent;

        if (event.type === 'CANDLE_UPDATED') {
          const candle = (event.payload as { candle?: Candle }).candle;
          if (candle && event.activeId !== undefined) setLastCandleUpdate({ activeId: event.activeId, candle });
          return;
        }

        setEvents((prev) => [event, ...prev].slice(0, MAX_EVENTS));
      } catch {
        // mensagem nao reconhecida - ignora silenciosamente, nao e critico para a UI
      }
    };

    return () => socket.close();
  }, []);

  return { connected, events, lastCandleUpdate };
}
