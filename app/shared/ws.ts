export interface WSMessage {
  type: string;
  [key: string]: unknown;
}

export interface WSClientOptions {
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: Event) => void;
  onMessage?: (message: WSMessage) => void;
  reconnect?: boolean;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}

export interface WSClient {
  send: (message: WSMessage) => void;
  close: () => void;
  isConnected: () => boolean;
}

export function createWSClient(url: string, options: WSClientOptions = {}): WSClient {
  const {
    onOpen,
    onClose,
    onError,
    onMessage,
    reconnect = true,
    reconnectInterval = 3000,
    maxReconnectAttempts = 5
  } = options;

  let ws: WebSocket | null = null;
  let reconnectAttempts = 0;
  let shouldReconnect = reconnect;
  let reconnectTimeout: number | null = null;

  function connect() {
    try {
      ws = new WebSocket(url);

      ws.onopen = () => {
        console.log('[WS] Connected to', url);
        reconnectAttempts = 0;
        onOpen?.();
      };

      ws.onclose = (event) => {
        console.log('[WS] Disconnected:', event.code, event.reason);
        ws = null;
        onClose?.();

        if (shouldReconnect && reconnectAttempts < maxReconnectAttempts) {
          reconnectAttempts++;
          console.log(`[WS] Reconnecting (${reconnectAttempts}/${maxReconnectAttempts})...`);
          reconnectTimeout = window.setTimeout(connect, reconnectInterval);
        }
      };

      ws.onerror = (error) => {
        console.error('[WS] Error:', error);
        onError?.(error);
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as WSMessage;
          console.log('[WS] Received:', message);
          onMessage?.(message);
        } catch (e) {
          console.error('[WS] Failed to parse message:', e);
        }
      };
    } catch (e) {
      console.error('[WS] Failed to create WebSocket:', e);
      onError?.(new Event('connection-error'));
    }
  }

  function send(message: WSMessage) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
      console.log('[WS] Sent:', message);
    } else {
      console.warn('[WS] Cannot send - not connected');
    }
  }

  function close() {
    shouldReconnect = false;
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
    if (ws) {
      ws.close();
      ws = null;
    }
  }

  function isConnected(): boolean {
    return ws !== null && ws.readyState === WebSocket.OPEN;
  }

  // Initial connection
  connect();

  return {
    send,
    close,
    isConnected
  };
}
