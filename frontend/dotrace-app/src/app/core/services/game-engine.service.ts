import { Injectable, OnDestroy, inject } from '@angular/core';
import { BehaviorSubject, Subject, Subscription } from 'rxjs';
import { getTrackById } from '../models/tracks';
import { replayChunks, slimBoard } from '../../features/game/relay-board';
import {
  GameMode,
  GameState,
  MIN_PLAYERS,
  Player,
  PlayerRejoinedPayload,
  RelayPayload,
  Vector2D,
  applyGrassPenalty,
  armDrsZones,
  syncDrsArms,
  beginNextLap,
  BoostRequest,
  canPlayerMove,
  createInitialState,
  createLobbyPlayer,
  engageRequestedDrs,
  gearOf,
  getTileAt,
  getValidMoves,
  isGameOver,
  isGearLimited,
  isGrassShortcut,
  isTimedMode,
  landingPosition,
  nextActiveTurnIndex,
  pushReplayMove,
  pushTrail,
  racingProgress,
  revertDrsOpen,
  settleBoostFromGears,
  spendErsIfAccepted,
  adoptNicknameConnection,
  retargetLocalPlayer,
  aiTurnToken,
  isAiPilotNickname,
  remapPlayerConnection,
  rollDice,
  segmentCrossesFinish,
  segmentEntersRect,
  updateSessionStats,
  buildRaceStatDeltas,
  zeroVector,
  buildRaceTelemetry,
  fuelEnabled,
  FUEL_RESERVE,
  FUEL_TANK,
  isLapOption,
  settleFuel,
  isPitTile,
  ownPitBox,
  DRS_MAX_GEAR,
  ERS_MAX_DELTA,
  MAX_GEAR,
  settlePitVisit,
  closeDrsOutsideZone,
} from '../models/ws-types';
import { ApiService } from './api.service';
import { RoomContext, RoomService } from './room.service';
import { SessionStorageService } from './session-storage.service';
import { WebSocketService } from './websocket.service';

