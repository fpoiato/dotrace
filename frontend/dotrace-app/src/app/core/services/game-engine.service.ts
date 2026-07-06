import { Injectable, OnDestroy, inject } from '@angular/core';
import { BehaviorSubject, Subscription } from 'rxjs';
import { getTrackById } from '../models/tracks';
import {
  GameMode,
  GameState,
  MIN_PLAYERS,
  Player,
  PlayerRejoinedPayload,
  RelayPayload,
  Vector2D,
  applyGrassPenalty,
  canPlayerMove,
  createInitialState,
  createLobbyPlayer,
  findCollisionOpponent,
  getTileAt,
  getValidMoves,
  isGameOver,
  isGrassShortcut,
  isTimedMode,
  landingPosition,
  nextActiveTurnIndex,
  pushReplayMove,
  pushTrail,
  rollDice,
  segmentCrossesFinish,
  segmentEntersRect,
  zeroVector,
  buildRaceTelemetry,
} from '../models/ws-types';
import { RoomService } from './room.service';
import { SessionStorageService } from './session-storage.service';
import { WebSocketService } from './websocket.service';

@Injectable({ providedIn: 'root' })
export class GameEngineService implements OnDestroy {
  private readonly ws = inject(WebSocketService);
  private readonly roomService = inject(RoomService);
  private readonly session = inject(SessionStorageService);

  private readonly stateSubject = new BehaviorSubject<GameState | null>(null);
  readonly state$ = this.stateSubject.asObservable();

  private messageSub: Subscription | null = null;
  private hostRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private gridOrderTimer: ReturnType<typeof setTimeout> | null = null;
  /** Old host to purge from game state once we (the new host) recover a snapshot. */
  private pendingHostRemovalId: string | null = null;

  get state(): GameState | null {
    return this.stateSubject.value;
  }

  /**
   * Emit a deep clone so every emission is a NEW reference. The host mutates
   * game state in place; without cloning, Angular input bindings (e.g. the
   * track canvas) never see a change and stop re-rendering — the "player 2
   * has no highlighted squares" bug.
   */
  private emit(state: GameState): void {
    this.stateSubject.next(structuredClone(state));
  }

  get isHost(): boolean {
    return this.roomService.room?.isHost ?? false;
  }

  get myId(): string | null {
    return this.roomService.room?.connectionId ?? this.ws.connectionId;
  }

  init(): void {
    if (this.messageSub) return;
    this.messageSub = this.ws.messages$.subscribe((msg) => this.handleMessage(msg.action, msg.payload));
  }

  selectTrack(trackId: string): void {
    if (!this.isHost) return;
    const state = this.state ?? this.bootstrapLobbyState();
    if (!getTrackById(trackId)) return;
    state.trackId = trackId;
    this.session.save({ trackId });
    this.setStateAndRelay('TRACK_SELECTED', state);
  }

  selectLaps(laps: number): void {
    if (!this.isHost) return;
    if (![1, 2, 3].includes(laps)) return;
    const state = this.state ?? this.bootstrapLobbyState();
    state.totalLaps = laps;
    this.session.save({ laps });
    this.setStateAndRelay('STATE_SYNC', state);
  }

  selectGameMode(mode: GameMode): void {
    if (!this.isHost) return;
    if (mode !== 'TURNS' && mode !== 'TIMED') return;
    const state = this.state ?? this.bootstrapLobbyState();
    state.gameMode = mode;
    this.session.save({ gameMode: mode });
    this.setStateAndRelay('STATE_SYNC', state);
  }

