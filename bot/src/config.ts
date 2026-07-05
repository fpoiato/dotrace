/**
 * Bot runtime configuration, sourced from environment variables so the same
 * binary can point at local mock servers or the deployed API Gateway endpoint.
 */
export interface BotConfig {
  /** WebSocket endpoint of the game server. */
  wsUrl: string;
  /** Room code to join. Required unless the server auto-assigns one. */
  roomCode: string;
  /** Nickname shown to other players in the lobby. */
  nickname: string;
  /** Artificial "thinking" delay before submitting a move (ms). */
  moveDelayMs: number;
  /** If the host has not acked our move, resubmit after this long (ms). */
  resubmitAfterMs: number;
}

export function loadConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    wsUrl: overrides.wsUrl ?? process.env.BOT_WS_URL ?? 'ws://localhost:8080/game',
    roomCode: overrides.roomCode ?? (process.env.BOT_ROOM_CODE ?? '').toUpperCase().trim(),
    nickname: overrides.nickname ?? process.env.BOT_NICKNAME ?? 'VectorBot',
    moveDelayMs: overrides.moveDelayMs ?? Number(process.env.BOT_MOVE_DELAY_MS ?? 600),
    resubmitAfterMs: overrides.resubmitAfterMs ?? Number(process.env.BOT_RESUBMIT_MS ?? 8000),
  };
}
