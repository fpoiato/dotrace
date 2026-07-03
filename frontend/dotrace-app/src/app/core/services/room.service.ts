import { Injectable, inject } from '@angular/core';
import { BehaviorSubject, Observable, Subscription } from 'rxjs';
import { Player, RoomRejoinedPayload } from '../models/ws-types';
import { SessionStorageService } from './session-storage.service';
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
  private readonly session = inject(SessionStorageService);
  private readonly roomSubject = new BehaviorSubject<RoomContext | null>(null);
  private readonly playersSubject = new BehaviorSubject<Player[]>([]);
  private readonly pendingSubject = new BehaviorSubject<Player[]>([]);

  readonly room$ = this.roomSubject.asObservable();
  readonly players$ = this.playersSubject.asObservable();
  readonly pending$ = this.pendingSubject.asObservable();

  constructor() {
    // Mobile browsers kill sockets on screen lock; when the socket reopens we
    // get a fresh connectionId, so transparently rejoin the room we were in.
    this.ws.reconnected$.subscribe(() => this.autoRejoin());
    this.ws.onAction<RoomRejoinedPayload>('ROOM_REJOINED').subscribe((p) => this.applyRejoined(p));
  }

  get room(): RoomContext | null {
    return this.roomSubject.value;
  }

  get players(): Player[] {
    return this.playersSubject.value;
  }

  private autoRejoin(): void {
    const ctx = this.roomSubject.value;
    const saved = this.session.load();
    const roomCode = ctx?.roomCode ?? saved?.roomCode;
    const nickname = ctx?.nickname ?? saved?.nickname;
    if (!roomCode || !nickname) return;
    this.ws.send(
      'REJOIN_ROOM',
      {
        nickname,
        roomCode,
        previousConnectionId: ctx?.connectionId ?? saved?.connectionId,
      },
      roomCode
    );
  }

  private applyRejoined(payload: RoomRejoinedPayload): void {
    const context: RoomContext = {
      roomCode: payload.roomCode,
      nickname: payload.nickname,
      isHost: payload.isHost,
      connectionId: payload.connectionId,
    };
    this.roomSubject.next(context);
    this.persistRoom(context);
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
    };
  }

  private persistRoom(context: RoomContext): void {
    this.session.save({
      roomCode: context.roomCode,
      nickname: context.nickname,
      isHost: context.isHost,
      connectionId: context.connectionId,
    });
  }

  async createRoom(nickname: string): Promise<string> {
    await this.ws.connect();
    this.reset(false);
    this.ws.send('CREATE_ROOM', { nickname });
    return new Promise((resolve, reject) => {
      const subs: Subscription[] = [];
      const done = () => subs.forEach((s) => s.unsubscribe());
      subs.push(
        this.ws
          .onAction<{ roomCode: string; connectionId: string; isHost: boolean; color: string }>('ROOM_CREATED')
          .subscribe({
            next: (payload) => {
              const context: RoomContext = {
                roomCode: payload.roomCode,
                nickname,
                isHost: payload.isHost,
                connectionId: payload.connectionId,
              };
              this.roomSubject.next(context);
              this.persistRoom(context);
              this.session.save({ screen: 'lobby' });
              // Seed players$ with the host — single source of truth for the lobby.
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
                },
              ]);
              done();
              resolve(payload.roomCode);
            },
            error: (err) => {
              done();
              reject(err);
            },
          }),
        this.ws.onAction<{ message: string }>('ERROR').subscribe((err) => {
          done();
          reject(new Error(err.message));
        })
      );
    });
  }

  async joinRoom(nickname: string, roomCode: string): Promise<void> {
    await this.ws.connect();
    this.reset(false);
    this.ws.send('JOIN_ROOM', { nickname, roomCode: roomCode.toUpperCase() });
    return new Promise((resolve, reject) => {
      const subs: Subscription[] = [];
      const done = () => subs.forEach((s) => s.unsubscribe());
      subs.push(
        this.ws
          .onAction<{ roomCode: string; connectionId: string; color: string; pending?: boolean }>('JOIN_PENDING')
          .subscribe((payload) => {
            if (!payload.pending) {
              const context: RoomContext = {
                roomCode: payload.roomCode,
                nickname,
                isHost: false,
                connectionId: payload.connectionId,
              };
              this.roomSubject.next(context);
              this.persistRoom(context);
              this.session.save({ screen: 'lobby' });
              // Seed self on join.
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
                },
              ]);
              done();
              resolve();
            }
          }),
        this.ws.onAction<{ message: string }>('ERROR').subscribe((err) => {
          done();
          reject(new Error(err.message));
        }),
        this.ws.onAction<{ message: string }>('JOIN_REJECTED').subscribe((err) => {
          done();
          reject(new Error(err.message));
        })
      );
    });
  }

  async rejoinSession(): Promise<void> {
    const saved = this.session.load();
    if (!saved?.roomCode || !saved.nickname) {
      throw new Error('No saved session');
    }

    await this.ws.connect();
    this.reset(false);
    this.ws.send(
      'REJOIN_ROOM',
      {
        nickname: saved.nickname,
        roomCode: saved.roomCode,
        previousConnectionId: saved.connectionId,
      },
      saved.roomCode
    );

    return new Promise((resolve, reject) => {
      const subs: Subscription[] = [];
      const done = () => subs.forEach((s) => s.unsubscribe());
      subs.push(
        this.ws.onAction<RoomRejoinedPayload>('ROOM_REJOINED').subscribe({
          next: () => {
            // State application happens in the persistent applyRejoined handler.
            done();
            resolve();
          },
          error: (err) => {
            done();
            reject(err);
          },
        }),
        this.ws.onAction<{ message: string }>('ERROR').subscribe((err) => {
          done();
          this.session.clear();
          reject(new Error(err.message));
        })
      );
    });
  }

  setScreen(screen: 'lobby' | 'game'): void {
    this.session.save({ screen });
  }

  listenForLobbyUpdates(): Observable<void> {
    return new Observable((observer) => {
      const subs = [
        this.ws.onAction<Player & { players?: Player[] }>('PLAYER_APPROVED').subscribe((p) => {
          if (p.players?.length) {
            // Server includes the authoritative approved roster — adopt it so
            // freshly approved players learn about everyone already in the room.
            this.playersSubject.next(
              p.players.map((pl) => this.normalize(pl)).sort((a, b) => a.joinOrder - b.joinOrder)
            );
          } else {
            this.playersSubject.next([
              ...this.playersSubject.value.filter((x) => x.connectionId !== p.connectionId),
              this.normalize(p),
            ]);
          }
          this.pendingSubject.next(this.pendingSubject.value.filter((x) => x.connectionId !== p.connectionId));
          observer.next();
        }),
        this.ws
          .onAction<{ connectionId: string; nickname: string; color: string; pending?: boolean }>('JOIN_PENDING')
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
              };
              this.pendingSubject.next([
                ...this.pendingSubject.value.filter((x) => x.connectionId !== p.connectionId),
                pendingPlayer,
              ]);
              observer.next();
            }
          }),
        this.ws.onAction<{ connectionId: string }>('PLAYER_REJECTED').subscribe((p) => {
          this.pendingSubject.next(this.pendingSubject.value.filter((x) => x.connectionId !== p.connectionId));
          observer.next();
        }),
        this.ws.onAction<{ connectionId: string; nickname: string }>('PLAYER_LEFT').subscribe((p) => {
          this.playersSubject.next(this.playersSubject.value.filter((x) => x.connectionId !== p.connectionId));
          observer.next();
        }),
        this.ws
          .onAction<{ oldConnectionId: string; newConnectionId: string; player: Player }>('PLAYER_REJOINED')
          .subscribe((p) => {
            const room = this.roomSubject.value;
            if (room?.connectionId === p.oldConnectionId) {
              this.roomSubject.next({ ...room, connectionId: p.newConnectionId, isHost: p.player.isHost });
              this.session.save({ connectionId: p.newConnectionId, isHost: p.player.isHost });
            }
            this.playersSubject.next(
              this.playersSubject.value
                .filter((x) => x.connectionId !== p.oldConnectionId)
                .concat(this.normalize(p.player))
                .sort((a, b) => a.joinOrder - b.joinOrder)
            );
            observer.next();
          }),
        this.ws.onAction<{ newHostId: string; newHostNickname: string }>('HOST_CHANGED').subscribe((p) => {
          const room = this.roomSubject.value;
          if (room) {
            const isNewHost = room.connectionId === p.newHostId;
            this.roomSubject.next({ ...room, isHost: isNewHost });
            this.session.save({ isHost: isNewHost });
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
    this.ws.send('APPROVE_PLAYER', { targetConnectionId: connectionId }, room.roomCode);
  }

  rejectPlayer(connectionId: string): void {
    const room = this.room;
    if (!room?.isHost) return;
    this.ws.send('REJECT_PLAYER', { targetConnectionId: connectionId }, room.roomCode);
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

  reset(clearSession = true): void {
    this.roomSubject.next(null);
    this.playersSubject.next([]);
    this.pendingSubject.next([]);
    if (clearSession) {
      this.session.clear();
    }
  }
}
