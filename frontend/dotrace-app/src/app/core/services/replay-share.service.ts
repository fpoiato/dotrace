import { Injectable, inject } from '@angular/core';
import {
  GameMode,
  GameState,
  MoveRecord,
  Player,
} from '../models/ws-types';
import { ApiService } from './api.service';

/** Compact player snapshot for shareable replays. */
interface SharedReplayPlayer {
  /** Short id (p0, p1, …) — connectionIds are remapped to keep URLs small. */
  id: string;
  n: string;
  c: string;
  jo: number;
  h?: 1;
  fo?: number;
  fr?: number;
  fa?: number;
  d?: number;
}

/**
 * Compact move row:
 * [playerIdx, round, x, y, vx, vy, offTrack(0|1), lap, flags?]
 * flags bit 0 = DRS open, bit 1 = ERS spent on this move. Omitted when 0.
 */
type SharedMoveRow = [number, number, number, number, number, number, 0 | 1, number, number?];

export interface SharedReplayPayload {
  v: 1;
  t: string;
  l: number;
  m: GameMode;
  p: SharedReplayPlayer[];
  r: SharedMoveRow[];
}

const HASH_PREFIX = 'r1.';

function base64UrlToBytes(encoded: string): Uint8Array {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function decompress(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

function textDecoder(): TextDecoder {
  return new TextDecoder();
}

/** Build a compact shareable payload from a finished race state. */
export function buildSharedReplayPayload(state: GameState): SharedReplayPayload | null {
  const log = state.replayLog;
  if (!log?.length) return null;

  const idMap = new Map<string, number>();
  const players: SharedReplayPlayer[] = state.players.map((p, i) => {
    idMap.set(p.connectionId, i);
    const row: SharedReplayPlayer = {
      id: `p${i}`,
      n: p.nickname,
      c: p.color,
      jo: p.joinOrder,
    };
    if (p.isHost) row.h = 1;
    if (p.finishOrder !== undefined) row.fo = p.finishOrder;
    if (p.finishRound !== undefined) row.fr = p.finishRound;
    if (p.finishedAt !== undefined) row.fa = p.finishedAt;
    if (p.diceRoll !== undefined) row.d = p.diceRoll;
    return row;
  });

  // Include anyone who appears in the log but left the roster (AI Lambda
  // disconnects after GAME_OVER). Prefer podium nickname when available.
  for (const rec of log) {
    if (!idMap.has(rec.connectionId)) {
      const i = players.length;
      idMap.set(rec.connectionId, i);
      const podiumHit = state.podium?.find((e) => e.connectionId === rec.connectionId);
      players.push({
        id: `p${i}`,
        n: podiumHit?.nickname ?? `Pilot ${i + 1}`,
        c: '#888888',
        jo: i,
        fo: podiumHit?.position,
      });
    }
  }

  const moves: SharedMoveRow[] = log
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((rec) => {
      const pi = idMap.get(rec.connectionId) ?? 0;
      const row: SharedMoveRow = [
        pi,
        rec.round,
        rec.position.x,
        rec.position.y,
        rec.velocity.x,
        rec.velocity.y,
        rec.isOffTrack ? 1 : 0,
        rec.lap,
      ];
      const flags = (rec.drsActive ? 1 : 0) | (rec.ersActive ? 2 : 0);
      if (flags) row[8] = flags;
      return row;
    });

  return {
    v: 1,
    t: state.trackId,
    l: state.totalLaps,
    m: state.gameMode,
    p: players,
    r: moves,
  };
}

/** Reconstruct a GameState the replay viewer can play. */
export function sharedPayloadToGameState(payload: SharedReplayPayload): GameState {
  const players: Player[] = payload.p.map((p) => ({
    connectionId: p.id,
    nickname: p.n,
    color: p.c,
    isHost: p.h === 1,
    joinOrder: p.jo,
    status: 'approved',
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    isOffTrack: false,
    trail: [],
    lap: 1,
    finishOrder: p.fo,
    finishRound: p.fr,
    finishedAt: p.fa,
    diceRoll: p.d,
  }));

  const replayLog: MoveRecord[] = payload.r.map((row, seq) => {
    const [pi, round, x, y, vx, vy, off, lap] = row;
    const flags = row[8] ?? 0;
    const player = players[pi] ?? players[0];
    return {
      seq,
      round,
      connectionId: player?.connectionId ?? `p${pi}`,
      position: { x, y },
      velocity: { x: vx, y: vy },
      isOffTrack: off === 1,
      lap,
      drsActive: (flags & 1) !== 0,
      ersActive: (flags & 2) !== 0,
    };
  });

  const host = players.find((p) => p.isHost) ?? players[0];
  const diceRolls: Record<string, number> = {};
  for (const p of players) {
    if (p.diceRoll !== undefined) diceRolls[p.connectionId] = p.diceRoll;
  }

  return {
    phase: 'GAME_OVER',
    players,
    hostId: host?.connectionId ?? '',
    trackId: payload.t,
    turnOrder: players.map((p) => p.connectionId),
    currentTurnIndex: 0,
    round: replayLog.reduce((max, r) => Math.max(max, r.round), 0),
    totalLaps: payload.l,
    gameMode: payload.m,
    diceRolls,
    podium: players
      .filter((p) => p.finishOrder !== undefined)
      .sort((a, b) => (a.finishOrder ?? 0) - (b.finishOrder ?? 0))
      .map((p) => ({
        connectionId: p.connectionId,
        nickname: p.nickname,
        position: p.finishOrder!,
      })),
    replayLog,
  };
}

function isSharedReplayPayload(value: unknown): value is SharedReplayPayload {
  if (!value || typeof value !== 'object') return false;
  const p = value as SharedReplayPayload;
  return (
    p.v === 1 &&
    typeof p.t === 'string' &&
    typeof p.l === 'number' &&
    (p.m === 'TURNS' || p.m === 'TIMED') &&
    Array.isArray(p.p) &&
    Array.isArray(p.r)
  );
}

@Injectable({ providedIn: 'root' })
export class ReplayShareService {
  private readonly api = inject(ApiService);

  /**
   * Persist the race and return `/replay/:id`.
   * The id is the only thing that goes into WhatsApp — a 3-lap log no longer
   * has to survive as a compressed hash.
   */
  async buildShareUrl(state: GameState): Promise<string | null> {
    const payload = buildSharedReplayPayload(state);
    if (!payload) return null;
    const id = await this.api.saveReplay(payload);
    return `${window.location.origin}/replay/${id}`;
  }

  /** Load a replay saved with a one-day TTL. */
  async loadById(id: string): Promise<GameState | null> {
    try {
      const payload: unknown = await this.api.getReplay(id);
      if (!isSharedReplayPayload(payload)) return null;
      return sharedPayloadToGameState(payload);
    } catch {
      return null;
    }
  }

  /** Decode a legacy hash fragment (`#r1.c.…` or `#r1.u.…`) into GameState. */
  async decodeHash(hash: string): Promise<GameState | null> {
    const raw = hash.startsWith('#') ? hash.slice(1) : hash;
    if (!raw.startsWith(HASH_PREFIX)) return null;
    const rest = raw.slice(HASH_PREFIX.length);
    const dot = rest.indexOf('.');
    if (dot < 0) return null;
    const flag = rest.slice(0, dot);
    const body = rest.slice(dot + 1);
    if (!body || (flag !== 'c' && flag !== 'u')) return null;

    try {
      let bytes = base64UrlToBytes(body);
      if (flag === 'c') bytes = await decompress(bytes);
      const json = textDecoder().decode(bytes);
      const parsed: unknown = JSON.parse(json);
      if (!isSharedReplayPayload(parsed)) return null;
      return sharedPayloadToGameState(parsed);
    } catch {
      return null;
    }
  }

  getWhatsAppUrl(shareUrl: string): string {
    const text = encodeURIComponent(`Replay Dot Race\n${shareUrl}`);
    return `https://wa.me/?text=${text}`;
  }
}
