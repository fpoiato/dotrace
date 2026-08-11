import { Injectable } from '@angular/core';
import {
  BotDifficulty,
  GameState,
  Player,
  TileType,
  TrackDefinition,
  Vector2D,
  gearOf,
  getTileAt,
  getValidMoves,
  isGrassShortcut,
  landingPosition,
} from '../models/ws-types';

interface DifficultyProfile {
  /** Chance to pick a random legal move instead of the best one (mistakes). */
  epsilon: number;
  /** Preferred top gear; going faster is discouraged, not forbidden. */
  maxGear: number;
  /** Base distance ahead on the racing line to aim for (grows with speed). */
  lookahead: number;
  /** Reward per unit of speed, so bots carry pace down the straights. */
  speedReward: number;
  /** Weight for penalties that keep the car on track and out of the grass. */
  safety: number;
  /** Weight for braking into corners (scales with speed when escapes are few). */
  corner: number;
  /** How many turns ahead the safety check looks for a survivable line. */
  planDepth: number;
}

const PROFILES: Record<BotDifficulty, DifficultyProfile> = {
  easy: { epsilon: 0.28, maxGear: 3, lookahead: 5, speedReward: 0.6, safety: 8, corner: 2.5, planDepth: 1 },
  normal: { epsilon: 0.08, maxGear: 5, lookahead: 8, speedReward: 1.1, safety: 16, corner: 2.0, planDepth: 2 },
  hard: { epsilon: 0, maxGear: 6, lookahead: 11, speedReward: 1.5, safety: 26, corner: 1.6, planDepth: 2 },
};

/** Comfortable number of on-track exits from a landing; fewer = brake. */
const SAFE_ESCAPES = 3;

/** Precomputed racing-line geometry for a track (cached by id). */
interface Centerline {
  points: Vector2D[];
  /** Length of each segment points[i] -> points[i+1] (cyclic). */
  segLen: number[];
}

/** How close (cells) the car must get to a waypoint before targeting the next. */
const ARRIVE_RADIUS = 6;
/** Max waypoints advanced in a single turn (prevents skipping the loop). */
const MAX_ADVANCE = 6;
/**
 * If the car strays this far from its target waypoint it is considered lost
 * (usually after being nudged off line near a self-crossing) and the index is
 * re-locked onto whichever waypoint it is actually nearest.
 */
const RESYNC_DIST = 11;

/** Tiles a car can drive on without spinning off. */
function isDrivable(tile: TileType | null): boolean {
  return tile === 'track' || tile === 'finish';
}

