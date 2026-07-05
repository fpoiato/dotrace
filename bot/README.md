# DotRace Agentive Client Bot

Headless WebSocket bot for the turn-based Vector Rally / Racetrack game.

The bot joins an existing room, listens for host-authoritative game-state
snapshots, computes a legal next acceleration, and submits the move back to the
host through the existing WebSocket protocol.

## Run

```bash
npm install
npm run bot -- --room ABCDE --nickname AgentiveBot --url ws://localhost:8080/game
```

Environment variables are also supported:

```bash
BOT_WS_URL=ws://localhost:8080/game BOT_ROOM=ABCDE BOT_NICKNAME=AgentiveBot npm run bot
```

After joining, the browser host still needs to approve the pending bot player.

## WebSocket contract

The repository server stores only connection metadata. The browser host owns the
game state and relays snapshots to approved players.

### Inbound turn state

The bot treats `RELAY` messages as state updates. When `canPlayerMove(state,
botConnectionId)` is true, the message is considered the bot's turn.

```json
{
  "action": "RELAY",
  "roomCode": "ABCDE",
  "payload": {
    "type": "TURN_ADVANCED",
    "state": {
      "phase": "GAME_ROUND",
      "trackId": "monza",
      "players": [
        {
          "connectionId": "abc",
          "nickname": "AgentiveBot",
          "position": { "x": 31, "y": 31 },
          "velocity": { "x": 0, "y": 0 },
          "isOffTrack": false,
          "lap": 1
        }
      ],
      "turnOrder": ["abc"],
      "currentTurnIndex": 0,
      "round": 1
    }
  }
}
```

### Outbound move

`BotBrain` returns the chosen acceleration as `{ "dx": number, "dy": number }`.
The current server validates absolute next velocity vectors, so the WebSocket
client converts the acceleration to `vector = currentVelocity + acceleration`
before sending:

```json
{
  "action": "FORWARD_TO_HOST",
  "roomCode": "ABCDE",
  "payload": {
    "action": "SUBMIT_MOVE",
    "vector": { "x": 1, "y": 0 }
  }
}
```

For simple prototype servers that send `{ "type": "YOUR_TURN", "gameState": ... }`,
the parser also recognizes the example shape and replies with:

```json
{
  "action": "MOVE",
  "payload": { "dx": 1, "dy": 0 }
}
```

## Architecture

- `src/agentive-client.ts` - WebSocket connection, reconnect, join/rejoin, and
  outbound move execution.
- `src/state-parser.ts` - JSON parsing and runtime state normalization.
- `src/bot-brain.ts` - pathfinding stub that enumerates the 9 legal acceleration
  deltas, filters out invalid landings, and greedily aims toward the checkpoint
  or finish stripe.
- `src/main.ts` - CLI entry point.
