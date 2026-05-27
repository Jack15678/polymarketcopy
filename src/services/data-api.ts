const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_LEADERBOARD_LIMIT = 50;
const MAX_TRADES_LIMIT = 10_000;

export type LeaderboardCategory =
  | "OVERALL"
  | "POLITICS"
  | "SPORTS"
  | "CRYPTO"
  | "CULTURE"
  | "MENTIONS"
  | "WEATHER"
  | "ECONOMICS"
  | "TECH"
  | "FINANCE";

export type LeaderboardTimePeriod = "DAY" | "WEEK" | "MONTH" | "ALL";
export type LeaderboardOrderBy = "PNL" | "VOL";

export interface LeaderboardTrader {
  rank: string;
  proxyWallet: string;
  userName?: string;
  vol?: number;
  pnl?: number;
  profileImage?: string;
  xUsername?: string;
  verifiedBadge?: boolean;
}

export interface GetLeaderboardParams {
  category?: LeaderboardCategory;
  timePeriod?: LeaderboardTimePeriod;
  orderBy?: LeaderboardOrderBy;
  limit?: number;
  offset?: number;
  user?: string;
  userName?: string;
}

export type ActivityType =
  | "TRADE"
  | "SPLIT"
  | "MERGE"
  | "REDEEM"
  | "REWARD"
  | "CONVERSION"
  | "MAKER_REBATE";

export interface Activity {
  proxyWallet?: string;
  timestamp: number;
  conditionId?: string;
  type: ActivityType;
  size?: number;
  usdcSize?: number;
  transactionHash?: string;
  price?: number;
  asset?: string;
  side?: "BUY" | "SELL";
  outcomeIndex?: number;
  title?: string;
  slug?: string;
  eventSlug?: string;
  outcome?: string;
}

export interface Position {
  proxyWallet?: string;
  asset?: string;
  conditionId?: string;
  size?: number;
  avgPrice?: number;
  initialValue?: number;
  currentValue?: number;
  cashPnl?: number;
  percentPnl?: number;
  totalBought?: number;
  realizedPnl?: number;
  percentRealizedPnl?: number;
  curPrice?: number;
  redeemable?: boolean;
  mergeable?: boolean;
  title?: string;
  slug?: string;
  icon?: string;
  eventSlug?: string;
  outcome?: string;
  outcomeIndex?: number;
  oppositeOutcome?: string;
  oppositeAsset?: string;
  endDate?: string;
  negativeRisk?: boolean;
}

export interface ClosedPosition {
  proxyWallet?: string;
  asset?: string;
  conditionId?: string;
  size?: number;
  avgPrice?: number;
  initialValue?: number;
  currentValue?: number;
  totalBought?: number;
  realizedPnl?: number;
  percentRealizedPnl?: number;
  curPrice?: number;
  title?: string;
  slug?: string;
  eventSlug?: string;
  outcome?: string;
  outcomeIndex?: number;
  timestamp?: number;
  endDate?: string;
}

export type Trade = Omit<Activity, "type" | "usdcSize"> & {
  name?: string;
  pseudonym?: string;
  bio?: string;
  profileImage?: string;
  profileImageOptimized?: string;
};

export interface GetActivityParams {
  user: string;
  limit?: number;
  offset?: number;
  type?: ActivityType | ActivityType[];
  sortBy?: "TIMESTAMP" | "TOKENS" | "CASH";
  sortDirection?: "ASC" | "DESC";
}

export interface GetPositionsParams {
  user: string;
  limit?: number;
  offset?: number;
  sizeThreshold?: number;
  sortBy?: "CURRENT" | "INITIAL" | "TOKENS" | "CASHPNL" | "PERCENTPNL" | "TITLE" | "RESOLVING" | "PRICE" | "AVGPRICE";
  sortDirection?: "ASC" | "DESC";
}

export interface GetTradesParams {
  user?: string;
  limit?: number;
  offset?: number;
  side?: "BUY" | "SELL";
  takerOnly?: boolean;
}

export interface GetClosedPositionsParams {
  user: string;
  limit?: number;
  offset?: number;
  sortBy?: "TIMESTAMP" | "REALIZEDPNL" | "PERCENTREALIZEDPNL" | "TITLE" | "RESOLVING";
  sortDirection?: "ASC" | "DESC";
}

