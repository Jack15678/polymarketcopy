import { getActivity, getPositions, tradeEventKey, type Position } from "../services/data-api.js";
import { getOrderMarketConfig, placeLimitOrder } from "../services/clob.js";
import { config } from "../config/index.js";
import { getCopyTarget } from "../utils/target.js";

/**
 * Build snapshot of open positions at copy-start.
 */
async function buildPositionSnapshot(user: string, label: string): Promise<Map<string, Position>> {
  const snapshot = new Map<string, Position>();
  try {
    const positions = await getPositions(config.dataApiUrl, { user, limit: 500 });
    for (const p of positions) {
      if (p.asset && p.size && p.size > 0) {
        snapshot.set(p.asset, p);
      }
    }
  } catch (e) {
    console.warn(`Failed to fetch initial ${label} positions:`, e instanceof Error ? e.message : e);
  }
  return snapshot;
}

const SEEN_CAP = 10_000;
const seen = new Set<string>();
let targetSnapshotPromise: Promise<Map<string, Position>> | null = null;
let followerSnapshotPromise: Promise<Map<string, Position>> | null = null;
let warmedUp = false;

function trimSeen(): void {
  if (seen.size <= SEEN_CAP) return;
  const arr = [...seen];
  for (let i = 0; i < arr.length - SEEN_CAP; i++) seen.delete(arr[i]!);
}

function getTargetSnapshot(user: string): Promise<Map<string, Position>> {
  if (!targetSnapshotPromise) {
    targetSnapshotPromise = buildPositionSnapshot(user, "target").then((snapshot) => {
      console.log(`Initialized target startup position snapshot: ${snapshot.size} assets`);
      return snapshot;
    });
  }
  return targetSnapshotPromise;
}

function getFollowerSnapshot(): Promise<Map<string, Position>> {
  if (!followerSnapshotPromise) {
    followerSnapshotPromise = buildPositionSnapshot(config.funderAddress, "follower").then((snapshot) => {
      console.log(`Initialized follower startup position snapshot: ${snapshot.size} assets`);
      return snapshot;
    });
  }
  return followerSnapshotPromise;
}

function describePosition(p: Position): string {
  const title = p.title ? ` ${p.title.slice(0, 50)}` : "";
  const outcome = p.outcome ? ` / ${p.outcome}` : "";
  return `${p.asset?.slice(0, 12)}... size=${p.size ?? 0}${outcome}${title}`;
}

function logStartupPositionComparison(target: Map<string, Position>, follower: Map<string, Position>): void {
  const shared = [...target.keys()].filter((asset) => follower.has(asset));
  const targetOnly = [...target.keys()].filter((asset) => !follower.has(asset));
  const followerOnly = [...follower.keys()].filter((asset) => !target.has(asset));

  console.log(
    `Startup position compare: target=${target.size}, follower=${follower.size}, shared=${shared.length}, targetOnly=${targetOnly.length}, followerOnly=${followerOnly.length}`
  );
  for (const asset of shared.slice(0, 20)) {
    const t = target.get(asset)!;
    const f = follower.get(asset)!;
    console.log(
      `Startup shared asset: ${asset.slice(0, 12)}... targetSize=${t.size ?? 0} followerSize=${f.size ?? 0} ${t.title ?? ""}`
    );
  }
  for (const asset of targetOnly.slice(0, 20)) {
    console.log(`Startup target-only skip asset: ${describePosition(target.get(asset)!)}`);
  }
}

function applySizeLimit(size: number, price: number): number {
  let s = size * config.sizeMultiplier;
  if (config.maxOrderUsd != null && config.maxOrderUsd > 0 && price > 0) {
    const notional = s * price;
    if (notional > config.maxOrderUsd) s = config.maxOrderUsd / price;
  }
  return Math.max(0.01, Math.round(s * 100) / 100);
}

async function getFollowerPositionSize(tokenId: string): Promise<number> {
  if (!config.funderAddress) return 0;
  const positions = await getPositions(config.dataApiUrl, {
    user: config.funderAddress,
    limit: 500,
    sizeThreshold: 0,
  });
  const position = positions.find((p) => p.asset === tokenId);
  return Math.max(0, position?.size ?? 0);
}

export async function pollAndCopy(): Promise<{
  fetched: number;
  copied: number;
  errors: string[];
}> {
  const errors: string[] = [];
  const user = getCopyTarget() || config.targetUser;
  if (!user) return { fetched: 0, copied: 0, errors: ["No target user"] };

  const targetSnapshot = await getTargetSnapshot(user);
  const followerSnapshot = await getFollowerSnapshot();
  if (!warmedUp) logStartupPositionComparison(targetSnapshot, followerSnapshot);

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

    const price = a.price ?? 0;
    const size = a.size ?? 0;
    if (size < 0.01) continue;

    // For positions the target already held at copy-start, only follow that token
    // if the follower also held the exact same asset at copy-start.
    if (targetSnapshot.has(tokenId) && !followerSnapshot.has(tokenId)) continue;

    let orderSize = applySizeLimit(size, price);
    if (side === "SELL") {
      let followerPositionSize = 0;
      try {
        followerPositionSize = await getFollowerPositionSize(tokenId);
      } catch (e) {
        errors.push(`follower position ${tokenId}: ${e instanceof Error ? e.message : e}`);
        continue;
      }
      if (followerPositionSize < 0.01) continue;
      orderSize = Math.min(orderSize, Math.round(followerPositionSize * 100) / 100);
    }

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
    if (orderSize < orderConfig.minOrderSize) {
      errors.push(
        `Skip: order size ${orderSize} is below market minimum ${orderConfig.minOrderSize} for token ${tokenId.slice(0, 12)}...`
      );
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
