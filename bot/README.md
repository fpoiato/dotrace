# Dot Race Bot — Agentive Client

A **headless AI client** for [Dot Race](../README.md) (Vector Rally / Racetrack).
It connects to the game server over WebSockets, parses the host-authoritative
game state, computes its next move with an algorithmic pathfinder, and submits
its acceleration back over the socket.

The bot is a **player**, not a host: a human (or another client) creates the
room and approves the bot from the lobby, exactly like any other participant.

## Architecture

Concerns are split into distinct modules so the transport, the parser and the
pathfinding math never bleed into each other:

| File | Responsibility |
|------|----------------|
| `src/ws-client.ts` | **Transport.** Persistent socket, auto-reconnect with capped exponential backoff, `WsEnvelope` (de)serialization, lifecycle logging (`[CONNECTED]`, `[DISCONNECTED]`, `[MESSAGE RECEIVED]`). Knows nothing about game rules. |
| `src/state-parser.ts` | **Inbound.** Defensively validates `RELAY` payloads into a typed `GameState`, then projects a bot-centric `BotView` (own car, opponents, whether it is the bot's turn). |
| `src/bot-brain.ts` | **The brain.** `BotBrain.computeNextMove(carState, trackState)` enumerates the 9 grid accelerations, filters illegal/out-of-bounds options, and greedily seeks the goal. Returns `{ dx, dy }`. |
| `src/bot.ts` | **Orchestrator + entry point.** Joins the room, tracks identity, drives the turn loop, converts the brain's acceleration into the velocity the server expects, and submits it. |
| `src/config.ts` / `src/logger.ts` | Environment config and a tiny leveled logger. |
| `test/mock-server.ts` | A minimal local server that plays the host role so you can run the bot end-to-end without deploying the backend. |

Game types and rules (`getValidMoves`, `getTileAt`, vector math, …) are reused
from the repo's [`shared/`](../shared) contract, so the bot's moves are always
validated with the **exact same logic the real host enforces**.

## Protocol notes (how it maps to the real server)

Dot Race state is **ephemeral and host-authoritative** — there is no dedicated
"your turn" message. Instead:

- **Inbound:** the host broadcasts `RELAY` envelopes carrying the full
  `GameState`. The bot recomputes whether it may act via `canPlayerMove(state, myId)`
  (in `TURNS` mode: `turnOrder[currentTurnIndex] === myId`).
- **Move semantics:** a move's `vector` is the car's **new velocity**
  (`position + velocity = landing`), constrained to ±1 per axis vs. the current
  velocity. The brain thinks in *acceleration* `{ dx, dy }`; the orchestrator
  folds that into the velocity before sending.
- **Outbound:** non-host players submit via
  `FORWARD_TO_HOST → { action: "SUBMIT_MOVE", vector }`.

## The pathfinder (stub)

Each turn the brain:

1. enumerates all **9 accelerations** — `dx ∈ {-1,0,1}`, `dy ∈ {-1,0,1}`;
2. folds each into the current velocity and computes the landing square;
3. **filters** out illegal options — off the grid, over the top-speed (gear)
   cap, illegal off-track gears, or landing on an opponent;
4. **scores** survivors greedily: distance to the current goal (the far-side
   checkpoint until cleared, then the finish stripe), a heavy penalty for
   landing on grass (which kills momentum), a crash penalty, and a small bonus
   for carrying speed toward the goal;
5. returns the best `{ dx, dy }`.

It is intentionally simple — swap the scoring in `bot-brain.ts` for A-star or a
beam search without touching the transport or parsing layers.

## Setup

Requires Node.js 20+.

```bash
cd bot
npm install
cp .env.example .env   # then edit WS_URL / ROOM_CODE / NICKNAME
```

### Configuration (`.env`)

| Var | Default | Meaning |
|-----|---------|---------|
| `WS_URL` | `ws://localhost:8080/game` | Game server WebSocket URL (use the API Gateway `wss://…/prod` URL for the deployed backend). |
| `ROOM_CODE` | — | **Required.** Code of the room to join. |
| `NICKNAME` | `RoboRacer` | Lobby display name. |
| `MOVE_DELAY_MS` | `250` | Delay before submitting each move. |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |

## Run

```bash
# 1. Start the local mock host (terminal A)
npm run mock-server

# 2. Run the bot against it (terminal B)
WS_URL=ws://localhost:8080/game ROOM_CODE=MOCKR npm start
```

Against the real backend, set `WS_URL` to the deployed WebSocket URL and
`ROOM_CODE` to a room a host has opened, then approve the bot from the lobby.

```bash
npm run typecheck   # type-check without emitting
```
