/**
 * Racing-line samples for the Nova fine-tune.
 *
 * Positions sit on the directed line (and one step off it, on grass) at the
 * gears a car actually carries. Each row uses the same Laya decide packet the
 * live brain sends.
 */
import {
  createInitialState,
  createLobbyPlayer,
  getTileAt,
  type GameState,
  type Player,
  type TrackDefinition,
  type Vector2D,
} from '../../shared/ws-types';
import { TRACKS } from '../../shared/tracks';
import { densifyRacingLine, racingLine } from './track-path';
import { bedrockConversationRecord, type BedrockConversationRecord } from './bedrock-dataset';
import { buildLayaScene } from './laya-scene';

const LINE_STRIDE = 5;

function playerOn(track: TrackDefinition): { me: Player; state: GameState } {
  const me = createLobbyPlayer('tune', 'Tune', false, 1, '#3B82F6');
  const state = createInitialState([me], 'tune');
  state.phase = 'GAME_ROUND';
  state.trackId = track.id;
  state.turnOrder = ['tune'];
  state.round = 4;
  state.totalLaps = 3;
  me.lap = 1;
  return { me, state };
}

function sign(n: number): number {
  if (n > 0) return 1;
  if (n < 0) return -1;
  return 0;
}

/** Unit step along the racing line, Chebyshev. */
function stepToward(from: Vector2D, to: Vector2D): Vector2D {
  const dx = sign(to.x - from.x);
  const dy = sign(to.y - from.y);
  if (dx === 0 && dy === 0) return { x: 1, y: 0 };
  return { x: dx, y: dy };
}

function scaled(step: Vector2D, gear: number): Vector2D {
  return { x: step.x * gear, y: step.y * gear };
}

function onBoard(track: TrackDefinition, point: Vector2D): boolean {
  return getTileAt(track, point.x, point.y) !== null;
}

function asphalt(track: TrackDefinition, point: Vector2D): boolean {
  const tile = getTileAt(track, point.x, point.y);
  return tile === 'track' || tile === 'finish';
}

/** A grass cell beside the line, for the off-track `back` label. */
function grassBeside(track: TrackDefinition, point: Vector2D): Vector2D | null {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (dx === 0 && dy === 0) continue;
      const next = { x: point.x + dx, y: point.y + dy };
      if (getTileAt(track, next.x, next.y) === 'grass') return next;
    }
  }
  return null;
}

function pushScene(
  out: BedrockConversationRecord[],
  seen: Set<string>,
  track: TrackDefinition,
  me: Player,
  state: GameState,
  position: Vector2D,
  velocity: Vector2D,
  passedCheckpoint: boolean,
  offTrack: boolean
): void {
  if (!onBoard(track, position)) return;
  const key = [
    track.id,
    position.x,
    position.y,
    velocity.x,
    velocity.y,
    passedCheckpoint ? 1 : 0,
    offTrack ? 1 : 0,
  ].join(',');
  if (seen.has(key)) return;
  seen.add(key);

  me.position = position;
  me.velocity = velocity;
  me.passedCheckpoint = passedCheckpoint;
  me.isOffTrack = offTrack;
  me.gearPenaltyUntilRound = offTrack ? state.round + 3 : undefined;

  const scene = buildLayaScene(me, state, track);
  const choice =
    scene.options.find((option) => !option.illegal && option.detail.startsWith('best '))?.label ??
    scene.options.find((option) => !option.illegal && option.detail.startsWith('back '))?.label;
  if (!choice) return;
  const record = bedrockConversationRecord(scene, choice);
  if (record) out.push(record);
}

/** One pass over every circuit. Order is stable so the JSONL does not churn. */
export function collectFinetuneRecords(tracks: TrackDefinition[] = TRACKS): BedrockConversationRecord[] {
  const out: BedrockConversationRecord[] = [];
  const seen = new Set<string>();

  for (const track of tracks) {
    const line = densifyRacingLine(racingLine(track), 1);
    if (line.length === 0) continue;
    const { me, state } = playerOn(track);

    for (let i = 0; i < line.length; i += LINE_STRIDE) {
      const here = {
        x: Math.round(line[i]!.x),
        y: Math.round(line[i]!.y),
      };
      const aheadRaw = line[(i + 4) % line.length]!;
      const ahead = { x: Math.round(aheadRaw.x), y: Math.round(aheadRaw.y) };
      const heading = stepToward(here, ahead);
      const sideways: Vector2D = { x: -heading.y, y: heading.x };
      const passed = i > line.length / 2;
      const velocities: Vector2D[] = [
        { x: 0, y: 0 },
        scaled(heading, 1),
        scaled(heading, 3),
        scaled(heading, 6),
        scaled({ x: -heading.x, y: -heading.y }, 2),
        { x: heading.x * 2 + sideways.x, y: heading.y * 2 + sideways.y },
      ];

      if (asphalt(track, here)) {
        for (const velocity of velocities) {
          pushScene(out, seen, track, me, state, here, velocity, passed, false);
        }
      }

      if (i % (LINE_STRIDE * 4) === 0) {
        const grass = grassBeside(track, here);
        if (grass) {
          pushScene(out, seen, track, me, state, grass, { x: 0, y: 0 }, passed, true);
          pushScene(out, seen, track, me, state, grass, heading, passed, true);
          pushScene(
            out,
            seen,
            track,
            me,
            state,
            grass,
            { x: -heading.x, y: -heading.y },
            passed,
            true
          );
        }
      }
    }
  }

  return out;
}
