import express from "express";
import { ethers } from "ethers";

export function createRoutes({ rankService, historyService, config, db }) {
  const router = express.Router();

  router.get("/health", (req, res) => {
    res.json({
      ok: true,
      vaultAddress: config.vaultAddress,
    });
  });

  router.get("/ranks", async (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const data = await rankService.getRanks({ limit });
    res.json(data);
  });

  router.post("/players/register", (req, res) => {
    const address = req.body?.address;
    if (!address || !ethers.isAddress(address)) {
      return res.status(400).json({ ok: false, error: "Invalid address" });
    }

    const normalized = ethers.getAddress(address);
    const inserted = db.registerPlayer(normalized);
    db.save();
    res.json({ ok: true, address: normalized, inserted });
  });

  router.get("/history/draws", async (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const data = await historyService.getDrawHistory({ limit });
    res.json(data);
  });

  router.get("/live-feed", (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : 8;
    res.json({ ok: true, items: db.listLiveFeed(limit) });
  });

  router.get("/relief/claim/:address", (req, res) => {
    const address = req.params.address;
    if (!address || !ethers.isAddress(address)) {
      return res.status(400).json({ ok: false, error: "Invalid address" });
    }
    const normalized = ethers.getAddress(address);
    const stmt = db.db.prepare("SELECT * FROM holder_relief_epochs ORDER BY epoch_id DESC LIMIT 1");
    if (!stmt.step()) {
      stmt.free();
      return res.status(404).json({ ok: false, error: "No relief epoch found in database" });
    }
    const epoch = stmt.getAsObject();
    stmt.free();

    if (!epoch.settled) {
      return res.status(202).json({ ok: false, error: "Relief epoch found but not yet settled (calculating proofs...)", epochId: epoch.epoch_id });
    }
    if (!epoch.merkle_root || epoch.merkle_root === ethers.ZeroHash) {
      return res.status(404).json({ ok: false, error: "Relief epoch settled but no eligible holders found in snapshot", epochId: epoch.epoch_id });
    }

    const claim = db.getReliefClaim(epoch.epoch_id, normalized);
    if (!claim) {
      // 尝试全小写匹配，防止数据库存储格式不一致
      const claimLower = db.getReliefClaim(epoch.epoch_id, address.toLowerCase());
      if (!claimLower) {
        return res.status(404).json({ ok: false, error: "Address not eligible for this epoch (below 10M threshold or not a player)", epochId: epoch.epoch_id });
      }
      return res.json({
        ok: true,
        epochId: epoch.epoch_id,
        amountWei: claimLower.amount_wei,
        proof: JSON.parse(claimLower.proof_json)
      });
    }
    res.json({
      ok: true,
      epochId: epoch.epoch_id,
      amountWei: claim.amount_wei,
      proof: JSON.parse(claim.proof_json)
    });
  });

  return router;
}

