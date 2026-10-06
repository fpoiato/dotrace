/** Runtime configuration for the AI player, from env vars or CLI args. */
import { AiDifficulty, DIFFICULTY_TUNING, difficultyFromUnknown } from './difficulty';

/**
 * Claude Opus 4.7 on Bedrock Converse. The base id has no on-demand throughput;
 * the US geo profile keeps the call in us-east-1, us-east-2, and us-west-2.
 */
export const DEFAULT_BEDROCK_MODEL_ID = 'us.anthropic.claude-opus-4-7';

export interface AgentConfig {
  /** WebSocket endpoint (push channel). */
  wsUrl: string;
  /** HTTP API endpoint for client→server commands (no trailing slash). */
  apiUrl: string;
  /** Five-letter room code to join. */
  roomCode: string;
  /** Display name shown in the lobby and race. */
  nickname: string;
  /** Bedrock model id (or inference profile id). */
  modelId: string;
  /** AWS region for Bedrock. */
  region: string;
  /** 'laya' asks Ollaya; 'bedrock' uses Opus; 'heuristic' is local. */
  brain: 'bedrock' | 'heuristic' | 'laya';
  /** easy | medium | hard | pro — tunes speed, mistakes, gear cap. */
  difficulty: AiDifficulty;
  /** Artificial delay before each move (ms) so the race feels natural. */
  moveDelayMs: number;
}

function requireRoomCode(roomCode: string): string {
  const code = roomCode.toUpperCase().trim();
  if (code.length !== 5) {
    throw new Error(
      'ROOM_CODE is required (5 letters). Usage: npm run dev -- <ROOM_CODE> [NICKNAME]'
    );
  }
  return code;
}

export function loadConfig(): AgentConfig {
  const roomCode = requireRoomCode(process.env.ROOM_CODE ?? process.argv[2] ?? '');
  const nickname = (process.env.NICKNAME ?? process.argv[3] ?? 'AI Pilot').trim();
  const brain =
    process.env.BRAIN === 'heuristic' ? 'heuristic' : process.env.BRAIN === 'laya' ? 'laya' : 'bedrock';
  const difficulty = difficultyFromUnknown(process.env.DIFFICULTY);
  const defaultDelay = DIFFICULTY_TUNING[difficulty].moveDelayMs;

  return {
    wsUrl: process.env.WS_URL ?? 'ws://localhost:8080/game',
    apiUrl: (process.env.API_URL ?? 'http://localhost:3001').replace(/\/$/, ''),
    roomCode,
    nickname,
    modelId: process.env.BEDROCK_MODEL_ID ?? DEFAULT_BEDROCK_MODEL_ID,
    region: process.env.AWS_REGION ?? 'us-east-1',
    brain,
    difficulty,
    moveDelayMs: Number(process.env.MOVE_DELAY_MS ?? defaultDelay),
  };
}