function dist(a: Vector2D, b: Vector2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * In-browser AI that drives computer-controlled cars. The host client owns the
 * authoritative game state, so it simply asks this service for each bot's move
 * and applies it like any other player's — no extra connection is involved.
 *
 * The driver follows the track centerline as an ordered waypoint list with a
 * strictly-increasing index. It aims at a point a little further along the line
 * and only advances the index once the car reaches the current waypoint. That
 * ordering forces the correct lap direction and survives self-crossing layouts
 * (e.g. Silverstone's infield) where a nearest-point heuristic would jump onto
 * the wrong leg of a crossover. Steering rewards both closeness to the aim
 * point and raw speed, so bots carry real pace on the straights.
 */
@Injectable({ providedIn: 'root' })
export class BotDriverService {
  private readonly centerlineCache = new Map<string, Centerline | null>();
  /** Current waypoint index each bot is driving toward (monotonic per lap). */
  private readonly waypoint = new Map<string, number>();

  /** Forget per-bot progress tracking. Call when a fresh race starts. */
  resetTracking(): void {
    this.waypoint.clear();
  }

  /** Test hook: current waypoint index a bot is targeting. */
  debugWaypoint(connectionId: string): number | undefined {
    return this.waypoint.get(connectionId);
  }

  /**
   * Choose the next velocity vector for a bot. The result is always one of the
   * host-legal moves for the player, so it passes engine validation as-is.
   */
  pickMove(player: Player, state: GameState, track: TrackDefinition): Vector2D {
    const profile = PROFILES[player.botDifficulty ?? 'normal'];
    const moves = getValidMoves(player, track, state.players, state.round);
    if (moves.length <= 1) {
      return moves[0]?.velocity ?? { ...player.velocity };
    }

    // Occasional imperfect driving. Even mistakes avoid the grass when a
    // safe alternative exists, so easy bots are beatable but not suicidal.
    if (profile.epsilon > 0 && Math.random() < profile.epsilon) {
      const onTrack = moves.filter((m) => isDrivable(getTileAt(track, m.landing.x, m.landing.y)));
      const pool = onTrack.length > 0 ? onTrack : moves;
      return pool[Math.floor(Math.random() * pool.length)].velocity;
    }

    const line = this.getCenterline(track);
    const target = line
      ? this.aimPoint(player, line, profile)
      : this.finishCentroid(track);

    let best = moves[0];
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const move of moves) {
      const score = this.scoreMove(player, move, target, track, profile);
      if (score > bestScore) {
        bestScore = score;
        best = move;
      }
    }
    return best.velocity;
  }

  /**
   * Advance the car's waypoint index as it reaches waypoints, then return a
   * point a little further along the line to steer toward.
   */
  private aimPoint(player: Player, line: Centerline, profile: DifficultyProfile): Vector2D {
    const { points } = line;
    const n = points.length;
    let idx = this.waypoint.get(player.connectionId) ?? this.nearestIndex(player.position, points);

    // Recover from desync: if the car has drifted well away from its target
    // waypoint (e.g. bumped onto the other leg of a crossover), re-lock the
    // index onto the nearest waypoint so steering follows the car's real spot.
    if (dist(player.position, points[idx % n]) > RESYNC_DIST) {
      idx = this.nearestIndex(player.position, points);
    }

    // Walk the index forward (never back) to the waypoint just ahead of the
    // car: advance while it has reached the current waypoint or the next one is
    // already closer. Stepping one at a time keeps it on the right leg through
    // self-crossings; the cap stops a single fast move skipping the whole loop.
    for (let advanced = 0; advanced < MAX_ADVANCE; advanced++) {
      const cur = points[idx % n];
      const next = points[(idx + 1) % n];
      const reached = dist(player.position, cur) <= ARRIVE_RADIUS;
      const nextCloser = dist(player.position, next) < dist(player.position, cur);
      if (!reached && !nextCloser) break;
      idx = (idx + 1) % n;
    }
    this.waypoint.set(player.connectionId, idx);

    // Walk forward along the line from the current waypoint by the look-ahead
    // distance (which grows with speed) to find the aim point.
    const ahead = profile.lookahead + gearOf(player.velocity) * 1.2;
    return this.walkForward(line, idx, ahead);
  }

  private scoreMove(
    player: Player,
    move: { velocity: Vector2D; landing: Vector2D },
    target: Vector2D,
    track: TrackDefinition,
    profile: DifficultyProfile
  ): number {
    let score = -dist(move.landing, target);

    // Carry speed, but only meaningfully once roughly pointed at the aim point.
    score += gearOf(move.velocity) * profile.speedReward;

    const tile = getTileAt(track, move.landing.x, move.landing.y);
    // Stay on the tarmac: landing off track kills momentum and costs penalties.
    if (tile === 'grass' || tile === 'rumble') score -= profile.safety * 2;
    if (isGrassShortcut(track, player.position, move.landing)) score -= profile.safety;

    // Respect the difficulty's comfortable top speed.
    const g = gearOf(move.velocity);
    if (g > profile.maxGear) score -= (g - profile.maxGear) * 4;

    // Brake for corners: a fast landing with few on-track exits is a spin
    // waiting to happen. Only penalize above a crawl so the car can always
    // ease through genuinely tight sections at gear 1–2 without stalling.
    const escapes = this.onTrackEscapes(move.landing, move.velocity, track);
    if (escapes < SAFE_ESCAPES && g > 2) {
      score -= (SAFE_ESCAPES - escapes) * (g - 2) * profile.corner;
    }

    // Don't barrel into a dead end: penalize positions we can't drive out of.
    if (!this.hasSurvivableLine(move.landing, move.velocity, track, profile.planDepth)) {
      score -= profile.safety * 3;
    }

    return score;
  }

  /**
   * Whether, from `pos` moving at `velocity`, there is a chain of `depth`
   * on-track continuations (each within ±1 gear per axis). Guards against
   * accelerating into a wall the bot can't escape next turn.
   */
  private hasSurvivableLine(
    pos: Vector2D,
    velocity: Vector2D,
    track: TrackDefinition,
    depth: number
  ): boolean {
    if (depth <= 0) return true;
    for (let dvx = -1; dvx <= 1; dvx++) {
      for (let dvy = -1; dvy <= 1; dvy++) {
        const next: Vector2D = { x: velocity.x + dvx, y: velocity.y + dvy };
        const landing = landingPosition(pos, next);
        if (!isDrivable(getTileAt(track, landing.x, landing.y))) continue;
        if (this.hasSurvivableLine(landing, next, track, depth - 1)) return true;
      }
    }
    return false;
  }

  /** Count the ±1 next velocities from `pos`@`velocity` that stay on track. */
  private onTrackEscapes(pos: Vector2D, velocity: Vector2D, track: TrackDefinition): number {
    let count = 0;
    for (let dvx = -1; dvx <= 1; dvx++) {
      for (let dvy = -1; dvy <= 1; dvy++) {
        const next: Vector2D = { x: velocity.x + dvx, y: velocity.y + dvy };
        const landing = landingPosition(pos, next);
        if (isDrivable(getTileAt(track, landing.x, landing.y))) count++;
      }
    }
    return count;
  }

  private nearestIndex(pos: Vector2D, points: Vector2D[]): number {
    let idx = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < points.length; i++) {
      const d = dist(pos, points[i]);
      if (d < bestDist) {
        bestDist = d;
        idx = i;
      }
    }
    return idx;
  }

  /** Point `ahead` cells along the line, starting from waypoint `idx`. */
  private walkForward(line: Centerline, idx: number, ahead: number): Vector2D {
    const { points, segLen } = line;
    const n = points.length;
    let remaining = ahead;
    let i = idx % n;
    for (let hops = 0; hops < n; hops++) {
      const from = points[i];
      const to = points[(i + 1) % n];
      const len = segLen[i];
      if (len >= remaining) {
        const t = len === 0 ? 1 : remaining / len;
        return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
      }
      remaining -= len;
      i = (i + 1) % n;
    }
    return { ...points[i] };
  }

  /** Centerline with the duplicated closing point removed, cached per track. */
  private getCenterline(track: TrackDefinition): Centerline | null {
    if (this.centerlineCache.has(track.id)) {
      return this.centerlineCache.get(track.id) ?? null;
    }

    const raw = track.centerline ?? [];
    const points = [...raw];
    if (
      points.length >= 2 &&
      points[0].x === points[points.length - 1].x &&
      points[0].y === points[points.length - 1].y
    ) {
      points.pop();
    }

    if (points.length < 2) {
      this.centerlineCache.set(track.id, null);
      return null;
    }

    const segLen = points.map((p, i) => dist(p, points[(i + 1) % points.length]));
    const line: Centerline = { points, segLen };
    this.centerlineCache.set(track.id, line);
    return line;
  }

  private finishCentroid(track: TrackDefinition): Vector2D {
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
    if (count === 0) return { x: Math.floor(track.width / 2), y: Math.floor(track.height / 2) };
    return { x: Math.round(sumX / count), y: Math.round(sumY / count) };
  }
}
