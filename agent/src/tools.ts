/**
 * Pure "player tools" over the shared game rules.
 *
 * Everything here is deterministic and side-effect free so the same functions
 * back the autonomous agent loop, the MCP server, and unit tests. Moves are
 * always derived from getValidMoves() — the same enumeration the host uses to
 * validate — so a brain that picks from this list can never play an illegal move.
 */
import {
  GameState,
  Player,
  TrackDefinition,
  Vector2D,
  gearOf,
  getTileAt,
  getValidMoves,
  isGearLimited,
  isGrassShortcut,
  segmentCrossesFinish,
  segmentEntersRect,
} from '../../shared/ws-types';

export interface AnnotatedMove {
  /** Stable index the brain answers with. */
  index: number;
  /** Absolute velocity to submit (not a delta). */
  velocity: Vector2D;
  landing: Vector2D;
  gear: number;
  /** Tile under the landing square ('track' | 'grass' | 'finish' | 'rumble'). */
  landingTile: string;
  /** Lands on or cuts across grass — triggers escalating penalties. */
  grassShortcut: boolean;
  /** Passes through the far-side checkpoint zone (needed for a valid lap). */
  entersCheckpoint: boolean;
  /** Crosses the finish stripe (only counts after the checkpoint). */
  crossesFinish: boolean;
  /** Chebyshev distance from landing to the current goal, lower is better. */
  distanceToGoal: number;
}

export interface BoardSummary {
  phase: GameState['phase'];
  gameMode: GameState['gameMode'];
  round: number;
  lap: number;
  totalLaps: number;
  position: Vector2D;
  velocity: Vector2D;
  gear: number;
  passedCheckpoint: boolean;
  gearLimited: boolean;
  /** 'checkpoint' until the checkpoint is passed, then 'finish'. */
  goal: 'checkpoint' | 'finish';
  goalPoint: Vector2D;
  opponents: {
    nickname: string;
    position: Vector2D;
    lap: number;
    finished: boolean;
  }[];
}

function rectCenter(rect: { x0: number; y0: number; x1: number; y1: number }): Vector2D {
  return {
    x: Math.round((rect.x0 + rect.x1) / 2),
    y: Math.round((rect.y0 + rect.y1) / 2),
  };
}

export function finishCentroid(track: TrackDefinition): Vector2D {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (let y = 0; y < track.height; y++) {
    for (let x = 0; x < track.width; x++) {
      if (track.grid[y][x] === 'finish') {
        sumX += x;
        sumY += y;
        count++;
      }
    }
  }
  return count > 0
    ? { x: Math.round(sumX / count), y: Math.round(sumY / count) }
    : { x: Math.floor(track.width / 2), y: Math.floor(track.height / 2) };
}

/** Current navigation goal: far-side checkpoint first, then the finish stripe. */
export function goalPoint(player: Player, track: TrackDefinition): {
  goal: 'checkpoint' | 'finish';
  point: Vector2D;
} {
  if (track.checkpoint && !player.passedCheckpoint) {
    return { goal: 'checkpoint', point: rectCenter(track.checkpoint) };
  }
  return { goal: 'finish', point: finishCentroid(track) };
}

function chebyshev(a: Vector2D, b: Vector2D): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** Enumerate the player's legal moves with racing-relevant annotations. */
export function listAnnotatedMoves(
  player: Player,
  state: GameState,
  track: TrackDefinition
): AnnotatedMove[] {
  const { point } = goalPoint(player, track);
  const moves = getValidMoves(player, track, state.players, state.round);

  return moves.map((move, index) => ({
    index,
    velocity: move.velocity,
    landing: move.landing,
    gear: gearOf(move.velocity),
    landingTile: getTileAt(track, move.landing.x, move.landing.y) ?? 'void',
    grassShortcut: isGrassShortcut(track, player.position, move.landing),
    entersCheckpoint: track.checkpoint
      ? segmentEntersRect(player.position, move.landing, track.checkpoint)
      : false,
    crossesFinish: segmentCrossesFinish(track, player.position, move.landing),
    distanceToGoal: chebyshev(move.landing, point),
  }));
}

/** Compact single-player view of the race, cheap to serialize for an LLM. */
export function buildBoardSummary(
  player: Player,
  state: GameState,
  track: TrackDefinition
): BoardSummary {
  const { goal, point } = goalPoint(player, track);
  return {
    phase: state.phase,
    gameMode: state.gameMode,
    round: state.round,
    lap: player.lap,
    totalLaps: state.totalLaps,
    position: player.position,
    velocity: player.velocity,
    gear: gearOf(player.velocity),
    passedCheckpoint: player.passedCheckpoint ?? false,
    gearLimited: isGearLimited(player, state.round),
    goal,
    goalPoint: point,
    opponents: state.players
      .filter((p) => p.connectionId !== player.connectionId)
      .map((p) => ({
        nickname: p.nickname,
        position: p.position,
        lap: p.lap,
        finished: p.finishOrder !== undefined,
      })),
  };
}

/** True when the velocity matches one of the enumerated legal moves. */
export function isMoveInList(moves: AnnotatedMove[], velocity: Vector2D): boolean {
  return moves.some((m) => m.velocity.x === velocity.x && m.velocity.y === velocity.y);
}
