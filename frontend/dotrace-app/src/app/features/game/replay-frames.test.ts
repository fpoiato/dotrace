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

// Handoff without remapping would leave early moves on ai-old and late moves on
// ai-new. After remapping (host-side), the log is continuous under ai-new —
// verify that path. Also ensure a missing grid slot falls back to the first
// move, NOT the live finish cell (which parked a ghost on the last corner).
const remapped: MoveRecord[] = [
  { seq: 0, round: 0, connectionId: 'ai-new', position: { x: 12, y: 10 }, velocity: { x: 0, y: 0 }, isOffTrack: false, lap: 1 },
  { seq: 1, round: 1, connectionId: 'ai-new', position: { x: 14, y: 10 }, velocity: { x: 2, y: 0 }, isOffTrack: false, lap: 1 },
  { seq: 2, round: 2, connectionId: 'ai-new', position: { x: 20, y: 30 }, velocity: { x: 1, y: 1 }, isOffTrack: false, lap: 1 },
  { seq: 3, round: 3, connectionId: 'ai-new', position: { x: 22, y: 32 }, velocity: { x: 2, y: 2 }, isOffTrack: false, lap: 1 },
];
const aiLive: Player = {
  connectionId: 'ai-new',
  nickname: 'Bot Alfa',
  color: '#3B82F6',
  isHost: false,
  joinOrder: 1,
  status: 'approved',
  // Live state after the race — near the finish / last corner.
  position: { x: 99, y: 99 },
  velocity: { x: 0, y: 0 },
  isOffTrack: false,
  trail: [{ x: 90, y: 90 }, { x: 99, y: 99 }],
  lap: 2,
  finishOrder: 1,
};
const handoffFrames = buildReplayFrames(remapped, [aiLive], [
  { connectionId: 'ai-new', nickname: 'Bot Alfa', position: 1 },
]);
const handoffStart = handoffFrames[0]!.players.find((p) => p.connectionId === 'ai-new')!;
assert(
  handoffStart.position.x === 12 && handoffStart.position.y === 10,
  `expected grid start, got (${handoffStart.position.x},${handoffStart.position.y})`
);
const mid = handoffFrames[2]!.players.find((p) => p.connectionId === 'ai-new')!;
assert(mid.position.x === 20 && mid.position.y === 30, 'mid-race position wrong after handoff remap');
assert(handoffFrames.every((f) => f.players.length === 1), 'handoff must not split into two cars');

console.log('replay handoff continuity: ok');

// Missing round=0: first move is the spawn, never the live finish cell.
const noGrid: MoveRecord[] = [
  { seq: 0, round: 5, connectionId: 'ai-new', position: { x: 40, y: 10 }, velocity: { x: 3, y: 0 }, isOffTrack: false, lap: 1 },
  { seq: 1, round: 6, connectionId: 'ai-new', position: { x: 44, y: 10 }, velocity: { x: 4, y: 0 }, isOffTrack: false, lap: 1 },
];
const noGridFrames = buildReplayFrames(noGrid, [aiLive], []);
const noGridStart = noGridFrames[0]!.players.find((p) => p.connectionId === 'ai-new')!;
assert(
  noGridStart.position.x === 40 && noGridStart.position.y === 10,
  `expected first-move start, got (${noGridStart.position.x},${noGridStart.position.y}) — must not use live finish`
);

console.log('replay first-move fallback: ok');

// Unrepaired handoff split in the raw log: early moves on ai-old, late on ai-new.
// Viewer must stitch them into one continuous car.
const splitLog: MoveRecord[] = [
  { seq: 0, round: 0, connectionId: 'ai-old', position: { x: 12, y: 10 }, velocity: { x: 0, y: 0 }, isOffTrack: false, lap: 1 },
  { seq: 1, round: 1, connectionId: 'ai-old', position: { x: 16, y: 10 }, velocity: { x: 4, y: 0 }, isOffTrack: false, lap: 1 },
  { seq: 2, round: 2, connectionId: 'ai-old', position: { x: 18, y: 12 }, velocity: { x: 2, y: 2 }, isOffTrack: false, lap: 1 },
  { seq: 3, round: 3, connectionId: 'ai-new', position: { x: 19, y: 14 }, velocity: { x: 1, y: 2 }, isOffTrack: false, lap: 1 },
  { seq: 4, round: 4, connectionId: 'ai-new', position: { x: 20, y: 16 }, velocity: { x: 1, y: 2 }, isOffTrack: false, lap: 1 },
];
const splitFrames = buildReplayFrames(splitLog, [aiLive], [
  { connectionId: 'ai-new', nickname: 'Bot Alfa', position: 1 },
]);
assert(
  splitFrames.every((f) => f.players.every((p) => p.connectionId === 'ai-new') && f.players.length === 1),
  'split handoff log must stitch into a single ai-new car'
);
const splitLast = splitFrames[splitFrames.length - 1]!.players[0]!;
assert(splitLast.position.x === 20 && splitLast.position.y === 16, 'stitched final position wrong');
assert(splitLast.trail.length >= 4, 'stitched trail should include pre- and post-handoff points');

console.log('replay unrepaired handoff stitch: ok');

// DRS stays on until a later move of that car drops it. ERS marks the move
// that spent the bar and clears on the next one.
const boostLog: MoveRecord[] = [
  { seq: 0, round: 0, connectionId: 'human-1', position: { x: 1, y: 1 }, velocity: { x: 0, y: 0 }, isOffTrack: false, lap: 1 },
  { seq: 1, round: 1, connectionId: 'human-1', position: { x: 3, y: 1 }, velocity: { x: 2, y: 0 }, isOffTrack: false, lap: 1, drsActive: true },
  { seq: 2, round: 2, connectionId: 'human-1', position: { x: 6, y: 1 }, velocity: { x: 3, y: 0 }, isOffTrack: false, lap: 1, drsActive: true, ersActive: true },
  { seq: 3, round: 3, connectionId: 'human-1', position: { x: 8, y: 1 }, velocity: { x: 2, y: 0 }, isOffTrack: false, lap: 1 },
];
const boostFrames = buildReplayFrames(boostLog, [human], []);
assert(boostFrames[1]!.players[0]!.drsActive === true, 'DRS should be open on the move that armed it');
assert(boostFrames[1]!.players[0]!.ersActive === false, 'ERS should be off before it is spent');
assert(boostFrames[2]!.players[0]!.drsActive === true && boostFrames[2]!.players[0]!.ersActive === true, 'both boosts on the ERS move');
assert(boostFrames[3]!.players[0]!.drsActive === false && boostFrames[3]!.players[0]!.ersActive === false, 'boosts clear when the next move omits them');

console.log('replay boost flags: ok');
