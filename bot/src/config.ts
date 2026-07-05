import 'dotenv/config';

/**
 * Runtime configuration, sourced from environment variables (see `.env.example`).
 * Kept in one place so the transport, parser and brain never read `process.env`
 * directly — they receive a typed, validated config object instead.
 */
export interface BotConfig {
  /** Full ws:// or wss:// URL of the game server. */
  wsUrl: string;
  /** Code of the room to join (the bot is a client player, not the host). */
  roomCode: string;
  /** Lobby display name. */
  nickname: string;
  /** Artificial delay before submitting a move, in milliseconds (human-ish pacing). */
  moveDelayMs: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

function envStr(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(): BotConfig {
  return {
    wsUrl: envStr('WS_URL', 'ws://localhost:8080/game'),
    roomCode: envStr('ROOM_CODE', '').toUpperCase().trim(),
    nickname: envStr('NICKNAME', 'RoboRacer'),
    moveDelayMs: envInt('MOVE_DELAY_MS', 250),
    logLevel: envStr('LOG_LEVEL', 'info') as BotConfig['logLevel'],
  };
}
