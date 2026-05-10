import { ethers } from "ethers";
import { SimpleMerkleTree } from "@openzeppelin/merkle-tree";
import { config } from "./config.js";
import { createChain } from "./chain.js";

export async function processReliefEpoch(db, epochId) {
  const chain = createChain({ rpcUrl: config.rpcUrl, rpcUrls: config.rpcUrls, vaultAddress: config.vaultAddress, botPrivateKey: config.botPrivateKey });
  const epoch = db.getReliefEpoch(epochId);
  if (!epoch) throw new Error("Epoch not found in DB");
  if (epoch.settled) return;

  console.log(`[Relief] 正在为 Epoch ${epochId} 计算保底分配...`);
  
  const tokenAddr = await chain.vault.taxToken();
  const minHolding = ethers.parseUnits("10000000", 18);

  // 只按真实持币地址计算，不再混入 players / player_stats_cache
  const allCandidates = new Map();
  const hStmt = db.db.prepare("SELECT address, balance_wei FROM token_holders");
  while (hStmt.step()) {
    const row = hStmt.getAsObject();
    allCandidates.set(row.address.toLowerCase(), {
      address: row.address,
      balance: BigInt(row.balance_wei || "0")
    });
  }
  hStmt.free();
  let qualified = [];
  const SYSTEM_BLACKLIST = [
    ethers.ZeroAddress.toLowerCase(),
    "0x000000000000000000000000000000000000dEaD".toLowerCase(),
    config.vaultAddress.toLowerCase(),
    tokenAddr.toLowerCase(),
    "0x5bEacaF7ABCbB3aB280e80D007FD31fcE26510e9".toLowerCase()
  ];

  for (const [addr, data] of allCandidates) {
    if (SYSTEM_BLACKLIST.includes(addr)) continue;
    if (data.balance >= minHolding) {
      qualified.push({ address: data.address, balance: data.balance });
    }
  }

  if (qualified.length === 0) {
    console.log("[Relief] token_holders 未命中合格地址，开始用已知地址实时回补余额...");
    const token = new ethers.Contract(tokenAddr, ["function balanceOf(address) view returns (uint256)"], chain.provider);
    const latestBlock = await chain.provider.getBlockNumber();
    const seedAddresses = new Set();
    for (const sql of ["SELECT address FROM player_stats_cache", "SELECT address FROM players"]) {
      const stmt = db.db.prepare(sql);
      while (stmt.step()) seedAddresses.add(stmt.getAsObject().address);
      stmt.free();
    }
    const fallback = new Map();
    for (const address of seedAddresses) {
      const normalized = ethers.getAddress(address);
      const bal = await token.balanceOf(normalized);
      db.updateTokenHolder(normalized, bal.toString(), latestBlock);
      if (!SYSTEM_BLACKLIST.includes(normalized.toLowerCase()) && bal >= minHolding) {
        fallback.set(normalized.toLowerCase(), { address: normalized, balance: bal });
      }
    }
    db.save();
    qualified = [...fallback.values()];
  }

  if (qualified.length === 0) {
    console.log("[Relief] 无满足 1000万持仓条件的真实持币地址，Epoch 标记为已结算无名单。");
    db.setReliefEpoch({ ...epoch, merkle_root: ethers.ZeroHash, settled: 1 });
    db.save();
    return;
  }

  const totalBal = qualified.reduce((acc, cur) => acc + cur.balance, 0n);
  const claims = qualified.map((p) => {
    const amountWei = ((BigInt(epoch.pool_amount_wei) * p.balance) / totalBal).toString();
    const leaf = ethers.solidityPackedKeccak256(["address", "uint256"], [p.address, amountWei]);
    return { address: p.address, amountWei, leaf };
  });

  const tree = SimpleMerkleTree.of(claims.map((c) => c.leaf));
  console.log(`[Relief] 成功生成证明。Root: ${tree.root}`);

  // 检查合约状态
  try {
    const onChainEpoch = await chain.vault.holderReliefEpochs(epochId);
    // 0:poolAmount, 1:remainingAmount, 2:snapshotBlock, 3:triggeredAt, 4:merkleRoot, 5:claimDeadline
    const onChainRoot = onChainEpoch[4]; 

    if (onChainRoot && onChainRoot !== ethers.ZeroHash) {
      console.log(`[Relief] 合约已有 Root，同步本地。`);
    } else {
      console.log(`[Relief] 提交 Root 到合约...`);
      const tx = await chain.drawVault.setHolderReliefMerkleRoot(epochId, tree.root);
      await tx.wait();
    }
  } catch (e) {
    const msg = String(e.message || e);
    if (!msg.includes("Root already set")) {
      console.error(`[Relief] 失败: ${msg}`);
      return;
    }
  }

  // 保存名单
  db.setReliefClaims(epochId, claims.map((c) => ({
    address: c.address,
    amountWei: c.amountWei,
    proofJson: JSON.stringify(tree.getProof(c.leaf))
  })));
  db.setReliefEpoch({ ...epoch, merkle_root: tree.root, settled: 1 });
  db.save();
  
  console.log(`[Relief] Epoch ${epochId} 结算完成！`);
}
