/**
 * Lightweight node test for the 5s stall key.
 * Run: npx tsx frontend/dotrace-app/src/app/features/game/turn-stall.test.ts
 */
import { GameState } from '../../core/models/ws-types';
import { BOT_STALL_MS, PLAY_NOW_SECONDS, TURN_STALL_MS, isBotPlayer, stallWindowMs, turnStallKey } from './turn-stall';

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const state = {
  phase: 'GAME_ROUND',
  gameMode: 'TURNS',
  round: 3,
  currentTurnIndex: 1,
  turnOrder: ['human', 'ai#laya'],
} as GameState;

assert(TURN_STALL_MS === 5_000, 'human stall window is 5s');
assert(BOT_STALL_MS === 6_000, 'bot wake button shows before a hung AI request');
assert(PLAY_NOW_SECONDS === 5, 'human countdown is 5s');
assert(stallWindowMs({ connectionId: 'human', nickname: 'Fernando' } as never) === TURN_STALL_MS, 'human window');
assert(stallWindowMs({ connectionId: 'ai#laya', nickname: 'Laya · Fácil' } as never) === BOT_STALL_MS, 'bot window');
assert(turnStallKey(state) === '3:1:ai#laya', 'key follows the seat on the clock');
assert(turnStallKey({ ...state, phase: 'LOBBY' } as GameState) === null, 'lobby is not a stall');
assert(
  isBotPlayer({ connectionId: 'ai#laya', nickname: 'Laya · Fácil' } as never),
  'on-demand seat is a bot'
);
assert(
  isBotPlayer({ connectionId: 'sock', nickname: 'Bot Senna' } as never),
  'socket bot nickname is a bot'
);
assert(
  !isBotPlayer({ connectionId: 'human', nickname: 'Fernando' } as never),
  'human is not a bot'
);

console.log('turn-stall.test.ts ok');