  startRace(): void {
    if (!this.isHost) return;
    const room = this.roomService.room;
    const lobbyPlayers = this.roomService.players.filter((p) => p.status === 'approved');
    if (!room || lobbyPlayers.length < MIN_PLAYERS) return;

    const saved = this.session.load();
    const trackId = this.state?.trackId || saved?.trackId || '';
    if (!trackId || !getTrackById(trackId)) return;
    const totalLaps = this.state?.totalLaps ?? saved?.laps ?? 1;
    const gameMode = this.state?.gameMode ?? saved?.gameMode ?? 'TURNS';

    // Rebuild the roster from players$ (the single source of truth) so anyone
    // approved after the track was selected is included in the race.
    const state = createInitialState(
      lobbyPlayers.map((p) =>
        createLobbyPlayer(p.connectionId, p.nickname, p.isHost, p.joinOrder, p.color)
      ),
      room.connectionId
    );
    state.trackId = trackId;
    state.totalLaps = [1, 2, 3].includes(totalLaps) ? totalLaps : 1;
    state.gameMode = gameMode === 'TIMED' ? 'TIMED' : 'TURNS';

    const track = getTrackById(trackId)!;

    // Timed races and solo practice skip grid qualifying: there is no
    // starting order to decide, so the race begins immediately.
    if (isTimedMode(state) || state.players.length === 1) {
      const sorted = [...state.players].sort((a, b) => a.joinOrder - b.joinOrder);
      this.placePlayersOnStartLine(state, track, sorted);
      state.turnOrder = sorted.map((p) => p.connectionId);
      state.currentTurnIndex = 0;
      state.round = 1;
      state.phase = 'GAME_ROUND';
      state.raceStartedAt = Date.now();
      this.setStateAndRelay('GRID_ORDER_DONE', state);
      return;
    }

    state.phase = 'GRID_ORDER';
    state.diceRolls = {};
    for (const p of state.players) {
      state.diceRolls[p.connectionId] = rollDice();
      p.diceRoll = state.diceRolls[p.connectionId];
    }
    this.setStateAndRelay('STATE_SYNC', state);

    if (this.gridOrderTimer) clearTimeout(this.gridOrderTimer);
    this.gridOrderTimer = setTimeout(() => this.finalizeGridOrder(), 2500);
  }

  submitMove(vector: Vector2D): void {
    const room = this.roomService.room;
    if (!room) return;

    if (this.isHost) {
      this.applyMove(room.connectionId, vector);
    } else {
      this.ws.send('FORWARD_TO_HOST', { action: 'SUBMIT_MOVE', vector }, room.roomCode);
    }
  }

  private finalizeGridOrder(): void {
    if (!this.isHost) return;
    const state = this.state;
    const track = state?.trackId ? getTrackById(state.trackId) : undefined;
    if (!state || !track || state.phase !== 'GRID_ORDER') return;

    const sorted = [...state.players].sort((a, b) => {
      const rollA = state.diceRolls[a.connectionId] ?? 0;
      const rollB = state.diceRolls[b.connectionId] ?? 0;
      if (rollB !== rollA) return rollB - rollA;
      return a.joinOrder - b.joinOrder;
    });

    state.turnOrder = sorted.map((p) => p.connectionId);
    this.placePlayersOnStartLine(state, track, sorted);
    state.round = 1;

    state.currentTurnIndex = 0;
    while (
      state.turnOrder.length > 0 &&
      state.players.find((p) => p.connectionId === state.turnOrder[state.currentTurnIndex])?.finishOrder !== undefined
    ) {
      state.currentTurnIndex = nextActiveTurnIndex(state);
    }

    state.phase = 'GAME_ROUND';
    state.raceStartedAt = Date.now();
    this.setStateAndRelay('GRID_ORDER_DONE', state);
  }

  private placePlayersOnStartLine(
    state: GameState,
    track: ReturnType<typeof getTrackById>,
    ordered: Player[]
  ): void {
    if (!track) return;
    ordered.forEach((player, idx) => {
      const start = track.startLine[idx % track.startLine.length];
      player.position = { ...start };
      player.velocity = zeroVector();
      player.isOffTrack = false;
      player.grassCuts = 0;
      player.gearPenaltyUntilRound = undefined;
      player.stopUntil = undefined;
      player.passedCheckpoint = false;
      player.trail = [{ ...start }];
      player.lap = 1;
    });
    // Record starting positions as seq=0 replay entries.
    state.replayLog = [];
    for (const player of ordered) {
      pushReplayMove(state, {
        round: 0,
        connectionId: player.connectionId,
        position: { ...player.position },
        velocity: { ...player.velocity },
        isOffTrack: player.isOffTrack,
        lap: player.lap,
      });
    }
  }

