/**
 * Re-export the shared BotBrain used by both the host UI and this headless client.
 * Pathfinding lives in shared/bot-brain.ts so the in-browser vs-computer mode
 * and the standalone Agentive Client stay in sync.
 */
export { BotBrain, chooseBotVelocity, botGoal } from '../../shared/bot-brain';
export type { BotMoveInput } from '../../shared/bot-brain';
