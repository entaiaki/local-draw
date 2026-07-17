import type {
  WsRunMessage,
  WsStatusEvent,
  WsRunPayload
} from '../types';

function getWsUrl(baseUrl: string, path: string): string {
  const url = new URL(path, baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export type RunMessageHandler = (msg: WsRunMessage) => void;

export function connectRunWs(
  baseUrl: string,
  payload: WsRunPayload,
  onMessage: RunMessageHandler,
  onOpen?: () => void,
  onClose?: (code: number, reason: string) => void,
  onError?: (ev: Event) => void
): WebSocket {
  const ws = new WebSocket(getWsUrl(baseUrl, '/ws/run'));

  ws.onopen = () => {
    ws.send(JSON.stringify(payload));
    onOpen?.();
  };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data) as WsRunMessage;
      onMessage(msg);
    } catch {
      // ignore parse errors
    }
  };

  ws.onclose = (ev) => {
    onClose?.(ev.code, ev.reason);
  };

  ws.onerror = (ev) => {
    onError?.(ev);
  };

  return ws;
}

export type StatusMessageHandler = (msg: WsStatusEvent) => void;

export interface StatusConnection {
  ws: WebSocket;
  close: () => void;
}

export function connectStatusWs(
  baseUrl: string,
  onMessage: StatusMessageHandler,
  onOpen?: () => void,
  onClose?: () => void,
): StatusConnection {
  let ws: WebSocket;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  function connect() {
    ws = new WebSocket(getWsUrl(baseUrl, '/ws/status'));

    ws.onopen = () => {
      onOpen?.();
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as WsStatusEvent;
        onMessage(msg);
      } catch {
        // ignore parse errors
      }
    };

    ws.onclose = () => {
      onClose?.();
      if (!closed) {
        reconnectTimer = setTimeout(connect, 2000);
      }
    };

    ws.onerror = () => {
      // onclose will fire after this
    };
  }

  connect();

  return {
    get ws() {
      return ws;
    },
    close: () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    }
  };
}
