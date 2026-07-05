/**
 * @typedef {Object} SessionContext
 * @property {string|null} connectionId
 * @property {string|null} previousConnectionId
 * @property {string|null} roomCode
 *
 * @typedef {Object} ParsedTurnContext
 * @property {'dotrace'|'generic'} protocol
 * @property {{x:number,y:number,vx:number,vy:number}} carState
 * @property {{width:number,height:number,goal?:{x:number,y:number}}} trackState
 * @property {string} turnToken
 */

function parseIncomingMessage(rawData, session, config) {
  const text = String(rawData);
  const envelope = safeJsonParse(text);
  if (!envelope || typeof envelope !== 'object') {
    return { envelope: null, updates: {}, turnContext: null };
  }

  const updates = parseSessionUpdates(envelope, session);
  const connectionId = updates.connectionId ?? session.connectionId;
  const turnContext =
    parseDotRaceTurn(envelope, connectionId, config) || parseGenericTurn(envelope, config);

  return { envelope, updates, turnContext };
}

function parseSessionUpdates(envelope, session) {
  const payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {};
  const next = {};

  if (typeof payload.connectionId === 'string') {
    next.connectionId = payload.connectionId;
  }

  const envelopeRoomCode = typeof envelope.roomCode === 'string' ? envelope.roomCode : null;
  const payloadRoomCode = typeof payload.roomCode === 'string' ? payload.roomCode : null;
  const roomCode = (payloadRoomCode ?? envelopeRoomCode ?? session.roomCode ?? '').trim();
  if (roomCode) {
    next.roomCode = roomCode.toUpperCase();
  }

  return next;
}

function parseDotRaceTurn(envelope, connectionId, config) {
  if (envelope.action !== 'RELAY') return null;
  const relayPayload = envelope.payload;
  if (!relayPayload || typeof relayPayload !== 'object') return null;
  const state = relayPayload.state;
  if (!state || typeof state !== 'object' || !connectionId) return null;

  const players = Array.isArray(state.players) ? state.players : [];
  const player = players.find((item) => item?.connectionId === connectionId);
  if (!player) return null;

  const isGameRound = state.phase === 'GAME_ROUND';
  const finished = player.finishOrder !== undefined && player.finishOrder !== null;
  const isTimedMode = state.gameMode === 'TIMED';
  const currentTurnPlayer = Array.isArray(state.turnOrder)
    ? state.turnOrder[state.currentTurnIndex ?? 0]
    : null;

  const isMyTurn = isGameRound && !finished && (isTimedMode || currentTurnPlayer === connectionId);
  if (!isMyTurn) return null;

  const carState = {
    x: Number(player.position?.x ?? 0),
    y: Number(player.position?.y ?? 0),
    vx: Number(player.velocity?.x ?? 0),
    vy: Number(player.velocity?.y ?? 0),
  };

  const goal =
    typeof config.goalX === 'number' && typeof config.goalY === 'number'
      ? { x: config.goalX, y: config.goalY }
      : undefined;

  const trackState = {
    width: Number(config.dotRaceTrackWidth),
    height: Number(config.dotRaceTrackHeight),
    goal,
  };

  const turnToken = [
    'dotrace',
    state.round ?? 'r?',
    state.currentTurnIndex ?? 't?',
    player.position?.x ?? 'x?',
    player.position?.y ?? 'y?',
    player.velocity?.x ?? 'vx?',
    player.velocity?.y ?? 'vy?',
  ].join(':');

  return {
    protocol: 'dotrace',
    carState,
    trackState,
    turnToken,
  };
}

function parseGenericTurn(envelope, config) {
  const actionType = envelope.type ?? envelope.action;
  if (actionType !== 'YOUR_TURN') return null;
  const state = envelope.gameState ?? envelope.payload?.gameState;
  if (!state || typeof state !== 'object') return null;

  const car = state.car;
  const track = state.track;
  if (!car || !track) return null;

  const carState = {
    x: Number(car.x),
    y: Number(car.y),
    vx: Number(car.vx),
    vy: Number(car.vy),
  };

  const fallbackGoal = {
    x: Number(track.width) - 1,
    y: Number(track.height) - 1,
  };
  const goal =
    typeof config.goalX === 'number' && typeof config.goalY === 'number'
      ? { x: config.goalX, y: config.goalY }
      : fallbackGoal;

  return {
    protocol: 'generic',
    carState,
    trackState: {
      width: Number(track.width),
      height: Number(track.height),
      goal,
    },
    turnToken: `generic:${Date.now()}`,
  };
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

module.exports = {
  parseIncomingMessage,
};
