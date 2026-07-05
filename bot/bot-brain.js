/**
 * @typedef {Object} CarState
 * @property {number} x
 * @property {number} y
 * @property {number} vx
 * @property {number} vy
 *
 * @typedef {Object} TrackState
 * @property {number} width
 * @property {number} height
 * @property {{x:number, y:number}=} goal
 */

class BotBrain {
  /**
   * Compute acceleration from the 9 legal options.
   * @param {CarState} carState
   * @param {TrackState} trackState
   * @returns {{dx:number, dy:number}}
   */
  computeNextMove(carState, trackState) {
    const candidates = [];

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const nextVx = carState.vx + dx;
        const nextVy = carState.vy + dy;
        const nextX = carState.x + nextVx;
        const nextY = carState.y + nextVy;

        if (!this.#isInBounds(nextX, nextY, trackState)) continue;

        // Placeholder heuristic: move toward goal while preferring smaller
        // accelerations to keep trajectories stable.
        const goal = trackState.goal ?? { x: trackState.width - 1, y: trackState.height - 1 };
        const distance = Math.abs(goal.x - nextX) + Math.abs(goal.y - nextY);
        const accelCost = Math.abs(dx) + Math.abs(dy) * 0.2;
        candidates.push({ dx, dy, score: distance + accelCost });
      }
    }

    if (candidates.length === 0) {
      return { dx: 0, dy: 0 };
    }

    candidates.sort((a, b) => a.score - b.score);
    return { dx: candidates[0].dx, dy: candidates[0].dy };
  }

  #isInBounds(x, y, trackState) {
    return x >= 0 && y >= 0 && x < trackState.width && y < trackState.height;
  }
}

module.exports = {
  BotBrain,
};
