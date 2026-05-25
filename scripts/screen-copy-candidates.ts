import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getActivity,
  getClosedPositions,
  getLeaderboard,
  getPositions,
  getTrades,
  type ClosedPosition,
  type LeaderboardTrader,
  type Position,
  type Trade,
  type LeaderboardOrderBy,
  type LeaderboardTimePeriod,
} from "../src/services/data-api.js";

const DATA_API_URL = "https://data-api.polymarket.com";
const REPORT_PATH = path.resolve("docs/copytrade-candidate-screen.md");
const ACCOUNT_SIZE_USD = 100;
const MAX_ORDER_USD = 1;
const LEADERBOARD_PAGE_LIMIT = 50;
const CANDIDATE_LIMIT = Math.max(50, Number.parseInt(process.env.SCREEN_CANDIDATE_LIMIT ?? "250", 10));
const RECENT_TRADE_LIMIT = 500;
const CLOSED_POSITION_LIMIT = 200;
const SCREEN_CONCURRENCY = Math.max(1, Number.parseInt(process.env.SCREEN_CONCURRENCY ?? "8", 10));

const LEADERBOARD_SOURCES: Array<{ timePeriod: LeaderboardTimePeriod; orderBy: LeaderboardOrderBy }> = [
  { timePeriod: "MONTH", orderBy: "PNL" },
  { timePeriod: "MONTH", orderBy: "VOL" },
  { timePeriod: "WEEK", orderBy: "PNL" },
  { timePeriod: "ALL", orderBy: "PNL" },
  { timePeriod: "ALL", orderBy: "VOL" },
];

type Rating = "Recommended" | "Watch" | "Reject";

