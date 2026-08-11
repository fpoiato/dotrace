#!/usr/bin/env node
/**
 * Autonomous AI player — joins a Dot Race room and races until GAME_OVER.
 *
 * Usage:
 *   WS_URL=wss://… API_URL=https://… ROOM_CODE=ABCDE npm run dev --workspace=agent
 *   BRAIN=heuristic npm run dev --workspace=agent -- ABCDE "Nova Micro"
 *
 * The host must approve the join (same flow as any human player).
 */
import { getTrackById } from '../../shared/tracks';
import { HttpClient } from '../../bot/src/http-client';
import { WsClient } from '../../bot/src/ws-client';
import { BedrockBrain, HeuristicBrain, MoveBrain } from './brain';
import { AgentConfig, loadConfig } from './config';
import { GameSession } from './session';
import { buildBoardSummary, listAnnotatedMoves } from './tools';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function raceLoop(
  session: GameSession,
  brain: MoveBrain,
  moveDelayMs: number
): Promise<void> {
  for (;;) {
    const racing = await session.waitForTurn();
    if (!racing) {
      console.log('[RACE] Game over');
      return;
    }

    const state = session.getState();
    const player = session.getMyPlayer();
    if (!state || !player) continue;

    const track = getTrackById(state.trackId);
    if (!track) {
      console.warn(`[RACE] Unknown track ${state.trackId} — waiting`);
      await sleep(1000);
      continue;
    }

    const summary = buildBoardSummary(player, state, track);
    const moves = listAnnotatedMoves(player, state, track);
    const chosen = await brain.pickMove(summary, moves);

    console.log(
      `[MOVE] round=${state.round} lap=${player.lap}/${state.totalLaps} ` +
        `velocity=(${chosen.velocity.x},${chosen.velocity.y}) ` +
        `landing=(${chosen.landing.x},${chosen.landing.y}) goal=${summary.goal}`
    );

    if (moveDelayMs > 0) await sleep(moveDelayMs);
    try {
      await session.submitMove(chosen.velocity);
    } catch (err) {
      console.warn('[MOVE FAILED]', err instanceof Error ? err.message : err);
      await sleep(1000);
    }
    // Yield until the host relays the applied move (turn passes to the next player).
    await sleep(250);
  }
}

function buildBrain(config: AgentConfig): MoveBrain {
  if (config.brain === 'heuristic') {
    console.log('[BRAIN] heuristic');
    return new HeuristicBrain();
  }
  console.log(`[BRAIN] bedrock model=${config.modelId} region=${config.region}`);
  return new BedrockBrain({ modelId: config.modelId, region: config.region });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const ws = new WsClient(config.wsUrl);
  const http = new HttpClient(config.apiUrl);
  const session = new GameSession(ws, http, config.roomCode, config.nickname);

  process.on('SIGINT', () => {
    console.log('\n[SHUTDOWN]');
    session.leave();
    process.exit(0);
  });

  console.log(`[JOIN] Room ${config.roomCode} as ${config.nickname}`);
  await session.join();
  console.log('[LOBBY] Waiting for host approval…');
  await session.waitForApproval();
  console.log('[LOBBY] Approved — racing');

  await raceLoop(session, buildBrain(config), config.moveDelayMs);
  session.leave();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[FATAL]', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
