# Dot Race Bot — headless agentive client

A Node.js AI player for Dot Race (Vector Rally). It connects to the game's
API Gateway WebSocket like any browser client, joins a room, and races using
an algorithmic pathfinder — no UI.

## Architecture

Three fully separated layers (each a distinct module in `src/`):

| Module | Responsibility |
|--------|----------------|
| `socket-client.ts` | Transport only: connect, exponential-backoff reconnect, envelope (de)serialization, `[CONNECTED]` / `[DISCONNECTED]` / `[MESSAGE RECEIVED]` logging |
| `state-store.ts` | Inbound parsing: turns raw `WsEnvelope` payloads into typed `RoomContext` + `GameState`, detects "it's my turn" and emits high-level events |
| `bot-brain.ts` | The math: enumerates the 9 grid accelerations (dx, dy ∈ {-1, 0, 1}), filters illegal/out-of-bounds options, greedily scores the rest against a goal |
| `main.ts` | Entry point: wires the layers, joins the room, submits moves |

Types and game rules are imported directly from the repo's
[`shared/ws-types.ts`](../shared/ws-types.ts) and
[`shared/tracks.ts`](../shared/tracks.ts), so the bot validates moves with the
exact same code the host runs.

## Wire protocol (this server's actual shapes)

Dot Race is host-authoritative: there is no `YOUR_TURN` push. The host
broadcasts the full game state via `RELAY`, and each client decides locally
whether it may move (`canPlayerMove`).

**Inbound** — host state broadcast the bot listens for:

```json
{
  "action": "RELAY",
  "payload": {
    "type": "TURN_ADVANCED",
    "state": {
      "phase": "GAME_ROUND",
      "trackId": "monza",
      "turnOrder": ["conn-a", "conn-b"],
      "currentTurnIndex": 1,
      "players": [
        { "connectionId": "conn-b", "position": { "x": 31, "y": 31 }, "velocity": { "x": 2, "y": 0 } }
      ]
    }
  }
}
```

**Outbound** — the move, forwarded to the host for validation. Note the server
expects the absolute next *velocity* vector (v' = v + a), not the raw
acceleration:

```json
{
  "action": "FORWARD_TO_HOST",
  "payload": { "action": "SUBMIT_MOVE", "vector": { "x": 3, "y": 0 } },
  "roomCode": "ABCDE"
}
```

## Running

```bash
cd bot
npm install

# Against the deployed backend:
BOT_WS_URL=wss://<api-id>.execute-api.us-east-1.amazonaws.com/prod \
BOT_ROOM_CODE=ABCDE \
BOT_NICKNAME=VectorBot \
npm start
```

Flow: create a room in the web app, start the bot with the room code, approve
"VectorBot" in the lobby, start the race. The bot moves automatically on its
turn (in both TURNS and TIMED modes) and rejoins transparently if the socket
drops.

| Env var | Default | Purpose |
|---------|---------|---------|
| `BOT_WS_URL` | `ws://localhost:8080/game` | WebSocket endpoint |
| `BOT_ROOM_CODE` | — (required) | 5-letter room code |
| `BOT_NICKNAME` | `VectorBot` | Lobby name |
| `BOT_THINK_DELAY_MS` | `400` | Delay before submitting a move |

## Offline smoke test

Drives the brain around a real circuit with the host's rules simulated
locally — no server required:

```bash
npm run smoke            # defaults to monza
npm run smoke -- suzuka  # any track id from shared/tracks.ts
```

## Upgrading the brain

`BotBrain.computeNextMove(carState, trackState, others)` is deliberately a
stub: it already produces the full legal move set each turn, so replacing the
greedy `score()` with A* / BFS over (position, velocity) states is a drop-in
change that touches nothing else.
