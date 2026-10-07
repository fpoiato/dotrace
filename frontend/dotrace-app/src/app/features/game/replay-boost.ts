/** Callouts for DRS and ERS on a replay frame. */

export type ReplayBoostKind = 'drs' | 'ers';

export interface ReplayBoostSeat {
  connectionId: string;
  nickname: string;
  color: string;
  drsActive?: boolean;
  ersActive?: boolean;
}

export interface ReplayBoostNotice {
  connectionId: string;
  nickname: string;
  color: string;
  kind: ReplayBoostKind;
  /** DRS rose on this move. Later frames with the wing still open stay false. */
  justOpened: boolean;
}

/**
 * DRS is announced when it opens and kept on screen while that car still has it,
 * so scrubbing does not hide an open wing. ERS is only the move that spent a bar.
 */
export function replayBoostNotices(
  previous: readonly ReplayBoostSeat[] | null,
  frame: { movedId?: string; players: readonly ReplayBoostSeat[] }
): ReplayBoostNotice[] {
  const prevDrs = new Set(
    (previous ?? []).filter((player) => player.drsActive).map((player) => player.connectionId)
  );
  const notices: ReplayBoostNotice[] = [];
  for (const player of frame.players) {
    if (!player.drsActive) continue;
    notices.push({
      connectionId: player.connectionId,
      nickname: player.nickname,
      color: player.color,
      kind: 'drs',
      justOpened: !prevDrs.has(player.connectionId),
    });
  }
  if (frame.movedId) {
    const mover = frame.players.find((player) => player.connectionId === frame.movedId);
    if (mover?.ersActive) {
      notices.push({
        connectionId: mover.connectionId,
        nickname: mover.nickname,
        color: mover.color,
        kind: 'ers',
        justOpened: true,
      });
    }
  }
  return notices;
}
