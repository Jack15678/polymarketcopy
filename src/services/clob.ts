import { ApiError, Chain, ClobClient, Side, OrderType } from "@polymarket/clob-client-v2";
import { Wallet } from "@ethersproject/wallet";
import { config } from "../config/index.js";

const VALID_TICK_SIZES = ["0.1", "0.01", "0.001", "0.0001"] as const;
type TickSize = (typeof VALID_TICK_SIZES)[number];

function toTickSize(s: string): TickSize {
  const v = s.trim();
  if (VALID_TICK_SIZES.includes(v as TickSize)) return v as TickSize;
  return "0.01";
}

let client: ClobClient | null = null;
let clientPromise: Promise<ClobClient> | null = null;
let readOnlyClient: ClobClient | null = null;

const ORDER_VERSION_MISMATCH = "order_version_mismatch";

function getSigner(): Wallet {
  return new Wallet(config.privateKey);
}

function getApiCreds(): { key: string; secret: string; passphrase: string } | null {
  if (config.apiKey && config.apiSecret && config.apiPassphrase)
    return { key: config.apiKey, secret: config.apiSecret, passphrase: config.apiPassphrase };
  return null;
}

function getReadOnlyClobClient(): ClobClient {
  if (!readOnlyClient) readOnlyClient = new ClobClient({ host: config.clobUrl, chain: config.chainId as Chain });
  return readOnlyClient;
}

function isFullApiCreds(c: { key?: string; secret?: string; passphrase?: string }): c is {
  key: string;
  secret: string;
  passphrase: string;
} {
  return Boolean(c.key && c.secret && c.passphrase);
}

/**
 * Polymarket CLOB: `createApiKey` often returns 400 if keys already exist; the SDK's
 * createOrDeriveApiKey only falls back when the response is empty, not when the request throws.
 * Try derive first, then create, then derive again after a failed create.
 */
async function deriveOrCreateApiKey(client: ClobClient): Promise<{
  key: string;
  secret: string;
  passphrase: string;
}> {
  const hint =
    "If this keeps failing: set POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_API_PASSPHRASE from Polymarket; " +
    "confirm POLYMARKET_CHAIN_ID=137; and if POLYMARKET_ADDRESS is your proxy (not the key's EOA), set POLYMARKET_SIGNATURE_TYPE=1.";

  try {
    const d = await client.deriveApiKey();
    if (isFullApiCreds(d)) return d;
  } catch {
    // No existing key — try create below
  }

  try {
    const c = await client.createApiKey();
    if (isFullApiCreds(c)) return c;
  } catch (e) {
    if (e instanceof ApiError) {
      try {
        const d2 = await client.deriveApiKey();
        if (isFullApiCreds(d2)) return d2;
      } catch {
        /* fall through */
      }
      throw new Error(`${e.message} (${e.status ?? "?"}) — ${hint}`);
    }
    throw e;
  }

  throw new Error(`CLOB API key derive/create returned incomplete credentials. ${hint}`);
}

export async function getClobClient(): Promise<ClobClient> {
  if (client) return client;
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const signer = getSigner();
    let creds = getApiCreds();
    if (!creds && config.autoDeriveApiKey) {
      const authOnly = new ClobClient({
        host: config.clobUrl,
        chain: config.chainId as Chain,
        signer,
        signatureType: config.signatureType,
        funderAddress: config.funderAddress,
        throwOnError: true,
      });
      creds = await deriveOrCreateApiKey(authOnly);
      console.log("Derived API key (key=%s...)", (creds!.key ?? "").slice(0, 8));
    }
    if (!creds)
      throw new Error(
        "No API creds: set POLYMARKET_API_KEY/SECRET/PASSPHRASE or POLYMARKET_AUTO_DERIVE_API_KEY=true"
      );
    client = new ClobClient({
      host: config.clobUrl,
      chain: config.chainId as Chain,
      signer,
      creds,
      signatureType: config.signatureType,
      funderAddress: config.funderAddress,
      throwOnError: true,
    });
    return client;
  })();
  return clientPromise;
}

export interface OrderBookSummary {
  tick_size: string;
  bids: Array<[string, string] | { price: string; size: string }>;
  asks: Array<[string, string] | { price: string; size: string }>;
  min_order_size?: string;
  neg_risk?: boolean;
}

export async function getClobOrderVersion(): Promise<number> {
  const clob = await getClobClient();
  return clob.getVersion();
}

function resetClobClient(): void {
  client = null;
  clientPromise = null;
}

export interface OrderMarketConfig {
  tickSize: string;
  minOrderSize: number;
  negRisk?: boolean;
}

export async function getOrderBook(tokenId: string): Promise<OrderBookSummary | null> {
  const c = getReadOnlyClobClient();
  try {
    const book = await c.getOrderBook(tokenId);
    return book as unknown as OrderBookSummary;
  } catch {
    return null;
  }
}

