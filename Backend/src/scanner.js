import { ethers } from "ethers";
import { buyTicketSelector } from "./chain.js";

function normalizeAddress(addr) {
  return ethers.getAddress(addr);
}

async function getSafeLatestBlock(provider, confirmations) {
  return await withRetry(async () => {
    const latest = await provider.getBlockNumber();
    return Math.max(latest - Math.max(confirmations, 0), 0);
  });
}

async function withRetry(fn, maxRetries = 3, delayMs = 2000) {
  let lastErr;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = e?.message || String(e);
      if (msg.includes("ECONNRESET") || msg.includes("ETIMEDOUT") || msg.includes("TIMEOUT") || msg.includes("TLS") || msg.includes("quorum not met") || msg.includes("limit exceeded") || msg.includes("could not coalesce error")) {
        console.log(`[scanner] 网络波动 (${msg}), 正在进行第 ${i + 1} 次重试...`);
        await new Promise(r => setTimeout(r, delayMs * (i + 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

export function createScanner({ provider, vaultAddress, db, config }) {
  const address = normalizeAddress(vaultAddress);
  const stateKey = `scanner:lastBlock:${address.toLowerCase()}`;
  
  const VAULT_INTERFACE = new ethers.Interface([
    "event TicketBought(uint256 indexed roundId, address indexed player, uint16 number)",
    "event HolderReliefTriggered(uint256 indexed epochId, uint256 poolAmount, uint256 snapshotBlock)",
    "event Transfer(address indexed from, address indexed to, uint256 value)"
  ]);

  async function updateHolderBalance(addr, prov) {
    if (addr === ethers.ZeroAddress) return;
    try {
      const taxTokenAddr = db.getState("taxTokenAddress");
      if (!taxTokenAddr || taxTokenAddr === ethers.ZeroAddress) return;
      const token = new ethers.Contract(taxTokenAddr, ["function balanceOf(address) view returns (uint256)"], prov);
      const bal = await token.balanceOf(addr);
      const latestBlock = await prov.getBlockNumber();
      db.updateTokenHolder(addr, bal.toString(), latestBlock);
    } catch (e) {}
  }

  async function scanRange(fromBlock, toBlock) {
    if (toBlock < fromBlock) return { scannedTo: toBlock, found: 0 };
    let found = 0;
    const CHUNK_SIZE = Math.max(10, Number(config.scanChunkSize || 40));

    for (let start = fromBlock; start <= toBlock; start += CHUNK_SIZE) {
      const end = Math.min(start + CHUNK_SIZE - 1, toBlock);
      console.log(`[scanner] fetching logs ${start} -> ${end}`);

      const tokenAddress = db.getState("taxTokenAddress");
      const logGroups = await withRetry(async () => {
        const requests = [
          provider.getLogs({ address, fromBlock: start, toBlock: end })
        ];
        if (tokenAddress && tokenAddress !== ethers.ZeroAddress) {
          requests.push(provider.getLogs({ address: tokenAddress, fromBlock: start, toBlock: end }));
        }
        return await Promise.all(requests);
      });
      const logs = logGroups.flat().sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);

      for (const log of logs) {
        try {
          const parsed = VAULT_INTERFACE.parseLog(log);
          if (!parsed) continue;

          if (parsed.name === "TicketBought") {
            const { roundId, player, number } = parsed.args;
            const addr = normalizeAddress(player);
            db.upsertPlayer(addr, log.blockNumber);
            db.addLiveFeedItem({
              id: `buy-${log.transactionHash}-${log.index}`,
              type: "buy",
              title: "发起进攻",
              content: `${addr.slice(0, 6)}...${addr.slice(-4)} 选择路线 ${String(number).padStart(3, "0")}`,
              createdAtMs: Date.now()
            });
            found++;
          } else if (parsed.name === "Transfer") {
            const { from, to, value } = parsed.args;
            // 实实在在的持币者追踪：更新双方余额
            await updateHolderBalance(normalizeAddress(from), provider);
            await updateHolderBalance(normalizeAddress(to), provider);
          } else if (parsed.name === "HolderReliefTriggered") {
            const { epochId, poolAmount, snapshotBlock } = parsed.args;
            db.setReliefEpoch({
              epochId: Number(epochId),
              poolAmountWei: poolAmount.toString(),
              snapshotBlock: Number(snapshotBlock),
              triggeredAtMs: Date.now(),
              merkleRoot: "",
              claimDeadlineMs: Date.now() + 7 * 86400 * 1000
            });
            console.log(`[scanner] 触发持币保底分配轮 Epoch ${epochId}`);
          }
        } catch (e) {
          // 忽略无法解析的 log
        }
      }
    }

    return { scannedTo: toBlock, found };
  }

  async function scanLogsInRange(fromBlock, toBlock) {
    // 扫描 Transfer 和 HolderReliefTriggered 日志
    const logs = await withRetry(async () => {
      return await provider.getLogs({
        fromBlock,
        toBlock,
        topics: [[
          ethers.id("Transfer(address,address,uint256)"),
          ethers.id("HolderReliefTriggered(uint256,uint256,uint256)")
        ]]
      });
    });

    for (const log of logs) {
      if (log.topics[0] === ethers.id("Transfer(address,address,uint256)")) {
        const from = normalizeAddress(ethers.dataSlice(log.topics[1], 12));
        const to = normalizeAddress(ethers.dataSlice(log.topics[2], 12));
        // 更新 Transfer 双方的余额快照
        // 这里只是标记地址，实际余额可以在结算时拉取，或者实时拉取
        db.registerPlayer(from);
        db.registerPlayer(to);
      } else if (log.topics[0] === ethers.id("HolderReliefTriggered(uint256,uint256,uint256)")) {
        if (normalizeAddress(log.address) !== address) continue;
        const epochId = Number(log.topics[1]);
        const data = ethers.AbiCoder.defaultAbiCoder().decode(["uint256", "uint256"], log.data);
        const poolAmountWei = data[0].toString();
        const snapshotBlock = Number(data[1]);
        
        db.setReliefEpoch({
          epochId,
          poolAmountWei,
          snapshotBlock,
          triggeredAtMs: Date.now(),
          merkleRoot: "",
          claimDeadlineMs: Date.now() + 7 * 86400 * 1000
        });
        console.log(`[scanner] 触发持币保底分配轮 Epoch ${epochId}, 金额: ${ethers.formatEther(poolAmountWei)} BNB`);
      }
    }
  }

  async function scanOnce() {
    const safeLatest = await getSafeLatestBlock(provider, config.scanConfirmations);

    const rawLast = db.getState(stateKey);
    const lastScanned = rawLast ? Number(rawLast) : null;

    const fromBlock =
      lastScanned !== null
        ? lastScanned + 1
        : config.scanLatestOnly
          ? safeLatest
          : config.scanStartBlock !== null
            ? config.scanStartBlock
            : safeLatest;

    if (fromBlock > safeLatest) {
      return { fromBlock, toBlock: safeLatest, found: 0, scannedTo: lastScanned ?? safeLatest };
    }

    const { scannedTo, found } = await scanRange(fromBlock, safeLatest);
    db.setState(stateKey, scannedTo);
    db.save();
    return { fromBlock, toBlock: safeLatest, found, scannedTo };
  }

  return { scanOnce };
}