  private applyMove(senderId: string, vector: Vector2D): void {
    const state = this.state;
    if (!state || state.phase !== 'GAME_ROUND') return;

    if (!canPlayerMove(state, senderId)) return;

    const player = state.players.find((p) => p.connectionId === senderId);
    if (!player || player.finishOrder !== undefined) return;

    const track = getTrackById(state.trackId);
    if (!track) return;

    // Strict validation: the submitted velocity must be one of the moves the
    // host itself considers legal (±1 gear rule, off-track cap, in-grid landing,
    // including the emergency stop when no other move exists).
    const isLegal = getValidMoves(player, track, state.players, state.round).some(
      (m) => m.velocity.x === vector.x && m.velocity.y === vector.y
    );
    if (!isLegal) return;

    const from = { ...player.position };
    const landing = landingPosition(player.position, vector);

    if (findCollisionOpponent(senderId, from, landing, state.players)) {
      // Crash: stay put, kill momentum (gear 0). Never share a cell.
      player.velocity = zeroVector();
      pushReplayMove(state, {
        round: state.round,
        connectionId: senderId,
        position: { ...player.position },
        velocity: { ...player.velocity },
        isOffTrack: player.isOffTrack,
        lap: player.lap,
      });
      this.afterMove(state);
      return;
    }

    const tile = getTileAt(track, landing.x, landing.y);
    if (tile === null) return;

    const grassShortcut = isGrassShortcut(track, from, landing);

    player.position = landing;
    pushTrail(player, landing);

    if (tile === 'grass') {
      // Gravel trap: stop on the spot, kill momentum (gotcha #5 — only the
      // landing square matters for the off-track check).
      player.velocity = zeroVector();
      player.isOffTrack = true;
    } else {
      player.velocity = { ...vector };
      player.isOffTrack = false;
    }

    if (grassShortcut) {
      applyGrassPenalty(player, state);
    }

    if (track.checkpoint && !player.passedCheckpoint) {
      player.passedCheckpoint = segmentEntersRect(from, landing, track.checkpoint);
    }

    // Crossing the stripe (even flying over it) closes the lap — but only
    // after the far-side checkpoint, so the line can't be gamed on turn one.
    const crossedFinish =
      player.passedCheckpoint !== false && segmentCrossesFinish(track, from, landing);
    if (crossedFinish && player.finishOrder === undefined && tile !== 'grass') {
      const now = Date.now();
      player.lapTimes = [...(player.lapTimes ?? []), now];
      player.lapRounds = [...(player.lapRounds ?? []), state.round];

      if (player.lap < state.totalLaps) {
        // Lap done, more to go: rearm the checkpoint and erase the pen trail
        // so the sheet stays readable on the next tour.
        player.lap += 1;
        player.passedCheckpoint = false;
        player.trail = [{ ...landing }];
      } else {
        const pos = state.podium.length + 1;
        player.finishOrder = pos;
        player.finishRound = state.round;
        player.finishedAt = now;
        state.podium.push({
          connectionId: player.connectionId,
          nickname: player.nickname,
          position: pos,
        });
        this.setStateAndRelay('PLAYER_FINISHED', state, { finisher: player.nickname });
      }
    }

    // Record this move for the post-race replay (after all state mutations).
    pushReplayMove(state, {
      round: state.round,
      connectionId: senderId,
      position: { ...player.position },
      velocity: { ...player.velocity },
      isOffTrack: player.isOffTrack,
      lap: player.lap,
    });

    if (isGameOver(state)) {
      state.phase = 'GAME_OVER';
      this.setStateAndRelay('GAME_OVER', state);
      return;
    }

    this.afterMove(state);
  }

  private afterMove(state: GameState): void {
    if (isTimedMode(state)) {
      this.setStateAndRelay('TURN_ADVANCED', state);
      return;
    }
    this.advanceTurn(state);
  }

  private advanceTurn(state: GameState): void {
    if (isGameOver(state)) {
      state.phase = 'GAME_OVER';
      this.setStateAndRelay('GAME_OVER', state);
      return;
    }

    const prevIndex = state.currentTurnIndex;
    state.currentTurnIndex = nextActiveTurnIndex(state);
    if (state.currentTurnIndex <= prevIndex) {
      state.round += 1;
    }
    this.setStateAndRelay('TURN_ADVANCED', state);
  }

  private bootstrapLobbyState(): GameState {
    const room = this.roomService.room!;
    const players = this.roomService.players
      .filter((p) => p.status === 'approved')
      .map((p) =>
        createLobbyPlayer(p.connectionId, p.nickname, p.isHost, p.joinOrder, p.color)
      );
    const state = createInitialState(players, room.connectionId);
    const saved = this.session.load();
    if (saved?.trackId) state.trackId = saved.trackId;
    if (saved?.laps) state.totalLaps = saved.laps;
    if (saved?.gameMode) state.gameMode = saved.gameMode;
    this.emit(state);
    return state;
  }

  /**
   * Called when THIS client was promoted to host. Do not gate on
   * roomService.room.isHost here — that flag is updated by a separate
   * subscription and may not have flipped yet when the message arrives.
   */
  private requestHostStateRecovery(): void {
    const room = this.roomService.room;
    if (!room) return;
    this.ws.send('REQUEST_HOST_STATE', {}, room.roomCode);
    if (this.hostRecoveryTimer) clearTimeout(this.hostRecoveryTimer);
    this.hostRecoveryTimer = setTimeout(() => this.fallbackRecovery(), 5000);
  }

