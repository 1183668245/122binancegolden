import cors from "cors";
import express from "express";
import { ethers } from "ethers";
import { config } from "./config.js";
import { createDb } from "./db.js";
import { createChain } from "./chain.js";
import { createScanner } from "./scanner.js";
import { createRankService } from "./ranks.js";
import { createHistoryService } from "./history.js";
import { createRoutes } from "./routes.js";
import { processReliefEpoch } from "./relief-processor.js";

function installProcessGuards() {
  process.on("unhandledRejection", (reason) => {
    console.error("[Fatal] Unhandled Rejection:", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[Fatal] Uncaught Exception:", err);
    if (err?.code === "ECONNRESET" || err?.code === "TIMEOUT" || String(err?.message || err).includes("TLS")) {
      console.log("[Recover] 自动忽略网络层严重错误，等待下一轮轮询...");
      return;
    }
  });
}

function normalizeAddress(addr) {
  return ethers.getAddress(addr);
}

async function main() {
  const db = await createDb();
  const vaultAddress = normalizeAddress(config.vaultAddress);
  const chain = createChain({ rpcUrl: config.rpcUrl, rpcUrls: config.rpcUrls, vaultAddress, botPrivateKey: config.botPrivateKey });

  async function syncVaultRuntimeState() {
    const [taxToken, roundId] = await Promise.all([
      chain.vault.taxToken(),
      chain.vault.currentRoundId(),
    ]);
    const round = await chain.vault.rounds(roundId);
    const started = taxToken !== ethers.ZeroAddress && Number(round?.endTime || 0) > 0;
    db.setState("taxTokenAddress", taxToken === ethers.ZeroAddress ? "" : taxToken);
    db.setState("matchStarted", started ? "1" : "0");
    db.save();
    return { taxToken, roundId, round, started };
  }

  const scanner = createScanner({
    provider: chain.provider,
    vaultAddress,
    db,
    config,
  });

  const rankService = createRankService({
    db,
    vault: chain.vault,
    config,
  });

  const historyService = createHistoryService({
    vault: chain.vault,
  });

  async function syncLiveDrawFeed() {
    const currentRoundId = Number(await chain.vault.currentRoundId());
    const stateKey = "live:lastResolvedRoundId";
    const lastResolved = Number(db.getState(stateKey) ?? Math.max(currentRoundId - 1, 0));
    if (currentRoundId <= lastResolved + 1) {
      db.setState(stateKey, Math.max(lastResolved, currentRoundId - 1));
      return;
    }
    for (let roundId = lastResolved + 1; roundId < currentRoundId; roundId++) {
      const round = await chain.vault.rounds(roundId);
      if (!round?.resolved) continue;
      db.addLiveFeedItem({
        id: `draw-${roundId}`,
        type: "draw",
        title: "终场开奖",
        content: `第 ${roundId} 期金靴号码 ${String(round.winningNumber).padStart(3, "0")}`,
        createdAtMs: Number(round.endTime) * 1000
      });
      db.setState(stateKey, roundId);
    }
    db.save();
  }

  async function tryAutoDraw() {
    if (!config.autoDrawEnabled) return;
    if (!chain.botWallet || !chain.drawVault) {
      console.log("[draw] skipped: missing BOT_PRIVATE_KEY or PRIVATE_KEY");
      return;
    }
 
    try {
      const [{ taxToken, roundId, round, started }, latestBlock, balance] = await Promise.all([
        syncVaultRuntimeState(),
        chain.provider.getBlock("latest"),
        chain.provider.getBalance(chain.botWallet.address),
      ]);

      if (!latestBlock || !started || taxToken === ethers.ZeroAddress) return;

      const endTime = Number(round.endTime);
      const resolved = Boolean(round.resolved);
      const now = Number(latestBlock.timestamp);
      const minBalance = ethers.parseEther(config.drawMinBalanceBNB);

      if (balance < minBalance) {
        console.log(`[draw] skipped: bot balance too low (${ethers.formatEther(balance)} BNB)`);
        return;
      }

      if (resolved || now < endTime) {
        return;
      }

      const fee = await chain.provider.getFeeData();
      const tx = await chain.drawVault.draw({
        maxFeePerGas: fee.maxFeePerGas ?? undefined,
        maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? undefined,
        gasLimit: 350000,
      });
      console.log(`[draw] sent: ${tx.hash} round=${roundId}`);
      const rc = await tx.wait();
      console.log(`[draw] confirmed: block=${rc.blockNumber} round=${roundId}`);
    } catch (e) {
      console.log(`[draw] error: ${e.message}`);
    }
  }

  async function tryProcessRelief() {
    // 获取未结算的保底 Epoch
    const stmt = db.db.prepare("SELECT epoch_id FROM holder_relief_epochs WHERE settled = 0");
    const pendingIds = [];
    while (stmt.step()) {
      pendingIds.push(stmt.getAsObject().epoch_id);
    }
    stmt.free();

    for (const id of pendingIds) {
      try {
        await processReliefEpoch(db, id);
      } catch (e) {
        console.error(`[Relief] Epoch ${id} 处理失败:`, e.message);
      }
    }
  }

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.use("/api", createRoutes({ rankService, historyService, config: { ...config, vaultAddress }, db }));

  app.use((err, req, res, next) => {
    const msg = err?.message || String(err);
    res.status(500).json({ ok: false, error: msg });
  });

  const server = app.listen(config.port, () => {
    console.log(`backend listening on port ${config.port}`);
    console.log(`vault: ${vaultAddress}`);
  });

  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      await syncVaultRuntimeState();
      const info = await scanner.scanOnce();
      const changed = info.found > 0;
      const label = changed ? "scan" : "idle";
      console.log(
        `[${label}] from=${info.fromBlock} to=${info.toBlock} found=${info.found} scannedTo=${info.scannedTo}`
      );
      await syncLiveDrawFeed();
      await tryAutoDraw();
      await tryProcessRelief();
    } catch (e) {
      const msg = e?.shortMessage || e?.reason || e?.message || String(e);
      console.log(`[err] ${msg}`);
    } finally {
      running = false;
    }
  }

  await tick();
  setInterval(tick, config.scanPollIntervalMs);

  function shutdown() {
    try {
      server.close();
    } catch {}
    try {
      db.save();
    } catch {}
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

installProcessGuards();

main().catch((e) => {
  const msg = e?.message || String(e);
  console.error(msg);
  process.exitCode = 1;
});

