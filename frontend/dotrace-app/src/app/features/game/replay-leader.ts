/**
 * Who the replay camera should sit on.
 *
 * Finish order on a replay frame is the final podium, copied onto every frame,
 * so it cannot say who is ahead *right now*. Rank by lap, then by how far the
 * car has travelled along the directed centerline. Cars that already took the
 * flag (current round is past their finish round) drop out, so the view stays
 * with the race instead of a car parked on the stripe.
 */
import { TrackDefinition, Vector2D } from '../../core/models/ws-types';

export interface RaceProgressCar {
  connectionId: string;
  nickname: string;
  position: Vector2D;
  lap: number;
  /** Racing round when this car finished. Absent while it is still out. */
  finishRound?: number;
}

function racingLine(track: TrackDefinition): Vector2D[] {
  const line = track.centerline;
  if (line.length < 2) return line;
  const last = line[line.length - 1]!;
  const first = line[0]!;
  if (last.x === first.x && last.y === first.y) return line.slice(0, -1);
  return line;
}

/** Closed line resampled at about one cell, so nearest-vertex tracks arc progress. */
function densify(line: Vector2D[]): Vector2D[] {
  if (line.length < 2) return line;
  const out: Vector2D[] = [];
  for (let i = 0; i < line.length; i++) {
    const a = line[i]!;
    const b = line[(i + 1) % line.length]!;
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

function nearestIndex(line: Vector2D[], p: Vector2D): number {
  let best = 0;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i < line.length; i++) {
    const q = line[i]!;
    const d = (q.x - p.x) * (q.x - p.x) + (q.y - p.y) * (q.y - p.y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Connection id of the car the replay should follow.
 * `round` is the frame's racing round; omit it to ignore finish timing.
 */
export function leadingPlayerId(
  cars: readonly RaceProgressCar[],
  track: TrackDefinition,
  round?: number
): string | undefined {
  if (cars.length === 0) return undefined;
  const stillRacing = cars.filter(
    (c) => c.finishRound === undefined || round === undefined || round <= c.finishRound
  );
  const pool = stillRacing.length > 0 ? stillRacing : cars;
  const line = densify(racingLine(track));
  const ranked = [...pool].sort((a, b) => {
    if (b.lap !== a.lap) return b.lap - a.lap;
    const along = nearestIndex(line, b.position) - nearestIndex(line, a.position);
    if (along !== 0) return along;
    return a.nickname.localeCompare(b.nickname);
  });
  return ranked[0]?.connectionId;
}
