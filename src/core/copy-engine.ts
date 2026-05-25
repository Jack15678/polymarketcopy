import { getActivity, getPositions, tradeEventKey } from "../services/data-api.js";
import { getTickSize, placeLimitOrder } from "../services/clob.js";
import { config } from "../config/index.js";
import { getCopyTarget } from "../utils/target.js";

/** Snapshot state of the target's positions during copy session. */
type PositionDir = "long" | "short";

/**
 * Build initial working map from the target's current open positions.
 * Direction is inferred from currentValue: positive = long, negative = short.
 */
async function buildWorkingMap(user: string): Promise<Map<string, { dir: PositionDir; size: number }>> {
  const map = new Map<string, { dir: PositionDir; size: number }>();
  try {
    const positions = await getPositions(config.dataApiUrl, { user, limit: 500 });
    for (const p of positions) {
      if (!p.asset || !p.size || p.size <= 0) continue;
      // currentValue > 0 → long, currentValue < 0 → short
      const dir: PositionDir = (p.currentValue ?? 0) < 0 ? "short" : "long";
      map.set(p.asset, { dir, size: p.size });
    }
  } catch (e) {
    console.warn("Failed to fetch initial positions:", e instanceof Error ? e.message : e);
  }
  return map;
}

const SEEN_CAP = 10_000;
const seen = new Set<string>();

function trimSeen(): void {
  if (seen.size <= SEEN_CAP) return;
  const arr = [...seen];
  for (let i = 0; i < arr.length - SEEN_CAP; i++) seen.delete(arr[i]!);
}

function applySizeLimit(size: number, price: number): number {
  let s = size * config.sizeMultiplier;
  if (config.maxOrderUsd != null && config.maxOrderUsd > 0 && price > 0) {
    const notional = s * price;
    if (notional > config.maxOrderUsd) s = config.maxOrderUsd / price;
  }
  return Math.max(0.01, Math.round(s * 100) / 100);
}

export async function pollAndCopy(): Promise<{
  fetched: number;
  copied: number;
  errors: string[];
}> {
  const errors: string[] = [];
  const user = getCopyTarget() || config.targetUser;
  if (!user) return { fetched: 0, copied: 0, errors: ["No target user"] };

  // Build working map from target's current positions at copy start.
  // Any asset in this map → target already held it → skip all subsequent operations on it.
  const workingMap = await buildWorkingMap(user);
  // Track assets that become "known" during the session (new opens we participate in).
  // Once tracked, also skip future operations to avoid double-copying.
  const knownAssets = new Set<string>(workingMap.keys());

  const activities = await getActivity(config.dataApiUrl, {
    user,
    limit: config.activityLimit,
    offset: 0,
    type: config.copyTradesOnly ? "TRADE" : undefined,
    sortBy: "TIMESTAMP",
    sortDirection: "DESC",
  });

  let copied = 0;
  for (let i = activities.length - 1; i >= 0; i--) {
    const a = activities[i]!;
    if (a.type !== "TRADE" || !a.asset || !a.side) continue;

    const key = tradeEventKey(a);
    if (seen.has(key)) continue;
    seen.add(key);
    trimSeen();

    const tokenId = a.asset;
    const side = a.side;

    // Skip if target already held this asset at copy-start, or we've already participated in it.
    if (knownAssets.has(tokenId)) continue;

    const price = a.price ?? 0;
    const size = a.size ?? 0;
    if (size < 0.01) continue;

    const orderSize = applySizeLimit(size, price);

    if (!workingMap.has(tokenId)) {
      workingMap.set(tokenId, { dir: side === "BUY" ? "long" : "short", size });
    }

    let tickSize: string | null = null;
    try {
      tickSize = await getTickSize(tokenId);
    } catch (e) {
      errors.push(`tick ${tokenId}: ${e instanceof Error ? e.message : e}`);
    }
    if (tickSize === null) {
      errors.push(`Skip: no orderbook for token ${tokenId.slice(0, 12)}... (market may be closed or resolved)`);
      continue;
    }

    const result = await placeLimitOrder(tokenId, side, price, orderSize, tickSize, false);
    if (result.error) {
      errors.push(`${tokenId} ${side}: ${result.error}`);
    } else {
      console.log(
        `Copied: ${side} ${orderSize} @ ${price} token=${tokenId.slice(0, 10)}... orderID=${result.orderID ?? "ok"}`
      );
      copied++;
    }
  }

  return { fetched: activities.length, copied, errors };
}
