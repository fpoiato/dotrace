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
import { BedrockBrain, HeuristicBrain, MoveBrain, applyPilotPolicy } from './brain';
import { LayaBrain } from './laya-brain';
import { LAYA_DECIDE_MODEL } from './laya-scene';
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
  shouldHandoff: () => boolean,
  onSlice?: () => void
): Promise<boolean | 'handoff'> {
  for (;;) {
    if (shouldHandoff()) return 'handoff';
    onSlice?.();
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
  const askForState = () => {
    const phase = session.getState()?.phase;
    // A live board is refreshed by the host while an AI is on the clock.
    // Ask only when this process has not seen the race yet (fresh handoff).
    if (phase === 'GAME_ROUND' || phase === 'GAME_OVER' || phase === 'GRID_ORDER') return;
    void session.requestRaceState();
  };

  // Spawn happens in the lobby — wait through host setup / grid order without
  // burning the per-turn timeout (that used to drop AI pilots before the race).
  // Each slice also asks the host to re-send the board, so a handoff that
  // missed STATE_SYNC does not sit in "before green flag" until the next rotation.
  const started = await waitSliced(
    (ms) => session.waitUntilRacing(ms),
    waitSliceMs,
    shouldHandoff,
    askForState
  );
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
      racing = await waitSliced(
        (ms) => session.waitForTurn(ms),
        waitSliceMs,
        shouldHandoff,
        askForState
      );
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
    const chosen = await applyPilotPolicy(
      summary,
      moves,
      await brain.pickMove(summary, moves)
    );

    console.log(
      `[MOVE] round=${state.round} lap=${player.lap}/${state.totalLaps} ` +
        `pos=(${player.position.x},${player.position.y}) ` +
        `velocity=(${chosen.velocity.x},${chosen.velocity.y}) ` +
        `boost=${chosen.drs ? 'DRS' : ''}${chosen.ers ? 'ERS' : ''} ` +
        `landing=(${chosen.landing.x},${chosen.landing.y}) goal=${summary.goal} ` +
        `align=${summary.situation.alignment} progress=${summary.situation.lapProgressPct}% ` +
        `cornerIn=${summary.situation.cellsToCorner ?? '∞'}`
    );

    if (moveDelayMs > 0) await sleep(moveDelayMs);
    const before = {
      round: state.round,
      x: player.position.x,
      y: player.position.y,
      replay: state.replayLog?.length ?? 0,
    };
    try {
      await session.submitMove(chosen.velocity, { drs: chosen.drs, ers: chosen.ers });
      // When this pilot is the only one still racing, the host hands the turn
      // straight back. Waiting until it is no longer our turn then hangs.
      await session.waitUntilMoveSettled(before);
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
  if (config.brain === 'laya') {
    console.log(
      `[BRAIN] laya model=${process.env.OLLAYA_MODEL || LAYA_DECIDE_MODEL} difficulty=${config.difficulty}`
    );
    return new LayaBrain({
      endpoint: async () => {
        const url = process.env.OLLAYA_URL;
        if (!url) return null;
        return { url, apiKey: process.env.OLLAYA_API_KEY };
      },
      fallbackSeed: config.nickname,
      difficulty: config.difficulty,
      model: process.env.OLLAYA_MODEL || LAYA_DECIDE_MODEL,
    });
  }
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
