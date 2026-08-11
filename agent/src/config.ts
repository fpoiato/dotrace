/** Runtime configuration for the AI player, from env vars or CLI args. */

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
  /** 'bedrock' uses the LLM brain; 'heuristic' skips Bedrock entirely. */
  brain: 'bedrock' | 'heuristic';
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
  const brain = process.env.BRAIN === 'heuristic' ? 'heuristic' : 'bedrock';

  return {
    wsUrl: process.env.WS_URL ?? 'ws://localhost:8080/game',
    apiUrl: (process.env.API_URL ?? 'http://localhost:3001').replace(/\/$/, ''),
    roomCode,
    nickname,
    modelId: process.env.BEDROCK_MODEL_ID ?? 'amazon.nova-micro-v1:0',
    region: process.env.AWS_REGION ?? 'us-east-1',
    brain,
    moveDelayMs: Number(process.env.MOVE_DELAY_MS ?? 400),
  };
}
