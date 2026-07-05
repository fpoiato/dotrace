# Agentive Client Bot (Headless)

This folder contains a headless WebSocket bot for Dot Race / Vector Rally.

## Modules

- `main.js` → entry point and runtime orchestration.
- `websocket-client.js` → persistent socket + auto-reconnect logic.
- `state-parser.js` → inbound JSON parsing into structured bot state.
- `bot-brain.js` → pathfinder stub (9 acceleration options).
- `protocol.js` → outbound command serializer.
- `config.js` → env-driven runtime configuration.

## Inbound message shape used by this bot

### DotRace protocol (this repository's server)

```json
{
  "action": "RELAY",
  "payload": {
    "type": "TURN_ADVANCED",
    "state": {
      "phase": "GAME_ROUND",
      "round": 5,
      "currentTurnIndex": 2,
      "turnOrder": ["p1", "p2", "p3"],
      "players": [
        {
          "connectionId": "p2",
          "position": { "x": 10, "y": 14 },
          "velocity": { "x": 2, "y": -1 }
        }
      ]
    }
  },
  "roomCode": "ABCDE"
}
```

### Generic protocol fallback

```json
{
  "type": "YOUR_TURN",
  "gameState": {
    "car": { "x": 10, "y": 14, "vx": 2, "vy": -1 },
    "track": { "width": 100, "height": 100 }
  }
}
```

## Outbound message shape

### DotRace protocol (exact server envelope expected by this repo)

```json
{
  "action": "FORWARD_TO_HOST",
  "roomCode": "ABCDE",
  "payload": {
    "action": "SUBMIT_MOVE",
    "vector": { "x": 3, "y": -1 }
  }
}
```

### Generic fallback

```json
{
  "action": "MOVE",
  "payload": { "dx": 1, "dy": 0 }
}
```

## Run

```bash
BOT_WS_URL=ws://localhost:8080/game \
BOT_PROTOCOL=dotrace \
BOT_ROOM_CODE=ABCDE \
BOT_NICKNAME=AgentiveBot \
npm run bot:start
```

## Configuration

- `BOT_WS_URL` (default: `ws://localhost:8080/game`)
- `BOT_PROTOCOL` (`dotrace` or `generic`, default: `dotrace`)
- `BOT_NICKNAME` (default: `AgentiveBot`)
- `BOT_ROOM_CODE` (optional)
- `BOT_CREATE_ROOM` (`true`/`false`, default: `true`)
- `BOT_RECONNECT_BASE_MS` (default: `1000`)
- `BOT_RECONNECT_MAX_MS` (default: `10000`)
- `BOT_GOAL_X`, `BOT_GOAL_Y` (optional goal override for greedy stub)
