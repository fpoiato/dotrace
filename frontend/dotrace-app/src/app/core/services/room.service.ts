import { Injectable, inject } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { Player, RoomRejoinedPayload, WsEnvelope } from '../models/ws-types';
import { ApiService } from './api.service';
import { WebSocketService } from './websocket.service';

export interface RoomContext {
  roomCode: string;
  nickname: string;
  isHost: boolean;
  connectionId: string;
}

@Injectable({ providedIn: 'root' })
export class RoomService {
  private readonly ws = inject(WebSocketService);
  private readonly api = inject(ApiService);
  private readonly roomSubject = new BehaviorSubject<RoomContext | null>(null);
  private readonly playersSubject = new BehaviorSubject<Player[]>([]);
  private readonly pendingSubject = new BehaviorSubject<Player[]>([]);
  private rejoinInFlight: Promise<void> | null = null;

  readonly room$ = this.roomSubject.asObservable();
  readonly players$ = this.playersSubject.asObservable();
  readonly pending$ = this.pendingSubject.asObservable();

  constructor() {
    // Mobile browsers kill sockets on screen lock; when the socket reopens we
    // get a fresh connectionId, so transparently rejoin the room we were in.
    this.ws.reconnected$.subscribe(() => {
      void this.autoRejoin();
    });
    this.ws.onAction<RoomRejoinedPayload>('ROOM_REJOINED').subscribe((p) => this.applyRejoined(p));
  }

  get room(): RoomContext | null {
    return this.roomSubject.value;
  }

  get players(): Player[] {
    return this.playersSubject.value;
  }

  /**
   * Rejoin after a socket drop, using ONLY the in-memory room context.
   * Room identity is deliberately not persisted anywhere: a fresh page
   * never gets pulled back into an old room.
   */
  private async autoRejoin(): Promise<void> {
    const ctx = this.roomSubject.value;
    if (!ctx) return;
    if (this.rejoinInFlight) return this.rejoinInFlight;

    this.rejoinInFlight = (async () => {
      const connectionId = this.ws.connectionId;
      if (!connectionId) return;
      try {
        const response = await this.api.postRaw<RoomRejoinedPayload>(
          'REJOIN_ROOM',
          {
            nickname: ctx.nickname,
            roomCode: ctx.roomCode,
            previousConnectionId: ctx.connectionId,
          },
          ctx.roomCode,
          connectionId
        );
        if (response.action === 'ROOM_REJOINED' && response.payload) {
          this.applyRejoined(response.payload);
          // Fan into the local stream so ApiService waiters / game engine see it.
          this.ws.publishLocal(response as WsEnvelope<RoomRejoinedPayload>);
        }
      } catch (err) {
        console.warn('Auto-rejoin failed', err);
      } finally {
        this.rejoinInFlight = null;
      }
    })();

    return this.rejoinInFlight;
  }

  private applyRejoined(payload: RoomRejoinedPayload): void {
    const context: RoomContext = {
      roomCode: payload.roomCode,
      nickname: payload.nickname,
      isHost: payload.isHost,
      connectionId: payload.connectionId,
    };
    this.roomSubject.next(context);
    this.playersSubject.next(payload.players.map((p) => this.normalize(p)));
    this.pendingSubject.next(payload.pending.map((p) => this.normalize(p)));
  }

  private normalize(p: Player): Player {
    return {
      ...p,
      position: p.position ?? { x: 0, y: 0 },
      velocity: p.velocity ?? { x: 0, y: 0 },
      isOffTrack: p.isOffTrack ?? false,
      trail: p.trail ?? [],
      lap: p.lap ?? 1,
    };
  }

  async createRoom(nickname: string): Promise<string> {
    await this.ws.ensureConnected();
    this.reset();
    const response = await this.api.postAction<{
      roomCode: string;
      connectionId: string;
      isHost: boolean;
      color: string;
    }>('CREATE_ROOM', { nickname });

    if (response.action !== 'ROOM_CREATED' || !response.payload) {
      throw new Error('Failed to create room');
    }

    const payload = response.payload;
    const context: RoomContext = {
      roomCode: payload.roomCode,
      nickname,
      isHost: payload.isHost,
      connectionId: payload.connectionId,
    };
    this.roomSubject.next(context);
    this.playersSubject.next([
      {
        connectionId: payload.connectionId,
        nickname,
        color: payload.color,
        isHost: true,
        joinOrder: 0,
        status: 'approved',
        position: { x: 0, y: 0 },
        velocity: { x: 0, y: 0 },
        isOffTrack: false,
        trail: [],
        lap: 1,
      },
    ]);
    return payload.roomCode;
  }

  async joinRoom(nickname: string, roomCode: string): Promise<void> {
    await this.ws.ensureConnected();
    this.reset();
    const response = await this.api.postAction<{
      roomCode: string;
      connectionId: string;
      color: string;
      pending?: boolean;
    }>('JOIN_ROOM', { nickname, roomCode: roomCode.toUpperCase() }, roomCode.toUpperCase());

    if (response.action === 'JOIN_REJECTED') {
      throw new Error(
        (response.payload as { message?: string })?.message ?? 'Join rejected'
      );
    }
    if (response.action !== 'JOIN_PENDING' || !response.payload) {
      throw new Error('Failed to join room');
    }

    const payload = response.payload;
    const context: RoomContext = {
      roomCode: payload.roomCode,
      nickname,
      isHost: false,
      connectionId: payload.connectionId,
    };
    this.roomSubject.next(context);
    this.playersSubject.next([
      {
        connectionId: payload.connectionId,
        nickname,
        color: payload.color,
        isHost: false,
        joinOrder: -1,
        status: 'approved',
        position: { x: 0, y: 0 },
        velocity: { x: 0, y: 0 },
        isOffTrack: false,
        trail: [],
        lap: 1,
      },
    ]);
  }

