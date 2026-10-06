/**
 * Run: npx tsx frontend/dotrace-app/src/app/features/game/map-camera.test.ts
 */
import {
  applyMapZoom,
  focusLeaderCamera,
  isFollowingLeader,
  type MapCamera,
} from './map-camera';

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const following: MapCamera = { manualCamera: false, fitMode: false, zoomFactor: 1 };

const zoomedIn = applyMapZoom(following, true, 1.3);
assert(!zoomedIn.scaleManually, 'leader zoom stays on the automatic frame');
assert(isFollowingLeader(true, zoomedIn.camera), 'zoom does not release leader follow');
assert(zoomedIn.camera.zoomFactor === 1.3, 'zoom in multiplies the leader frame');

const zoomedOut = applyMapZoom(zoomedIn.camera, true, 1 / 1.3);
assert(isFollowingLeader(true, zoomedOut.camera), 'zoom out keeps leader follow');
assert(Math.abs(zoomedOut.camera.zoomFactor - 1) < 1e-9, 'zoom out undoes the previous step');

let pulledBack = following;
for (let i = 0; i < 8; i++) pulledBack = applyMapZoom(pulledBack, true, 1 / 1.3).camera;
assert(isFollowingLeader(true, pulledBack), 'zooming out several times stays on the leader');
assert(pulledBack.zoomFactor < 0.4, 'leader zoom is not capped like the fit-sheet zoom');

const panned: MapCamera = { manualCamera: true, fitMode: false, zoomFactor: 1.3 };
const zoomWhileFree = applyMapZoom(panned, true, 1.3);
assert(zoomWhileFree.scaleManually, 'zoom after a pan adjusts the free camera');
assert(zoomWhileFree.camera.manualCamera, 'zoom does not turn leader follow back on');
assert(!isFollowingLeader(true, zoomWhileFree.camera), 'a panned camera stays free');

const back = focusLeaderCamera(panned);
assert(isFollowingLeader(true, back), 'Leader button tracks the leader again');
assert(back.zoomFactor === 1.3, 'Leader button does not reset zoom');

const live = applyMapZoom(following, false, 1.3);
assert(live.scaleManually && live.camera.manualCamera, 'live-race zoom still hands over the camera');

const fitted: MapCamera = { manualCamera: false, fitMode: true, zoomFactor: 1 };
const fitZoom = applyMapZoom(fitted, true, 1.3);
assert(fitZoom.camera.fitMode && !fitZoom.scaleManually, 'fit zoom stays on the whole sheet');
assert(!isFollowingLeader(true, fitZoom.camera), 'fit mode is not leader follow');

let fittedOut = fitted;
for (let i = 0; i < 8; i++) fittedOut = applyMapZoom(fittedOut, true, 1 / 1.3).camera;
assert(fittedOut.fitMode && fittedOut.zoomFactor === 0.4, 'fit zoom still stops at the sheet floor');

console.log('map camera: ok');
