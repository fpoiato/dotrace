import { BotSkill, TrackDefinition, Vector2D } from '../../shared/ws-types';
import { planBotMove } from '../../shared/bot-ai';
import type { TurnContext } from './state-parser';

/**
 * The headless client's driver.
 *
 * The planning itself lives in shared/bot-ai.ts, which is also what the host
 * browser runs for the CPU racers it drives locally. Keeping one implementation
 * means this client races exactly like an in-game bot, and the planner is
 * covered by the same tests.
 */
export class BotBrain {
  constructor(private readonly skill: BotSkill = 'HARD') {}

  /**
   * The velocity to play this turn, or null when the car has no legal move.
   * Returns the new velocity rather than an acceleration delta, because that
   * is what the server's SUBMIT_MOVE expects.
   */
  computeNextMove(ctx: TurnContext, track: TrackDefinition): Vector2D | null {
    return planBotMove({
      bot: ctx.myPlayer,
      track,
      players: ctx.gameState.players,
      round: ctx.gameState.round,
      skill: this.skill,
    });
  }
}