interface CandidateReport {
  trader: LeaderboardTrader;
  address: string;
  rating: Rating;
  score: number;
  positions: Position[];
  trades: Trade[];
  closedPositions: ClosedPosition[];
  metrics: {
    accountAgeDays: number | null;
    openPositions: number;
    currentValue: number;
    avgPositionValue: number;
    maxPositionShare: number;
    smallPositionShare: number;
    currentUnrealizedDrawdownPct: number;
    recentTrades: number;
    activeDays: number;
    tradesPerDay: number;
    avgTradeNotional: number;
    realizedMaxDrawdownPct: number | null;
    profitableWeeksRatio: number | null;
    pnlConcentration: number | null;
    closedPositionWinRate: number | null;
    avgWinLossRatio: number | null;
    suggestedMultiplier: number | null;
  };
  reasons: string[];
  warnings: string[];
  error?: string;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function fmtUsd(value: number): string {
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: value >= 100 ? 0 : 2 })}`;
}

function fmtPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function fmtNum(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "0.00";
}

function fmtNullableNum(value: number | null, digits = 2): string {
  return value == null ? "n/a" : fmtNum(value, digits);
}

function fmtNullablePct(value: number | null): string {
  return value == null ? "n/a" : fmtPct(value);
}

function markdownEscape(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function displayName(trader: LeaderboardTrader): string {
  return trader.userName || trader.xUsername || trader.proxyWallet;
}

function tradeNotional(trade: Trade): number {
  const explicit = asNumber((trade as { usdcSize?: number }).usdcSize);
  if (explicit > 0) return explicit;
  return asNumber(trade.size) * asNumber(trade.price);
}

function tradeActiveDays(trades: Trade[]): number {
  if (trades.length === 0) return 0;
  const timestamps = trades.map((t) => asNumber(t.timestamp)).filter((t) => t > 0);
  if (timestamps.length === 0) return 1;
  const min = Math.min(...timestamps);
  const max = Math.max(...timestamps);
  const spanDays = Math.max(1, Math.ceil((max - min) / 86_400));
  return spanDays;
}

function accountAgeDays(earliestTimestamp: number | null): number | null {
  if (earliestTimestamp == null || earliestTimestamp <= 0) return null;
  return Math.max(0, Math.floor((Date.now() / 1000 - earliestTimestamp) / 86_400));
}

function realizedMaxDrawdownPct(closedPositions: ClosedPosition[]): number | null {
  const ordered = closedPositions
    .filter((p) => asNumber(p.timestamp) > 0)
    .sort((a, b) => asNumber(a.timestamp) - asNumber(b.timestamp));
  if (ordered.length < 2) return null;

  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const position of ordered) {
    equity += asNumber(position.realizedPnl);
    if (equity > peak) peak = equity;
    const drawdown = peak - equity;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }
  if (peak <= 0) return maxDrawdown > 0 ? 1 : 0;
  return maxDrawdown / peak;
}

function profitableWeeksRatio(closedPositions: ClosedPosition[]): number | null {
  const byWeek = new Map<string, number>();
  for (const position of closedPositions) {
    const ts = asNumber(position.timestamp);
    if (ts <= 0) continue;
    const week = Math.floor(ts / (7 * 86_400));
    byWeek.set(String(week), (byWeek.get(String(week)) ?? 0) + asNumber(position.realizedPnl));
  }
  if (byWeek.size === 0) return null;
  let profitable = 0;
  for (const pnl of byWeek.values()) {
    if (pnl > 0) profitable++;
  }
  return profitable / byWeek.size;
}

function pnlConcentration(closedPositions: ClosedPosition[]): number | null {
  const wins = closedPositions.map((p) => asNumber(p.realizedPnl)).filter((pnl) => pnl > 0);
  const totalWin = wins.reduce((sum, pnl) => sum + pnl, 0);
  if (totalWin <= 0 || wins.length === 0) return null;
  return Math.max(...wins) / totalWin;
}

function closedPositionWinRate(closedPositions: ClosedPosition[]): number | null {
  const resolved = closedPositions.filter((p) => asNumber(p.realizedPnl) !== 0);
  if (resolved.length === 0) return null;
  const wins = resolved.filter((p) => asNumber(p.realizedPnl) > 0).length;
  return wins / resolved.length;
}

function avgWinLossRatio(closedPositions: ClosedPosition[]): number | null {
  const wins = closedPositions.map((p) => asNumber(p.realizedPnl)).filter((pnl) => pnl > 0);
  const losses = closedPositions.map((p) => asNumber(p.realizedPnl)).filter((pnl) => pnl < 0);
  if (wins.length === 0 || losses.length === 0) return null;
  const avgWin = wins.reduce((sum, pnl) => sum + pnl, 0) / wins.length;
  const avgLoss = Math.abs(losses.reduce((sum, pnl) => sum + pnl, 0) / losses.length);
  return avgLoss > 0 ? avgWin / avgLoss : null;
}

function suggestedMultiplier(avgTradeNotional: number): number | null {
  if (avgTradeNotional <= 0) return null;
  const multiplier = Math.min(1, MAX_ORDER_USD / avgTradeNotional);
  if (multiplier >= 0.1) return Math.round(multiplier * 100) / 100;
  if (multiplier >= 0.01) return Math.round(multiplier * 1_000) / 1_000;
  return Math.max(0.0001, Math.round(multiplier * 10_000) / 10_000);
}

function scoreCandidate(metrics: CandidateReport["metrics"]): Pick<CandidateReport, "rating" | "score" | "reasons" | "warnings"> {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const hardRejects: string[] = [];
  let score = 0;

  if (metrics.accountAgeDays == null) {
    warnings.push("account age could not be estimated");
  } else if (metrics.accountAgeDays < 14) {
    hardRejects.push("estimated Polymarket account age is below 14 days");
  } else if (metrics.accountAgeDays < 30) {
    score += 2;
    warnings.push("estimated account age is 14-30 days, so it cannot be recommended yet");
  } else if (metrics.accountAgeDays >= 60) {
    score += 12;
    reasons.push("estimated account age is at least 60 days");
  } else {
    score += 8;
    reasons.push("estimated account age is at least 30 days");
  }

  if (metrics.openPositions >= 3 && metrics.openPositions <= 10) {
    score += 30;
    reasons.push("open positions are in the 3-10 target range");
  } else if (metrics.openPositions >= 11 && metrics.openPositions <= 20) {
    score += 12;
    warnings.push("open positions are manageable but above the preferred range");
  } else if (metrics.openPositions === 0) {
    warnings.push("no current open positions");
  } else {
    warnings.push("too many current open positions for a 100 USDC copy account");
  }

  if (metrics.currentValue >= 500 && metrics.currentValue <= 10_000) {
    score += 25;
    reasons.push("current open-position value is in the 500-10,000 USDC target range");
  } else if (metrics.currentValue > 10_000) {
    score += 10;
    warnings.push("current open-position value is large, so copying requires a small multiplier");
  } else if (metrics.currentValue > 0) {
    score += 5;
    warnings.push("current open-position value is small, so the account may be too inactive or undercapitalized");
    if (metrics.currentValue < 100) hardRejects.push("current open-position value is below 100 USDC");
  } else {
    hardRejects.push("current open-position value is zero");
  }

  if (metrics.maxPositionShare > 0 && metrics.maxPositionShare < 0.35) {
    score += 20;
    reasons.push("largest position is below 35% of current exposure");
  } else if (metrics.maxPositionShare >= 0.35 && metrics.maxPositionShare <= 0.5) {
    score += 8;
    warnings.push("largest position is concentrated but still in the watch range");
  } else if (metrics.maxPositionShare > 0.5) {
    warnings.push("largest position is over 50% of current exposure");
  }

  if (metrics.recentTrades >= 10 && metrics.tradesPerDay >= 0.5) {
    score += 15;
    reasons.push("recent trade history shows ongoing activity");
  } else if (metrics.recentTrades > 0) {
    score += 5;
    warnings.push("recent activity is light");
  } else {
    warnings.push("no recent trades found");
    hardRejects.push("no recent trades found");
  }

  if (metrics.avgTradeNotional >= 5 && metrics.avgTradeNotional <= 1_000) {
    score += 10;
    reasons.push("average trade size can be copied with a practical small-account cap");
  } else if (metrics.avgTradeNotional > 1_000) {
    warnings.push("average trade size is very large relative to 100 USDC");
  } else if (metrics.avgTradeNotional > 0) {
    warnings.push("average trade size is very small and may create fragmented fills");
  }

  if (metrics.smallPositionShare > 0.5) {
    score -= 15;
    warnings.push("more than half of open positions are below 5 USDC");
  }

  if (metrics.realizedMaxDrawdownPct != null) {
    if (metrics.realizedMaxDrawdownPct < 0.25) {
      score += 12;
      reasons.push("realized max drawdown is below 25%");
    } else if (metrics.realizedMaxDrawdownPct < 0.4) {
      score += 5;
      warnings.push("realized max drawdown is in the watch range");
    } else if (metrics.realizedMaxDrawdownPct > 0.5) {
      hardRejects.push("realized max drawdown is above 50%");
    } else {
      warnings.push("realized max drawdown is elevated");
    }
  } else {
    warnings.push("not enough closed-position history to estimate realized drawdown");
  }

  if (metrics.profitableWeeksRatio != null) {
    if (metrics.profitableWeeksRatio >= 0.5) {
      score += 10;
      reasons.push("at least half of observed weeks were profitable");
    } else if (metrics.profitableWeeksRatio >= 0.35) {
      score += 4;
      warnings.push("profitable-week ratio is in the watch range");
    } else {
      warnings.push("profitable-week ratio is weak");
    }
  }

  if (metrics.pnlConcentration != null) {
    if (metrics.pnlConcentration < 0.4) {
      score += 8;
      reasons.push("realized profits are not dominated by one closed position");
    } else if (metrics.pnlConcentration < 0.6) {
      score += 3;
      warnings.push("realized profit concentration is in the watch range");
    } else if (metrics.pnlConcentration > 0.7) {
      hardRejects.push("realized profits are too concentrated in one closed position");
    } else {
      warnings.push("realized profits are concentrated");
    }
  }

  if (metrics.closedPositionWinRate != null) {
    if (metrics.closedPositionWinRate >= 0.45) {
      score += 6;
      reasons.push("closed-position win rate is at least 45%");
    } else {
      warnings.push("closed-position win rate is below 45%");
    }
  }

  if (metrics.currentUnrealizedDrawdownPct < 0.2) {
    score += 5;
    reasons.push("current unrealized drawdown is below 20% of exposure");
  } else {
    warnings.push("current unrealized drawdown is high relative to exposure");
  }

  let rating: Rating = "Reject";
  if (
    score >= 90 &&
    metrics.accountAgeDays != null &&
    metrics.accountAgeDays >= 30 &&
    metrics.openPositions >= 3 &&
    metrics.openPositions <= 10 &&
    metrics.currentValue >= 500 &&
    metrics.currentValue <= 10_000 &&
    metrics.maxPositionShare < 0.35 &&
    metrics.realizedMaxDrawdownPct != null &&
    metrics.realizedMaxDrawdownPct < 0.25 &&
    metrics.profitableWeeksRatio != null &&
    metrics.profitableWeeksRatio >= 0.5 &&
    metrics.pnlConcentration != null &&
    metrics.pnlConcentration < 0.4 &&
    metrics.closedPositionWinRate != null &&
    metrics.closedPositionWinRate >= 0.45 &&
    metrics.currentUnrealizedDrawdownPct < 0.2 &&
    metrics.recentTrades > 0
  ) {
    rating = "Recommended";
  } else if (
    score >= 55 &&
    metrics.accountAgeDays != null &&
    metrics.accountAgeDays >= 14 &&
    metrics.openPositions > 0 &&
    metrics.openPositions <= 20 &&
    metrics.currentValue >= 100 &&
    metrics.maxPositionShare <= 0.5 &&
    (metrics.realizedMaxDrawdownPct == null || metrics.realizedMaxDrawdownPct < 0.4) &&
    (metrics.profitableWeeksRatio == null || metrics.profitableWeeksRatio >= 0.35) &&
    (metrics.pnlConcentration == null || metrics.pnlConcentration < 0.6) &&
    metrics.recentTrades > 0
  ) {
    rating = "Watch";
  }

  if (hardRejects.length > 0) {
    rating = "Reject";
    warnings.push(...hardRejects);
  }

  return { rating, score, reasons, warnings };
}

async function analyzeCandidate(trader: LeaderboardTrader): Promise<CandidateReport> {
  const address = trader.proxyWallet;
  try {
    const [positions, trades] = await Promise.all([
      getPositions(DATA_API_URL, {
        user: address,
        limit: 500,
        sizeThreshold: 0,
        sortBy: "CURRENT",
        sortDirection: "DESC",
      }),
      getTrades(DATA_API_URL, {
        user: address,
        limit: RECENT_TRADE_LIMIT,
      }),
    ]);
    const [closedPositions, oldestActivity] = await Promise.all([
      getClosedPositions(DATA_API_URL, {
        user: address,
        limit: CLOSED_POSITION_LIMIT,
        sortBy: "TIMESTAMP",
        sortDirection: "ASC",
      }),
      getActivity(DATA_API_URL, {
        user: address,
        limit: 1,
        offset: 0,
        sortBy: "TIMESTAMP",
        sortDirection: "ASC",
      }),
    ]);

    const values = positions.map((p) => asNumber(p.currentValue)).filter((v) => v > 0);
    const currentValue = values.reduce((sum, value) => sum + value, 0);
    const maxPositionValue = values.length > 0 ? Math.max(...values) : 0;
    const smallPositions = values.filter((value) => value < 5).length;
    const unrealizedLoss = positions
      .map((p) => asNumber(p.cashPnl))
      .filter((pnl) => pnl < 0)
      .reduce((sum, pnl) => sum + Math.abs(pnl), 0);
    const notionals = trades.map(tradeNotional).filter((value) => value > 0);
    const activeDays = tradeActiveDays(trades);
    const avgTradeNotional =
      notionals.length > 0 ? notionals.reduce((sum, value) => sum + value, 0) / notionals.length : 0;

    const metrics = {
      accountAgeDays: accountAgeDays(oldestActivity[0]?.timestamp ?? null),
      openPositions: positions.length,
      currentValue,
      avgPositionValue: positions.length > 0 ? currentValue / positions.length : 0,
      maxPositionShare: currentValue > 0 ? maxPositionValue / currentValue : 0,
      smallPositionShare: positions.length > 0 ? smallPositions / positions.length : 0,
      currentUnrealizedDrawdownPct: currentValue > 0 ? unrealizedLoss / currentValue : 0,
      recentTrades: trades.length,
      activeDays,
      tradesPerDay: activeDays > 0 ? trades.length / activeDays : 0,
      avgTradeNotional,
      realizedMaxDrawdownPct: realizedMaxDrawdownPct(closedPositions),
      profitableWeeksRatio: profitableWeeksRatio(closedPositions),
      pnlConcentration: pnlConcentration(closedPositions),
      closedPositionWinRate: closedPositionWinRate(closedPositions),
      avgWinLossRatio: avgWinLossRatio(closedPositions),
      suggestedMultiplier: suggestedMultiplier(avgTradeNotional),
    };
    const scored = scoreCandidate(metrics);

    return {
      trader,
      address,
      positions,
      trades,
      closedPositions,
      metrics,
      ...scored,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      trader,
      address,
      rating: "Reject",
      score: 0,
      positions: [],
      trades: [],
      closedPositions: [],
      metrics: {
        accountAgeDays: null,
        openPositions: 0,
        currentValue: 0,
        avgPositionValue: 0,
        maxPositionShare: 0,
        smallPositionShare: 0,
        currentUnrealizedDrawdownPct: 0,
        recentTrades: 0,
        activeDays: 0,
        tradesPerDay: 0,
        avgTradeNotional: 0,
        realizedMaxDrawdownPct: null,
        profitableWeeksRatio: null,
        pnlConcentration: null,
        closedPositionWinRate: null,
        avgWinLossRatio: null,
        suggestedMultiplier: null,
      },
      reasons: [],
      warnings: ["failed to fetch candidate data"],
      error: message,
    };
  }
}

function ratingRank(rating: Rating): number {
  if (rating === "Recommended") return 0;
  if (rating === "Watch") return 1;
  return 2;
}

function renderSummaryTable(reports: CandidateReport[]): string {
  const lines = [
    "| Rating | Score | Trader | Address | Age Days | Open | Current Value | Max Share | Realized MDD | Profitable Weeks | PnL Concentration | Closed Win Rate | Current DD | Trades/Day | Avg Trade | Suggested Multiplier |",
    "| --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const report of reports) {
    const m = report.metrics;
    lines.push(
      [
        report.rating,
        String(report.score),
        markdownEscape(displayName(report.trader)),
        `\`${report.address}\``,
        m.accountAgeDays == null ? "n/a" : String(m.accountAgeDays),
        String(m.openPositions),
        fmtUsd(m.currentValue),
        fmtPct(m.maxPositionShare),
        fmtNullablePct(m.realizedMaxDrawdownPct),
        fmtNullablePct(m.profitableWeeksRatio),
        fmtNullablePct(m.pnlConcentration),
        fmtNullablePct(m.closedPositionWinRate),
        fmtPct(m.currentUnrealizedDrawdownPct),
        fmtNum(m.tradesPerDay),
        fmtUsd(m.avgTradeNotional),
        m.suggestedMultiplier == null ? "n/a" : String(m.suggestedMultiplier),
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |")
    );
  }
  return lines.join("\n");
}

