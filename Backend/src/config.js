import dotenv from "dotenv";

dotenv.config();

function mustEnv(key) {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env: ${key}`);
  return v;
}

function optionalEnv(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (value) return value;
  }
  return null;
}

function parseRpcUrls() {
  const raw = optionalEnv("BSC_RPC_URLS", "BSC_RPC_URL", "BSC_TESTNET_RPC_URLS", "BSC_TESTNET_RPC_URL");
  if (!raw) throw new Error("Missing env: BSC_RPC_URLS or BSC_RPC_URL");
  return raw.split(",").map((v) => v.trim()).filter(Boolean);
}

const rpcUrls = parseRpcUrls();

export const config = {
  rpcUrl: rpcUrls[0],
  rpcUrls,
  vaultAddress: mustEnv("VAULT_ADDRESS"),
  port: Number(process.env.PORT || 8787),
  scanStartBlock: process.env.SCAN_START_BLOCK ? Number(process.env.SCAN_START_BLOCK) : null,
  scanLatestOnly: String(process.env.SCAN_LATEST_ONLY || "false").toLowerCase() === "true",
  scanPollIntervalMs: Number(process.env.SCAN_POLL_INTERVAL_MS || 15000),
  scanChunkSize: Number(process.env.SCAN_CHUNK_SIZE || 40),
  scanConfirmations: Number(process.env.SCAN_CONFIRMATIONS || 3),
  statsCacheTtlMs: Number(process.env.STATS_CACHE_TTL_MS || 60000),
  autoDrawEnabled: String(process.env.AUTO_DRAW_ENABLED || "true").toLowerCase() === "true",
  botPrivateKey: optionalEnv("BOT_PRIVATE_KEY", "PRIVATE_KEY"),
  drawMinBalanceBNB: process.env.DRAW_MIN_BALANCE_BNB || "0.002",
};

