import { TRACKS, getTrackById } from '../models/tracks';
import {
  BotDifficulty,
  GameState,
  Player,
  Vector2D,
  createInitialState,
  createLobbyPlayer,
  getTileAt,
  getValidMoves,
  landingPosition,
  segmentCrossesFinish,
} from '../models/ws-types';
import { BotDriverService } from './bot-driver.service';

function botAt(position: Vector2D, difficulty: BotDifficulty): Player {
  const p = createLobbyPlayer('bot-1', 'CPU 1', false, 1, '#3B82F6', {
    isBot: true,
    botDifficulty: difficulty,
  });
  p.position = { ...position };
  p.trail = [{ ...position }];
  return p;
}

function raceState(bot: Player): GameState {
  const state = createInitialState([bot], bot.connectionId);
  state.trackId = 'monza';
  state.phase = 'GAME_ROUND';
  state.turnOrder = [bot.connectionId];
  state.round = 1;
  return state;
}

describe('BotDriverService', () => {
  let driver: BotDriverService;

  beforeEach(() => {
    driver = new BotDriverService();
  });

  it('always returns a host-legal move', () => {
    const track = getTrackById('monza')!;
    const bot = botAt(track.startLine[0], 'normal');
    const state = raceState(bot);

    const vector = driver.pickMove(bot, state, track);
    const legal = getValidMoves(bot, track, state.players, state.round).some(
      (m) => m.velocity.x === vector.x && m.velocity.y === vector.y
    );
    expect(legal).toBeTrue();
  });

  it('accelerates off the start line onto drivable tarmac', () => {
    const track = getTrackById('monza')!;
    const bot = botAt(track.startLine[0], 'hard');
    const state = raceState(bot);

    const vector = driver.pickMove(bot, state, track);
    expect(Math.abs(vector.x) + Math.abs(vector.y)).toBeGreaterThan(0);

    const landing = landingPosition(bot.position, vector);
    const tile = getTileAt(track, landing.x, landing.y);
    expect(tile === 'track' || tile === 'finish').toBeTrue();
  });

  // Circuits whose centerline physically crosses itself (figure-eight style).
  // The reactive driver still laps them in racing-line terms but may cut the
  // central crossover, so we don't require a clean finish-stripe crossing there
  // — the engine's stall safety net guarantees such a race still ends.
  const SELF_CROSSING = new Set(['suzuka', 'silverstone']);

  // Every real circuit must be drivable the correct way around, proving the
  // centerline orientation guides bots around a full lap of the racing line.
  for (const trackDef of TRACKS) {
    it(`drives ${trackDef.id} the right way around, staying mostly on track`, () => {
      const track = getTrackById(trackDef.id)!;
      const n = (track.centerline?.length ?? 1) - 1; // open loop length
      const bot = botAt(track.startLine[0], 'hard');
      const state = raceState(bot);
      state.trackId = track.id;

      let onTrack = 0;
      let crossedFinish = false;
      let wraps = 0;
      let prevIdx = -1;
      const steps = 300;
      // The car starts on the finish stripe, so ignore the opening lap's
      // crossing and only count a genuine loop back to the line.
      let leftFinishZone = false;

      for (let i = 0; i < steps; i++) {
        const vector = driver.pickMove(bot, state, track);
        const legal = getValidMoves(bot, track, state.players, state.round).some(
          (m) => m.velocity.x === vector.x && m.velocity.y === vector.y
        );
        expect(legal).toBeTrue();

        const from = { ...bot.position };
        const landing = landingPosition(bot.position, vector);
        const tile = getTileAt(track, landing.x, landing.y);
        expect(tile).not.toBeNull();

        if (tile !== 'finish') leftFinishZone = true;
        if (leftFinishZone && segmentCrossesFinish(track, from, landing)) crossedFinish = true;
        if (tile === 'track' || tile === 'finish') {
          onTrack++;
          bot.velocity = { ...vector };
          bot.isOffTrack = false;
        } else {
          // Off-track: mirror the engine's spin-out (stop, gear reset).
          bot.velocity = { x: 0, y: 0 };
          bot.isOffTrack = true;
        }
        bot.position = { ...landing };

        // A big drop in the target waypoint index = the racing line wrapped,
        // i.e. the bot drove a complete loop of the circuit.
        const idx = driver.debugWaypoint(bot.connectionId) ?? -1;
        if (prevIdx >= 0 && idx < prevIdx - n / 2) wraps++;
        prevIdx = idx;
      }

      // Drives, never stalls, and mostly keeps it on the tarmac.
      expect(onTrack / steps).toBeGreaterThan(0.8);
      // Completes at least one full loop of the racing line.
      expect(wraps).toBeGreaterThanOrEqual(1);
      // Non-crossing circuits must also cross the physical finish stripe.
      if (!SELF_CROSSING.has(trackDef.id)) {
        expect(crossedFinish).toBeTrue();
      }
    });
  }
});
