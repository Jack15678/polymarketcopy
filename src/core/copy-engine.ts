import { readFile, writeFile } from "node:fs/promises";
import { getActivity, getPositions, tradeEventKey, type Activity, type Position } from "../services/data-api.js";
import { getOrderMarketConfig, placeLimitOrder } from "../services/clob.js";
import { config } from "../config/index.js";
import { getCopyTarget } from "../utils/target.js";

interface CopyState {
  managedAssets: string[];
  pendingExitAssets: string[];
}

const STATE_FILE = ".copytrade-state.json";
let statePromise: Promise<CopyState> | null = null;

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

async function loadState(): Promise<CopyState> {
  if (!statePromise) {
    statePromise = readFile(STATE_FILE, "utf8")
      .then((raw) => {
        const parsed = JSON.parse(raw) as Partial<CopyState>;
        return {
          managedAssets: Array.isArray(parsed.managedAssets)
            ? parsed.managedAssets.filter((asset): asset is string => typeof asset === "string")
            : [],
          pendingExitAssets: Array.isArray(parsed.pendingExitAssets)
            ? parsed.pendingExitAssets.filter((asset): asset is string => typeof asset === "string")
            : [],
        };
      })
      .catch(() => ({ managedAssets: [], pendingExitAssets: [] }));
  }
  return statePromise;
}

