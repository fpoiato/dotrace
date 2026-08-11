/**
 * Lightweight node test for replay orphan recovery (no Angular TestBed).
 * Run: npx tsx frontend/dotrace-app/src/app/features/game/replay-frames.test.ts
 */
import { buildReplayFrames } from './replay-frames';
import type { MoveRecord, Player, PodiumEntry } from '../../core/models/ws-types';

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const human: Player = {
  connectionId: 'human-1',
  nickname: 'You',
  color: '#EF4444',
  isHost: true,
  joinOrder: 0,
  status: 'approved',
  position: { x: 10, y: 10 },
  velocity: { x: 0, y: 0 },
  isOffTrack: false,
  trail: [{ x: 10, y: 10 }],
  lap: 1,
};

const log: MoveRecord[] = [
  { seq: 0, round: 0, connectionId: 'human-1', position: { x: 10, y: 10 }, velocity: { x: 0, y: 0 }, isOffTrack: false, lap: 1 },
  { seq: 1, round: 0, connectionId: 'ai-1', position: { x: 12, y: 10 }, velocity: { x: 0, y: 0 }, isOffTrack: false, lap: 1 },
  { seq: 2, round: 1, connectionId: 'human-1', position: { x: 11, y: 10 }, velocity: { x: 1, y: 0 }, isOffTrack: false, lap: 1 },
  { seq: 3, round: 1, connectionId: 'ai-1', position: { x: 14, y: 10 }, velocity: { x: 2, y: 0 }, isOffTrack: false, lap: 1 },
  { seq: 4, round: 2, connectionId: 'ai-1', position: { x: 17, y: 10 }, velocity: { x: 3, y: 0 }, isOffTrack: false, lap: 1 },
];

const podium: PodiumEntry[] = [
  { connectionId: 'ai-1', nickname: 'Bot Alfa', position: 1 },
  { connectionId: 'human-1', nickname: 'You', position: 2 },
];

// Roster after AI Lambda disconnected post-race — only the human remains.
const frames = buildReplayFrames(log, [human], podium);
assert(frames.length > 1, 'expected multiple frames');
const last = frames[frames.length - 1]!;
const ids = new Set(last.players.map((p) => p.connectionId));
assert(ids.has('human-1'), 'human missing from replay');
assert(ids.has('ai-1'), 'AI orphan missing from replay');
const ai = last.players.find((p) => p.connectionId === 'ai-1')!;
assert(ai.nickname === 'Bot Alfa', `expected Bot Alfa, got ${ai.nickname}`);
assert(ai.position.x === 17 && ai.position.y === 10, 'AI final position wrong');
assert(ai.trail.length >= 2, 'AI trail should have multiple points');

console.log('replay orphan recovery: ok');
