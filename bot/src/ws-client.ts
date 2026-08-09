import WebSocket from 'ws';
import type { ClientAction, ServerEvent, WsEnvelope } from '../../shared/ws-types';

export type MessageHandler = (envelope: WsEnvelope) => void;
export type ReconnectHandler = () => void;

/**
 * Thin WebSocket transport — push channel + HELLO/PING only.
 * Game commands go through HttpClient.
 */
export class WsClient {
  private socket: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private shouldReconnect = true;
  private everConnected = false;
  private connectionId: string | null = null;
  private connectPromise: Promise<void> | null = null;
  private readonly handlers = new Set<MessageHandler>();
  private readonly reconnectHandlers = new Set<ReconnectHandler>();

  constructor(private readonly wsUrl: string) {}

  getConnectionId(): string | null {
    return this.connectionId;
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onReconnect(handler: ReconnectHandler): () => void {
    this.reconnectHandlers.add(handler);
    return () => this.reconnectHandlers.delete(handler);
  }

  /** Inject a locally-produced envelope (e.g. HTTP rejoin reply) into handlers. */
  publishLocal(envelope: WsEnvelope): void {
    for (const handler of this.handlers) {
      handler(envelope);
    }
  }

  connect(): Promise<void> {
    this.shouldReconnect = true;

    if (this.socket?.readyState === WebSocket.OPEN && this.connectionId) {
      return Promise.resolve();
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.socket = new WebSocket(this.wsUrl);
      let settled = false;

      const succeed = () => {
        if (settled) return;
        settled = true;
        this.connectPromise = null;
        resolve();
      };

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        this.connectPromise = null;
        reject(err);
      };

      this.socket.on('open', () => {
        this.reconnectAttempts = 0;
        console.log('[CONNECTED]', this.wsUrl);
        this.startPingLoop();
        this.send('HELLO', {});
      });

      this.socket.on('message', (data) => {
        const raw = data.toString();
        console.log('[MESSAGE RECEIVED]', raw.slice(0, 200) + (raw.length > 200 ? '…' : ''));
        try {
          const envelope = JSON.parse(raw) as WsEnvelope;
          if (envelope.action === 'CONNECTED') {
            const id = (envelope.payload as { connectionId?: string })?.connectionId;
            if (id) {
              const isReconnect = this.everConnected;
              this.connectionId = id;
              this.everConnected = true;
              succeed();
              if (isReconnect) {
                for (const handler of this.reconnectHandlers) {
                  handler();
                }
              }
            }
          }
          for (const handler of this.handlers) {
            handler(envelope);
          }
        } catch {
          console.warn('[MESSAGE RECEIVED] Invalid JSON — ignored');
        }
      });

      this.socket.on('error', (err) => {
        console.error('[WS ERROR]', err.message);
        fail(err);
      });

      this.socket.on('close', (code, reason) => {
        console.log('[DISCONNECTED]', `code=${code}`, reason.toString() || '(no reason)');
        this.connectionId = null;
        this.stopPingLoop();
        this.connectPromise = null;
        if (!settled) {
          fail(new Error('WebSocket closed before CONNECTED'));
        }
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });
    });

    return this.connectPromise;
  }

  /** Channel-control send only (HELLO / PING). Prefer HttpClient for game actions. */
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
    this.stopPingLoop();
    this.socket?.close();
    this.socket = null;
    this.connectionId = null;
  }

  private startPingLoop(): void {
    this.stopPingLoop();
    this.pingTimer = setInterval(() => this.send('PING', { ts: Date.now() }), 4 * 60 * 1000);
  }

  private stopPingLoop(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
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