  private respondToHostStateRequest(requesterId: string): void {
    const state = this.state;
    const room = this.roomService.room;
    if (!state || !room || room.isHost) return;
    if (state.phase === 'LOBBY') return;
    this.ws.send('HOST_STATE_RESPONSE', { targetHostId: requesterId, state }, room.roomCode);
  }

  private applyHostSnapshot(state: GameState): void {
    // Only apply snapshots we actually asked for (recovery in flight).
    if (!this.hostRecoveryTimer) return;
    clearTimeout(this.hostRecoveryTimer);
    this.hostRecoveryTimer = null;
    if (!state.gameMode) state.gameMode = 'TURNS';
    if (!state.replayLog) state.replayLog = [];
    const myId = this.myId;
    state.hostId = myId ?? state.hostId;
    for (const p of state.players) {
      p.isHost = p.connectionId === state.hostId;
    }
    this.emit(state);

    // Purge the disconnected old host from the recovered snapshot and let
    // every peer converge on the cleaned state.
    if (this.pendingHostRemovalId) {
      const goneId = this.pendingHostRemovalId;
      this.pendingHostRemovalId = null;
      this.removePlayerFromState(goneId);
    } else {
      this.setStateAndRelay('STATE_SYNC', state);
    }
  }

  private fallbackRecovery(): void {
    const room = this.roomService.room;
    if (!room) return;
    this.pendingHostRemovalId = null;
    const state = this.bootstrapLobbyState();
    this.setStateAndRelay('STATE_SYNC', state);
  }

  private handleMessage(action: string, payload: unknown): void {
    switch (action) {
      case 'RELAY':
        this.applyRelay(payload as RelayPayload);
        break;
      case 'PLAYER_ACTION':
        if (this.isHost) this.handlePlayerAction(payload as Record<string, unknown>);
        break;
      case 'REQUEST_HOST_STATE':
        this.respondToHostStateRequest((payload as { requesterId: string }).requesterId);
        break;
      case 'HOST_STATE_RESPONSE':
        this.applyHostSnapshot((payload as { state: GameState }).state);
        break;
      case 'HOST_CHANGED': {
        const p = payload as { newHostId: string; previousHostId?: string };
        // Compare IDs directly: roomService's isHost flag is updated by another
        // subscription and may still be stale at this point.
        if (p.newHostId === this.myId) {
          this.pendingHostRemovalId = p.previousHostId ?? null;
          this.requestHostStateRecovery();
        }
        break;
      }
      case 'PLAYER_LEFT':
        if (this.isHost) this.handlePlayerLeft((payload as { connectionId: string }).connectionId);
        break;
      case 'PLAYER_REJOINED':
        this.handlePlayerRejoined(payload as PlayerRejoinedPayload);
        break;
    }
  }

  private handlePlayerLeft(connectionId: string): void {
    this.removePlayerFromState(connectionId);
  }

  private removePlayerFromState(connectionId: string): void {
    const state = this.state;
    if (!state) return;

    // Capture whose turn it is BEFORE mutating turnOrder — filtering shifts
    // indexes and would otherwise hand the turn to the wrong player.
    const currentId = state.turnOrder[state.currentTurnIndex];

    state.players = state.players.filter((p) => p.connectionId !== connectionId);
    state.turnOrder = state.turnOrder.filter((id) => id !== connectionId);
    delete state.diceRolls[connectionId];
    // Podium entries are kept: a finished player who leaves still earned their spot.

    if (state.turnOrder.length === 0) {
      this.emit(state);
      return;
    }

    if (currentId === connectionId) {
      // Leaver was mid-turn: the next player in order takes over.
      state.currentTurnIndex = state.currentTurnIndex % state.turnOrder.length;
    } else {
      state.currentTurnIndex = Math.max(0, state.turnOrder.indexOf(currentId));
    }

    if (state.phase === 'GAME_ROUND' && !isTimedMode(state)) {
      const active = state.players.find(
        (p) => p.connectionId === state.turnOrder[state.currentTurnIndex]
      );
      if (!active || active.finishOrder !== undefined) {
        state.currentTurnIndex = nextActiveTurnIndex(state);
      }
      if (isGameOver(state)) {
        state.phase = 'GAME_OVER';
        this.setStateAndRelay('GAME_OVER', state);
        return;
      }
    }

    this.setStateAndRelay('STATE_SYNC', state);
  }

