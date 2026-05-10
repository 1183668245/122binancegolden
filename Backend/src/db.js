import fs from "node:fs";
import path from "node:path";
import initSqlJs from "sql.js";

function dbFilePath() {
  return path.resolve("data", "ranks.sqlite");
}

function ensureDir() {
  fs.mkdirSync(path.dirname(dbFilePath()), { recursive: true });
}

export async function createDb() {
  ensureDir();
  const SQL = await initSqlJs({
    locateFile(file) {
      return path.resolve("node_modules", "sql.js", "dist", file);
    },
  });

  const fp = dbFilePath();
  const db = fs.existsSync(fp) ? new SQL.Database(fs.readFileSync(fp)) : new SQL.Database();

  db.run(`
    PRAGMA journal_mode = MEMORY;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS scanner_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS players (
      address TEXT PRIMARY KEY,
      first_seen_block INTEGER NOT NULL,
      last_seen_block INTEGER NOT NULL,
      buy_count INTEGER NOT NULL,
      is_contract INTEGER DEFAULT -1
    );
    CREATE TABLE IF NOT EXISTS player_stats_cache (
      address TEXT PRIMARY KEY,
      total_won_bnb_wei TEXT NOT NULL,
      total_burned_token TEXT NOT NULL,
      fortune_points TEXT NOT NULL,
      claimable_bnb_wei TEXT NOT NULL,
      balance_token TEXT NOT NULL DEFAULT '0',
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS holder_relief_epochs (
      epoch_id INTEGER PRIMARY KEY,
      pool_amount_wei TEXT NOT NULL,
      snapshot_block INTEGER NOT NULL,
      triggered_at_ms INTEGER NOT NULL,
      merkle_root TEXT NOT NULL,
      claim_deadline_ms INTEGER NOT NULL,
      settled INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS relief_claims (
      epoch_id INTEGER NOT NULL,
      address TEXT NOT NULL,
      amount_wei TEXT NOT NULL,
      proof_json TEXT NOT NULL,
      PRIMARY KEY(epoch_id, address)
    );
    CREATE TABLE IF NOT EXISTS token_holders (
      address TEXT PRIMARY KEY,
      balance_wei TEXT NOT NULL,
      last_updated_block INTEGER NOT NULL,
      first_seen_block INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS live_feed (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
  `);

  // 自动迁移逻辑
  try {
    const tableInfo = db.prepare("PRAGMA table_info(player_stats_cache)");
    let hasBalanceToken = false;
    while (tableInfo.step()) {
      if (tableInfo.getAsObject().name === "balance_token") {
        hasBalanceToken = true;
        break;
      }
    }
    tableInfo.free();
    if (!hasBalanceToken) db.run("ALTER TABLE player_stats_cache ADD COLUMN balance_token TEXT NOT NULL DEFAULT '0'");

    const playerInfo = db.prepare("PRAGMA table_info(players)");
    let hasIsContract = false;
    while (playerInfo.step()) {
      if (playerInfo.getAsObject().name === "is_contract") {
        hasIsContract = true;
        break;
      }
    }
    playerInfo.free();
    if (!hasIsContract) db.run("ALTER TABLE players ADD COLUMN is_contract INTEGER DEFAULT -1");
  } catch (e) {}

  function save() {
    ensureDir();
    const data = db.export();
    fs.writeFileSync(fp, Buffer.from(data));
  }

  function getState(key) {
    const stmt = db.prepare("SELECT value FROM scanner_state WHERE key = ?");
    stmt.bind([key]);
    if (!stmt.step()) { stmt.free(); return null; }
    const res = stmt.getAsObject().value ?? null;
    stmt.free();
    return res;
  }

  function setState(key, value) {
    db.run("INSERT INTO scanner_state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [
      key,
      String(value),
    ]);
  }

  function upsertPlayer(address, blockNumber) {
    const stmt = db.prepare("SELECT address, first_seen_block, last_seen_block, buy_count FROM players WHERE address = ?");
    stmt.bind([address]);
    if (!stmt.step()) {
      stmt.free();
      db.run("INSERT INTO players(address, first_seen_block, last_seen_block, buy_count) VALUES(?, ?, ?, ?)", [address, blockNumber, blockNumber, 1]);
      return;
    }
    const row = stmt.getAsObject();
    stmt.free();
    const firstSeen = Math.min(Number(row.first_seen_block), blockNumber);
    const lastSeen = Math.max(Number(row.last_seen_block), blockNumber);
    const buyCount = Number(row.buy_count) + 1;
    db.run("UPDATE players SET first_seen_block = ?, last_seen_block = ?, buy_count = ? WHERE address = ?", [firstSeen, lastSeen, buyCount, address]);
  }

  function registerPlayer(address) {
    const stmt = db.prepare("SELECT address FROM players WHERE address = ?");
    stmt.bind([address]);
    if (!stmt.step()) {
      stmt.free();
      db.run("INSERT INTO players(address, first_seen_block, last_seen_block, buy_count) VALUES(?, ?, ?, ?)", [address, 0, 0, 0]);
      return true;
    }
    stmt.free();
    return false;
  }

  function listPlayers(limit = 5000) {
    const stmt = db.prepare("SELECT address, first_seen_block, last_seen_block, buy_count FROM players ORDER BY last_seen_block DESC LIMIT ?");
    stmt.bind([limit]);
    const out = [];
    while (stmt.step()) out.push(stmt.getAsObject());
    stmt.free();
    return out;
  }

  function getCachedStats(address) {
    const stmt = db.prepare("SELECT * FROM player_stats_cache WHERE address = ?");
    stmt.bind([address]);
    if (!stmt.step()) { stmt.free(); return null; }
    const res = stmt.getAsObject();
    stmt.free();
    return res;
  }

  function setCachedStats(s) {
    db.run(`INSERT INTO player_stats_cache(address, total_won_bnb_wei, total_burned_token, fortune_points, claimable_bnb_wei, balance_token, updated_at_ms)
      VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(address) DO UPDATE SET
      total_won_bnb_wei=excluded.total_won_bnb_wei, total_burned_token=excluded.total_burned_token, fortune_points=excluded.fortune_points,
      claimable_bnb_wei=excluded.claimable_bnb_wei, balance_token=excluded.balance_token, updated_at_ms=excluded.updated_at_ms`,
      [s.address, s.totalWonBNBWei, s.totalBurnedToken, s.fortunePoints, s.claimableBNBWei, s.balanceToken, s.updatedAtMs]
    );
  }

  function updateTokenHolder(address, balanceWei, blockNumber) {
    const stmt = db.prepare("SELECT address FROM token_holders WHERE address = ?");
    stmt.bind([address]);
    if (!stmt.step()) {
      stmt.free();
      db.run("INSERT INTO token_holders(address, balance_wei, last_updated_block, first_seen_block) VALUES(?, ?, ?, ?)", [address, balanceWei, blockNumber, blockNumber]);
    } else {
      stmt.free();
      db.run("UPDATE token_holders SET balance_wei = ?, last_updated_block = ? WHERE address = ?", [balanceWei, blockNumber, address]);
    }
  }

  function getReliefEpoch(epochId) {
    const stmt = db.prepare("SELECT * FROM holder_relief_epochs WHERE epoch_id = ?");
    stmt.bind([epochId]);
    if (!stmt.step()) { stmt.free(); return null; }
    const res = stmt.getAsObject();
    stmt.free();
    return res;
  }

  function setReliefEpoch(e) {
    const epochId = e.epoch_id ?? e.epochId;
    const poolAmountWei = e.pool_amount_wei ?? e.poolAmountWei ?? "0";
    const snapshotBlock = e.snapshot_block ?? e.snapshotBlock ?? 0;
    const triggeredAtMs = e.triggered_at_ms ?? e.triggeredAtMs ?? Date.now();
    const merkleRoot = e.merkle_root ?? e.merkleRoot ?? "";
    const claimDeadlineMs = e.claim_deadline_ms ?? e.claimDeadlineMs ?? triggeredAtMs;
    const settled = e.settled ?? 0;

    db.run(`INSERT INTO holder_relief_epochs(epoch_id, pool_amount_wei, snapshot_block, triggered_at_ms, merkle_root, claim_deadline_ms, settled)
      VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(epoch_id) DO UPDATE SET
      pool_amount_wei=excluded.pool_amount_wei, snapshot_block=excluded.snapshot_block, triggered_at_ms=excluded.triggered_at_ms,
      merkle_root=excluded.merkle_root, claim_deadline_ms=excluded.claim_deadline_ms, settled=excluded.settled`,
      [epochId, String(poolAmountWei), Number(snapshotBlock), Number(triggeredAtMs), merkleRoot, Number(claimDeadlineMs), Number(settled)]
    );
  }

  function addLiveFeedItem(item) {
    db.run("INSERT OR IGNORE INTO live_feed(id, type, title, content, created_at_ms) VALUES(?, ?, ?, ?, ?)", [
      item.id, item.type, item.title, item.content, Number(item.createdAtMs ?? Date.now())
    ]);
    db.run("DELETE FROM live_feed WHERE id NOT IN (SELECT id FROM live_feed ORDER BY created_at_ms DESC LIMIT 20)");
  }

  function listLiveFeed(limit = 12) {
    const stmt = db.prepare("SELECT * FROM live_feed ORDER BY created_at_ms DESC LIMIT ?");
    stmt.bind([limit]);
    const out = [];
    while (stmt.step()) out.push(stmt.getAsObject());
    stmt.free();
    return out;
  }

  function getReliefClaim(epochId, address) {
    const stmt = db.prepare("SELECT * FROM relief_claims WHERE epoch_id = ? AND address = ?");
    stmt.bind([epochId, address]);
    if (!stmt.step()) { stmt.free(); return null; }
    const res = stmt.getAsObject();
    stmt.free();
    return res;
  }

  function setReliefClaims(epochId, claims) {
    for (const c of claims) {
      db.run("INSERT INTO relief_claims(epoch_id, address, amount_wei, proof_json) VALUES(?, ?, ?, ?) ON CONFLICT(epoch_id, address) DO UPDATE SET amount_wei=excluded.amount_wei, proof_json=excluded.proof_json",
        [epochId, c.address, c.amountWei, c.proofJson]
      );
    }
  }

  return {
    db, save, getState, setState, upsertPlayer, registerPlayer, listPlayers,
    getCachedStats, setCachedStats, updateTokenHolder, addLiveFeedItem, listLiveFeed,
    getReliefEpoch, setReliefEpoch, getReliefClaim, setReliefClaims
  };
}
