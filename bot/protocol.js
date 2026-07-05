function buildJoinEnvelope(config, session, isReconnect) {
  if (config.protocol === 'generic') {
    return null;
  }

  if (config.roomCode) {
    if (isReconnect && session.previousConnectionId) {
      return {
        action: 'REJOIN_ROOM',
        roomCode: config.roomCode,
        payload: {
          nickname: config.nickname,
          roomCode: config.roomCode,
          previousConnectionId: session.previousConnectionId,
        },
      };
    }
    return {
      action: 'JOIN_ROOM',
      roomCode: config.roomCode,
      payload: {
        nickname: config.nickname,
        roomCode: config.roomCode,
      },
    };
  }

  if (!config.createRoomIfMissingRoomCode) {
    return null;
  }

  return {
    action: 'CREATE_ROOM',
    payload: { nickname: config.nickname },
  };
}

function serializeMoveCommand(move, turnContext, session) {
  if (turnContext.protocol === 'dotrace') {
    if (!session.roomCode) {
      throw new Error('Missing roomCode; cannot submit DotRace move.');
    }
    const nextVelocity = {
      x: turnContext.carState.vx + move.dx,
      y: turnContext.carState.vy + move.dy,
    };

    return {
      action: 'FORWARD_TO_HOST',
      roomCode: session.roomCode,
      payload: {
        action: 'SUBMIT_MOVE',
        vector: nextVelocity,
      },
    };
  }

  return {
    action: 'MOVE',
    payload: { dx: move.dx, dy: move.dy },
  };
}

module.exports = {
  buildJoinEnvelope,
  serializeMoveCommand,
};