  listenForLobbyUpdates(): Observable<void> {
    return new Observable((observer) => {
      const subs = [
        this.ws.onAction<Player & { players?: Player[] }>('PLAYER_APPROVED').subscribe((p) => {
          if (p.players?.length) {
            this.playersSubject.next(
              p.players.map((pl) => this.normalize(pl)).sort((a, b) => a.joinOrder - b.joinOrder)
            );
          } else {
            this.playersSubject.next([
              ...this.playersSubject.value.filter((x) => x.connectionId !== p.connectionId),
              this.normalize(p),
            ]);
          }
          this.pendingSubject.next(
            this.pendingSubject.value.filter((x) => x.connectionId !== p.connectionId)
          );
          observer.next();
        }),
        this.ws
          .onAction<{ connectionId: string; nickname: string; color: string; pending?: boolean }>(
            'JOIN_PENDING'
          )
          .subscribe((p) => {
            if (p.pending) {
              const pendingPlayer: Player = {
                connectionId: p.connectionId,
                nickname: p.nickname,
                color: p.color,
                isHost: false,
                joinOrder: -1,
                status: 'pending',
                position: { x: 0, y: 0 },
                velocity: { x: 0, y: 0 },
                isOffTrack: false,
                trail: [],
                lap: 1,
              };
              this.pendingSubject.next([
                ...this.pendingSubject.value.filter((x) => x.connectionId !== p.connectionId),
                pendingPlayer,
              ]);
              observer.next();
            }
          }),
        this.ws.onAction<{ connectionId: string }>('PLAYER_REJECTED').subscribe((p) => {
          this.pendingSubject.next(
            this.pendingSubject.value.filter((x) => x.connectionId !== p.connectionId)
          );
          observer.next();
        }),
        this.ws.onAction<{ connectionId: string; nickname: string }>('PLAYER_LEFT').subscribe((p) => {
          this.playersSubject.next(
            this.playersSubject.value.filter((x) => x.connectionId !== p.connectionId)
          );
          observer.next();
        }),
        this.ws
          .onAction<{ oldConnectionId: string; newConnectionId: string; player: Player }>(
            'PLAYER_REJOINED'
          )
          .subscribe((p) => {
            const room = this.roomSubject.value;
            if (room?.connectionId === p.oldConnectionId) {
              this.roomSubject.next({
                ...room,
                connectionId: p.newConnectionId,
                isHost: p.player.isHost,
              });
            }
            this.playersSubject.next(
              this.playersSubject.value
                .filter((x) => x.connectionId !== p.oldConnectionId)
                .concat(this.normalize(p.player))
                .sort((a, b) => a.joinOrder - b.joinOrder)
            );
            observer.next();
          }),
        this.ws
          .onAction<{ newHostId: string; newHostNickname: string }>('HOST_CHANGED')
          .subscribe((p) => {
            const room = this.roomSubject.value;
            if (room) {
              const isNewHost = room.connectionId === p.newHostId;
              this.roomSubject.next({ ...room, isHost: isNewHost });
              this.playersSubject.next(
                this.playersSubject.value.map((pl) => ({
                  ...pl,
                  isHost: pl.connectionId === p.newHostId,
                }))
              );
            }
            observer.next();
          }),
      ];
      return () => subs.forEach((s) => s.unsubscribe());
    });
  }

  /**
   * Ask the server to spawn an AI pilot into this room. The AI joins through
   * the normal player flow and is auto-approved server-side, so it shows up
   * via the usual PLAYER_APPROVED broadcast.
   */
  async spawnAiPlayer(nickname: string): Promise<void> {
    const room = this.room;
    if (!room?.isHost) return;
    await this.api.postAction('SPAWN_AI_PLAYER', { nickname }, room.roomCode);
  }

  approvePlayer(connectionId: string): void {
    const room = this.room;
    if (!room?.isHost) return;
    void this.api
      .postAction('APPROVE_PLAYER', { targetConnectionId: connectionId }, room.roomCode)
      .catch((err) => console.warn('Approve failed', err));
  }

  rejectPlayer(connectionId: string): void {
    const room = this.room;
    if (!room?.isHost) return;
    void this.api
      .postAction('REJECT_PLAYER', { targetConnectionId: connectionId }, room.roomCode)
      .catch((err) => console.warn('Reject failed', err));
  }

  getInviteUrl(roomCode: string): string {
    return `${window.location.origin}/?room=${roomCode}`;
  }

  getWhatsAppUrl(roomCode: string): string {
    const text = encodeURIComponent(
      `Bora jogar Dot Race! Código da sala: ${roomCode}\n${this.getInviteUrl(roomCode)}`
    );
    return `https://wa.me/?text=${text}`;
  }

  reset(): void {
    this.roomSubject.next(null);
    this.playersSubject.next([]);
    this.pendingSubject.next([]);
  }
}