function renderCandidate(report: CandidateReport): string {
  const m = report.metrics;
  const parts = [
    `### ${markdownEscape(displayName(report.trader))}`,
    "",
    `- Rating: **${report.rating}** (${report.score}/100)`,
    `- Address: \`${report.address}\``,
    `- Leaderboard rank: ${report.trader.rank ?? "n/a"}, PnL: ${fmtUsd(asNumber(report.trader.pnl))}, Volume: ${fmtUsd(asNumber(report.trader.vol))}`,
    `- Account age: ${m.accountAgeDays == null ? "n/a" : `${m.accountAgeDays} days`}`,
    `- Current open positions: ${m.openPositions}, current value: ${fmtUsd(m.currentValue)}, max position share: ${fmtPct(m.maxPositionShare)}`,
    `- Recent trades: ${m.recentTrades}, trades/day: ${fmtNum(m.tradesPerDay)}, avg trade notional: ${fmtUsd(m.avgTradeNotional)}`,
    `- Stability: realized MDD ${fmtNullablePct(m.realizedMaxDrawdownPct)}, profitable weeks ${fmtNullablePct(m.profitableWeeksRatio)}, PnL concentration ${fmtNullablePct(m.pnlConcentration)}, closed win rate ${fmtNullablePct(m.closedPositionWinRate)}, avg win/loss ${fmtNullableNum(m.avgWinLossRatio)}`,
    `- Current unrealized drawdown: ${fmtPct(m.currentUnrealizedDrawdownPct)}`,
  ];

  if (report.reasons.length > 0) {
    parts.push("", "**Why it passed**");
    parts.push(...report.reasons.map((reason) => `- ${reason}`));
  }

  if (report.warnings.length > 0 || report.error) {
    parts.push("", "**Warnings**");
    parts.push(...report.warnings.map((warning) => `- ${warning}`));
    if (report.error) parts.push(`- Error: ${report.error}`);
  }

  parts.push(
    "",
    "**Suggested test settings**",
    "",
    "```env",
    `COPY_TARGET_USER=${report.address}`,
    `COPY_SIZE_MULTIPLIER=${report.metrics.suggestedMultiplier ?? 0.001}`,
    `COPY_MAX_ORDER_USD=${MAX_ORDER_USD}`,
    "COPY_TRADES_ONLY=true",
    "```"
  );

  return parts.join("\n");
}

