/**
 * WebSocket communication layer.
 *
 * Owns the raw socket only: connect, exponential-backoff reconnect, envelope
 * (de)serialization and event fan-out. It knows nothing about game rules —
 * higher layers subscribe to typed envelopes and react.
 */
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { WsEnvelope } from '../../shared/ws-types';
import { log } from './log';

const MAX_RECONNECT_DELAY_MS = 10_000;

export class SocketClient extends EventEmitter {
  private socket: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shouldReconnect = true;
  private everConnected = false;

  constructor(private readonly url: string) {
    super();
  }

  /** Resolves once the socket is open; subsequent drops self-heal. */
  connect(): Promise<void> {
    this.shouldReconnect = true;
    if (this.socket?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      let settled = false;

      socket.on('open', () => {
        log('CONNECTED', `WebSocket open → ${this.url}`);
        this.reconnectAttempts = 0;
        const isReconnect = this.everConnected;
        this.everConnected = true;
        settled = true;
        resolve();
        // Consumers use this to transparently REJOIN_ROOM after a drop.
        if (isReconnect) this.emit('reconnected');
      });

      socket.on('message', (raw) => {
        let envelope: WsEnvelope;
        try {
          envelope = JSON.parse(raw.toString()) as WsEnvelope;
        } catch {
          log('ERROR', 'Invalid (non-JSON) WS message ignored', raw.toString().slice(0, 200));
          return;
        }
        log('MESSAGE RECEIVED', envelope.action as string);
        this.emit('envelope', envelope);
      });

      socket.on('error', (err) => {
        log('ERROR', `WebSocket error: ${err.message}`);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      socket.on('close', (code) => {
        log('DISCONNECTED', `WebSocket closed (code ${code})`);
        if (this.shouldReconnect) this.scheduleReconnect();
      });
    });
  }

  /** Serialize an envelope in the exact shape the server expects. */
  send(action: WsEnvelope['action'], payload: unknown, roomCode?: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      log('ERROR', `Cannot send ${action as string}: socket not open`);
      return;
    }
    const envelope: WsEnvelope = { action, payload, roomCode };
    this.socket.send(JSON.stringify(envelope));
    log('MESSAGE SENT', action as string);
  }

  onEnvelope(handler: (envelope: WsEnvelope) => void): void {
    this.on('envelope', handler);
  }

  onReconnected(handler: () => void): void {
    this.on('reconnected', handler);
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
    log('RECONNECTING', `Retrying in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => undefined); // failures re-enter scheduleReconnect via 'close'
    }, delay);
  }
}
