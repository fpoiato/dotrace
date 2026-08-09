/** Runtime configuration loaded from environment variables or CLI args. */

export interface BotConfig {
  /** WebSocket endpoint (push channel). */
  wsUrl: string;
  /** HTTP API endpoint for client→server commands (no trailing slash). */
  apiUrl: string;
  /** Five-letter room code to join. */
  roomCode: string;
  /** Display name shown in the lobby and race. */
  nickname: string;
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

export function loadConfig(): BotConfig {
  const roomCode = requireRoomCode(process.env.ROOM_CODE ?? process.argv[2] ?? '');
  const nickname = (process.env.NICKNAME ?? process.argv[3] ?? 'AgentBot').trim();

  return {
    wsUrl: process.env.WS_URL ?? 'ws://localhost:8080/game',
    apiUrl: (process.env.API_URL ?? 'http://localhost:3001').replace(/\/$/, ''),
    roomCode,
    nickname,
  };
}
