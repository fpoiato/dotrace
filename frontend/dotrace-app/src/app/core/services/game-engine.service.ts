import { Injectable, OnDestroy, inject } from '@angular/core';
import { BehaviorSubject, Subscription } from 'rxjs';
import { getTrackById } from '../models/tracks';
import {
  BotSkill,
  DEFAULT_BOT_SKILL,
  GameMode,
  GameState,
  MAX_BOTS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  Player,
  PlayerRejoinedPayload,
  RelayPayload,
  Vector2D,
  applyGrassPenalty,
  botsOf,
  canPlayerMove,
  createBotPlayer,
  createInitialState,
  createLobbyPlayer,
  getTileAt,
  getValidMoves,
  isGameOver,
  isGrassShortcut,
  isTimedMode,
  landingPosition,
  lobbyRosterWithBots,
  nextActiveTurnIndex,
  pickBotIdentity,
  pushReplayMove,
  pushTrail,
  remapSessionStatsConnectionId,
  rollDice,
  segmentCrossesFinish,
  segmentEntersRect,
  updateSessionStats,
  buildRaceStatDeltas,
  zeroVector,
  buildRaceTelemetry,
} from '../models/ws-types';
import { botTurnDelayMs, chooseBotMove } from '../models/bot-ai';
import { ApiService } from './api.service';
import { RoomService } from './room.service';
import { SessionStorageService } from './session-storage.service';
import { WebSocketService } from './websocket.service';

@Injectable({ providedIn: 'root' })
export class GameEngineService implements OnDestroy {
  private readonly ws = inject(WebSocketService);
  private readonly api = inject(ApiService);
  private readonly roomService = inject(RoomService);
  private readonly session = inject(SessionStorageService);

  private readonly stateSubject = new BehaviorSubject<GameState | null>(null);
  readonly state$ = this.stateSubject.asObservable();

  private messageSub: Subscription | null = null;
  private roomSub: Subscription | null = null;
  private hostRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private gridOrderTimer: ReturnType<typeof setTimeout> | null = null;
  /** Pending "thinking" pause per CPU racer, keyed by its synthetic id. */
  private readonly botTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
    this.scheduleBotTurns();
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
    // Being promoted to host mid-race means taking over its CPU racers. The
    // host flag lands on a different stream than the state snapshot, so watch
    // it directly rather than waiting for the next relay to notice.
    this.roomSub = this.roomService.room$.subscribe(() => this.scheduleBotTurns());
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

  /** CPU racers currently on the grid, in join order. */
  get bots(): Player[] {
    return botsOf(this.state?.players ?? []);
  }

  /** Difficulty shown in the lobby — one setting for the whole CPU field. */
  get botSkill(): BotSkill {
    return this.bots[0]?.botSkill ?? this.session.load()?.botSkill ?? DEFAULT_BOT_SKILL;
  }

  canAddBot(): boolean {
    const humans = this.roomService.players.filter((p) => p.status === 'approved').length;
    const bots = this.bots.length;
    return bots < MAX_BOTS && humans + bots < MAX_PLAYERS;
  }

  /**
   * Host-only: put another CPU racer on the grid.
   *
   * Bots exist only in game state — no WebSocket connection, no DynamoDB
   * record. The host drives them locally and every other client learns about
   * them through the ordinary RELAY snapshots, so they need no server support.
   */
  addBot(skill: BotSkill = this.botSkill): void {
    if (!this.isHost || !this.canAddBot()) return;
    const state = this.state ?? this.bootstrapLobbyState();
    if (state.phase !== 'LOBBY') return;

    const bots = botsOf(state.players);
    const identity = pickBotIdentity(this.lobbyRoster(bots));
    this.session.save({ botSkill: skill });
    // Join order is provisional: setLobbyRoster renumbers the CPU field behind
    // whoever the server has approved by then.
    this.setLobbyRoster(state, [
      ...bots,
      createBotPlayer(identity.nickname, bots.length, identity.color, skill),
    ]);
  }

  /** Host-only: take a CPU racer off the grid (the newest one by default). */
  removeBot(connectionId?: string): void {
    if (!this.isHost) return;
    const state = this.state;
    if (!state || state.phase !== 'LOBBY') return;

    const bots = botsOf(state.players);
    if (bots.length === 0) return;
    const target = connectionId ?? bots[bots.length - 1].connectionId;
    this.setLobbyRoster(
      state,
      bots.filter((b) => b.connectionId !== target)
    );
  }