/** Only the buttons the pilot actually pressed travel with the move. */
function requestedBoost(boost?: BoostRequest): BoostRequest | undefined {
  if (!boost?.drs && !boost?.ers) return undefined;
  return { drs: !!boost.drs, ers: !!boost.ers };
}

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
  /** Socket id this phone last used. A change means the car must be retargeted. */
  private localConnectionId: string | null = null;
  private hostRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private gridOrderTimer: ReturnType<typeof setTimeout> | null = null;
  /** Re-broadcast / retry when the seat on the clock has not moved. */
  private turnNudgeTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly TURN_NUDGE_MS = 5_000;
  /** Host plays the bot locally if the seat is still waiting. A retry in flight is not an excuse to drop the nudge. */
  private static readonly BOT_NUDGE_MS = 12_000;
  /** Human phones listen for this and show the "jogue agora!" countdown. */
  readonly playNow$ = new Subject<string>();
  /** Fast local moves once only bots are left, so the human is not waiting on Lambda. */
  private rushTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly AI_RUSH_MS = 70;
  private readonly aiFollowUps = new Map<string, ReturnType<typeof setTimeout>>();
  /** Seats with a PLAY_AI_TURN already in flight, so a nudge cannot double-request. */
  private readonly aiInFlight = new Set<string>();
  private static readonly AI_TURN_TIMEOUT_MS = 10_000;
  private static readonly AI_TIMED_GAP_MS = 400;
  private static readonly AI_RETRY_MS = 1_800;
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
    this.noteSeatClock(state);
    this.stateSubject.next(structuredClone(state));
  }

  /** Wall clock for the seat on the turn. A hidden phone freezes timers, not this. */
  private seatKey = '';
  private seatSince = 0;
  private lastRecover = 0;

  private noteSeatClock(state: GameState): void {
    if (state.phase !== 'GAME_ROUND' || isTimedMode(state)) return;
    const seat = state.turnOrder[state.currentTurnIndex];
    const key = `${state.round}:${state.currentTurnIndex}:${seat}`;
    if (key === this.seatKey) return;
    this.seatKey = key;
    this.seatSince = Date.now();
  }

  /**
   * A pause of a few seconds used to leave round 94 stuck: background timers
   * never fired. Recover from the clock as soon as the page runs again.
   */
  recoverIfStale(): void {
    const state = this.state;
    if (!state || state.phase !== 'GAME_ROUND' || isTimedMode(state)) return;
    this.noteSeatClock(state);
    if (!this.seatSince) return;
    const player = this.currentPlayer();
    const limit = player && this.isBotSeat(player) ? 6_000 : 5_000;
    if (Date.now() - this.seatSince < limit) return;
    if (Date.now() - this.lastRecover < 4_000) return;
    this.lastRecover = Date.now();
    this.wakeOpponents();
  }

  get isHost(): boolean {
    return this.roomService.room?.isHost ?? false;
  }

  get myId(): string | null {
    return this.roomService.room?.connectionId ?? this.ws.connectionId;
  }

  /**
   * The phone's socket id changes on every reconnect. The race board does not,
   * so the car (and the turn) must follow the new id or the pad stays disabled
   * on "Aguardando …" for the player who is holding the phone.
   */
  private retargetSelf(room: RoomContext | null): void {
    if (!room) {
      this.localConnectionId = null;
      return;
    }
    const previous = this.localConnectionId;
    this.localConnectionId = room.connectionId;
    const state = this.state;
    if (!state) return;
    if (!retargetLocalPlayer(state, previous, room.connectionId, room.nickname)) return;
    this.setStateAndRelay('STATE_SYNC', state);
  }

  init(): void {
    if (this.messageSub) return;
    this.messageSub = this.ws.messages$.subscribe((msg) => this.handleMessage(msg.action, msg.payload));
    this.roomSub = this.roomService.room$.subscribe((room) => this.retargetSelf(room));
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
    if (!isLapOption(laps)) return;
    const state = this.state ?? this.bootstrapLobbyState();
    state.totalLaps = laps;
    this.session.save({ laps });
    this.setStateAndRelay('STATE_SYNC', state);
  }

  selectGameMode(_mode: GameMode): void {
    if (!this.isHost) return;
    const state = this.state ?? this.bootstrapLobbyState();
    state.gameMode = 'TURNS';
    this.session.save({ gameMode: 'TURNS' });
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
    const gameMode = 'TURNS';
    // Keep party-session ranking across rematches in the same room.
    const sessionStats = prev?.sessionStats;

    // Rebuild the roster from players$ (the single source of truth) so anyone
    // approved after the track was selected is included in the race.
    const state = createInitialState(
      lobbyPlayers.map((p) =>
        createLobbyPlayer(p.connectionId, p.nickname, p.isHost, p.joinOrder, p.color)
      ),
      room.connectionId
    );
    state.trackId = trackId;
    state.totalLaps = isLapOption(totalLaps) ? totalLaps : 1;
    state.gameMode = gameMode;
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
      this.recordRaceStarted(state.raceStartedAt);
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

  submitMove(vector: Vector2D, boost?: BoostRequest): void {
    const room = this.roomService.room;
    if (!room) return;
    this.retargetSelf(room);

    const request = requestedBoost(boost);
    if (this.isHost) {
      this.applyMove(room.connectionId, vector, request);
    } else {
      void this.api
        .postAction(
          'FORWARD_TO_HOST',
          { action: 'SUBMIT_MOVE', vector, ...request },
          room.roomCode
        )
        .catch((err) => console.warn('Move forward failed', err));
    }
  }

  /**
   * Human asked to stop waiting. Remaining cars are left unfinished (DNF)
   * and the race closes.
   */
  endRaceNow(): void {
    const room = this.roomService.room;
    if (!room) return;
    if (this.isHost) {
      this.forceEndRace();
      return;
    }
    void this.api
      .postAction('FORWARD_TO_HOST', { action: 'END_RACE' }, room.roomCode)
      .catch((err) => console.warn('End race forward failed', err));
  }

  private forceEndRace(): void {
    const state = this.state;
    if (!state || state.phase !== 'GAME_ROUND') return;
    if (this.rushTimer) {
      clearTimeout(this.rushTimer);
      this.rushTimer = null;
    }
    state.phase = 'GAME_OVER';
    updateSessionStats(state);
    this.setStateAndRelay('GAME_OVER', state);
    this.submitGlobalRaceStats(state);
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
    this.recordRaceStarted(state.raceStartedAt);
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
      player.drsArmed = false;
      player.drsActive = false;
      player.drsZonesUsed = [];
      player.ersCharge = 0;
      player.ersActive = false;
      player.fuel = fuelEnabled(state.totalLaps) ? FUEL_TANK : undefined;
      player.pitBoxIndex = idx;
      player.driveThroughArmed = false;
      player.driveThroughOwed = 0;
      player.pitHoldUntilRound = undefined;
      player.disqualified = false;
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
        grassCuts: player.grassCuts ?? 0,
      });
    }
  }

  private applyMove(senderId: string, vector: Vector2D, request?: BoostRequest): boolean {
    const state = this.state;
    if (!state || state.phase !== 'GAME_ROUND') return false;

    if (!canPlayerMove(state, senderId)) return false;

    const player = state.players.find((p) => p.connectionId === senderId);
    if (!player || player.finishOrder !== undefined) return false;

    const track = getTrackById(state.trackId);
    if (!track) return false;

    // DRS opens before the gear check so gear 8 is legal on this move only
    // when the button was actually armed in the blue zone. A rejected vector
    // rolls that back and does not spend ERS.
    const armedBefore = player.drsArmed;
    const activeBefore = player.drsActive;
    const chargeBefore = player.ersCharge;
    const limits = engageRequestedDrs(player, state.round, request);
    const isLegal = getValidMoves(
      player,
      track,
      state.players,
      state.round,
      limits.maxGear,
      limits.maxDelta,
      limits.spendErs
    ).some((m) => m.velocity.x === vector.x && m.velocity.y === vector.y);
    if (!isLegal) {
      revertDrsOpen(player, activeBefore, armedBefore);
      return false;
    }
    spendErsIfAccepted(player, limits);

    const previousGear = gearOf(player.velocity);
    const from = { ...player.position };
    const landing = landingPosition(player.position, vector);

    const tile = getTileAt(track, landing.x, landing.y);
    if (tile === null) {
      revertDrsOpen(player, activeBefore, armedBefore);
      player.ersCharge = chargeBefore;
      return false;
    }

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
    settleBoostFromGears(player, previousGear, gearOf(player.velocity));
    closeDrsOutsideZone(player, track);
    player.ersActive = limits.spendErs;
    settleFuel(player, gearOf(player.velocity), limits.spendErs);
    settlePitVisit(player, track, tile, state.round);

    if (grassShortcut) {
      applyGrassPenalty(player, state);
    }

    if (track.checkpoint && !player.passedCheckpoint) {
      player.passedCheckpoint = segmentEntersRect(from, landing, track.checkpoint);
    }
    armDrsZones(player, from, landing, state.players, track);

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
        beginNextLap(player);
        player.trail = [{ ...landing }];
      } else if ((player.driveThroughOwed ?? 0) > 0) {
        player.disqualified = true;
        player.finishOrder = 100 + state.players.length;
        player.finishRound = state.round;
        player.finishedAt = now;
        this.setStateAndRelay('PLAYER_FINISHED', state, { finisher: player.nickname, dsq: true });
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

    // Anyone already standing on blue can arm now, including the car that
    // just stepped onto the zone and a trailer who was overtaken there.
    syncDrsArms(state.players, track);

    // Record this move for the post-race replay (after all state mutations).
    pushReplayMove(state, {
      round: state.round,
      connectionId: senderId,
      position: { ...player.position },
      velocity: { ...player.velocity },
      isOffTrack: player.isOffTrack,
      lap: player.lap,
      drsActive: !!player.drsActive,
      ersActive: !!player.ersActive,
      grassCuts: player.grassCuts ?? 0,
      gearPenaltyUntilRound: player.gearPenaltyUntilRound,
      stopUntil: player.stopUntil,
      fuel: player.fuel,
      driveThroughOwed: player.driveThroughOwed,
      disqualified: player.disqualified,
    });

    if (this.tryEndRace(state)) return true;

    this.afterMove(state);
    return true;
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
    if (this.servePitHold(state)) return;
    this.setStateAndRelay('TURN_ADVANCED', state, meta);
  }

  /** A car in its own box sits out exactly one following round, then is released. */
  private servePitHold(state: GameState): boolean {
    const id = state.turnOrder[state.currentTurnIndex];
    const player = state.players.find((p) => p.connectionId === id);
    if (!player || player.finishOrder !== undefined) return false;
    if (player.pitHoldUntilRound === undefined || state.round > player.pitHoldUntilRound) return false;
    player.velocity = zeroVector();
    player.pitHoldUntilRound = undefined;
    pushReplayMove(state, {
      round: state.round,
      connectionId: player.connectionId,
      position: { ...player.position },
      velocity: { ...player.velocity },
      isOffTrack: player.isOffTrack,
      lap: player.lap,
      fuel: player.fuel,
      driveThroughOwed: player.driveThroughOwed,
      disqualified: player.disqualified,
      grassCuts: player.grassCuts ?? 0,
    });
    this.advanceTurn(state, { pitStop: player.nickname });
    return true;
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

  /** Persist this race's deltas and the finish counter (host only, no screen). */
  private submitGlobalRaceStats(state: GameState): void {
    if (!this.isHost) return;
    const room = this.roomService.room;
    if (!room) return;
    const stats = buildRaceStatDeltas(state);
    const raceStartedAt = state.raceStartedAt;
    const durationMs =
      typeof raceStartedAt === 'number' ? Math.max(0, Date.now() - raceStartedAt) : undefined;
    if (stats.length === 0 && durationMs === undefined) return;
    void this.api
      .postAction('SUBMIT_RACE_STATS', { stats, raceStartedAt, durationMs }, room.roomCode)
      .catch((err) => console.warn('Race stats submit failed', err));
  }

  /** Count the green flag once. A retry with the same timestamp is ignored server-side. */
  private recordRaceStarted(raceStartedAt: number): void {
    if (!this.isHost) return;
    const room = this.roomService.room;
    if (!room) return;
    void this.api
      .postAction('RECORD_RACE_START', { raceStartedAt }, room.roomCode)
      .catch((err) => console.warn('Race start counter failed', err));
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

    const players = this.roomService.players
      .filter((p) => p.status === 'approved')
      .map((p) =>
        createLobbyPlayer(p.connectionId, p.nickname, p.isHost, p.joinOrder, p.color)
      );
    const state = createInitialState(players, room.connectionId);
    state.trackId = current.trackId || '';
    state.totalLaps = isLapOption(current.totalLaps) ? current.totalLaps : 1;
    state.gameMode = 'TURNS';
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
    const players = this.roomService.players
      .filter((p) => p.status === 'approved')
      .map((p) =>
        createLobbyPlayer(p.connectionId, p.nickname, p.isHost, p.joinOrder, p.color)
      );
    const state = createInitialState(players, room.connectionId);
    const saved = this.session.load();
    if (saved?.trackId) state.trackId = saved.trackId;
    if (saved?.laps && isLapOption(saved.laps)) state.totalLaps = saved.laps;
    state.gameMode = 'TURNS';
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
      .postAction(
        'HOST_STATE_RESPONSE',
        { targetHostId: requesterId, state: slimBoard(state) },
        room.roomCode
      )
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

    // AI Lambdas disconnect in finally() right after GAME_OVER. Keep them in
    // the roster so the in-app replay still has nickname/color for their trail.
    if (state.phase === 'GAME_OVER') {
      return;
    }

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
    const existing = state.players.find((p) => p.connectionId === oldConnectionId);
    remapPlayerConnection(state, oldConnectionId, newConnectionId);

    const merged: Player = {
      ...player,
      connectionId: newConnectionId,
      position: existing?.position ?? player.position ?? { x: 0, y: 0 },
      velocity: existing?.velocity ?? player.velocity ?? { x: 0, y: 0 },
      isOffTrack: existing?.isOffTrack ?? player.isOffTrack ?? false,
      trail: existing?.trail ?? player.trail ?? [],
      lap: existing?.lap ?? player.lap ?? 1,
      passedCheckpoint: existing?.passedCheckpoint ?? player.passedCheckpoint,
      diceRoll: existing?.diceRoll ?? player.diceRoll,
      finishOrder: existing?.finishOrder,
      finishRound: existing?.finishRound,
      finishedAt: existing?.finishedAt,
      lapTimes: existing?.lapTimes,
      lapRounds: existing?.lapRounds,
      grassCuts: existing?.grassCuts,
      gearPenaltyUntilRound: existing?.gearPenaltyUntilRound,
      stopUntil: existing?.stopUntil,
      drsArmed: existing?.drsArmed ?? player.drsArmed,
      drsActive: existing?.drsActive ?? player.drsActive,
      drsZonesUsed: existing?.drsZonesUsed ?? player.drsZonesUsed,
      ersCharge: existing?.ersCharge ?? player.ersCharge,
    };
    const idx = state.players.findIndex((p) => p.connectionId === newConnectionId);
    if (idx >= 0) state.players[idx] = merged;
    else state.players.push(merged);

    this.setStateAndRelay('STATE_SYNC', state);
  }

  /**
   * A rotated AI Lambda submits with a new socket id. Retarget the car that
   * still carries that nickname so the move is not dropped as "not your turn".
   */
  private adoptRejoinedSeat(connectionId: string, nickname: string | undefined): boolean {
    const state = this.state;
    if (!state || !nickname) return false;
    return adoptNicknameConnection(state, nickname, connectionId);
  }

  /** Replay lives in Dynamo. The socket only said the race ended. */
  private loadLiveReplay(): void {
    const room = this.roomService.room;
    if (!room || !this.state) return;
    void this.api
      .postAction<{ moves?: unknown[] }>('GET_LIVE_REPLAY', {}, room.roomCode)
      .then((response) => {
        const moves = (response.payload as { moves?: unknown[] } | undefined)?.moves;
        if (!this.state || !Array.isArray(moves) || moves.length === 0) return;
        this.state.replayLog = moves as GameState['replayLog'];
        this.emit(this.state);
      })
      .catch((err) => console.warn('Replay load failed', err));
  }

  private applyRelay(relay: RelayPayload): void {

    if (this.isHost) return;
    const chunk = relay.meta?.['replayMoves'];
    if (Array.isArray(chunk) && this.state) {
      const seq = Number(relay.meta?.['replaySeq'] ?? 0);
      const log = this.state.replayLog ?? [];
      if (seq === log.length) {
        this.state.replayLog = log.concat(chunk);
        this.emit(this.state);
      }
      return;
    }
    const state = relay.state;
    if (!state.gameMode) state.gameMode = 'TURNS';
    if (!state.replayLog) state.replayLog = [];
    this.notePlayNow(relay.meta);
    this.emit(state);
    if (relay.type === 'GAME_OVER') this.loadLiveReplay();
  }

  private handlePlayerAction(action: Record<string, unknown>): void {
    const senderId = action['senderId'] as string;
    if (!senderId) return;
    switch (action['action']) {
      case 'REQUEST_RACE_STATE': {
        const nickname = action['senderNickname'] as string | undefined;
        this.adoptRejoinedSeat(senderId, nickname);
        const latest = this.state;
        if (latest && latest.phase !== 'LOBBY') {
          this.setStateAndRelay('STATE_SYNC', latest);
        }
        break;
      }
      // Track selection is host-only; forwarded SELECT_TRACK actions are ignored.
      case 'SUBMIT_MOVE': {
        const nickname = action['senderNickname'] as string | undefined;
        this.adoptRejoinedSeat(senderId, nickname);
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
        const drs = action['drs'] === true;
        const ers = action['ers'] === true;
        this.applyMove(senderId, vector, { drs, ers });
        break;
      }
      case 'END_RACE': {
        const nickname = action['senderNickname'] as string | undefined;
        if (nickname && isAiPilotNickname(nickname)) return;
        this.forceEndRace();
        break;
      }
      case 'WAKE_OPPONENTS':
        this.wakeCurrentSeat();
        break;
    }
  }

  private setStateAndRelay(type: RelayPayload['type'], state: GameState, meta?: Record<string, unknown>): void {
    this.emit(state);
    this.armTurnNudge(state);
    this.maybeDriveAi(state);
    const room = this.roomService.room;
    if (!room?.isHost) return;
    const telemetry = buildRaceTelemetry(state);
    const relayMeta = telemetry ? { ...meta, telemetry } : meta;
    void this.api
      .postAction('RELAY', { type, state: slimBoard(state), meta: relayMeta }, room.roomCode)
      .catch((err) => console.warn('Relay failed', err));
    if (type === 'GAME_OVER') this.sendReplayChunks(state);
  }

  /**
   * The finish frame used to carry the whole replay. By round 58 that crosses
   * the WebSocket limit again, the broadcast dies, and the race looks frozen.
   * Guests get the log in small chunks after the board.
   */
  private sendReplayChunks(state: GameState): void {
    const room = this.roomService.room;
    if (!room?.isHost) return;
    replayChunks(state.replayLog).forEach((moves, index) => {
      void this.api
        .postAction('SAVE_LIVE_REPLAY', { index, moves }, room.roomCode)
        .catch((err) => console.warn('Replay chunk failed', err));
    });
  }

  /**
   * If the seat on the clock has not moved, poke it. Humans get a play-now
   * ping at 5s. A bot gets a local move at 12s. A request still in flight
   * is not a reason to drop the only nudge — that retry loop is why the
   * race stayed frozen with no button.
   */
  private armTurnNudge(state: GameState): void {
    if (this.turnNudgeTimer) {
      clearTimeout(this.turnNudgeTimer);
      this.turnNudgeTimer = null;
    }
    if (!this.isHost || state.phase !== 'GAME_ROUND' || isTimedMode(state)) return;
    const seat = state.turnOrder[state.currentTurnIndex];
    if (!seat) return;
    const player = state.players.find((candidate) => candidate.connectionId === seat);
    const wait = player && this.isBotSeat(player) ? GameEngineService.BOT_NUDGE_MS : GameEngineService.TURN_NUDGE_MS;
    const round = state.round;
    const index = state.currentTurnIndex;
    this.turnNudgeTimer = setTimeout(() => this.nudgeStuckSeat(seat, round, index, false), wait);
  }

  /** One shot used to land while the AI retry was in flight and then never run again. */
  private nudgeStuckSeat(seat: string, round: number, index: number, force: boolean): void {
    this.turnNudgeTimer = null;
    const latest = this.state;
    if (!latest || latest.phase !== 'GAME_ROUND' || isTimedMode(latest)) return;
    if (latest.round !== round || latest.currentTurnIndex !== index) return;
    if (latest.turnOrder[latest.currentTurnIndex] !== seat) return;
    if (!force && this.aiInFlight.has(seat)) {
      this.turnNudgeTimer = setTimeout(() => this.nudgeStuckSeat(seat, round, index, true), 2_000);
      return;
    }
    this.wakeCurrentSeat();
    // A single poke did not free round 102. Keep recovering until the seat moves.
    this.turnNudgeTimer = setTimeout(() => this.nudgeStuckSeat(seat, round, index, true), 8_000);
  }

  /**
   * Waiting player asked to poke the seat on the clock. Host does it;
   * everyone else forwards the same action.
   */
  wakeOpponents(): void {
    const room = this.roomService.room;
    if (!room) return;
    if (!this.isHost) {
      void this.api
        .postAction('FORWARD_TO_HOST', { action: 'WAKE_OPPONENTS' }, room.roomCode)
        .catch((err) => console.warn('Wake forward failed', err));
      return;
    }
    this.wakeCurrentSeat();
  }

  private wakeCurrentSeat(): void {
    const state = this.state;
    if (!state || state.phase !== 'GAME_ROUND' || isTimedMode(state)) return;
    const seat = state.turnOrder[state.currentTurnIndex];
    if (!seat) return;
    const player = state.players.find((candidate) => candidate.connectionId === seat);
    if (!player || player.finishOrder !== undefined) return;
    if (this.isBotSeat(player)) {
      this.aiInFlight.delete(seat);
      const pending = this.aiFollowUps.get(seat);
      if (pending) {
        clearTimeout(pending);
        this.aiFollowUps.delete(seat);
      }
      // A hung PLAY_AI_TURN is why the button looked dead. Play here.
      if (!this.playLocalBotMove()) {
        this.setStateAndRelay('STATE_SYNC', state, { stuck: true, seat });
      }
      return;
    }
    this.playNow$.next(seat);
    this.setStateAndRelay('STATE_SYNC', state, { playNow: true, seat });
  }

  private notePlayNow(meta?: Record<string, unknown>): void {
    if (meta?.['playNow'] === true && typeof meta['seat'] === 'string') {
      this.playNow$.next(meta['seat']);
    }
  }

  private isBotSeat(player: Player): boolean {
    return player.connectionId.startsWith('ai#') || isAiPilotNickname(player.nickname);
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
    if (this.hostRecoveryTimer) clearTimeout(this.hostRecoveryTimer);
    if (this.gridOrderTimer) clearTimeout(this.gridOrderTimer);
    if (this.turnNudgeTimer) clearTimeout(this.turnNudgeTimer);
    if (this.rushTimer) clearTimeout(this.rushTimer);
    for (const timer of this.aiFollowUps.values()) clearTimeout(timer);
    this.aiFollowUps.clear();
  }

  /**
   * Ask each on-demand AI seat (`ai#…`) whose turn it is. Socket bots keep
   * the old nudge path and are not driven from here.
   */
  private maybeDriveAi(state: GameState): void {
    if (!this.isHost || state.phase !== 'GAME_ROUND') return;
    if (this.shouldRushBots(state)) {
      this.scheduleRush();
      return;
    }
    if (isTimedMode(state)) {
      for (const player of state.players) {
        if (!player.connectionId.startsWith('ai#')) continue;
        if (player.finishOrder !== undefined) continue;
        if (canPlayerMove(state, player.connectionId)) {
          this.requestAiMove(player);
          continue;
        }
        if (player.stopUntil !== undefined && player.stopUntil > Date.now()) {
          const wait = player.stopUntil - Date.now() + 40;
          this.scheduleAi(player.connectionId, wait, () => {
            const now = this.state;
            if (now) this.maybeDriveAi(now);
          });
        }
      }
      return;
    }
    const seat = state.turnOrder[state.currentTurnIndex];
    if (!seat?.startsWith('ai#')) return;
    const player = state.players.find((candidate) => candidate.connectionId === seat);
    if (player) this.requestAiMove(player);
  }

  /** Humans are done and at least one bot is still out. */
  private shouldRushBots(state: GameState): boolean {
    if (state.phase !== 'GAME_ROUND' || isTimedMode(state)) return false;
    const humansOut = state.players.some(
      (p) => !isAiPilotNickname(p.nickname) && p.finishOrder === undefined
    );
    const botsOut = state.players.some(
      (p) => isAiPilotNickname(p.nickname) && p.finishOrder === undefined
    );
    return !humansOut && botsOut;
  }

  private scheduleRush(): void {
    if (this.rushTimer) return;
    this.rushTimer = setTimeout(() => {
      this.rushTimer = null;
      this.applyRushMove();
    }, GameEngineService.AI_RUSH_MS);
  }

  /** Host plays the bot's turn locally, picking the move that gains the most lap. */
  private applyRushMove(): void {
    const state = this.state;
    if (!state || !this.shouldRushBots(state)) return;
    this.playLocalBotMove();
  }

  /** Legal local move for the bot on the clock. Does not wait on Lambda. */
  private playLocalBotMove(): boolean {
    const state = this.state;
    if (!state || state.phase !== 'GAME_ROUND') return false;
    const seat = state.turnOrder[state.currentTurnIndex];
    const player = state.players.find((p) => p.connectionId === seat);
    if (!player || !this.isBotSeat(player) || !canPlayerMove(state, player.connectionId)) {
      return false;
    }
    const track = getTrackById(state.trackId);
    if (!track) return false;
    const limited = isGearLimited(player, state.round);
    const drs = !limited && !!player.drsArmed && !player.drsActive;
    const ers = !limited && (player.ersCharge ?? 0) >= 1;
    const climb = gearOf(player.velocity) < MAX_GEAR;
    const request = requestedBoost({ drs, ers });
    const moves = getValidMoves(
      player,
      track,
      state.players,
      state.round,
      drs ? DRS_MAX_GEAR : MAX_GEAR,
      ers || (drs && climb) ? ERS_MAX_DELTA : 1,
      ers
    );
    if (moves.length === 0) return false;
    const box = ownPitBox(track, player);
    const here = getTileAt(track, player.position.x, player.position.y);
    const onPit = isPitTile(here);
    const reserve = player.fuel !== undefined && player.fuel <= FUEL_RESERVE;
    const through = (player.driveThroughOwed ?? 0) > 0;
    const boxDist = box
      ? Math.max(Math.abs(player.position.x - box.x), Math.abs(player.position.y - box.y))
      : Number.POSITIVE_INFINITY;
    const commitFuel = !!box && reserve && (player.fuel! <= 12 || boxDist <= 22 || onPit);
    const commitThrough = !!box && through && !reserve && (boxDist <= 14 || onPit);
    let best = moves[0]!;
    let bestScore = -Infinity;
    for (const move of moves) {
      let score = racingProgress(move.landing, track);
      if (
        player.passedCheckpoint &&
        segmentCrossesFinish(track, player.position, move.landing)
      ) {
        score += 10_000;
      }
      if (move.velocity.x === 0 && move.velocity.y === 0) score -= 100;
      const tile = getTileAt(track, move.landing.x, move.landing.y);
      if (box && (commitFuel || commitThrough)) {
        const dist = Math.max(Math.abs(move.landing.x - box.x), Math.abs(move.landing.y - box.y));
        score += (48 - dist) * (commitFuel ? 180 : 90);
        if (isPitTile(tile)) score += commitFuel ? 4_000 : 3_000;
        if (commitFuel && move.landing.x === box.x && move.landing.y === box.y) score += 100_000;
        if (commitThrough && move.landing.x === box.x && move.landing.y === box.y) score -= 50_000;
      }
      if (gearOf(move.velocity) > gearOf(player.velocity) && !commitFuel) score += 40;
      if (score > bestScore) {
        bestScore = score;
        best = move;
      }
    }
    const accelerating = gearOf(best.velocity) > gearOf(player.velocity) || gearOf(best.velocity) > MAX_GEAR;
    const boost = accelerating && !isPitTile(getTileAt(track, best.landing.x, best.landing.y)) ? request : undefined;
    return this.applyMove(player.connectionId, best.velocity, boost);
  }

  private requestAiMove(player: Player, attempt = 1, stuck = false): void {
    const seatId = player.connectionId;
    if (this.aiInFlight.has(seatId) && !stuck) return;
    const state = this.state;
    const room = this.roomService.room;
    if (!state || !room || !canPlayerMove(state, seatId)) return;
    const current = state.players.find((candidate) => candidate.connectionId === seatId);
    if (!current) return;
    const pending = this.aiFollowUps.get(seatId);
    if (pending) {
      clearTimeout(pending);
      this.aiFollowUps.delete(seatId);
    }
    const base = aiTurnToken(state, current);
    const token = stuck ? `${base}:stuck` : attempt > 1 ? `${base}:2` : base;
    this.aiInFlight.add(seatId);
    void this.api
      .postAction<{ velocity?: Vector2D }>(
        'PLAY_AI_TURN',
        { nickname: current.nickname, token, state: this.boardForAi(state) },
        room.roomCode,
        GameEngineService.AI_TURN_TIMEOUT_MS
      )
      .then((response) => {
        const payload = response.payload as { velocity?: Vector2D; drs?: boolean; ers?: boolean } | undefined;
        this.finishAiMove(seatId, token, payload?.velocity, attempt, {
          drs: payload?.drs === true,
          ers: payload?.ers === true,
        });
      })
      .catch((err) => {
        console.warn('AI turn failed', err);
        if (stuck || attempt >= 2) {
          this.playLocalBotMove();
          return;
        }
        this.scheduleAi(seatId, GameEngineService.AI_RETRY_MS, () => {
          const again = this.state?.players.find((candidate) => candidate.connectionId === seatId);
          if (again) this.requestAiMove(again, attempt + 1);
        });
      })
      .finally(() => {
        this.aiInFlight.delete(seatId);
      });
  }

  private finishAiMove(
    seatId: string,
    token: string,
    velocity: Vector2D | undefined,
    attempt: number,
    boost?: BoostRequest
  ): void {
    const latest = this.state;
    const player = latest?.players.find((candidate) => candidate.connectionId === seatId);
    if (!latest || !player || !velocity) return;
    if (!Number.isInteger(velocity.x) || !Number.isInteger(velocity.y)) return;
    if (!canPlayerMove(latest, seatId)) return;
    const expected = aiTurnToken(latest, player);
    if (token !== expected && token !== `${expected}:2` && token !== `${expected}:stuck`) return;
    const applied = this.applyMove(seatId, velocity, requestedBoost(boost));
    if (!applied) {
      if (attempt === 1) {
        this.scheduleAi(seatId, 0, () => {
          const again = this.state?.players.find((candidate) => candidate.connectionId === seatId);
          if (again) this.requestAiMove(again, 2);
        });
      }
      return;
    }
    if (isTimedMode(this.state ?? latest)) {
      this.scheduleAi(seatId, GameEngineService.AI_TIMED_GAP_MS, () => {
        const now = this.state;
        if (now) this.maybeDriveAi(now);
      });
    }
  }

  private boardForAi(state: GameState): GameState {
    const copy = structuredClone(state);
    delete copy.replayLog;
    delete copy.sessionStats;
    for (const player of copy.players) {
      player.trail = player.trail?.slice(-1) ?? [];
    }
    return copy;
  }

  private scheduleAi(connectionId: string, delayMs: number, run: () => void): void {
    const existing = this.aiFollowUps.get(connectionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.aiFollowUps.delete(connectionId);
      run();
    }, delayMs);
    this.aiFollowUps.set(connectionId, timer);
  }

  reset(): void {
    if (this.gridOrderTimer) clearTimeout(this.gridOrderTimer);
    if (this.turnNudgeTimer) clearTimeout(this.turnNudgeTimer);
    this.turnNudgeTimer = null;
    this.stateSubject.next(null);
  }
}
