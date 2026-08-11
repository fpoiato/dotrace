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
  for (const rec of replayLog) {
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
    replayLog.filter((r) => r.round === 0).map((r) => [r.connectionId, r])
  );

  for (const [id, info] of meta) {
    const live = players.find((p) => p.connectionId === id);
    const rec = startByPlayer.get(id);
    const pos = rec?.position ?? live?.trail?.[0] ?? live?.position ?? { x: 0, y: 0 };
    currentState.set(id, {
      connectionId: id,
      nickname: info.nickname,
      color: info.color,
      isHost: info.isHost,
      joinOrder: info.joinOrder,
      status: info.status,
      position: { ...pos },
      velocity: rec ? { ...rec.velocity } : live ? { ...live.velocity } : { x: 0, y: 0 },
      isOffTrack: rec?.isOffTrack ?? live?.isOffTrack ?? false,
      trail: [{ ...pos }],
      lap: rec?.lap ?? live?.lap ?? 1,
      diceRoll: info.diceRoll,
      finishOrder: info.finishOrder,
      finishedAt: info.finishedAt,
      finishRound: info.finishRound,
    });
  }

  const frames: ReplayFrame[] = [];
  frames.push({
    seq: 0,
    round: 0,
    movedId: undefined,
    players: cloneStates(currentState),
  });

  const moves = replayLog.filter((r) => r.round > 0).sort((a, b) => a.seq - b.seq);
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
      };
      currentState.set(rec.connectionId, ps);
    }

    const trail = rec.lap > ps.lap ? [{ ...rec.position }] : [...ps.trail, { ...rec.position }];

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
