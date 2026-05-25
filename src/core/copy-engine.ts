import { getActivity, getPositions, tradeEventKey } from "../services/data-api.js";
import { getOrderMarketConfig, placeLimitOrder } from "../services/clob.js";
import { config } from "../config/index.js";
import { getCopyTarget } from "../utils/target.js";

/**
 * Build snapshot of target's open positions at copy-start.
 * Returns Set of asset IDs that target already holds — all subsequent ops on these are skipped.
 */
async function buildSnapshot(user: string): Promise<Set<string>> {
  const snapshot = new Set<string>();
  try {
    const positions = await getPositions(config.dataApiUrl, { user, limit: 500 });
    for (const p of positions) {
      if (p.asset && p.size && p.size > 0) {
        snapshot.add(p.asset);
      }
    }
  } catch (e) {
    console.warn("Failed to fetch initial positions:", e instanceof Error ? e.message : e);
  }
  return snapshot;
}

const SEEN_CAP = 10_000;
const seen = new Set<string>();
let startupSnapshotPromise: Promise<Set<string>> | null = null;
let warmedUp = false;

function trimSeen(): void {
  if (seen.size <= SEEN_CAP) return;
  const arr = [...seen];
  for (let i = 0; i < arr.length - SEEN_CAP; i++) seen.delete(arr[i]!);
}

function getStartupSnapshot(user: string): Promise<Set<string>> {
  if (!startupSnapshotPromise) {
    startupSnapshotPromise = buildSnapshot(user).then((snapshot) => {
      console.log(`Initialized startup position snapshot: ${snapshot.size} assets`);
      return snapshot;
    });
  }
  return startupSnapshotPromise;
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

  // Snapshot of target's open positions at copy-start.
  const snapshot = await getStartupSnapshot(user);

  const activities = await getActivity(config.dataApiUrl, {
    user,
    limit: config.activityLimit,
    offset: 0,
    type: config.copyTradesOnly ? "TRADE" : undefined,
    sortBy: "TIMESTAMP",
    sortDirection: "DESC",
  });

  if (!warmedUp) {
    for (const a of activities) {
      if (a.type !== "TRADE" || !a.asset || !a.side) continue;
      seen.add(tradeEventKey(a));
      trimSeen();
    }
    warmedUp = true;
    console.log(`Initialized recent activity baseline: ${seen.size} trades`);
    return { fetched: activities.length, copied: 0, errors };
  }

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

    // Skip if target already held this asset at copy-start.
    if (snapshot.has(tokenId)) continue;

    const price = a.price ?? 0;
    const size = a.size ?? 0;
    if (size < 0.01) continue;

    const orderSize = applySizeLimit(size, price);

    let orderConfig: Awaited<ReturnType<typeof getOrderMarketConfig>> = null;
    try {
      orderConfig = await getOrderMarketConfig(tokenId);
    } catch (e) {
      errors.push(`market config ${tokenId}: ${e instanceof Error ? e.message : e}`);
    }
    if (orderConfig === null) {
      errors.push(`Skip: no orderbook for token ${tokenId.slice(0, 12)}... (market may be closed or resolved)`);
      continue;
    }

    const result = await placeLimitOrder(tokenId, side, price, orderSize, orderConfig);
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
