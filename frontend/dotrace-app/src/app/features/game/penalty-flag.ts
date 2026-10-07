/** A black-and-white flag shown to every client when a pilot is penalized. */
export interface PenaltyFlagNotice {
  connectionId: string;
  nickname: string;
  color: string;
}

export interface PenaltySeat {
  connectionId: string;
  nickname: string;
  color: string;
  grassCuts?: number;
  gearPenaltyUntilRound?: number;
  stopUntil?: number;
}

/** Enough of a seat to tell whether a new penalty was just applied. */
export interface PenaltyMark {
  cuts: number;
  gearUntil: number;
  stopUntil: number;
}

function markOf(player: PenaltySeat): PenaltyMark {
  return {
    cuts: player.grassCuts ?? 0,
    gearUntil: player.gearPenaltyUntilRound ?? 0,
    stopUntil: player.stopUntil ?? 0,
  };
}

function markRose(prev: PenaltyMark, next: PenaltyMark): boolean {
  return next.cuts > prev.cuts || next.gearUntil > prev.gearUntil || next.stopUntil > prev.stopUntil;
}

/**
 * Diff penalty marks between two race snapshots.
 * The first snapshot only sets the baseline, so joining mid-race or
 * reconnecting with cuts already on the board does not flash old penalties.
 * A seat that was not in the previous snapshot is baselined the same way.
 * A notice fires when the cut count rises or a gear/stop penalty is extended,
 * so the flag still shows if one of those fields is what the client received.
 */
export function newPenaltyFlags(
  previous: ReadonlyMap<string, PenaltyMark> | null,
  players: readonly PenaltySeat[]
): { baseline: Map<string, PenaltyMark>; notices: PenaltyFlagNotice[] } {
  const baseline = new Map<string, PenaltyMark>();
  const notices: PenaltyFlagNotice[] = [];
  for (const player of players) {
    const next = markOf(player);
    baseline.set(player.connectionId, next);
    if (!previous?.has(player.connectionId)) continue;
    const prev = previous.get(player.connectionId);
    if (!prev || !markRose(prev, next)) continue;
    notices.push({
      connectionId: player.connectionId,
      nickname: player.nickname,
      color: player.color,
    });
  }
  return { baseline, notices };
}
