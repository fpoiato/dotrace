import { Injectable, inject } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import {
  MAX_PLAYERS,
  PLAYER_COLORS,
  Player,
  RoomRejoinedPayload,
  WsEnvelope,
  botNickname,
  createLobbyPlayer,
  isBotPlayer,
  nextBotConnectionId,
} from '../models/ws-types';
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
    this.playersSubject.next(this.mergeHumansWithBots(payload.players));
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

  /** Keep host-local bots when the server replaces the human roster. */
  private mergeHumansWithBots(humans: Player[]): Player[] {
    const bots = this.playersSubject.value.filter((p) => isBotPlayer(p));
    const normalized = humans
      .filter((p) => !isBotPlayer(p))
      .map((p) => this.normalize(p));
    return [...normalized, ...bots].sort((a, b) => a.joinOrder - b.joinOrder);
  }

  /**
   * Host-only: add a computer opponent to the lobby roster.
   * Bots are local to the host — they never hit DynamoDB / WebSocket membership.
   */
  addBot(): Player | null {
    if (!this.room?.isHost) return null;
    const current = this.playersSubject.value;
    if (current.length >= MAX_PLAYERS) return null;

    const usedColors = new Set(current.map((p) => p.color));
    const color =
      PLAYER_COLORS.find((c) => !usedColors.has(c)) ??
      PLAYER_COLORS[current.length % PLAYER_COLORS.length];
    const connectionId = nextBotConnectionId(current);
    const botNumber = Number(connectionId.slice('bot-'.length)) || current.filter(isBotPlayer).length + 1;
    const joinOrder =
      current.reduce((max, p) => Math.max(max, p.joinOrder), -1) + 1;
    const bot = createLobbyPlayer(
      connectionId,
      botNickname(botNumber),
      false,
      joinOrder,
      color,
      true
    );
    this.playersSubject.next(
      [...current, bot].sort((a, b) => a.joinOrder - b.joinOrder)
    );
    return bot;
  }

  /** Host-only: remove a computer opponent from the lobby roster. */
  removeBot(connectionId: string): void {
    if (!this.room?.isHost) return;
    const target = this.playersSubject.value.find((p) => p.connectionId === connectionId);
    if (!target || !isBotPlayer(target)) return;
    this.playersSubject.next(
      this.playersSubject.value.filter((p) => p.connectionId !== connectionId)
    );
  }

  get botCount(): number {
    return this.playersSubject.value.filter((p) => isBotPlayer(p)).length;
  }

  get canAddBot(): boolean {
    return !!this.room?.isHost && this.playersSubject.value.length < MAX_PLAYERS;
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
            this.playersSubject.next(this.mergeHumansWithBots(p.players));
          } else {
            this.playersSubject.next(
              this.mergeHumansWithBots([
                ...this.playersSubject.value.filter(
                  (x) => x.connectionId !== p.connectionId && !isBotPlayer(x)
                ),
                this.normalize(p),
              ])
            );
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
            const humans = this.playersSubject.value
              .filter((x) => !isBotPlayer(x) && x.connectionId !== p.oldConnectionId)
              .concat(this.normalize(p.player));
            this.playersSubject.next(this.mergeHumansWithBots(humans));
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