export function buildLeaderboardUrl(base: string, params: GetLeaderboardParams = {}): string {
  const u = new URL(`${base}/v1/leaderboard`);
  u.searchParams.set("category", params.category ?? "OVERALL");
  u.searchParams.set("timePeriod", params.timePeriod ?? "MONTH");
  u.searchParams.set("orderBy", params.orderBy ?? "PNL");
  u.searchParams.set("limit", String(Math.min(MAX_LEADERBOARD_LIMIT, Math.max(1, params.limit ?? 50))));
  u.searchParams.set("offset", String(Math.max(0, params.offset ?? 0)));
  if (params.user) u.searchParams.set("user", params.user);
  if (params.userName) u.searchParams.set("userName", params.userName);
  return u.toString();
}

export function buildActivityUrl(base: string, params: GetActivityParams): string {
  const u = new URL(`${base}/activity`);
  u.searchParams.set("user", params.user);
  u.searchParams.set("limit", String(Math.min(MAX_LIMIT, params.limit ?? DEFAULT_LIMIT)));
  u.searchParams.set("offset", String(Math.max(0, params.offset ?? 0)));
  if (params.type) {
    const t = Array.isArray(params.type) ? params.type : [params.type];
    u.searchParams.set("type", t.join(","));
  }
  if (params.sortBy) u.searchParams.set("sortBy", params.sortBy);
  if (params.sortDirection) u.searchParams.set("sortDirection", params.sortDirection);
  return u.toString();
}

export function buildPositionsUrl(base: string, params: GetPositionsParams): string {
  const u = new URL(`${base}/positions`);
  u.searchParams.set("user", params.user);
  u.searchParams.set("limit", String(Math.min(MAX_LIMIT, Math.max(0, params.limit ?? DEFAULT_LIMIT))));
  u.searchParams.set("offset", String(Math.max(0, params.offset ?? 0)));
  u.searchParams.set("sizeThreshold", String(Math.max(0, params.sizeThreshold ?? 0)));
  if (params.sortBy) u.searchParams.set("sortBy", params.sortBy);
  if (params.sortDirection) u.searchParams.set("sortDirection", params.sortDirection);
  return u.toString();
}

export function buildTradesUrl(base: string, params: GetTradesParams = {}): string {
  const u = new URL(`${base}/trades`);
  u.searchParams.set("limit", String(Math.min(MAX_TRADES_LIMIT, Math.max(0, params.limit ?? DEFAULT_LIMIT))));
  u.searchParams.set("offset", String(Math.max(0, params.offset ?? 0)));
  if (params.user) u.searchParams.set("user", params.user);
  if (params.side) u.searchParams.set("side", params.side);
  if (params.takerOnly !== undefined) u.searchParams.set("takerOnly", String(params.takerOnly));
  return u.toString();
}

export function buildClosedPositionsUrl(base: string, params: GetClosedPositionsParams): string {
  const u = new URL(`${base}/closed-positions`);
  u.searchParams.set("user", params.user);
  u.searchParams.set("limit", String(Math.min(MAX_LIMIT, Math.max(0, params.limit ?? DEFAULT_LIMIT))));
  u.searchParams.set("offset", String(Math.max(0, params.offset ?? 0)));
  if (params.sortBy) u.searchParams.set("sortBy", params.sortBy);
  if (params.sortDirection) u.searchParams.set("sortDirection", params.sortDirection);
  return u.toString();
}

export async function getLeaderboard(
  base: string,
  params: GetLeaderboardParams = {}
): Promise<LeaderboardTrader[]> {
  const url = buildLeaderboardUrl(base, params);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Data API leaderboard ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export async function getActivity(
  base: string,
  params: GetActivityParams
): Promise<Activity[]> {
  const url = buildActivityUrl(base, params);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Data API activity ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export async function getPositions(
  base: string,
  params: GetPositionsParams
): Promise<Position[]> {
  const url = buildPositionsUrl(base, params);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Data API positions ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export async function getTrades(
  base: string,
  params: GetTradesParams = {}
): Promise<Trade[]> {
  const url = buildTradesUrl(base, params);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Data API trades ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export async function getClosedPositions(
  base: string,
  params: GetClosedPositionsParams
): Promise<ClosedPosition[]> {
  const url = buildClosedPositionsUrl(base, params);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Data API closed positions ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export function tradeEventKey(a: Activity): string {
  const tx = a.transactionHash ?? "";
  const asset = a.asset ?? "";
  const side = a.side ?? "";
  const price = a.price ?? "";
  const size = a.size ?? "";
  const ts = a.timestamp ?? 0;
  if (tx) return `${tx}:${asset}:${side}:${price}:${size}`;
  return `:${ts}:${asset}:${side}:${price}:${size}`;
}
