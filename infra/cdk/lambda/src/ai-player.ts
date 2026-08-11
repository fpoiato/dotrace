/**
 * AI player runner — one invocation races one AI pilot in one room.
 *
 * Invoked asynchronously by the SPAWN_AI_PLAYER action. Holds the WebSocket
 * session for the whole race (agent code from the `agent/` workspace), so the
 * function timeout is the upper bound on race duration. If the function dies
 * (timeout / crash) the WebSocket closes and the normal disconnect flow
 * removes the player from the race.
 *
 * Env: WS_URL, API_URL, BEDROCK_MODEL_ID, MOVE_DELAY_MS, BRAIN (fallback when
 * the spawn payload omits `brain`). Host chooses per pilot: bedrock | heuristic.
 */
import { raceLoop } from '../../../../agent/src/agent';
import { BedrockBrain, HeuristicBrain, MoveBrain } from '../../../../agent/src/brain';
import { GameSession } from '../../../../agent/src/session';
import { HttpClient } from '../../../../bot/src/http-client';
import { WsClient } from '../../../../bot/src/ws-client';

export interface SpawnAiPlayerEvent {
  roomCode: string;
  nickname: string;
  brain?: 'bedrock' | 'heuristic';
}

function buildBrain(event: SpawnAiPlayerEvent): MoveBrain {
  const mode = event.brain ?? process.env.BRAIN ?? 'heuristic';
  if (mode === 'bedrock') {
    console.log(`[AI] brain=bedrock nickname=${event.nickname}`);
    return new BedrockBrain({
      modelId: process.env.BEDROCK_MODEL_ID ?? 'amazon.nova-micro-v1:0',
      region: process.env.AWS_REGION ?? 'us-east-1',
      fallbackSeed: event.nickname,
    });
  }
  console.log(`[AI] brain=heuristic nickname=${event.nickname}`);
  return new HeuristicBrain(event.nickname);
}

export const handler = async (event: SpawnAiPlayerEvent): Promise<void> => {
  const wsUrl = process.env.WS_URL;
  const apiUrl = process.env.API_URL;
  if (!wsUrl || !apiUrl) {
    throw new Error('WS_URL and API_URL must be configured');
  }
  if (!event?.roomCode || !event?.nickname) {
    throw new Error('roomCode and nickname are required');
  }

  const session = new GameSession(
    new WsClient(wsUrl),
    new HttpClient(apiUrl.replace(/\/$/, '')),
    event.roomCode.toUpperCase(),
    event.nickname
  );

  console.log(
    `[AI] Joining room ${event.roomCode} as ${event.nickname} brain=${event.brain ?? process.env.BRAIN ?? 'heuristic'}`
  );
  try {
    await session.join();
    await session.waitForApproval(90_000);
    console.log('[AI] Approved — waiting for race / racing');
    await raceLoop(session, buildBrain(event), Number(process.env.MOVE_DELAY_MS ?? 600));
    console.log('[AI] Race finished');
  } finally {
    session.leave();
  }
};
