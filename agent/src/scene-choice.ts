/**
 * Turn a Laya choice id into the move that is actually driven.
 *
 * Same rule the Ollaya brain uses: a legal label is replaced by the asphalt
 * step tagged `best` when one exists, and by `back` when the car is already
 * off the track. Anything else that stands still or leaves the asphalt falls
 * through to the heuristic.
 */
import type { AnnotatedMove } from './tools';
import { parseMoveLabel, type LayaScene } from './laya-scene';

export function applySceneChoice(
  who: string,
  scene: LayaScene,
  moves: AnnotatedMove[],
  choice: string | null,
  heuristicPick: AnnotatedMove
): AnnotatedMove {
  if (!choice || !parseMoveLabel(choice)) {
    console.warn(
      `[BRAIN] ${who} returned no move label (${JSON.stringify(choice)}) — using heuristic`
    );
    return heuristicPick;
  }
  const option = scene.options.find((item) => item.label === choice);
  if (!option || option.illegal) {
    console.warn(`[BRAIN] ${who} picked ${choice} which is illegal — using heuristic`);
    return heuristicPick;
  }
  const match = moves.find(
    (move) => move.velocity.x === option.velocity.x && move.velocity.y === option.velocity.y
  );
  if (!match) {
    console.warn(`[BRAIN] ${who} picked ${choice} which is not a legal move — using heuristic`);
    return heuristicPick;
  }
  const bestOption = scene.options.find((item) => item.detail.startsWith('best '));
  const bestMove = bestOption
    ? moves.find(
        (move) =>
          move.velocity.x === bestOption.velocity.x && move.velocity.y === bestOption.velocity.y
      )
    : undefined;
  if (bestMove) {
    if (match.velocity.x !== bestMove.velocity.x || match.velocity.y !== bestMove.velocity.y) {
      console.warn(`[BRAIN] ${who} picked ${choice} — using best`);
    }
    return bestMove;
  }
  const backOption = scene.options.find((item) => item.detail.startsWith('back '));
  const backMove = backOption
    ? moves.find(
        (move) =>
          move.velocity.x === backOption.velocity.x && move.velocity.y === backOption.velocity.y
      )
    : undefined;
  if (backMove) {
    if (match.velocity.x !== backMove.velocity.x || match.velocity.y !== backMove.velocity.y) {
      console.warn(`[BRAIN] ${who} picked ${choice} — using back`);
    }
    return backMove;
  }
  const stationary = match.velocity.x === 0 && match.velocity.y === 0;
  const hasMotion = moves.some((move) => move.velocity.x !== 0 || move.velocity.y !== 0);
  if (stationary && hasMotion) {
    console.warn(`[BRAIN] ${who} picked standstill — using heuristic`);
    return heuristicPick;
  }
  const leavesAsphalt =
    match.grassShortcut || match.landingTile === 'grass' || match.landingTile === 'rumble';
  const canStayOnAsphalt = moves.some(
    (move) =>
      !move.grassShortcut && (move.landingTile === 'track' || move.landingTile === 'finish')
  );
  if (leavesAsphalt && canStayOnAsphalt) {
    console.warn(`[BRAIN] ${who} left the asphalt — using heuristic`);
    return heuristicPick;
  }
  return match;
}
