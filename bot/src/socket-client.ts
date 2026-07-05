/**
 * WebSocket communication layer.
 *
 * Owns the raw socket: connect, auto-reconnect with exponential backoff,
 * JSON (de)serialization of WsEnvelope frames, and connection logging.
 * It knows nothing about game rules — consumers subscribe to parsed
 * envelopes and push envelopes back out.
 */
import WebSocket from 'ws';
import { WsEnvelope } from '../../shared/ws-types';
import { log, logError } from './logger';

export type EnvelopeHandler = (envelope: WsEnvelope) => void;

const MAX_RECONNECT_DELAY_MS = 10_000;

export class GameSocket {
  private socket: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shouldReconnect = true;

  private readonly messageHandlers = new Set<EnvelopeHandler>();
  private readonly openHandlers = new Set<(reconnect: boolean) => void>();
  private everConnected = false;

  constructor(private readonly url: string) {}

  /** Subscribe to every inbound envelope. Returns an unsubscribe function. */
  onMessage(handler: EnvelopeHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  /** Fired on every successful open; `reconnect` is true after a drop. */
  onOpen(handler: (reconnect: boolean) => void): () => void {
    this.openHandlers.add(handler);
    return () => this.openHandlers.delete(handler);
  }

  connect(): void {
    this.shouldReconnect = true;
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return;

    log('CONNECTING', this.url);
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.on('open', () => {
      const isReconnect = this.everConnected;
      this.everConnected = true;
      this.reconnectAttempts = 0;
      log('CONNECTED', this.url);
      for (const handler of this.openHandlers) handler(isReconnect);
    });

    socket.on('message', (data) => {
      const raw = data.toString();
      let envelope: WsEnvelope;
      try {
        envelope = JSON.parse(raw) as WsEnvelope;
      } catch {
        logError('MESSAGE RECEIVED', 'unparseable frame:', raw.slice(0, 200));
        return;
      }
      log('MESSAGE RECEIVED', envelope.action);
      for (const handler of this.messageHandlers) handler(envelope);
    });

    socket.on('error', (err) => {
      logError('SOCKET ERROR', err.message);
      // 'close' always follows 'error'; reconnect is scheduled there.
    });

    socket.on('close', (code) => {
      log('DISCONNECTED', `code=${code}`);
      if (this.socket === socket) this.socket = null;
      if (this.shouldReconnect) this.scheduleReconnect();
    });
  }

  /** Serialize and send one envelope; drops (with a warning) if not open. */
  send(action: WsEnvelope['action'], payload: unknown, roomCode?: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      logError('SEND SKIPPED', `socket not open (action=${action})`);
      return;
    }
    const envelope: WsEnvelope = { action, payload, roomCode };
    this.socket.send(JSON.stringify(envelope));
    log('SENT', action);
  }

  close(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
  }

  private scheduleReconnect(): void {
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, MAX_RECONNECT_DELAY_MS);
    this.reconnectAttempts++;
    log('RECONNECT', `retrying in ${delay}ms (attempt ${this.reconnectAttempts})`);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
