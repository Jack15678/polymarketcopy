#!/usr/bin/env node
/**
 * Safe order diagnostics: fetch market config and build a signed order without posting it.
 *
 * Usage:
 *   npm run test:order -- <tokenId> <BUY|SELL> <price> <size>
 *
 * Optional live server check:
 *   npm run test:order -- <tokenId> <BUY|SELL> <price> <size> --post-only --yes
 */
import "dotenv/config";
import { Chain, ClobClient, OrderType, Side } from "@polymarket/clob-client-v2";
import { Wallet } from "@ethersproject/wallet";
import { config } from "../src/config/index.js";
import { getClobClient } from "../src/services/clob.js";

function usage(): never {
  console.error("Usage: npm run test:order -- <tokenId> <BUY|SELL> <price> <size>");
  console.error("Live check: npm run test:order -- <tokenId> <BUY|SELL> <price> <size> --post-only --yes");
  console.error("Example: npm run test:order -- 20638327060642323967326862812034626082420440526162189149548584934232772624153 BUY 0.50 5");
  process.exit(1);
}

function shortAddress(address: string): string {
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

const args = process.argv.slice(2);
const [tokenId, rawSide, rawPrice, rawSize] = args;
if (!tokenId || !rawSide || !rawPrice || !rawSize) usage();

const shouldPostOnly = args.includes("--post-only");
const confirmed = args.includes("--yes");
if (shouldPostOnly && !confirmed) {
  console.error("Refusing to post without --yes. This mode sends a real post-only order, then tries to cancel it.");
  usage();
}

const side = rawSide.toUpperCase();
if (side !== "BUY" && side !== "SELL") usage();

const price = Number(rawPrice);
const size = Number(rawSize);
if (!Number.isFinite(price) || price <= 0 || price >= 1) usage();
if (!Number.isFinite(size) || size <= 0) usage();

if (!config.privateKey || !/^0x[a-fA-F0-9]{64}$/.test(config.privateKey)) {
  console.error("POLYMARKET_PRIVATE_KEY is missing or invalid.");
  process.exit(1);
}
if (!config.funderAddress || !/^0x[a-fA-F0-9]{40}$/.test(config.funderAddress)) {
  console.error("POLYMARKET_ADDRESS or POLYMARKET_FUNDER_ADDRESS is missing or invalid.");
  process.exit(1);
}

const wallet = new Wallet(config.privateKey);
const readOnly = new ClobClient({ host: config.clobUrl, chain: config.chainId as Chain });
console.log("CLOB URL:", config.clobUrl);
console.log("Chain:", config.chainId);
console.log("EOA:", shortAddress(wallet.address));
console.log("Funder:", shortAddress(config.funderAddress));
console.log("Signature type:", config.signatureType);
console.log("Token:", tokenId);
console.log("Requested:", side, size, "@", price);
console.log("Live post-only check:", shouldPostOnly ? "YES" : "no");
console.log("---");

try {
  const book = await readOnly.getOrderBook(tokenId);
  console.log("Orderbook tick_size:", book.tick_size);
  console.log("Orderbook min_order_size:", book.min_order_size);
  console.log("Orderbook neg_risk:", "neg_risk" in book ? String(book.neg_risk) : "<missing>");
  console.log("Orderbook bids/asks:", book.bids?.length ?? 0, "/", book.asks?.length ?? 0);
} catch (e) {
  console.error("Failed to fetch orderbook:", e instanceof Error ? e.message : e);
  process.exit(1);
}

try {
  const signerClient = await getClobClient();
  const clobVersion = await signerClient.getVersion();
  console.log("CLOB order version:", clobVersion);
  const tickSize = await signerClient.getTickSize(tokenId);
  const negRisk = await signerClient.getNegRisk(tokenId);
  console.log("SDK tickSize:", tickSize);
  console.log("SDK negRisk:", negRisk);

  const signedOrder = await signerClient.createOrder(
    {
      tokenID: tokenId,
      price,
      size,
      side: side === "BUY" ? Side.BUY : Side.SELL,
    },
    { tickSize }
  );

  console.log("---");
  console.log("Signed order created locally: OK");
  console.log("Signed order side:", signedOrder.side);
  console.log("Signed order maker:", shortAddress(signedOrder.maker));
  console.log("Signed order signer:", shortAddress(signedOrder.signer));
  console.log("Signed order signature:", `${signedOrder.signature.slice(0, 10)}...`);
  if (!shouldPostOnly) {
    console.log("Not posted to CLOB.");
    process.exit(0);
  }

  console.log("---");
  console.log("Posting post-only GTC order to CLOB...");
  const postResult = await signerClient.postOrder(signedOrder, OrderType.GTC, true, false);
  console.log("Post result:", JSON.stringify(postResult, null, 2));

  const orderID =
    (postResult as { orderID?: string; id?: string; orderId?: string }).orderID ??
    (postResult as { orderID?: string; id?: string; orderId?: string }).id ??
    (postResult as { orderID?: string; id?: string; orderId?: string }).orderId;

  if (orderID) {
    try {
      console.log("Cancelling order:", orderID);
      const cancelResult = await signerClient.cancelOrder({ orderID });
      console.log("Cancel result:", JSON.stringify(cancelResult, null, 2));
    } catch (cancelError) {
      console.error("Cancel failed; cancel manually in Polymarket if the order is still open.");
      console.error(cancelError instanceof Error ? cancelError.message : cancelError);
      process.exit(1);
    }
  } else {
    console.log("No order id returned; check result above.");
  }
} catch (e) {
  console.error("Order diagnostic failed:", e instanceof Error ? e.message : e);
  process.exit(1);
}
