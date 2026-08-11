# Dot Race — AI Player (`dotrace-ai-player`)

An AI **network player** for Dot Race. It joins a room through the same
protocol as any human (`JOIN_ROOM` → host approval → `RELAY` →
`FORWARD_TO_HOST`/`SUBMIT_MOVE`), and picks moves with either:

- **Heuristic brain** (default in the lobby Lambda) — track-aware planner:
  BFS distance along asphalt toward checkpoint/finish, accelerate on clear
  straights, brake before corners, avoid grass. No AWS account needed.
- **Bedrock brain** — Amazon Bedrock Converse API, model
  `amazon.nova-micro-v1:0` by default, IAM auth (no API keys). Falls back to
  the heuristic on any model failure or illegal output. Set `BRAIN=bedrock`
  to enable.

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
3. That Lambda runs this package's `GameSession` + `raceLoop` for the whole
   race (15 min function timeout caps race duration).
4. The AI's `JOIN_ROOM` consumes the marker and is auto-approved server-side —
   it never sits in the host's pending queue.

The runner has `bedrock:InvokeModel` scoped to Amazon Nova models; if model
access is not enabled in the region, the brain silently falls back to the
heuristic and the race still works.

## AWS deployment notes

- The session needs a **long-lived WebSocket**, so run the agent on compute
  that holds a process (AgentCore Runtime, ECS/Fargate, or a long-running
  Lambda invocation for a single race) — not one Lambda per tool call.
- Bedrock access is IAM (`bedrock:InvokeModel` on the chosen model); enable
  the model in the Bedrock console for the target region.

```bash
npm run test --workspace=agent   # unit tests (Bedrock stubbed)
npm run build --workspace=agent  # bundle to dist/
```
