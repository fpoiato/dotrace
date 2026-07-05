/**
 * Offline smoke test — no server needed.
 * Simulates the host's move rules on a real circuit and lets the BotBrain
 * drive solo until it completes a lap (or the turn budget runs out).
 *
 * Run with: npm run smoke
 */
import { getTrackById, TRACKS } from '../../shared/tracks';
import {
  Player,
  createLobbyPlayer,
  getTileAt,
  landingPosition,
  segmentCrossesFinish,
  segmentEntersRect,
  zeroVector,
} from '../../shared/ws-types';
import { BotBrain } from './bot-brain';

const MAX_TURNS = 200;
const trackId = process.argv[2] ?? 'monza';
const track = getTrackById(trackId);
if (!track) {
  console.error(`Unknown track "${trackId}". Options: ${TRACKS.map((t) => t.id).join(', ')}`);
  process.exit(1);
}

const bot: Player = createLobbyPlayer('bot-1', 'SmokeBot', false, 0, '#3B82F6');
bot.position = { ...track.startLine[0] };
bot.trail = [{ ...bot.position }];
bot.passedCheckpoint = false;

const brain = new BotBrain();
let finished = false;

for (let turn = 1; turn <= MAX_TURNS; turn++) {
  const move = brain.computeNextMove(bot, track, []);
  const from = { ...bot.position };
  const landing = landingPosition(bot.position, move.velocity);
  const tile = getTileAt(track, landing.x, landing.y);
  if (tile === null) {
    console.error(`Turn ${turn}: brain chose an out-of-grid landing — bug!`);
    process.exit(1);
  }

  // Mirror the host's rules: grass stops the car; track keeps momentum.
  bot.position = landing;
  if (tile === 'grass') {
    bot.velocity = zeroVector();
    bot.isOffTrack = true;
  } else {
    bot.velocity = { ...move.velocity };
    bot.isOffTrack = false;
  }
  if (track.checkpoint && !bot.passedCheckpoint) {
    bot.passedCheckpoint = segmentEntersRect(from, landing, track.checkpoint);
  }
  if (bot.passedCheckpoint && tile !== 'grass' && segmentCrossesFinish(track, from, landing)) {
    console.log(`\nLap completed on ${track.id} in ${turn} turns.`);
    finished = true;
    break;
  }
}

if (!finished) {
  console.error(`\nDid not finish a lap on ${track.id} within ${MAX_TURNS} turns.`);
  process.exit(1);
}
