const { loadBotConfig } = require('./config');
const { BotBrain } = require('./bot-brain');
const { buildJoinEnvelope, serializeMoveCommand } = require('./protocol');
const { parseIncomingMessage } = require('./state-parser');
const { ReconnectingWebSocketClient } = require('./websocket-client');

function startBot() {
  const config = loadBotConfig();
  const brain = new BotBrain();
  const session = {
    connectionId: null,
    previousConnectionId: null,
    roomCode: config.roomCode,
  };
  let lastTurnToken = null;

  const client = new ReconnectingWebSocketClient({
    url: config.wsUrl,
    baseDelayMs: config.reconnectBaseMs,
    maxDelayMs: config.reconnectMaxMs,
    onOpen: ({ isReconnect }) => {
      const joinEnvelope = buildJoinEnvelope(config, session, isReconnect);
      if (!joinEnvelope) return;
      if (isReconnect && session.connectionId) {
        session.previousConnectionId = session.connectionId;
      }
      client.sendJson(joinEnvelope);
      console.log(`[OUTBOUND] ${JSON.stringify(joinEnvelope)}`);
    },
    onMessage: (raw) => {
      const { updates, turnContext } = parseIncomingMessage(raw, session, config);
      applySessionUpdates(session, updates);

      if (!turnContext) return;
      if (turnContext.turnToken === lastTurnToken) return;
      lastTurnToken = turnContext.turnToken;

      const move = brain.computeNextMove(turnContext.carState, turnContext.trackState);
      console.log(`[BOT MOVE] ${JSON.stringify(move)}`);
      const outbound = serializeMoveCommand(move, turnContext, session);
      client.sendJson(outbound);
      console.log(`[OUTBOUND] ${JSON.stringify(outbound)}`);
    },
    onClose: () => {
      session.previousConnectionId = session.connectionId;
    },
  });

  client.connect();
}

function applySessionUpdates(session, updates) {
  if (updates.connectionId && updates.connectionId !== session.connectionId) {
    session.previousConnectionId = session.connectionId;
    session.connectionId = updates.connectionId;
  }
  if (updates.roomCode) {
    session.roomCode = updates.roomCode;
  }
}

startBot();
