#!/usr/bin/env node
/**
 * MCP server — exposes Dot Race as player tools over stdio.
 *
 * Lets any MCP client (Cursor, Claude Desktop, an AgentCore agent) join a
 * room and race as a regular network player. The session (WebSocket + room
 * membership) lives inside this process, so the server must stay running for
 * the duration of the race.
 *
 * Config via env: WS_URL, API_URL (same as the bot package).
 *
 * Example Cursor mcp.json entry:
 *   "dotrace-player": {
 *     "command": "npx",
 *     "args": ["tsx", "agent/src/mcp-server.ts"],
 *     "env": { "WS_URL": "wss://…", "API_URL": "https://…" }
 *   }
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getTrackById } from '../../shared/tracks';
import { HttpClient } from '../../bot/src/http-client';
import { WsClient } from '../../bot/src/ws-client';
import { GameSession } from './session';
import { buildBoardSummary, isMoveInList, listAnnotatedMoves } from './tools';

const WS_URL = process.env.WS_URL ?? 'ws://localhost:8080/game';
const API_URL = (process.env.API_URL ?? 'http://localhost:3001').replace(/\/$/, '');

let session: GameSession | null = null;

function text(payload: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function requireSession(): GameSession {
  if (!session) {
    throw new Error('Not in a room — call join_room first');
  }
  return session;
}

function requireRaceContext() {
  const active = requireSession();
  const state = active.getState();
  const player = active.getMyPlayer();
  if (!state || !player) {
    throw new Error('No game state yet — the race has not started or no RELAY received');
  }
  const track = getTrackById(state.trackId);
  if (!track) {
    throw new Error(`Unknown track: ${state.trackId}`);
  }
  return { state, player, track };
}

const server = new McpServer({ name: 'dotrace-player', version: '1.0.0' });

server.tool(
  'join_room',
  'Join a Dot Race room as an AI player. The host must approve the join. ' +
    'Blocks until approved or rejected.',
  {
    roomCode: z.string().length(5).describe('Five-letter room code'),
    nickname: z.string().min(1).max(20).default('AI Pilot').describe('Display name'),
  },
  async ({ roomCode, nickname }) => {
    if (session) {
      session.leave();
      session = null;
    }
    const ws = new WsClient(WS_URL);
    const http = new HttpClient(API_URL);
    session = new GameSession(ws, http, roomCode.toUpperCase(), nickname);
    await session.join();
    await session.waitForApproval();
    return text({ joined: true, ...session.getSnapshot() });
  }
);

server.tool(
  'get_status',
  'Current session status: approval, game phase, and whether it is my turn.',
  {},
  async () => text(requireSession().getSnapshot())
);

server.tool(
  'get_board_state',
  'Compact race view for this player: position, velocity, lap, current goal ' +
    '(checkpoint or finish) and opponents.',
  {},
  async () => {
    const { state, player, track } = requireRaceContext();
    return text(buildBoardSummary(player, state, track));
  }
);

server.tool(
  'list_valid_moves',
  'All legal moves this turn, annotated with landing tile, grass-shortcut ' +
    'penalty, checkpoint/finish crossing and distance to goal. Pick from this ' +
    'list — any other velocity is illegal.',
  {},
  async () => {
    const { state, player, track } = requireRaceContext();
    return text(listAnnotatedMoves(player, state, track));
  }
);

server.tool(
  'submit_move',
  'Submit the chosen velocity (absolute, not a delta). Must be one of the ' +
    'velocities returned by list_valid_moves.',
  {
    x: z.number().int().describe('Velocity x'),
    y: z.number().int().describe('Velocity y'),
  },
  async ({ x, y }) => {
    const active = requireSession();
    const { state, player, track } = requireRaceContext();
    if (!active.isMyTurn()) {
      throw new Error('Not your turn — call wait_for_turn first');
    }
    const moves = listAnnotatedMoves(player, state, track);
    if (!isMoveInList(moves, { x, y })) {
      throw new Error(
        `Illegal move (${x},${y}). Legal velocities: ` +
          moves.map((m) => `(${m.velocity.x},${m.velocity.y})`).join(' ')
      );
    }
    await active.submitMove({ x, y });
    return text({ submitted: { x, y } });
  }
);

server.tool(
  'wait_for_turn',
  'Block until it is my turn (returns racing=true) or the race ends ' +
    '(racing=false). Use between moves instead of polling.',
  {
    timeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
  },
  async ({ timeoutMs }) => {
    const racing = await requireSession().waitForTurn(timeoutMs);
    return text({ racing, ...requireSession().getSnapshot() });
  }
);

server.tool(
  'leave_room',
  'Disconnect from the current room and end the session.',
  {},
  async () => {
    requireSession().leave();
    session = null;
    return text({ left: true });
  }
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  console.error(`[MCP] dotrace-player ready (ws=${WS_URL})`);
}

main().catch((err) => {
  console.error('[MCP FATAL]', err instanceof Error ? err.message : err);
  process.exit(1);
});