  private handlePlayerRejoined(payload: PlayerRejoinedPayload): void {
    const state = this.state;
    if (!state || !this.isHost) return;

    const { oldConnectionId, newConnectionId, player } = payload;
    state.turnOrder = state.turnOrder.map((id) => (id === oldConnectionId ? newConnectionId : id));

    if (state.diceRolls[oldConnectionId] !== undefined) {
      state.diceRolls[newConnectionId] = state.diceRolls[oldConnectionId];
      delete state.diceRolls[oldConnectionId];
    }

    state.podium = state.podium.map((e) =>
      e.connectionId === oldConnectionId ? { ...e, connectionId: newConnectionId } : e
    );

    const idx = state.players.findIndex((p) => p.connectionId === oldConnectionId);
    const merged: Player = {
      ...player,
      connectionId: newConnectionId,
      position: player.position ?? { x: 0, y: 0 },
      velocity: player.velocity ?? { x: 0, y: 0 },
      isOffTrack: player.isOffTrack ?? false,
      trail: player.trail ?? [],
      lap: player.lap ?? 1,
    };
    if (idx >= 0) {
      merged.position = state.players[idx].position;
      merged.velocity = state.players[idx].velocity;
      merged.isOffTrack = state.players[idx].isOffTrack;
      merged.trail = state.players[idx].trail ?? [];
      merged.lap = state.players[idx].lap ?? 1;
      merged.passedCheckpoint = state.players[idx].passedCheckpoint;
      merged.diceRoll = state.players[idx].diceRoll;
      merged.finishOrder = state.players[idx].finishOrder;
      merged.finishRound = state.players[idx].finishRound;
      merged.finishedAt = state.players[idx].finishedAt;
      merged.lapTimes = state.players[idx].lapTimes;
      merged.lapRounds = state.players[idx].lapRounds;
      merged.grassCuts = state.players[idx].grassCuts;
      merged.gearPenaltyUntilRound = state.players[idx].gearPenaltyUntilRound;
      merged.stopUntil = state.players[idx].stopUntil;
      state.players[idx] = merged;
    } else {
      state.players.push(merged);
    }

    if (state.hostId === oldConnectionId) {
      state.hostId = newConnectionId;
    }

    this.setStateAndRelay('STATE_SYNC', state);
  }

  private applyRelay(relay: RelayPayload): void {
    if (this.isHost) return;
    const state = relay.state;
    if (!state.gameMode) state.gameMode = 'TURNS';
    if (!state.replayLog) state.replayLog = [];
    this.emit(state);
  }

  private handlePlayerAction(action: Record<string, unknown>): void {
    const senderId = action['senderId'] as string;
    if (!senderId) return;
    switch (action['action']) {
      // Track selection is host-only; forwarded SELECT_TRACK actions are ignored.
      case 'SUBMIT_MOVE': {
        const vector = action['vector'] as Vector2D;
        if (
          !vector ||
          typeof vector.x !== 'number' ||
          typeof vector.y !== 'number' ||
          !Number.isInteger(vector.x) ||
          !Number.isInteger(vector.y)
        ) {
          return;
        }
        this.applyMove(senderId, vector);
        break;
      }
    }
  }

  private setStateAndRelay(type: RelayPayload['type'], state: GameState, meta?: Record<string, unknown>): void {
    this.emit(state);
    const room = this.roomService.room;
    if (!room?.isHost) return;
    const telemetry = buildRaceTelemetry(state);
    const relayMeta = telemetry ? { ...meta, telemetry } : meta;
    this.ws.send('RELAY', { type, state, meta: relayMeta }, room.roomCode);
  }

  currentPlayer(): Player | null {
    const state = this.state;
    if (!state || state.phase !== 'GAME_ROUND') return null;
    const id = state.turnOrder[state.currentTurnIndex];
    return state.players.find((p) => p.connectionId === id) ?? null;
  }

  isMyTurn(): boolean {
    const id = this.myId;
    const state = this.state;
    if (!id || !state) return false;
    return canPlayerMove(state, id);
  }

  ensureLobbyState(): void {
    if (!this.state && this.roomService.room) {
      this.bootstrapLobbyState();
    }
  }

  ngOnDestroy(): void {
    this.messageSub?.unsubscribe();
    if (this.hostRecoveryTimer) clearTimeout(this.hostRecoveryTimer);
    if (this.gridOrderTimer) clearTimeout(this.gridOrderTimer);
  }

  reset(): void {
    if (this.gridOrderTimer) clearTimeout(this.gridOrderTimer);
    this.stateSubject.next(null);
  }
}