function renderReport(reports: CandidateReport[]): string {
  const now = new Date().toISOString();
  const counts = reports.reduce(
    (acc, report) => {
      acc[report.rating] += 1;
      return acc;
    },
    { Recommended: 0, Watch: 0, Reject: 0 } as Record<Rating, number>
  );

  return [
    "# Copytrade Candidate Screen",
    "",
    `Generated: ${now}`,
    "",
    `Source: Polymarket official leaderboards, category \`OVERALL\`, sources \`${LEADERBOARD_SOURCES.map((s) => `${s.timePeriod}+${s.orderBy}`).join(", ")}\`, candidate limit \`${CANDIDATE_LIMIT}\`.`,
    "",
    `Account model: ${ACCOUNT_SIZE_USD} USDC test account with a ${MAX_ORDER_USD} USDC per-order cap.`,
    "",
    `Results: ${counts.Recommended} recommended, ${counts.Watch} watch, ${counts.Reject} rejected.`,
    "",
    "## Summary",
    "",
    renderSummaryTable(reports),
    "",
    "## Candidate Notes",
    "",
    ...reports.map(renderCandidate),
    "",
  ].join("\n");
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onProgress?: (completed: number, total: number) => void
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let completed = 0;

  async function runWorker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]!, index);
      completed++;
      onProgress?.(completed, items.length);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

