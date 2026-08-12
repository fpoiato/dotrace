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

export type RaceLoopResult = 'finished' | 'handoff';

export interface RaceLoopOptions {
  /** When true, stop cleanly so another runner can resume the same seat. */
  shouldHandoff?: () => boolean;
  /** Slice long waits so handoff can fire during lobby / opponent turns. */
  waitSliceMs?: number;
}

async function waitSliced(
  wait: (timeoutMs: number) => Promise<boolean>,
  sliceMs: number,
  shouldHandoff: () => boolean
): Promise<boolean | 'handoff'> {
  for (;;) {
    if (shouldHandoff()) return 'handoff';
    try {
      return await wait(sliceMs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/Timed out/i.test(msg)) throw err;
    }
  }
}

export async function raceLoop(
  session: GameSession,
  brain: MoveBrain,
  moveDelayMs: number,
  options?: RaceLoopOptions
): Promise<RaceLoopResult> {
  const shouldHandoff = options?.shouldHandoff ?? (() => false);
  const waitSliceMs = options?.waitSliceMs ?? 20_000;

  // Spawn happens in the lobby — wait through host setup / grid order without
  // burning the per-turn timeout (that used to drop AI pilots before the race).
  const started = await waitSliced((ms) => session.waitUntilRacing(ms), waitSliceMs, shouldHandoff);
  if (started === 'handoff') {
    console.log('[RACE] Handoff before green flag');
    return 'handoff';
  }
  if (!started) {
    console.log('[RACE] Game over before start');
    return 'finished';
  }
  console.log('[RACE] Green flag — entering turn loop');

  for (;;) {
    if (shouldHandoff()) {
      console.log('[RACE] Handoff between turns');
      return 'handoff';
    }
    let racing: boolean | 'handoff';
    try {
      racing = await waitSliced((ms) => session.waitForTurn(ms), waitSliceMs, shouldHandoff);
    } catch (err) {
      console.warn('[RACE] waitForTurn failed:', err instanceof Error ? err.message : err);
      return 'finished';
    }
    if (racing === 'handoff') {
      console.log('[RACE] Handoff while waiting for turn');
      return 'handoff';
    }
    if (!racing) {
      console.log('[RACE] Game over');
      return 'finished';
    }

    // Let the GRID_ORDER_DONE / TURN_ADVANCED relay settle so we plan from the
    // host's placed positions, not a stale lobby snapshot.
    await sleep(150);

    const state = session.getState();
    const player = session.getMyPlayer();
    if (!state || !player) continue;
    if (!session.isMyTurn()) continue;

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
        `pos=(${player.position.x},${player.position.y}) ` +
        `velocity=(${chosen.velocity.x},${chosen.velocity.y}) ` +
        `landing=(${chosen.landing.x},${chosen.landing.y}) goal=${summary.goal} ` +
        `align=${summary.situation.alignment} progress=${summary.situation.lapProgressPct}% ` +
        `cornerIn=${summary.situation.cellsToCorner ?? '∞'}`
    );

    if (moveDelayMs > 0) await sleep(moveDelayMs);
    try {
      await session.submitMove(chosen.velocity);
      // Do not re-enter waitForTurn while the cached state still says it is
      // our turn — that caused a second SUBMIT_MOVE (often standstill) before
      // the host relayed TURN_ADVANCED.
      await session.waitUntilNotMyTurn();
    } catch (err) {
      console.warn('[MOVE FAILED]', err instanceof Error ? err.message : err);
      // If the host never advanced (illegal/stale move), retry quickly with a
      // fresh board instead of idling on "Aguardando …".
      await sleep(400);
    }
    if (shouldHandoff()) {
      console.log('[RACE] Handoff after move');
      return 'handoff';
    }
  }
}

function buildBrain(config: AgentConfig): MoveBrain {
  if (config.brain === 'heuristic') {
    console.log(`[BRAIN] heuristic style=${config.nickname} difficulty=${config.difficulty}`);
    return new HeuristicBrain({ styleOrSeed: config.nickname, difficulty: config.difficulty });
  }
  console.log(
    `[BRAIN] bedrock model=${config.modelId} region=${config.region} difficulty=${config.difficulty}`
  );
  return new BedrockBrain({
    modelId: config.modelId,
    region: config.region,
    fallbackSeed: config.nickname,
    difficulty: config.difficulty,
  });
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
