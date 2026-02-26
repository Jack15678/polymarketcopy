/**
 * Order sync helpers for reconciling follower orders with leader activity.
 * Used by the copy engine when batching or retrying CLOB submissions.
 */

export type SyncCursor = {
  lastLeaderTradeId?: string;
  updatedAt: string;
};

export function bumpCursor(
  cursor: SyncCursor,
  leaderTradeId: string,
  nowIso = new Date().toISOString(),
): SyncCursor {
  return { lastLeaderTradeId: leaderTradeId, updatedAt: nowIso };
}

export function cursorFresh(): SyncCursor {
  return { updatedAt: new Date().toISOString() };
}
