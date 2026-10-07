/**
 * Pure helpers that rebuild replay frames from the host move log.
 * Kept free of Angular so unit tests can run under plain tsx/node.
 */
import {
  MoveRecord,
  PLAYER_COLORS,
  Player,
  PlayerStatus,
  PodiumEntry,
  Vector2D,
} from '../../core/models/ws-types';

export interface ReplayPlayerMeta {
  connectionId: string;
  nickname: string;
  color: string;
  isHost: boolean;
  joinOrder: number;
  status: PlayerStatus;
  finishOrder?: number;
  finishedAt?: number;
  finishRound?: number;
  diceRoll?: number;
}

export interface ReplayPlayerState {
  connectionId: string;
  nickname: string;
  color: string;
  isHost: boolean;
  joinOrder: number;
  status: PlayerStatus;
  position: Vector2D;
  velocity: Vector2D;
  isOffTrack: boolean;
  trail: Vector2D[];
  lap: number;
  finishOrder?: number;
  finishedAt?: number;
  finishRound?: number;
  passedCheckpoint?: boolean;
  diceRoll?: number;
  /** DRS still open on this frame. */
  drsActive?: boolean;
  /** This car's latest move spent an ERS bar. */
  ersActive?: boolean;
  /** Grass shortcuts taken by this car so far. */
  grassCuts?: number;
  /** TURNS mode: max gear 1 until this round (inclusive). */
  gearPenaltyUntilRound?: number;
  /** TIMED mode: epoch ms before the player may move again. */
  stopUntil?: number;
}

export interface ReplayFrame {
  seq: number;
  round: number;
  movedId?: string;
  players: ReplayPlayerState[];
}

function cloneStates(map: Map<string, ReplayPlayerState>): ReplayPlayerState[] {
  return [...map.values()].map((s) => ({
    ...s,
    position: { ...s.position },
    velocity: { ...s.velocity },
    trail: [...s.trail],
  }));
}

/**
 * Carry recorded grass penalties onto the frame. Logs saved before the fields
 * existed only have isOffTrack: treat a new off-track stop as one cut so the
 * replay still raises the flag.
 */
function penaltyAfterMove(
  prev: ReplayPlayerState,
  rec: MoveRecord
): { grassCuts: number; gearPenaltyUntilRound?: number; stopUntil?: number } {
  if (rec.grassCuts !== undefined) {
    return {
      grassCuts: rec.grassCuts,
      gearPenaltyUntilRound: rec.gearPenaltyUntilRound,
      stopUntil: rec.stopUntil,
    };
  }
  const cuts = prev.grassCuts ?? 0;
  if (rec.isOffTrack && !prev.isOffTrack) {
    return {
      grassCuts: cuts + 1,
      gearPenaltyUntilRound: rec.round + 3,
      stopUntil: prev.stopUntil,
    };
  }
  return {
    grassCuts: cuts,
    gearPenaltyUntilRound: prev.gearPenaltyUntilRound,
    stopUntil: prev.stopUntil,
  };
}

/**
 * Heal logs split by a reconnect / AI Lambda handoff that did not remap
 * connection ids: early moves stay on the old id, later moves use the new one.
 * When an orphan's last move precedes the first move of exactly one roster
 * player that has no grid slot, treat them as the same pilot.
 */
export function stitchReplayHandoffSplits(
  replayLog: MoveRecord[],
  players: Player[]
): MoveRecord[] {
  const rosterIds = new Set(players.map((p) => p.connectionId));
  const idsInLog = [...new Set(replayLog.map((r) => r.connectionId))];
  const orphans = idsInLog.filter((id) => !rosterIds.has(id));
  if (orphans.length === 0) return replayLog;

  let log = replayLog;
  for (const orphan of orphans) {
    const orphanRecs = log.filter((r) => r.connectionId === orphan);
    if (orphanRecs.length === 0) continue;
    const orphanLastSeq = Math.max(...orphanRecs.map((r) => r.seq));
    const candidates = [...rosterIds].filter((id) => {
      if (log.some((r) => r.connectionId === id && r.round === 0)) return false;
      const first = log.find((r) => r.connectionId === id && r.round > 0);
      return first !== undefined && first.seq > orphanLastSeq;
    });
    if (candidates.length !== 1) continue;
    const neo = candidates[0]!;
    log = log.map((r) =>
      r.connectionId === orphan ? { ...r, connectionId: neo } : r
    );
  }
  return log;
}

/**
 * Rebuild frame-by-frame state from the host's move log.
 * Includes pilots who left after GAME_OVER (AI Lambdas disconnect in finally)
 * by synthesizing meta from podium / fallback colors — otherwise their moves
 * are orphaned and the replay looks like a solo race.
 */
