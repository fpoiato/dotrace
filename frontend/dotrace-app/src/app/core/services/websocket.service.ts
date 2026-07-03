import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Observable, Subject, filter, map } from 'rxjs';
import { environment } from '../../../environments/environment';
import { WsEnvelope } from '../models/ws-types';

@Injectable({ providedIn: 'root' })
export class WebSocketService implements OnDestroy {
  private socket: WebSocket | null = null;
  private readonly messagesSubject = new Subject<WsEnvelope>();
  private readonly connectionIdSubject = new BehaviorSubject<string | null>(null);
  private readonly connectedSubject = new BehaviorSubject<boolean>(false);
  private readonly reconnectedSubject = new Subject<void>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = false;
  private everConnected = false;

  readonly messages$ = this.messagesSubject.asObservable();
  readonly connectionId$ = this.connectionIdSubject.asObservable();
  readonly connected$ = this.connectedSubject.asObservable();
  /** Emits after the socket re-opens following an unexpected drop. */
  readonly reconnected$ = this.reconnectedSubject.asObservable();

  get connectionId(): string | null {
    return this.connectionIdSubject.value;
  }

  connect(): Promise<void> {
    this.shouldReconnect = true;
    if (this.socket?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(environment.wsUrl);

      this.socket.onopen = () => {
        this.connectedSubject.next(true);
        this.reconnectAttempts = 0;
        if (this.everConnected) {
          this.reconnectedSubject.next();
        }
        this.everConnected = true;
        resolve();
      };

      this.socket.onmessage = (event) => {
        try {
          const envelope = JSON.parse(event.data as string) as WsEnvelope;
          if (
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

      this.socket.onerror = () => reject(new Error('WebSocket connection failed'));

      this.socket.onclose = () => {
        this.connectedSubject.next(false);
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      };
    });
  }

  onAction<T>(action: string): Observable<T> {
    return this.messages$.pipe(
      filter((m) => m.action === action),
      map((m) => m.payload as T)
    );
  }

  send(action: string, payload: unknown, roomCode?: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      console.warn('WebSocket not connected');
      return;
    }
    const envelope: WsEnvelope = { action: action as WsEnvelope['action'], payload, roomCode };
    this.socket.send(JSON.stringify(envelope));
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.everConnected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.socket?.close();
    this.socket = null;
    this.connectedSubject.next(false);
  }

  ngOnDestroy(): void {
    this.disconnect();
  }

  private scheduleReconnect(): void {
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 10000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => undefined);
    }, delay);
  }
}
