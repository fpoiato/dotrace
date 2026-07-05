import WebSocket from 'ws';
import type { WsEnvelope } from '../../shared/ws-types';
import { Logger } from './logger.js';

export type EnvelopeHandler = (envelope: WsEnvelope) => void;

/**
 * WebSocket transport layer — the ONLY module that touches the socket.
 *
 * Responsibilities:
 *  - keep a persistent connection alive
 *  - reconnect automatically with capped exponential backoff on drops
 *  - (de)serialize the `WsEnvelope` wire format
 *  - surface connection lifecycle events for the orchestrator
 *
 * It is deliberately ignorant of game rules: it just moves JSON in and out.
 */
export class GameSocket {
  private socket: WebSocket | null = null;
  private shouldReconnect = false;
  private reconnectAttempts = 0;
  private everConnected = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  private messageHandler: EnvelopeHandler | null = null;
  private openHandler: (() => void) | null = null;
  /** Fired only after an *unexpected* drop is recovered (not the first open). */
  private reconnectHandler: (() => void) | null = null;

  constructor(
    private readonly url: string,
    private readonly log: Logger
  ) {}

  onMessage(handler: EnvelopeHandler): void {
    this.messageHandler = handler;
  }

  onOpen(handler: () => void): void {
    this.openHandler = handler;
  }

  onReconnect(handler: () => void): void {
    this.reconnectHandler = handler;
  }

  connect(): void {
    this.shouldReconnect = true;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.log.info('[CONNECTING]', this.url);
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.on('open', () => {
      this.reconnectAttempts = 0;
      this.log.info('[CONNECTED]', this.url);
      if (this.everConnected) {
        this.reconnectHandler?.();
      }
      this.everConnected = true;
      this.openHandler?.();
    });

    socket.on('message', (raw: WebSocket.RawData) => {
      const text = raw.toString();
      let envelope: WsEnvelope;
      try {
        envelope = JSON.parse(text) as WsEnvelope;
      } catch {
        this.log.warn('[MESSAGE RECEIVED] (unparseable)', text.slice(0, 200));
        return;
      }
      this.log.debug('[MESSAGE RECEIVED]', envelope.action);
      this.messageHandler?.(envelope);
    });

    socket.on('error', (err: Error) => {
      // `error` is always followed by `close`; reconnection is handled there.
      this.log.error('[ERROR]', err.message);
    });

    socket.on('close', (code: number, reason: Buffer) => {
      this.log.warn('[DISCONNECTED]', `code=${code}`, reason.toString() || '');
      this.socket = null;
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    });
  }

  /** Serialize and send a game envelope. Drops the send (with a warning) if offline. */
  send(action: WsEnvelope['action'], payload: unknown, roomCode?: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.log.warn('[SEND SKIPPED] socket not open', action);
      return;
    }
    const envelope: WsEnvelope = { action, payload, roomCode };
    this.socket.send(JSON.stringify(envelope));
    this.log.debug('[SENT]', action);
  }

  close(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  private scheduleReconnect(): void {
    // 1s, 2s, 4s, 8s ... capped at 10s, mirroring the frontend client.
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 10_000);
    this.reconnectAttempts += 1;
    this.log.info('[RECONNECTING]', `attempt ${this.reconnectAttempts} in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
