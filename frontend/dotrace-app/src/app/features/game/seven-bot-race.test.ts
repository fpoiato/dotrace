/**
 * Seven bots, ten laps, no Lambda. A pause must not be required to finish.
 * Run: npx tsx frontend/dotrace-app/src/app/features/game/seven-bot-race.test.ts
 */
import { getTrackById } from '../../core/models/tracks';
import {
  GameState,
  Player,
  applyGrassPenalty,
  armDrsZones,
  beginNextLap,
  createInitialState,
  createLobbyPlayer,
  engageRequestedDrs,
  fuelEnabled,
  FUEL_TANK,
  getTileAt,
  getValidMoves,
  isGameOver,
  isGrassShortcut,
  landingPosition,
  MAX_GEAR,
  nextActiveTurnIndex,
  pushTrail,
  racingProgress,
  revertDrsOpen,
  segmentCrossesFinish,
  segmentEntersRect,
  settleBoostFromGears,
  settleFuel,
  settlePitVisit,
  spendErsIfAccepted,
  gearOf,
  zeroVector,
} from '../../core/models/ws-types';

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function step(state: GameState): boolean {
  const track = getTrackById(state.trackId);
  if (!track) return false;
  const seat = state.turnOrder[state.currentTurnIndex];
  const player = state.players.find((p) => p.connectionId === seat);
  if (!player || player.finishOrder !== undefined) return false;
  const limits = engageRequestedDrs(player, state.round);
  const moves = getValidMoves(player, track, state.players, state.round, limits.maxGear, limits.maxDelta, limits.spendErs);
  if (moves.length === 0) {
    revertDrsOpen(player, player.drsActive, player.drsArmed);
    return false;
  }
  let best = moves[0]!;
  let bestScore = -Infinity;
  for (const move of moves) {
    const line = track.centerline;
    let bestI = 0;
    let bestD = Infinity;
    line.forEach((point, i) => {
      const d = Math.abs(point.x - player.position.x) + Math.abs(point.y - player.position.y);
      if (d < bestD) { bestD = d; bestI = i; }
    });
    const target = line[(bestI + 1) % line.length]!;
    const dist = Math.abs(move.landing.x - target.x) + Math.abs(move.landing.y - target.y);
    const tile = getTileAt(track, move.landing.x, move.landing.y);
    let score = -dist;
    if (tile !== 'track' && tile !== 'finish' && tile !== 'pit') score -= 10_000;
    if (player.passedCheckpoint && segmentCrossesFinish(track, player.position, move.landing)) score += 10_000;
    if (move.velocity.x === 0 && move.velocity.y === 0) score -= 30;
    if (score > bestScore) {
      bestScore = score;
      best = move;
    }
  }
  const armedBefore = player.drsArmed;
  const activeBefore = player.drsActive;
  const chargeBefore = player.ersCharge;
  const from = { ...player.position };
  const landing = landingPosition(player.position, best.velocity);
  const tile = getTileAt(track, landing.x, landing.y);
  if (tile === null) return false;
  spendErsIfAccepted(player, limits);
  const previousGear = gearOf(player.velocity);
  player.position = landing;
  pushTrail(player, landing);
  if (tile === 'grass' || tile === 'rumble') {
    player.velocity = zeroVector();
    player.isOffTrack = true;
  } else {
    player.velocity = { ...best.velocity };
    player.isOffTrack = false;
  }
  settleBoostFromGears(player, previousGear, gearOf(player.velocity));
  player.ersActive = limits.spendErs;
  settleFuel(player, gearOf(player.velocity), limits.spendErs);
  settlePitVisit(player, track, tile, state.round);
  if (isGrassShortcut(track, from, landing)) applyGrassPenalty(player, state);
  if (track.checkpoint && !player.passedCheckpoint) {
    player.passedCheckpoint = segmentEntersRect(from, landing, track.checkpoint);
  }
  armDrsZones(player, from, landing, state.players, track);
  const crossed = player.passedCheckpoint !== false && segmentCrossesFinish(track, from, landing);
  if (crossed && tile !== 'grass' && tile !== 'rumble') {
    if (player.lap < state.totalLaps) {
      player.lap += 1;
      beginNextLap(player);
      player.trail = [{ ...landing }];
    } else {
      player.finishOrder = state.podium.length + 1;
      player.finishRound = state.round;
      state.podium.push({ connectionId: player.connectionId, nickname: player.nickname, position: player.finishOrder });
    }
  }
  const prev = state.currentTurnIndex;
  state.currentTurnIndex = nextActiveTurnIndex(state);
  if (state.currentTurnIndex <= prev) state.round += 1;
  return true;
}

const track = getTrackById('monza');
assert(track, 'monza exists');
const players: Player[] = Array.from({ length: 7 }, (_, i) =>
  createLobbyPlayer(`ai#bot-${i}`, `Bot ${i}`, i === 0, i, '#fff')
);
const state = createInitialState(players, players[0]!.connectionId);
state.phase = 'GAME_ROUND';
state.trackId = 'monza';
state.totalLaps = 10;
state.gameMode = 'TURNS';
state.round = 1;
state.turnOrder = players.map((p) => p.connectionId);
state.currentTurnIndex = 0;
state.podium = [];
players.forEach((player, idx) => {
  const start = track!.startLine[idx % track!.startLine.length]!;
  player.position = { ...start };
  player.velocity = zeroVector();
  player.lap = 1;
  player.trail = [{ ...start }];
  player.fuel = fuelEnabled(10) ? FUEL_TANK : undefined;
  player.pitBoxIndex = idx;
  player.passedCheckpoint = false;
});

let moves = 0;
const cap = 20_000;
while (!isGameOver(state) && moves < cap) {
  if (!step(state)) break;
  moves += 1;
}

const finished = state.players.filter((p) => p.finishOrder !== undefined).length;
console.log(`seven bots: moves=${moves} round=${state.round} finished=${finished}/7 laps=${state.players.map((p) => p.lap).join(',')}`);
assert(isGameOver(state), `race did not finish in ${moves} moves at round ${state.round}`);
assert(state.players.every((p) => (p.finishOrder ?? 0) > 0), 'every bot finished');
assert(state.round < 2_500, `round ${state.round} ran away`);
console.log('seven-bot-race.test.ts ok');
