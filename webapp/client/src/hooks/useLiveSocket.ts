import { useEffect, useRef, useState } from 'react';
import type { AppEvent } from '@polarium12c/shared';

export interface LiveSocketState {
  connected: boolean;
  events: AppEvent[];
}

const MAX_EVENTS = 200;

/** Conecta ao WebSocket do servidor e acumula os ultimos eventos recebidos. */
export function useLiveSocket(): LiveSocketState {
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<AppEvent[]>([]);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
    socketRef.current = socket;

    socket.onopen = () => setConnected(true);
    socket.onclose = () => setConnected(false);
    socket.onerror = () => setConnected(false);

    socket.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data) as { type: string; payload: unknown };
        if (data.type === 'APP_EVENT') {
          setEvents((prev) => [data.payload as AppEvent, ...prev].slice(0, MAX_EVENTS));
        }
      } catch {
        // mensagem nao reconhecida - ignora silenciosamente, nao e critico para a UI
      }
    };

    return () => socket.close();
  }, []);

  return { connected, events };
}