/** Returns tick size string, or null if no orderbook (e.g. market closed/resolved). */
export async function getTickSize(tokenId: string): Promise<string | null> {
  const orderConfig = await getOrderMarketConfig(tokenId);
  return orderConfig?.tickSize ?? null;
}

/** Returns order builder config, or null if the market has no live orderbook. */
export async function getOrderMarketConfig(tokenId: string): Promise<OrderMarketConfig | null> {
  const book = await getOrderBook(tokenId);
  if (!book) return null;
  const c = getReadOnlyClobClient();
  let tickSize: TickSize = book.tick_size ? toTickSize(book.tick_size) : "0.01";
  let negRisk = book.neg_risk;
  try {
    tickSize = toTickSize(await c.getTickSize(tokenId));
  } catch {
    // Fall back to orderbook metadata when the dedicated tick-size endpoint is unavailable.
  }
  try {
    negRisk = await c.getNegRisk(tokenId);
  } catch {
    // negRisk is optional for standard markets; orderbook metadata is enough as a fallback.
  }
  return {
    tickSize,
    minOrderSize: parseFloat(book.min_order_size ?? "0.01") || 0.01,
    ...(negRisk === undefined ? {} : { negRisk }),
  };
}

export async function placeLimitOrder(
  tokenId: string,
  side: "BUY" | "SELL",
  price: number,
  size: number,
  orderConfig: OrderMarketConfig
): Promise<{ orderID?: string; error?: string }> {
  const sideEnum = side === "BUY" ? Side.BUY : Side.SELL;
  const roundedPrice = roundToTick(price, parseFloat(orderConfig.tickSize));
  const roundedSize = Math.max(orderConfig.minOrderSize, 0.01, Math.round(size * 100) / 100);

  const postOnce = async (): Promise<{ orderID?: string; error?: string }> => {
    const clob = await getClobClient();
    const res = await clob.createAndPostOrder(
      {
        tokenID: tokenId,
        price: roundedPrice,
        size: roundedSize,
        side: sideEnum,
      },
      {
        tickSize: toTickSize(orderConfig.tickSize),
        ...(orderConfig.negRisk === undefined ? {} : { negRisk: orderConfig.negRisk }),
      },
      OrderType.GTC
    );
    return { orderID: (res as { orderID?: string })?.orderID ?? (res as { id?: string })?.id };
  };

  try {
    return await postOnce();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isOrderVersionMismatch(msg)) {
      resetClobClient();
      try {
        console.warn("CLOB order version mismatch; refreshed signing client and retrying once.");
        return await postOnce();
      } catch (retryError) {
        const retryMsg = retryError instanceof Error ? retryError.message : String(retryError);
        return { error: formatOrderVersionMismatch(retryMsg) };
      }
    }
    return { error: msg };
  }
}

export async function placeMarketOrder(
  tokenId: string,
  side: "BUY" | "SELL",
  amount: number,
  orderConfig: OrderMarketConfig
): Promise<{ orderID?: string; error?: string }> {
  const clob = await getClobClient();
  const sideEnum = side === "BUY" ? Side.BUY : Side.SELL;
  const roundedAmount = Math.max(0.01, Math.round(amount * 100) / 100);

  try {
    const res = await clob.createAndPostMarketOrder(
      {
        tokenID: tokenId,
        amount: roundedAmount,
        side: sideEnum,
      },
      {
        tickSize: toTickSize(orderConfig.tickSize),
        ...(orderConfig.negRisk === undefined ? {} : { negRisk: orderConfig.negRisk }),
      }
    );
    return { orderID: (res as { orderID?: string })?.orderID ?? (res as { id?: string })?.id };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: msg };
  }
}

function roundToTick(value: number, tickSize: number): number {
  if (tickSize <= 0) return value;
  const decimals = tickSize.toString().split(".")[1]?.length ?? 0;
  const minPrice = tickSize;
  const maxPrice = 1 - tickSize;
  const bounded = Math.max(minPrice, Math.min(maxPrice, value));
  const ticks = Math.round(bounded / tickSize);
  const rounded = ticks * tickSize;
  return Number(Math.max(minPrice, Math.min(maxPrice, rounded)).toFixed(decimals));
}

function isOrderVersionMismatch(msg: string): boolean {
  return msg.includes(ORDER_VERSION_MISMATCH);
}

function formatOrderVersionMismatch(msg: string): string {
  return (
    `${msg} ` +
    "(CLOB rejected the signed order version. Confirm the server is using @polymarket/clob-client-v2, " +
    "has been rebuilt/restarted, and POLYMARKET_CLOB_URL is https://clob.polymarket.com.)"
  );
}

// Market client integration notes
