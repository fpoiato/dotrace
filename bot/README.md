# Dot Race Bot — headless agentive client

A Node.js AI bot that plays Dot Race (Vector Rally) as a regular player: it
connects to the game's WebSocket endpoint, joins a room, waits for host
approval, and races laps on its own.

## Architecture

Three fully separated concerns:

| Module | Responsibility |
|--------|----------------|
| `src/socket-client.ts` | WebSocket transport: connect, exponential-backoff auto-reconnect, JSON envelope (de)serialization, `[CONNECTED]` / `[DISCONNECTED]` / `[MESSAGE RECEIVED]` logging |
| `src/state-store.ts` | Inbound processing: parses `RELAY` frames into the shared typed `GameState`, tracks the bot's identity through join/approve/rejoin, and detects "it's your turn" |
| `src/brain.ts` | `BotBrain` pathfinder: enumerates the 9 grid accelerations (dx, dy ∈ {-1, 0, 1}), filters out-of-bounds/illegal options via the shared rules, and greedily picks the move that minimizes a BFS distance field to the checkpoint / finish stripe |
| `src/bot.ts` | Entry point: wires the modules, debounces duplicate turn signals, converts the brain's acceleration into the absolute velocity vector the server expects, and submits it via `FORWARD_TO_HOST` |

All game rules (gear limits, off-track caps, move validation) are imported
from `shared/ws-types.ts` — the exact code the human host runs — so the bot
can never compute a move the host would reject.

## Protocol

Inbound (server → bot), host-authoritative relay model:

```json
{ "action": "RELAY", "payload": { "type": "TURN_ADVANCED", "state": { "phase": "GAME_ROUND", "players": [ ... ], "turnOrder": [ ... ], "currentTurnIndex": 0, "trackId": "monza" } } }
```

Outbound (bot → server), forwarded to the host for validation:

```json
{ "action": "FORWARD_TO_HOST", "payload": { "action": "SUBMIT_MOVE", "vector": { "x": 2, "y": -1 } }, "roomCode": "ABCDE" }
```

Note: `vector` is the **absolute next velocity** (current velocity + chosen
acceleration), matching what human clients send.

## Run

```bash
cd bot
npm install

BOT_WS_URL=wss://<api-id>.execute-api.us-east-1.amazonaws.com/prod \
BOT_ROOM_CODE=ABCDE \
BOT_NICKNAME=VectorBot \
npm start
```

| Env var | Default | Purpose |
|---------|---------|---------|
| `BOT_WS_URL` | `ws://localhost:8080/game` | WebSocket endpoint |
| `BOT_ROOM_CODE` | — (required) | 5-letter room code of an open lobby |
| `BOT_NICKNAME` | `VectorBot` | Lobby nickname |
| `BOT_MOVE_DELAY_MS` | `600` | Artificial thinking delay so humans can watch |
| `BOT_RESUBMIT_MS` | `8000` | Resend a move if the host never acked it |

The host must approve the bot in the lobby like any other player.

## Test

`npm run test:lap` boots a local mock server (playing both the relay and the
host engine, using the real shared rules and a real track) and asserts the
bot completes a full solo lap:

```bash
npm run test:lap                       # monza
TEST_TRACK_ID=monaco npm run test:lap  # any track id from shared/tracks.ts
```

## Limitations / next steps

- The bot is a guest client only; if it ever gets promoted to host it will
  keep racing but cannot run the host engine for other players.
- The greedy BFS heuristic is deliberately a stub: `BotBrain.computeNextMove`
  has a stable signature so it can be swapped for a proper A* search over
  (position, velocity) states without touching the transport or parser.
