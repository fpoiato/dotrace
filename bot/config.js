const DEFAULT_WS_URL = 'ws://localhost:8080/game';
const DEFAULT_PROTOCOL = 'dotrace';

function parseInteger(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value, fallback) {
  if (value === undefined) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return fallback;
}

function normalizeProtocol(protocol) {
  const normalized = String(protocol ?? DEFAULT_PROTOCOL).trim().toLowerCase();
  if (normalized === 'generic') return 'generic';
  return 'dotrace';
}

function loadBotConfig() {
  return {
    wsUrl: process.env.BOT_WS_URL ?? DEFAULT_WS_URL,
    protocol: normalizeProtocol(process.env.BOT_PROTOCOL),
    nickname: process.env.BOT_NICKNAME ?? 'AgentiveBot',
    roomCode: process.env.BOT_ROOM_CODE?.trim().toUpperCase() || null,
    createRoomIfMissingRoomCode: parseBoolean(process.env.BOT_CREATE_ROOM, true),
    reconnectBaseMs: parseInteger(process.env.BOT_RECONNECT_BASE_MS, 1000),
    reconnectMaxMs: parseInteger(process.env.BOT_RECONNECT_MAX_MS, 10000),
    goalX: parseInteger(process.env.BOT_GOAL_X, null),
    goalY: parseInteger(process.env.BOT_GOAL_Y, null),
    dotRaceTrackWidth: parseInteger(process.env.BOT_DOTRACE_TRACK_WIDTH, 56),
    dotRaceTrackHeight: parseInteger(process.env.BOT_DOTRACE_TRACK_HEIGHT, 36),
  };
}

module.exports = {
  loadBotConfig,
};