export function buildReplayFrames(
  replayLog: MoveRecord[],
  players: Player[],
  podium: PodiumEntry[] = []
): ReplayFrame[] {
  if (replayLog.length === 0) return [];

  const log = stitchReplayHandoffSplits(replayLog, players);

  const meta = new Map<string, ReplayPlayerMeta>();
  for (const p of players) {
    meta.set(p.connectionId, {
      connectionId: p.connectionId,
      nickname: p.nickname,
      color: p.color,
      isHost: p.isHost,
      joinOrder: p.joinOrder,
      status: p.status,
      finishOrder: p.finishOrder,
      finishedAt: p.finishedAt,
      finishRound: p.finishRound,
      diceRoll: p.diceRoll,
    });
  }

  let orphanIdx = 0;
  for (const rec of log) {
    if (meta.has(rec.connectionId)) continue;
    const podiumHit = podium.find((e) => e.connectionId === rec.connectionId);
    meta.set(rec.connectionId, {
      connectionId: rec.connectionId,
      nickname: podiumHit?.nickname ?? `Pilot ${orphanIdx + 1}`,
      color: PLAYER_COLORS[orphanIdx % PLAYER_COLORS.length] ?? '#888888',
      isHost: false,
      joinOrder: 1000 + orphanIdx,
      status: 'approved',
      finishOrder: podiumHit?.position,
    });
    orphanIdx++;
  }

  const currentState = new Map<string, ReplayPlayerState>();

  // round=0 marks every car's grid slot (seq alone is not reliable — each push
  // gets a unique seq, so only the first driver would match seq===0).
  const startByPlayer = new Map(
    log.filter((r) => r.round === 0).map((r) => [r.connectionId, r])
  );
  // Earliest non-start move per id — used when grid slots are missing (e.g. a
  // reconnect id that somehow skipped remapping). Never fall back to the live
  // final position: that parks a ghost on the last corner from frame 0.
  const firstMoveByPlayer = new Map<string, MoveRecord>();
  for (const r of log) {
    if (r.round <= 0) continue;
    if (!firstMoveByPlayer.has(r.connectionId)) firstMoveByPlayer.set(r.connectionId, r);
  }

  for (const [id, info] of meta) {
    const live = players.find((p) => p.connectionId === id);
    const rec = startByPlayer.get(id) ?? firstMoveByPlayer.get(id);
    const pos = rec?.position ?? live?.trail?.[0] ?? live?.position ?? { x: 0, y: 0 };
    currentState.set(id, {
      connectionId: id,
      nickname: info.nickname,
      color: info.color,
      isHost: info.isHost,
      joinOrder: info.joinOrder,
      status: info.status,
      position: { ...pos },
      velocity: rec ? { ...rec.velocity } : { x: 0, y: 0 },
      isOffTrack: rec?.isOffTrack ?? false,
      trail: [{ ...pos }],
      lap: rec?.lap ?? 1,
      diceRoll: info.diceRoll,
      finishOrder: info.finishOrder,
      finishedAt: info.finishedAt,
      finishRound: info.finishRound,
      drsActive: !!rec?.drsActive,
      ersActive: !!rec?.ersActive,
      grassCuts: rec?.grassCuts ?? 0,
      gearPenaltyUntilRound: rec?.gearPenaltyUntilRound,
      stopUntil: rec?.stopUntil,
    });
  }

  const frames: ReplayFrame[] = [];
  frames.push({
    seq: 0,
    round: 0,
    movedId: undefined,
    players: cloneStates(currentState),
  });

  const moves = log.filter((r) => r.round > 0).sort((a, b) => a.seq - b.seq);
  for (const rec of moves) {
    let ps = currentState.get(rec.connectionId);
    if (!ps) {
      const info = meta.get(rec.connectionId);
      if (!info) continue;
      ps = {
        connectionId: rec.connectionId,
        nickname: info.nickname,
        color: info.color,
        isHost: info.isHost,
        joinOrder: info.joinOrder,
        status: info.status,
        position: { ...rec.position },
        velocity: { ...rec.velocity },
        isOffTrack: rec.isOffTrack,
        trail: [{ ...rec.position }],
        lap: rec.lap,
        diceRoll: info.diceRoll,
        drsActive: !!rec.drsActive,
        ersActive: !!rec.ersActive,
        grassCuts: rec.grassCuts ?? 0,
        gearPenaltyUntilRound: rec.gearPenaltyUntilRound,
        stopUntil: rec.stopUntil,
      };
      currentState.set(rec.connectionId, ps);
    }

    const trail = rec.lap > ps.lap ? [{ ...rec.position }] : [...ps.trail, { ...rec.position }];
    const penalty = penaltyAfterMove(ps, rec);

    const info = meta.get(rec.connectionId);
    currentState.set(rec.connectionId, {
      ...ps,
      position: { ...rec.position },
      velocity: { ...rec.velocity },
      isOffTrack: rec.isOffTrack,
      lap: rec.lap,
      trail,
      finishOrder: info?.finishOrder,
      finishedAt: info?.finishedAt,
      finishRound: info?.finishRound,
      drsActive: !!rec.drsActive,
      ersActive: !!rec.ersActive,
      grassCuts: penalty.grassCuts,
      gearPenaltyUntilRound: penalty.gearPenaltyUntilRound,
      stopUntil: penalty.stopUntil,
    });

    frames.push({
      seq: rec.seq,
      round: rec.round,
      movedId: rec.connectionId,
      players: cloneStates(currentState),
    });
  }

  return frames;
}
