import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Observable, Subject, filter, map } from 'rxjs';
import { environment } from '../../../environments/environment';
import { WsEnvelope } from '../models/ws-types';

/** Keepalive interval — well under API Gateway's ~10 min idle timeout. */
const PING_INTERVAL_MS = 4 * 60 * 1000;

@Injectable({ providedIn: 'root' })
export class WebSocketService implements OnDestroy {
  private socket: WebSocket | null = null;
  private readonly messagesSubject = new Subject<WsEnvelope>();
  private readonly connectionIdSubject = new BehaviorSubject<string | null>(null);
  private readonly connectedSubject = new BehaviorSubject<boolean>(false);
  private readonly reconnectedSubject = new Subject<void>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private shouldReconnect = false;
  private everConnected = false;
  private connectPromise: Promise<void> | null = null;
  private visibilityHandler: (() => void) | null = null;

  readonly messages$ = this.messagesSubject.asObservable();
  readonly connectionId$ = this.connectionIdSubject.asObservable();
  readonly connected$ = this.connectedSubject.asObservable();
  /** Emits after the socket re-opens following an unexpected drop. */
  readonly reconnected$ = this.reconnectedSubject.asObservable();

  constructor() {
    // iOS Safari suspends sockets when the tab backgrounds; resume aggressively.
    if (typeof document !== 'undefined') {
      this.visibilityHandler = () => {
        if (document.visibilityState === 'visible' && this.shouldReconnect) {
          if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            void this.connect();
          } else {
            this.sendPing();
          }
        }
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }
  }

  get connectionId(): string | null {
    return this.connectionIdSubject.value;
  }

  /** Open (or reuse) the push channel and wait until HELLO yields a connectionId. */
  ensureConnected(): Promise<void> {
    return this.connect();
  }

  connect(): Promise<void> {
    this.shouldReconnect = true;
    if (this.socket?.readyState === WebSocket.OPEN && this.connectionIdSubject.value) {
      return Promise.resolve();
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
        try {
          this.socket.onclose = null;
          this.socket.close();
        } catch {
          /* ignore */
        }
      }

      this.socket = new WebSocket(environment.wsUrl);
      let settled = false;

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        this.connectPromise = null;
        reject(err);
      };

      const succeed = () => {
        if (settled) return;
        settled = true;
        this.connectPromise = null;
        resolve();
      };

      this.socket.onopen = () => {
        this.connectedSubject.next(true);
        this.reconnectAttempts = 0;
        this.startPingLoop();
        // Ask the server for our API Gateway connectionId (not exposed by browsers).
        this.sendRaw('HELLO', {});
      };

      this.socket.onmessage = (event) => {
        try {
          const envelope = JSON.parse(event.data as string) as WsEnvelope;
          if (envelope.action === 'CONNECTED') {
            const payload = envelope.payload as { connectionId?: string };
            if (payload?.connectionId) {
              const isReconnect = this.everConnected;
              this.connectionIdSubject.next(payload.connectionId);
              this.everConnected = true;
              succeed();
              if (isReconnect) {
                this.reconnectedSubject.next();
              }
            }
          } else if (
            envelope.action === 'ROOM_CREATED' ||
            envelope.action === 'ROOM_REJOINED' ||
            envelope.action === 'JOIN_PENDING'
          ) {
            const payload = envelope.payload as { connectionId?: string };
            if (payload?.connectionId) {
              this.connectionIdSubject.next(payload.connectionId);
            }
          }
          this.messagesSubject.next(envelope);
        } catch {
          console.warn('Invalid WS message', event.data);
        }
      };

      this.socket.onerror = () => fail(new Error('WebSocket connection failed'));

      this.socket.onclose = () => {
        this.connectedSubject.next(false);
        this.stopPingLoop();
        this.connectionIdSubject.next(null);
        this.connectPromise = null;
        if (!settled) {
          fail(new Error('WebSocket closed before CONNECTED'));
        }
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      };
    });

    return this.connectPromise;
  }

  /** Force a fresh socket (e.g. after a stale connectionId). */
  async forceReconnect(): Promise<void> {
    this.shouldReconnect = true;
    this.connectionIdSubject.next(null);
    if (this.socket) {
      try {
        this.socket.onclose = null;
        this.socket.close();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
    this.connectPromise = null;
    this.connectedSubject.next(false);
    await this.connect();
  }

  onAction<T>(action: string): Observable<T> {
    return this.messages$.pipe(
      filter((m) => m.action === action),
      map((m) => m.payload as T)
    );
  }

  /** Publish an envelope into the local message stream (e.g. HTTP rejoin reply). */
  publishLocal(envelope: WsEnvelope): void {
    if (
      envelope.action === 'CONNECTED' ||
      envelope.action === 'ROOM_CREATED' ||
      envelope.action === 'ROOM_REJOINED' ||
      envelope.action === 'JOIN_PENDING'
    ) {
      const payload = envelope.payload as { connectionId?: string };
      if (payload?.connectionId) {
        this.connectionIdSubject.next(payload.connectionId);
      }
    }
    this.messagesSubject.next(envelope);
  }

  /**
   * Low-level WS send — only for channel control (HELLO/PING).
   * Game commands go through ApiService HTTP POST.
   */
  send(action: string, payload: unknown, roomCode?: string): void {
    this.sendRaw(action, payload, roomCode);
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.everConnected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPingLoop();
    this.socket?.close();
    this.socket = null;
    this.connectPromise = null;
    this.connectionIdSubject.next(null);
    this.connectedSubject.next(false);
  }

  ngOnDestroy(): void {
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
    }
    this.disconnect();
  }

  private sendRaw(action: string, payload: unknown, roomCode?: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      console.warn('WebSocket not connected');
      return;
    }
    const envelope: WsEnvelope = { action: action as WsEnvelope['action'], payload, roomCode };
    this.socket.send(JSON.stringify(envelope));
  }

  private sendPing(): void {
    this.sendRaw('PING', { ts: Date.now() });
  }

  private startPingLoop(): void {
    this.stopPingLoop();
    this.pingTimer = setInterval(() => this.sendPing(), PING_INTERVAL_MS);
  }

  private stopPingLoop(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 10_000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => undefined);
    }, delay);
  }
}
