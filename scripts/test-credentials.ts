#!/usr/bin/env node
/**
 * Quick test: verify private key + address + auto-derive API key works.
 * Usage: node scripts/test-credentials.ts
 * (needs .env populated)
 */
import "dotenv/config";
import { Wallet } from "@ethersproject/wallet";
import { Chain, ClobClient } from "@polymarket/clob-client-v2";

const pk = process.env.POLYMARKET_PRIVATE_KEY?.trim();
const address = process.env.POLYMARKET_ADDRESS?.trim() || process.env.POLYMARKET_FUNDER_ADDRESS?.trim();
const clobUrl = process.env.POLYMARKET_CLOB_URL || "https://clob.polymarket.com";
const chainId = parseInt(process.env.POLYMARKET_CHAIN_ID || "137", 10);
const signatureType = parseInt(process.env.POLYMARKET_SIGNATURE_TYPE || "0", 10);
const allowCustomEndpoints = process.env.POLYMARKET_ALLOW_CUSTOM_ENDPOINTS === "true";

const allowedEndpoints = new Set([
  "https://data-api.polymarket.com",
  "https://clob.polymarket.com",
]);
if (!allowCustomEndpoints && !allowedEndpoints.has(clobUrl)) {
  console.error("❌ Custom CLOB endpoint not allowed. Set POLYMARKET_ALLOW_CUSTOM_ENDPOINTS=true or use default.");
  process.exit(1);
}

if (!pk) { console.error("❌ POLYMARKET_PRIVATE_KEY not set"); process.exit(1); }
if (!address) { console.error("❌ POLYMARKET_ADDRESS not set"); process.exit(1); }

const normalized = pk.startsWith("0x") ? pk : "0x" + pk;
if (!/^0x[a-fA-F0-9]{64}$/.test(normalized)) {
  console.error("❌ Invalid private key format (need 64 hex chars)");
  process.exit(1);
}

const wallet = new Wallet(normalized);
const eoa = wallet.address.toLowerCase();
const addr = address.toLowerCase();

console.log("EOA from PK:", eoa);
console.log("ADDRESS:", addr);
console.log("Match:", eoa === addr ? "✅" : "⚠️  MISMATCH");
console.log("Signature type:", signatureType, signatureType === 0 ? "(EOA)" : "(PROXY)");

async function test(sigType: number) {
  console.log(`\n[SignatureType=${sigType}] Trying to derive API key...`);
  const authOnly = new ClobClient({
    host: clobUrl,
    chain: chainId as Chain,
    signer: wallet,
    signatureType: sigType,
    throwOnError: true,
  });
  try {
    const creds = await authOnly.deriveApiKey();
    if (creds.key && creds.secret && creds.passphrase) {
      console.log("✅ API key derived successfully!");
      console.log("Key:", creds.key.slice(0, 8) + "...");
      return creds;
    } else {
      console.log("⚠️  Incomplete credentials:", creds);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = (e as { status?: number }).status;
    console.log("❌ deriveApiKey failed:", msg, status ? `[HTTP ${status}]` : "");
    return null;
  }

  // Try create if derive failed
  console.log("  Trying createApiKey...");
  const authOnly2 = new ClobClient({
    host: clobUrl,
    chain: chainId as Chain,
    signer: wallet,
    signatureType: sigType,
    throwOnError: true,
  });
  try {
    const creds2 = await authOnly2.createApiKey();
    if (creds2.key && creds2.secret && creds2.passphrase) {
      console.log("✅ API key created successfully!");
      console.log("Key:", creds2.key.slice(0, 8) + "...");
      return creds2;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = (e as { status?: number }).status;
    console.log("❌ createApiKey failed:", msg, status ? `[HTTP ${status}]` : "");
  }
  return null;
}

async function main() {
  let creds = await test(signatureType);
  if (!creds && signatureType === 0) {
    console.log("\n--- Trying SIGNATURE_TYPE=1 (Proxy wallet) ---");
    creds = await test(1);
    if (creds) {
      console.log("\n💡 Success with type=1. Add to your .env:");
      console.log("   POLYMARKET_SIGNATURE_TYPE=1");
    }
  }
  if (!creds) {
    console.error("\n❌ Could not derive/create API key.");
    console.error("Possible causes:");
    console.error("  1. Wallet has no prior CLOB activity (need to trade once on Polymarket first)");
    console.error("  2. Wrong private key");
    console.error("  3. Wrong POLYMARKET_ADDRESS");
  }
}

main();