async function saveState(state: CopyState): Promise<void> {
  state.managedAssets = [...new Set(state.managedAssets)];
  state.pendingExitAssets = [...new Set(state.pendingExitAssets)];
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

async function rememberManagedAsset(tokenId: string): Promise<void> {
  const state = await loadState();
  if (state.managedAssets.includes(tokenId)) return;
  state.managedAssets.push(tokenId);
  await saveState(state);
  console.log(`State: tracking managed asset ${tokenId.slice(0, 12)}...`);
}

async function markPendingExit(tokenId: string, reason: string): Promise<void> {
  const state = await loadState();
  if (state.pendingExitAssets.includes(tokenId)) return;
  state.pendingExitAssets.push(tokenId);
  await saveState(state);
  console.log(`State: pending exit ${tokenId.slice(0, 12)}... (${reason})`);
}

async function getPendingExitAssets(): Promise<Set<string>> {
  const state = await loadState();
  return new Set(state.pendingExitAssets);
}

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
  for (const asset of followerOnly.slice(0, 20)) {
    console.log(`Startup follower-only asset: ${describePosition(follower.get(asset)!)}`);
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

function floorOrderSize(size: number): number {
  return Math.floor(size * 100) / 100;
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

async function getManagedAssets(
  targetSnapshot: Map<string, Position>,
  followerSnapshot: Map<string, Position>,
  log = false
): Promise<Set<string>> {
  const state = await loadState();
  const managed = new Set(state.managedAssets);
  let changed = false;
  for (const asset of targetSnapshot.keys()) {
    if (followerSnapshot.has(asset)) {
      const before = managed.size;
      managed.add(asset);
      changed ||= managed.size !== before;
    }
  }
  if (changed) {
    state.managedAssets = [...managed];
    await saveState(state);
  }
  if (log) {
    console.log(
      `Managed assets: ${managed.size} (${[...managed]
        .slice(0, 10)
        .map((a) => `${a.slice(0, 12)}...`)
        .join(", ")})`
    );
  }
  return managed;
}

async function fetchCurrentPositionMap(user: string, label: string): Promise<Map<string, Position>> {
  try {
    const positions = await getPositions(config.dataApiUrl, {
      user,
      limit: 500,
      sizeThreshold: 0,
    });
    const map = new Map<string, Position>();
    for (const p of positions) {
      if (p.asset && (p.size ?? 0) > 0) map.set(p.asset, p);
    }
    return map;
  } catch (e) {
    throw new Error(`${label} positions: ${e instanceof Error ? e.message : e}`);
  }
}

function getRecentTargetSellAssets(activities: Activity[]): Set<string> {
  const assets = new Set<string>();
  for (const a of activities) {
    if (a.type === "TRADE" && a.side === "SELL" && a.asset) assets.add(a.asset);
  }
  return assets;
}

async function reconcileManagedExits(
  user: string,
  managedAssets: Set<string>,
  recentTargetSellAssets: Set<string>,
  errors: string[]
): Promise<{ copied: number; handledAssets: Set<string> }> {
  const exitCandidates = new Set([...managedAssets, ...recentTargetSellAssets]);
  const handledAssets = new Set<string>();
  if (exitCandidates.size === 0) return { copied: 0, handledAssets };

  const targetCurrent = await fetchCurrentPositionMap(user, "target");
  const followerCurrent = await fetchCurrentPositionMap(config.funderAddress, "follower");
  const pendingExitAssets = await getPendingExitAssets();
  let copied = 0;

  for (const tokenId of exitCandidates) {
    const followerPosition = followerCurrent.get(tokenId);
    if (!followerPosition) continue;
    if (targetCurrent.has(tokenId)) continue;
    handledAssets.add(tokenId);
    if (pendingExitAssets.has(tokenId)) continue;

    const size = floorOrderSize(followerPosition.size ?? 0);
    const price = followerPosition.curPrice ?? 0;
    if (size < 0.01 || price <= 0) continue;

    let orderConfig: Awaited<ReturnType<typeof getOrderMarketConfig>> = null;
    try {
      orderConfig = await getOrderMarketConfig(tokenId);
    } catch (e) {
      errors.push(`reconcile market config ${tokenId}: ${e instanceof Error ? e.message : e}`);
    }
    if (orderConfig === null) {
      errors.push(`Reconcile skip: no orderbook for ${tokenId.slice(0, 12)}...`);
      await markPendingExit(tokenId, "no live orderbook for exit");
      continue;
    }
    if (size < orderConfig.minOrderSize) {
      errors.push(
        `Reconcile skip: follower size ${size} is below market minimum ${orderConfig.minOrderSize} for ${tokenId.slice(0, 12)}...`
      );
      await markPendingExit(tokenId, "exit size below market minimum");
      continue;
    }

    console.log(
      `Reconcile exit: target no longer holds ${tokenId.slice(0, 12)}..., selling follower size=${size} @ ${price}${
        recentTargetSellAssets.has(tokenId) && !managedAssets.has(tokenId) ? " (recent target SELL recovery)" : ""
      }`
    );
    const result = await placeLimitOrder(tokenId, "SELL", price, size, orderConfig);
    if (result.error) {
      errors.push(`${tokenId} RECONCILE_SELL: ${result.error}`);
      if (
        result.error.includes("sum of active orders") ||
        result.error.includes("not enough balance / allowance")
      ) {
        await markPendingExit(tokenId, "active sell order already locks balance");
      } else if (
        result.error.includes("orderbook") ||
        result.error.includes("does not exist")
      ) {
        await markPendingExit(tokenId, "no live orderbook for exit");
      }
    } else {
      console.log(
        `Reconcile exit order placed: token=${tokenId.slice(0, 12)}... orderID=${result.orderID ?? "ok"}`
      );
      await markPendingExit(tokenId, "sell order placed");
      copied++;
    }
  }

  return { copied, handledAssets };
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
  const managedAssets = await getManagedAssets(targetSnapshot, followerSnapshot, !warmedUp);

  const activities = await getActivity(config.dataApiUrl, {
    user,
    limit: config.activityLimit,
    offset: 0,
    type: config.copyTradesOnly ? "TRADE" : undefined,
    sortBy: "TIMESTAMP",
    sortDirection: "DESC",
  });
  const recentTargetSellAssets = getRecentTargetSellAssets(activities);

  let copied = 0;
  let reconcileHandledAssets = new Set<string>();
  try {
    const reconcileResult = await reconcileManagedExits(user, managedAssets, recentTargetSellAssets, errors);
    copied += reconcileResult.copied;
    reconcileHandledAssets = reconcileResult.handledAssets;
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  if (!warmedUp) {
    for (const a of activities) {
      if (a.type !== "TRADE" || !a.asset || !a.side) continue;
      seen.add(tradeEventKey(a));
      trimSeen();
    }
    warmedUp = true;
    console.log(`Initialized recent activity baseline: ${seen.size} trades`);
    return { fetched: activities.length, copied, errors };
  }

  for (let i = activities.length - 1; i >= 0; i--) {
    const a = activities[i]!;
    if (a.type !== "TRADE" || !a.asset || !a.side) continue;

    const key = tradeEventKey(a);
    if (seen.has(key)) continue;
    seen.add(key);
    trimSeen();

    const tokenId = a.asset;
    const side = a.side;
    if (side === "SELL" && reconcileHandledAssets.has(tokenId)) continue;

    const price = a.price ?? 0;
    const size = a.size ?? 0;
    if (size < 0.01) continue;

    // If the target already held this token at startup and the follower did not,
    // ignore later activity for that startup-only position.
    if (targetSnapshot.has(tokenId) && !followerSnapshot.has(tokenId) && !managedAssets.has(tokenId)) continue;

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
      orderSize = Math.min(orderSize, floorOrderSize(followerPositionSize));
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
      if (side === "SELL") {
        if (
          result.error.includes("sum of active orders") ||
          result.error.includes("not enough balance / allowance")
        ) {
          await markPendingExit(tokenId, "active sell order already locks balance");
        } else if (result.error.includes("orderbook") || result.error.includes("does not exist")) {
          await markPendingExit(tokenId, "no live orderbook for exit");
        }
      }
    } else {
      console.log(
        `Copied: ${side} ${orderSize} @ ${price} token=${tokenId.slice(0, 10)}... orderID=${result.orderID ?? "ok"}`
      );
      if (side === "BUY") await rememberManagedAsset(tokenId);
      if (side === "SELL") await markPendingExit(tokenId, "sell order placed");
      copied++;
    }
  }

  return { fetched: activities.length, copied, errors };
}
