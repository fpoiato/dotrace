import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { firstValueFrom, timeout } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ClientAction, WsEnvelope } from '../models/ws-types';
import { WebSocketService } from './websocket.service';

/**
 * HTTP command channel for client→server actions.
 * WebSocket is reserved for server→client push (and HELLO/PING keepalive).
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly ws = inject(WebSocketService);

  private get baseUrl(): string {
    return (environment.apiUrl || '').replace(/\/$/, '');
  }

  /**
   * Ensure the push channel is up, POST the action, and retry once after a
   * reconnect (+ room rejoin) if the connection id was stale.
   */
  async postAction<T = unknown>(
    action: ClientAction,
    payload: unknown,
    roomCode?: string,
    timeoutMs = 15_000
  ): Promise<WsEnvelope<T>> {
    await this.ws.ensureConnected();
    const connectionId = this.ws.connectionId;
    if (!connectionId) {
      throw new Error('WebSocket connectionId not ready');
    }

    try {
      return await this.postRaw<T>(action, payload, roomCode, connectionId, timeoutMs);
    } catch (err) {
      // A slow model is not a dead socket. The turn token makes a later retry safe.
      if (action === 'REJOIN_ROOM' || action === 'PLAY_AI_TURN') throw err;

      await this.ws.forceReconnect();
      // RoomService listens to reconnected$ and rejoins; wait for that before retrying.
      if (roomCode) {
        await firstValueFrom(this.ws.onAction('ROOM_REJOINED').pipe(timeout(10_000))).catch(
          () => null
        );
      }
      const freshId = this.ws.connectionId;
      if (!freshId) throw err;
      return await this.postRaw<T>(action, payload, roomCode, freshId, timeoutMs);
    }
  }

  /**
   * Single-shot POST with an explicit connection id — used by room rejoin so we
   * do not nest reconnect/rejoin waits.
   */
  async postRaw<T = unknown>(
    action: ClientAction,
    payload: unknown,
    roomCode: string | undefined,
    connectionId: string,
    timeoutMs = 15_000
  ): Promise<WsEnvelope<T>> {
    if (!this.baseUrl) {
      throw new Error('HTTP API URL not configured');
    }
    const headers = new HttpHeaders({
      'Content-Type': 'application/json',
      'X-Connection-Id': connectionId,
    });
    const body: WsEnvelope = {
      action,
      payload,
      roomCode,
      connectionId,
    };
    const response = await firstValueFrom(
      this.http
        .post<WsEnvelope<T>>(`${this.baseUrl}/actions`, body, { headers })
        .pipe(timeout(timeoutMs))
    );
    if (response?.action === 'ERROR') {
      const message =
        (response.payload as { message?: string })?.message ?? 'Request failed';
      throw new Error(message);
    }
    return response;
  }

  async getTop10<T = { entries: unknown[] }>(): Promise<WsEnvelope<T>> {
    if (!this.baseUrl) {
      throw new Error('HTTP API URL not configured');
    }
    return firstValueFrom(
      this.http.get<WsEnvelope<T>>(`${this.baseUrl}/top10`).pipe(timeout(10_000))
    );
  }

  /** Store a compact replay. Returns the id used in `/replay/:id`. */
  async saveReplay(payload: unknown): Promise<string> {
    if (!this.baseUrl) {
      throw new Error('HTTP API URL not configured');
    }
    const response = await firstValueFrom(
      this.http
        .post<{ id: string }>(`${this.baseUrl}/replays`, payload)
        .pipe(timeout(20_000))
    );
    if (!response?.id) throw new Error('Replay id missing');
    return response.id;
  }

  async getReplay<T = unknown>(id: string): Promise<T> {
    if (!this.baseUrl) {
      throw new Error('HTTP API URL not configured');
    }
    return firstValueFrom(
      this.http
        .get<T>(`${this.baseUrl}/replays/${encodeURIComponent(id)}`)
        .pipe(timeout(15_000))
    );
  }
}
