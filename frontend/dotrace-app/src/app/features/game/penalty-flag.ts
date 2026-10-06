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
}

/**
 * Diff grass-cut counts between two race snapshots.
 * The first snapshot only sets the baseline, so joining mid-race or
 * reconnecting with cuts already on the board does not flash old penalties.
 * A seat that was not in the previous snapshot is baselined the same way.
 */
export function newPenaltyFlags(
  previous: ReadonlyMap<string, number> | null,
  players: readonly PenaltySeat[]
): { baseline: Map<string, number>; notices: PenaltyFlagNotice[] } {
  const baseline = new Map<string, number>();
  const notices: PenaltyFlagNotice[] = [];
  for (const player of players) {
    const next = player.grassCuts ?? 0;
    baseline.set(player.connectionId, next);
    if (!previous?.has(player.connectionId)) continue;
    const prev = previous.get(player.connectionId) ?? 0;
    if (next > prev) {
      notices.push({
        connectionId: player.connectionId,
        nickname: player.nickname,
        color: player.color,
      });
    }
  }
  return { baseline, notices };
}
