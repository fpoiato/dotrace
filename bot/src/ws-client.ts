import WebSocket from 'ws';
import type { ClientAction, ServerEvent, WsEnvelope } from '../../shared/ws-types';

export type MessageHandler = (envelope: WsEnvelope) => void;
export type ReconnectHandler = () => void;

/**
 * Thin WebSocket transport layer — owns the socket lifecycle and reconnection.
 * Game logic lives elsewhere; this module only sends/receives JSON envelopes.
 */
export class WsClient {
  private socket: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;
  private everConnected = false;
  private readonly handlers = new Set<MessageHandler>();
  private readonly reconnectHandlers = new Set<ReconnectHandler>();

  constructor(private readonly wsUrl: string) {}

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onReconnect(handler: ReconnectHandler): () => void {
    this.reconnectHandlers.add(handler);
    return () => this.reconnectHandlers.delete(handler);
  }

  connect(): Promise<void> {
    this.shouldReconnect = true;

    if (this.socket?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.wsUrl);

      this.socket.on('open', () => {
        this.reconnectAttempts = 0;
        console.log('[CONNECTED]', this.wsUrl);
        if (this.everConnected) {
          for (const handler of this.reconnectHandlers) {
            handler();
          }
        }
        this.everConnected = true;
        resolve();
      });

      this.socket.on('message', (data) => {
        const raw = data.toString();
        console.log('[MESSAGE RECEIVED]', raw.slice(0, 200) + (raw.length > 200 ? '…' : ''));
        try {
          const envelope = JSON.parse(raw) as WsEnvelope;
          for (const handler of this.handlers) {
            handler(envelope);
          }
        } catch {
          console.warn('[MESSAGE RECEIVED] Invalid JSON — ignored');
        }
      });

      this.socket.on('error', (err) => {
        console.error('[WS ERROR]', err.message);
        reject(err);
      });

      this.socket.on('close', (code, reason) => {
        console.log('[DISCONNECTED]', `code=${code}`, reason.toString() || '(no reason)');
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });
    });
  }

  send(action: ClientAction | ServerEvent, payload: unknown, roomCode?: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      console.warn('[SEND FAILED] WebSocket not connected');
      return;
    }
    const envelope: WsEnvelope = { action, payload, roomCode };
    this.socket.send(JSON.stringify(envelope));
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  private scheduleReconnect(): void {
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 10_000);
    this.reconnectAttempts++;
    console.log(`[RECONNECT] Attempt ${this.reconnectAttempts} in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => undefined);
    }, delay);
  }
}