async function main(): Promise<void> {
  console.log(`Fetching up to ${CANDIDATE_LIMIT} Polymarket leaderboard candidates...`);
  const unique = new Map<string, LeaderboardTrader>();
  let sourceIndex = 0;
  while (unique.size < CANDIDATE_LIMIT) {
    const source = LEADERBOARD_SOURCES[sourceIndex % LEADERBOARD_SOURCES.length]!;
    const cycle = Math.floor(sourceIndex / LEADERBOARD_SOURCES.length);
    const offset = cycle * LEADERBOARD_PAGE_LIMIT;
    const page = await getLeaderboard(DATA_API_URL, {
      category: "OVERALL",
      timePeriod: source.timePeriod,
      orderBy: source.orderBy,
      limit: Math.min(LEADERBOARD_PAGE_LIMIT, CANDIDATE_LIMIT - unique.size),
      offset,
    });
    for (const trader of page) {
      if (trader.proxyWallet && !unique.has(trader.proxyWallet.toLowerCase())) {
        unique.set(trader.proxyWallet.toLowerCase(), trader);
      }
    }
    console.log(`Fetched ${unique.size} unique candidates after ${source.timePeriod}+${source.orderBy} offset ${offset}...`);
    sourceIndex++;
    if (page.length === 0 && cycle > 20) break;
    if (sourceIndex > 1_000) break;
  }

  const traders = [...unique.values()];
  console.log(`Screening ${traders.length} candidates with concurrency ${SCREEN_CONCURRENCY}...`);
  const reports = await mapConcurrent(
    traders,
    SCREEN_CONCURRENCY,
    (trader) => analyzeCandidate(trader),
    (completed, total) => {
      if (completed === total || completed % 50 === 0) console.log(`Screened ${completed}/${total} candidates...`);
    }
  );

  reports.sort((a, b) => ratingRank(a.rating) - ratingRank(b.rating) || b.score - a.score);

  await mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, renderReport(reports), "utf8");

  console.log(`Wrote ${REPORT_PATH}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  if (e instanceof Error && e.message === "fetch failed") {
    console.error(
      "Network hint: if you use a terminal proxy, run `npm.cmd run screen:candidates:proxy` on Node 24+, " +
        "or set HTTPS_PROXY/HTTP_PROXY for your shell."
    );
  }
  process.exitCode = 1;
});
