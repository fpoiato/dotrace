/**
 * Lightweight node test for the penalty-flag diff (no Angular TestBed).
 * Run: npx tsx frontend/dotrace-app/src/app/features/game/penalty-flag.test.ts
 */
import { newPenaltyFlags, PenaltySeat } from './penalty-flag';

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const fernando: PenaltySeat = {
  connectionId: 'c1',
  nickname: 'Fernando',
  color: '#EF4444',
  grassCuts: 0,
};
const laya: PenaltySeat = {
  connectionId: 'c2',
  nickname: 'Laya',
  color: '#22C55E',
  grassCuts: 0,
};

const first = newPenaltyFlags(null, [{ ...fernando, grassCuts: 2 }, laya]);
assert(first.notices.length === 0, 'first snapshot does not announce existing cuts');

const rejoined = newPenaltyFlags(first.baseline, [
  { ...fernando, grassCuts: 2 },
  { ...laya, connectionId: 'c2-new', grassCuts: 4 },
]);
assert(rejoined.notices.length === 0, 'a new seat is baselined without a flag');

const cut = newPenaltyFlags(rejoined.baseline, [
  { ...fernando, grassCuts: 3 },
  { connectionId: 'c2-new', nickname: 'Laya', color: '#22C55E', grassCuts: 5 },
]);
assert(cut.notices.length === 2, 'every pilot whose cuts increased is announced');
assert(cut.notices[0].nickname === 'Fernando' && cut.notices[0].color === '#EF4444', 'keeps color and name');
assert(cut.notices[1].nickname === 'Laya', 'announces the second pilot too');

const same = newPenaltyFlags(cut.baseline, [
  { ...fernando, grassCuts: 3 },
  { connectionId: 'c2-new', nickname: 'Laya', color: '#22C55E', grassCuts: 5 },
]);
assert(same.notices.length === 0, 'a relay of the same board does not repeat the flag');

const back = newPenaltyFlags(cut.baseline, [
  fernando,
  { connectionId: 'c2-new', nickname: 'Laya', color: '#22C55E', grassCuts: 0 },
]);
assert(back.notices.length === 0, 'a lower cut count does not raise a flag');

console.log('penalty-flag tests passed');