  /** Host-only: set the difficulty of the whole CPU field. */
  setBotSkill(skill: BotSkill): void {
    if (!this.isHost) return;
    const state = this.state ?? this.bootstrapLobbyState();
    if (state.phase !== 'LOBBY') return;
    this.session.save({ botSkill: skill });
    this.setLobbyRoster(
      state,
      botsOf(state.players).map((b) => ({ ...b, botSkill: skill }))
    );
  }

  /** Rebuilt from players$ every time, so late joiners are never left out. */
  private lobbyRoster(bots: Player[]): Player[] {
    const humans = this.roomService.players
      .filter((p) => p.status === 'approved')
      .map((p) =>
        createLobbyPlayer(p.connectionId, p.nickname, p.isHost, p.joinOrder, p.color)
      );
    return lobbyRosterWithBots(humans, bots);
  }

  private setLobbyRoster(state: GameState, bots: Player[]): void {
    state.players = this.lobbyRoster(bots);
    this.setStateAndRelay('STATE_SYNC', state);
  }

  startRace(): void {
    if (!this.isHost) return;
    const room = this.roomService.room;
    const lobbyPlayers = this.roomService.players.filter((p) => p.status === 'approved');
    if (!room || lobbyPlayers.length < MIN_PLAYERS) return;

    const saved = this.session.load();
    const prev = this.state;
    const trackId = prev?.trackId || saved?.trackId || '';
    if (!trackId || !getTrackById(trackId)) return;
    const totalLaps = prev?.totalLaps ?? saved?.laps ?? 1;
    const gameMode = prev?.gameMode ?? saved?.gameMode ?? 'TURNS';
    // Keep party-session ranking across rematches in the same room.
    const sessionStats = prev?.sessionStats;

    // Rebuild the roster from players$ (the single source of truth) so anyone
    // approved after the track was selected is included in the race, keeping
    // the CPU racers the host added in the lobby.
    const state = createInitialState(
      this.lobbyRoster(botsOf(prev?.players ?? [])),
      room.connectionId
    );
    state.trackId = trackId;
    state.totalLaps = [1, 2, 3].includes(totalLaps) ? totalLaps : 1;
    state.gameMode = gameMode === 'TIMED' ? 'TIMED' : 'TURNS';
    if (sessionStats?.length) state.sessionStats = sessionStats;

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
      void this.api
        .postAction('FORWARD_TO_HOST', { action: 'SUBMIT_MOVE', vector }, room.roomCode)
        .catch((err) => console.warn('Move forward failed', err));
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

    const tile = getTileAt(track, landing.x, landing.y);
    if (tile === null) return;

    const grassShortcut = isGrassShortcut(track, from, landing);

    player.position = landing;
    pushTrail(player, landing);

    if (tile === 'grass' || tile === 'rumble') {
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
    if (crossedFinish && player.finishOrder === undefined && tile !== 'grass' && tile !== 'rumble') {
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

    if (this.tryEndRace(state)) return;

    this.afterMove(state);
  }

  /**
   * Host-only: keep a pending move armed for every CPU racer that is due to
   * play. Driven off every state emission, so a bot picks up its turn whatever
   * moved the race on — a human, another bot, or a player rejoining.
   */
  private scheduleBotTurns(): void {
    const state = this.state;
    if (!this.isHost || !state || state.phase !== 'GAME_ROUND') {
      this.clearBotTimers();
      return;
    }

    const due = new Map<string, number>();
    for (const bot of botsOf(state.players)) {
      const wait = botTurnDelayMs(state, bot);
      if (wait !== null) due.set(bot.connectionId, wait);
    }

    for (const [id, timer] of this.botTimers) {
      if (due.has(id)) continue;
      clearTimeout(timer);
      this.botTimers.delete(id);
    }

    for (const [id, wait] of due) {
      if (this.botTimers.has(id)) continue;
      this.botTimers.set(
        id,
        setTimeout(() => {
          this.botTimers.delete(id);
          this.playBotTurn(id);
        }, wait)
      );
    }
  }

  private playBotTurn(connectionId: string): void {
    const state = this.state;
    if (!this.isHost || !state || state.phase !== 'GAME_ROUND') return;

    const bot = state.players.find((p) => p.connectionId === connectionId);
    const track = getTrackById(state.trackId);
    // The race may have moved on while the bot was "thinking".
    if (!bot || !track || !canPlayerMove(state, connectionId)) {
      this.scheduleBotTurns();
      return;
    }

    const vector = chooseBotMove(state, bot, track);
    if (!vector) {
      this.scheduleBotTurns();
      return;
    }
    // Straight through the same validation a forwarded human move gets.
    this.applyMove(connectionId, vector);
  }

  private clearBotTimers(): void {
    for (const timer of this.botTimers.values()) clearTimeout(timer);
    this.botTimers.clear();
  }

  private afterMove(state: GameState, meta?: Record<string, unknown>): void {
    if (isTimedMode(state)) {
      this.setStateAndRelay('TURN_ADVANCED', state, meta);
      return;
    }
    this.advanceTurn(state, meta);
  }

  private advanceTurn(state: GameState, meta?: Record<string, unknown>): void {
    if (this.tryEndRace(state)) return;

    const prevIndex = state.currentTurnIndex;
    state.currentTurnIndex = nextActiveTurnIndex(state);
    if (state.currentTurnIndex <= prevIndex) {
      state.round += 1;
    }
    this.setStateAndRelay('TURN_ADVANCED', state, meta);
  }

  /**
   * Transition to GAME_OVER exactly once, folding race results into sessionStats.
   * Returns true when the race ended (caller should stop further turn advances).
   */
  private tryEndRace(state: GameState): boolean {
    if (state.phase === 'GAME_OVER' || !isGameOver(state)) return false;
    state.phase = 'GAME_OVER';
    updateSessionStats(state);
    this.setStateAndRelay('GAME_OVER', state);
    this.submitGlobalRaceStats(state);
    return true;
  }

  /** Persist this race's deltas into the global nickname leaderboard (host only). */
  private submitGlobalRaceStats(state: GameState): void {
    if (!this.isHost) return;
    const room = this.roomService.room;
    if (!room) return;
    const stats = buildRaceStatDeltas(state);
    if (stats.length === 0) return;
    void this.api
      .postAction('SUBMIT_RACE_STATS', { stats }, room.roomCode)
      .catch((err) => console.warn('Race stats submit failed', err));
  }

  /**
   * Host-only: after a finished race, return everyone to the lobby keeping
   * track/laps/mode and the session ranking so the party can rematch.
   */
  returnToLobby(): void {
    if (!this.isHost) return;
    const current = this.state;
    const room = this.roomService.room;
    if (!current || !room || current.phase !== 'GAME_OVER') return;

    if (this.gridOrderTimer) {
      clearTimeout(this.gridOrderTimer);
      this.gridOrderTimer = null;
    }

    const state = createInitialState(
      this.lobbyRoster(botsOf(current.players)),
      room.connectionId
    );
    state.trackId = current.trackId || '';
    state.totalLaps = [1, 2, 3].includes(current.totalLaps) ? current.totalLaps : 1;
    state.gameMode = current.gameMode === 'TIMED' ? 'TIMED' : 'TURNS';
    if (current.sessionStats?.length) state.sessionStats = current.sessionStats;
    this.session.save({
      trackId: state.trackId || undefined,
      laps: state.totalLaps,
      gameMode: state.gameMode,
    });
    this.setStateAndRelay('STATE_SYNC', state);
  }

  private bootstrapLobbyState(): GameState {
    const room = this.roomService.room!;
    const state = createInitialState(
      this.lobbyRoster(botsOf(this.state?.players ?? [])),
      room.connectionId
    );
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
    void this.api
      .postAction('REQUEST_HOST_STATE', {}, room.roomCode)
      .catch((err) => console.warn('Host state request failed', err));
    if (this.hostRecoveryTimer) clearTimeout(this.hostRecoveryTimer);
    this.hostRecoveryTimer = setTimeout(() => this.fallbackRecovery(), 5000);
  }

  private respondToHostStateRequest(requesterId: string): void {
    const state = this.state;
    const room = this.roomService.room;
    if (!state || !room || room.isHost) return;
    if (state.phase === 'LOBBY') return;
    void this.api
      .postAction('HOST_STATE_RESPONSE', { targetHostId: requesterId, state }, room.roomCode)
      .catch((err) => console.warn('Host state response failed', err));
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
      if (this.tryEndRace(state)) return;
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
    remapSessionStatsConnectionId(state, oldConnectionId, newConnectionId);

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
    void this.api
      .postAction('RELAY', { type, state, meta: relayMeta }, room.roomCode)
      .catch((err) => console.warn('Relay failed', err));
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
    this.roomSub?.unsubscribe();
    this.clearBotTimers();
    if (this.hostRecoveryTimer) clearTimeout(this.hostRecoveryTimer);
    if (this.gridOrderTimer) clearTimeout(this.gridOrderTimer);
  }

  reset(): void {
    if (this.gridOrderTimer) clearTimeout(this.gridOrderTimer);
    this.clearBotTimers();
    this.stateSubject.next(null);
  }
}
