import hre from "hardhat";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

dotenv.config();

const DEFAULT_OUTPUT_PATH = path.resolve("frontend", "rank-addresses.json");
const BUY_TICKET_SELECTOR = hre.ethers.id("buyTicket(uint16)").slice(0, 10);
const DEFAULT_DEPLOY_FROM_BLOCK = process.env.RANK_DEFAULT_FROM_BLOCK ? Number(process.env.RANK_DEFAULT_FROM_BLOCK) : null;
const CHUNK_SIZE = Number(process.env.RANK_SCAN_CHUNK_SIZE || 50);
const POLL_INTERVAL_MS = Number(process.env.RANK_POLL_INTERVAL_MS || 15000);

function toChecksum(address) {
  return hre.ethers.getAddress(address);
}

function loadExisting(outputPath) {
  if (!fs.existsSync(outputPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(outputPath, "utf8"));
  } catch {
    return null;
  }
}

function saveOutput(outputPath, data) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), "utf8");
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("Starting rank address collection...");

  const { chainId, name } = await hre.ethers.provider.getNetwork();
  if (chainId !== 56n) {
    throw new Error(`Wrong network: ${name} (${chainId}). Please use --network bsc`);
  }

  const provider = hre.ethers.provider;
  const vaultAddressRaw = process.env.VAULT_ADDRESS;
  if (!vaultAddressRaw) {
    throw new Error("Missing VAULT_ADDRESS in .env");
  }
  const vaultAddress = toChecksum(vaultAddressRaw);
  const outputPath = process.env.RANK_OUTPUT_PATH
    ? path.resolve(process.env.RANK_OUTPUT_PATH)
    : DEFAULT_OUTPUT_PATH;

  const envFromBlock = process.env.RANK_SCAN_FROM_BLOCK
    ? Number(process.env.RANK_SCAN_FROM_BLOCK)
    : null;

  console.log(`Network:        ${name} (${chainId})`);
  console.log(`Vault:          ${vaultAddress}`);
  console.log(`Output:         ${outputPath}`);
  console.log(`Selector:       ${BUY_TICKET_SELECTOR}`);
  console.log(`Poll interval:  ${POLL_INTERVAL_MS} ms`);

  while (true) {
    const latestBlock = await provider.getBlockNumber();
    const existing = loadExisting(outputPath);

    let fromBlock;
    if (
      existing &&
      existing.vaultAddress &&
      existing.vaultAddress.toLowerCase() === vaultAddress.toLowerCase() &&
      Number.isInteger(existing.lastScannedBlock)
    ) {
      fromBlock = existing.lastScannedBlock + 1;
    } else if (Number.isInteger(envFromBlock)) {
      fromBlock = envFromBlock;
    } else {
      fromBlock = DEFAULT_DEPLOY_FROM_BLOCK !== null ? Math.max(DEFAULT_DEPLOY_FROM_BLOCK, 0) : latestBlock;
      console.log(`[warn] First run without RANK_SCAN_FROM_BLOCK, defaulting to: ${fromBlock} -> ${latestBlock}`);
    }

    const playersMap = new Map();
    if (
      existing &&
      Array.isArray(existing.players) &&
      existing.vaultAddress &&
      existing.vaultAddress.toLowerCase() === vaultAddress.toLowerCase()
    ) {
      for (const item of existing.players) {
        if (!item?.address) continue;
        playersMap.set(toChecksum(item.address), {
          address: toChecksum(item.address),
          firstSeenBlock: Number(item.firstSeenBlock || 0),
          lastSeenBlock: Number(item.lastSeenBlock || 0),
          txCount: Number(item.txCount || 0),
        });
      }
    }

    if (fromBlock > latestBlock) {
      console.log(`[idle] no new blocks, latest=${latestBlock}`);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    console.log(`Scan blocks:    ${fromBlock} -> ${latestBlock}`);

    for (let start = fromBlock; start <= latestBlock; start += CHUNK_SIZE) {
    const end = Math.min(start + CHUNK_SIZE - 1, latestBlock);
    console.log(`[scan] blocks ${start} -> ${end}`);

    const blockPromises = [];
    for (let blockNumber = start; blockNumber <= end; blockNumber++) {
      blockPromises.push(provider.getBlock(blockNumber, true));
    }

    const blocks = await Promise.all(blockPromises);
    const candidates = [];

    for (const block of blocks) {
      if (!block) continue;

      const txs = block.prefetchedTransactions ?? block.transactions ?? [];
      for (const tx of txs) {
        if (!tx || typeof tx === "string") continue;

        if (!tx.to) continue;
        if (tx.to.toLowerCase() !== vaultAddress.toLowerCase()) continue;
        if (!tx.data || tx.data.slice(0, 10) !== BUY_TICKET_SELECTOR) continue;

        candidates.push({
          hash: tx.hash,
          from: tx.from,
          blockNumber: Number(tx.blockNumber ?? block.number),
        });
      }
    }

    if (!candidates.length) {
      continue;
    }

    const receipts = await Promise.all(
      candidates.map((item) => provider.getTransactionReceipt(item.hash))
    );

    for (let i = 0; i < candidates.length; i++) {
      const receipt = receipts[i];
      const item = candidates[i];

      if (!receipt) continue;
      if (receipt.status !== 1 && receipt.status !== 1n) continue;

      const address = toChecksum(item.from);
      const existingPlayer = playersMap.get(address);

      if (!existingPlayer) {
        playersMap.set(address, {
          address,
          firstSeenBlock: item.blockNumber,
          lastSeenBlock: item.blockNumber,
          txCount: 1,
        });
      } else {
        existingPlayer.firstSeenBlock = Math.min(existingPlayer.firstSeenBlock, item.blockNumber);
        existingPlayer.lastSeenBlock = Math.max(existingPlayer.lastSeenBlock, item.blockNumber);
        existingPlayer.txCount += 1;
      }
    }
  }

    const players = [...playersMap.values()].sort((a, b) => {
      if (a.firstSeenBlock !== b.firstSeenBlock) {
        return a.firstSeenBlock - b.firstSeenBlock;
      }
      return a.address.localeCompare(b.address);
    });

    const output = {
      version: 1,
      network: name,
      chainId: Number(chainId),
      vaultAddress,
      updatedAt: new Date().toISOString(),
      lastScannedBlock: latestBlock,
      buyTicketSelector: BUY_TICKET_SELECTOR,
      addressCount: players.length,
      addresses: players.map((item) => item.address),
      players,
    };

    saveOutput(outputPath, output);
    console.log(`Collected players: ${players.length}`);
    console.log(`Saved to: ${outputPath}`);
    await sleep(POLL_INTERVAL_MS);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});