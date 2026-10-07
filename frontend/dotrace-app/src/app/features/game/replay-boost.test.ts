/**
 * Run: npx tsx frontend/dotrace-app/src/app/features/game/replay-boost.test.ts
 */
import assert from 'node:assert/strict';
import { replayBoostNotices } from './replay-boost';

const alfa = {
  connectionId: 'a',
  nickname: 'Alfa',
  color: '#f00',
};
const beta = {
  connectionId: 'b',
  nickname: 'Beta',
  color: '#0f0',
};

const open = replayBoostNotices(null, {
  movedId: 'a',
  players: [{ ...alfa, drsActive: true }, beta],
});
assert.equal(open.length, 1);
assert.equal(open[0]!.kind, 'drs');
assert.equal(open[0]!.justOpened, true);
assert.equal(open[0]!.nickname, 'Alfa');

const stillOpen = replayBoostNotices([{ ...alfa, drsActive: true }], {
  movedId: 'a',
  players: [{ ...alfa, drsActive: true, ersActive: true }, beta],
});
assert.equal(stillOpen.filter((n) => n.kind === 'drs' && !n.justOpened).length, 1);
assert.equal(stillOpen.filter((n) => n.kind === 'ers' && n.justOpened).length, 1);

const cleared = replayBoostNotices([{ ...alfa, drsActive: true }], {
  movedId: 'a',
  players: [alfa, { ...beta, ersActive: true }],
});
assert.equal(cleared.length, 0, 'ERS on a car that did not move must not announce');

console.log('replay boost notices: ok');
