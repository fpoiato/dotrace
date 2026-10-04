# Dot Race — AI Player (`dotrace-ai-player`)

An AI **network player** for Dot Race. It joins a room through the same
protocol as any human (`JOIN_ROOM` → host approval → `RELAY` →
`FORWARD_TO_HOST`/`SUBMIT_MOVE`), and picks moves with either:

- **Bot / Laya** — the lobby Bot asks [Ollaya](https://ollaya.dev) (`laya:typed-decisions`, Convai Innovations) to pick one of the nine gear changes from a small track window. The packet says this is a vector race (gear carries; each option adds -1, 0, or +1 to vx and vy) and names the circuit direction on each option (`best`, `with race`, `brake`, `too fast`, `wrong way`, `back`), plus the next bend, the stopping distance, where the current velocity lands for the next three turns, and that a grass cut caps gear at 1. That tag is the English typed-choice ModernBERT with a 1024-token context, questions included. The router name `laya` still sends English to `laya:en` (512) and is not what this bot requests. A truncated answer is discarded. The model runs on the shared `t4g.medium` in [fpoiato/laya-host](https://github.com/fpoiato/laya-host). Dot Race still starts it on the first connection and asks to stop after the room has been empty for 3 minutes; the host stays up if another project (Truco, for example) holds a lease. If Ollaya is still booting, the call fails, or the state is truncated, the styled heuristic plays that turn.
- **IA / Bedrock** — Amazon Bedrock Converse (`amazon.nova-micro-v1:0`), IAM
  auth. Falls back to the styled heuristic on model failure. Small per-turn cost.

The lobby host picks Bot or IA when adding a pilot (`brain` on `SPAWN_AI_PLAYER`).

Moves are always chosen from `getValidMoves()` (the same enumeration the host
uses to validate), so the agent can never submit an illegal move.

## Autonomous agent

```bash
# Bedrock brain (needs AWS credentials with bedrock:InvokeModel)
WS_URL=wss://… API_URL=https://… ROOM_CODE=ABCDE \
  npm run dev --workspace=agent

# Heuristic only (no AWS)
BRAIN=heuristic WS_URL=wss://… API_URL=https://… ROOM_CODE=ABCDE \
  npm run dev --workspace=agent -- ABCDE "AI Pilot"
```

Env vars: `WS_URL`, `API_URL`, `ROOM_CODE`, `NICKNAME`, `BRAIN`
(`bedrock`|`heuristic`), `BEDROCK_MODEL_ID`, `AWS_REGION`, `MOVE_DELAY_MS`.

## MCP server (play via Cursor / Claude / AgentCore)

Exposes the player as MCP tools over stdio: `join_room`, `get_status`,
`get_board_state`, `list_valid_moves`, `submit_move`, `wait_for_turn`,
`leave_room`. The room session lives inside the server process.

```bash
WS_URL=wss://… API_URL=https://… npm run mcp --workspace=agent
```

Cursor `mcp.json` example:

```json
{
  "dotrace-player": {
    "command": "npx",
    "args": ["tsx", "agent/src/mcp-server.ts"],
    "env": { "WS_URL": "wss://…", "API_URL": "https://…" }
  }
}
```

Typical agent flow: `join_room` (host approves) → loop `wait_for_turn` →
`get_board_state` + `list_valid_moves` → `submit_move` → until
`wait_for_turn` returns `racing: false`.

## Layout

| File | Purpose |
|------|---------|
| `src/session.ts` | `GameSession` — WS+HTTP player session, state cache, `waitForTurn` |
| `src/tools.ts` | Pure tools: board summary, annotated legal moves |
| `src/brain.ts` | `HeuristicBrain` + `BedrockBrain` (with fallback) |
| `src/laya-brain.ts` | `LayaBrain` — Ollaya `/api/decide`, heuristic fallback |
| `src/laya-scene.ts` | Grid window, hold course, and the nine gear-change criteria |
| `src/agent.ts` | Autonomous CLI runner |
| `src/mcp-server.ts` | MCP stdio server |

Reuses the transport clients from `bot/` (`ws-client`, `http-client`) and the
canonical rules from `shared/ws-types.ts`. No backend changes required — the
host stays authoritative.

## In-game "Add AI pilot" (deployed flow)

The lobby has a host-only **Add AI pilot** button:

1. Frontend posts `SPAWN_AI_PLAYER` (host only) to the HTTP API.
2. The HTTP Lambda writes a short-lived auto-approve marker to DynamoDB and
   async-invokes the `AiPlayerHandler` Lambda (`infra/cdk/lambda/src/ai-player.ts`).
3. That Lambda runs this package's `GameSession` + `raceLoop`, then **rotates
   every ~10 minutes**: it writes a handoff marker, closes the socket without
   `PLAYER_LEFT`, and async-invokes itself. The successor `REJOIN_ROOM`s as the
   same seat (ghost + `PLAYER_REJOINED`) so 2–3 lap races outlive the 15 min
   Lambda cap. The current turn may see a short extra delay.
4. The AI's `JOIN_ROOM` consumes the marker and is auto-approved server-side —
   it never sits in the host's pending queue.

The runner has `bedrock:InvokeModel` scoped to Amazon Nova models; if model
access is not enabled in the region, the brain silently falls back to the
heuristic and the race still works.

## AWS deployment notes

- In AWS the lobby spawn uses a long-running Lambda that **self-handoffs every
  10 minutes** (still one seat, new invoke). Locally, run the agent as a
  process (CLI / MCP) that holds the WebSocket for the whole race.
- Bedrock access is IAM (`bedrock:InvokeModel` on the chosen model); enable
  the model in the Bedrock console for the target region.

```bash
npm run test --workspace=agent   # unit tests (Bedrock stubbed)
npm run build --workspace=agent  # bundle to dist/
```
