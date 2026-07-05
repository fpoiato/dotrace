/**
 * connection.ts — WebSocket transport layer.
 *
 * Manages a single persistent socket to the game server and provides:
 *   - Clean connect / disconnect lifecycle
 *   - Exponential-backoff auto-reconnect (up to MAX_RECONNECT_ATTEMPTS)
 *   - JSON serialisation / deserialisation of WsEnvelope objects
 *   - Named lifecycle events so callers can react to state changes without
 *     coupling to internal WebSocket events.
 */

import WebSocket from 'ws';

// ─── Types ────────────────────────────────────────────────────────────────────

export type MessageHandler = (envelope: Record<string, unknown>) => void;
export type ConnectionEvent = 'connected' | 'disconnected' | 'error';
export type EventHandler = () => void;

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_RECONNECT_ATTEMPTS = 10;
/** Backoff cap in ms (2^10 = 1024s capped to 10s). */
const MAX_BACKOFF_MS = 10_000;

// ─── Connection ───────────────────────────────────────────────────────────────

export class Connection {
  private socket: WebSocket | null = null;
  private messageHandler: MessageHandler | null = null;
  private readonly handlers = new Map<ConnectionEvent, EventHandler[]>();
  private reconnectAttempts = 0;
  private shouldReconnect = true;

  constructor(private readonly url: string) {}

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.url);

      this.socket.on('open', () => {
        console.log('[CONNECTED] WebSocket open');
        this.reconnectAttempts = 0;
        this.emit('connected');
        resolve();
      });

      this.socket.on('message', (raw: Buffer | string) => {
        try {
          const envelope = JSON.parse(raw.toString()) as Record<string, unknown>;
          console.log(`[MESSAGE RECEIVED] action=${String(envelope['action'])}`);
          this.messageHandler?.(envelope);
        } catch {
          console.warn('[WARNING] Unparseable message — discarding:', raw.toString().slice(0, 120));
        }
      });

      this.socket.on('error', (err: Error) => {
        console.error('[ERROR] Socket error:', err.message);
        this.emit('error');
        // Only reject if we haven't resolved yet (first connect attempt).
        reject(err);
      });

      this.socket.on('close', () => {
        console.log('[DISCONNECTED] Socket closed');
        this.emit('disconnected');
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.socket?.close();
    this.socket = null;
  }

  // ── Messaging ──────────────────────────────────────────────────────────────

  /**
   * Register the single inbound message handler.
   * Any previously registered handler is replaced.
   */
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /**
   * Subscribe to a connection lifecycle event.
   * Multiple handlers per event are supported.
   */
  on(event: ConnectionEvent, handler: EventHandler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  /**
   * Serialise an envelope and write it to the socket.
   * Returns false and logs a warning if the socket is not ready.
   *
   * Wire format (WsEnvelope):
   *   { action: string, payload: unknown, roomCode?: string }
   */
  send(action: string, payload: unknown, roomCode?: string): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      console.warn(`[WARNING] Cannot send '${action}' — socket not open`);
      return false;
    }
    const envelope: Record<string, unknown> = { action, payload };
    if (roomCode) envelope['roomCode'] = roomCode;
    this.socket.send(JSON.stringify(envelope));
    return true;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private emit(event: ConnectionEvent): void {
    (this.handlers.get(event) ?? []).forEach((h) => h());
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error('[ERROR] Max reconnection attempts reached — giving up');
      return;
    }
    const delay = Math.min(1_000 * 2 ** this.reconnectAttempts, MAX_BACKOFF_MS);
    this.reconnectAttempts++;
    console.log(`[RECONNECT] Retry ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);
    setTimeout(() => {
      this.connect().catch(() => {
        // 'error' event already emitted; scheduleReconnect will be called again
        // from the 'close' handler.
      });
    }, delay);
  }
}
