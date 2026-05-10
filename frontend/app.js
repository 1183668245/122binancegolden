const { ethers } = window;


const CONFIG = {
  chainIdHex: "0x38", // BSC Mainnet = 56
  chainName: "BNB Smart Chain",
  rpcUrls: [
    "https://rpc.ankr.com/bsc/567ded437255a1b5ccd46b5eb5155197ac24de6c90ebc56f1403ddcf0eb165e3"
  ],
  nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
  blockExplorerUrls: ["https://bscscan.com"],

  vaultAddress: "0x646Cb53D887929f5F324514ACdcbbC258CD35349" // 币安金靴主网金库地址
};

const VAULT_ABI = [
  "function taxToken() view returns (address)",
  "function jackpotPool() view returns (uint256)",
  "function fortunePool() view returns (uint256)",
  "function currentRoundId() view returns (uint256)",
  "function rounds(uint256) view returns (uint256 startTime, uint256 endTime, uint16 winningNumber, bool resolved)",
  "function TICKET_PRICE() view returns (uint256)",
  "function MIN_HOLDING() view returns (uint256)",
  "function claimableBNB(address) view returns (uint256)",
  "function noWinnerStreak() view returns (uint256)",
  "function holderReliefEpochId() view returns (uint256)",
  "function holderReliefClaimed(uint256, address) view returns (bool)",
  "function claimHolderRelief(uint256, uint256, bytes32[])",
  "function stats(address) view returns (uint256 totalWonBNB, uint256 totalBurnedToken, uint256 fortunePoints)",
  "function userTickets(uint256, address, uint256) view returns (uint16)",
  "function bindTaxToken(address _taxToken)",
  "function buyTicket(uint16 _number)",
  "function draw()",
  "function claim()",
  "function description() view returns (string)"
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)"
];

let provider, signer, account, vault;
let readProvider, readVault;
let roundMeta = null;
let minHolding = null;
let isEligible = false;
let currentClaimable = 0n;
let chainTimeOffsetSec = 0;
let lastChainSyncMs = 0;
let drawHistory = [];
let historyExpanded = false;
let historyTemplate = "list";
let participationExpanded = false;
let currentRoundTickets = [];
let observedRoundId = null;
let drawRefreshBusy = false;
let lastRankLoadAt = 0;
let rankLoadBusy = false;
let reliefPending = null;
const busyButtons = new Set();
let globalLoadingTimer = null;
let successToastTimer = null;
let liveFeedBusy = false;
const BACKEND_API_BASE = "https://api.binancegoldenboot.top/api";

const $ = (id) => document.getElementById(id);
const log = (msg) => {
  const now = new Date().toLocaleTimeString();
  $("log").textContent = `[${now}] ${msg}\n` + $("log").textContent;
};
const setReliefStatus = (text, tone = "muted") => {
  const el = $("reliefStatus");
  if (!el) return;
  el.textContent = text;
  el.style.color = tone === "ok" ? "var(--ok)" : tone === "warn" ? "#ff6b6b" : "var(--muted)";
};
const fmtFeedTime = (ms) => {
  const diff = Math.max(0, Date.now() - Number(ms || Date.now()));
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
};
function renderLiveFeed(items = []) {
  const el = $("liveActivityList");
  if (!el) return;
  if (!items.length) {
    el.innerHTML = '<div class="activity-item"><div class="activity-icon"><i class="fa-solid fa-signal"></i></div><div class="activity-content"><b>实时动态同步中</b><div class="activity-time">暂无最新赛事动态</div></div></div>';
    return;
  }
  el.innerHTML = items.map((item) => {
    const icon = item.type === "draw" ? "fa-trophy" : "fa-futbol";
    return `<div class="activity-item"><div class="activity-icon"><i class="fa-solid ${icon}"></i></div><div class="activity-content"><b>${item.title}</b><div>${item.content}</div><div class="activity-time">${fmtFeedTime(item.created_at_ms)}</div></div></div>`;
  }).join("");
}
async function loadLiveFeed(force = false) {
  if (liveFeedBusy && !force) return;
  liveFeedBusy = true;
  try {
    const res = await fetch(`${BACKEND_API_BASE}/live-feed?limit=8`, { cache: "no-store" });
    const data = await res.json();
    renderLiveFeed(data.items || []);
  } catch {
    renderLiveFeed([]);
  } finally {
    liveFeedBusy = false;
  }
}

function fmtBNB(v) {
  return `${Number(ethers.formatEther(v)).toFixed(6)} BNB`;
}
function shortAddr(a) {
  if (!a || a === ethers.ZeroAddress) return a;
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

function fmtToken(v) {
  return Number(ethers.formatUnits(v, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function fmtCountdown(seconds) {
  if (seconds <= 0) return "00:00";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
function padRoute(v) {
  if (v === "" || v == null) return "---";
  return String(v).padStart(3, "0").slice(-3);
}
function fmtDateTime(ts) {
  return new Date(Number(ts) * 1000).toLocaleString("zh-CN", { hour12: false });
}
function getLocalNowSec() {
  return Math.floor(Date.now() / 1000);
}
function getChainNowSec() {
  return getLocalNowSec() + chainTimeOffsetSec;
}
async function syncChainTime(force = false) {
  const activeProvider = provider || readProvider;
  if (!activeProvider) return;
  const nowMs = Date.now();
  if (!force && nowMs - lastChainSyncMs < 15000) return;
  const block = await activeProvider.getBlock("latest");
  if (!block?.timestamp) return;
  chainTimeOffsetSec = Number(block.timestamp) - getLocalNowSec();
  lastChainSyncMs = nowMs;
}
function isAmbiguousTxError(message = "") {
  return /could not coalesce error|unknown error|internal json-rpc error/i.test(message || "");
}
function humanizeError(message = "") {
  if (/user rejected|denied/i.test(message)) return "你已取消本次钱包签名";
  if (isAmbiguousTxError(message)) return "钱包返回了不稳定响应，系统将立即刷新链上状态确认本次操作是否已生效";
  if (/insufficient allowance/i.test(message)) return "参赛代币授权额度不足，请先完成授权";
  if (/Hold 500k\+/i.test(message)) return "持仓未达到 50 万，暂不具备出战资格";
  if (/Hold 10m\+/i.test(message)) return "当前实时持仓未达到 1000 万，无法领取持币保底";
  if (/Invalid proof/i.test(message)) return "保底证明校验失败，请稍后刷新页面重试";
  if (/Claim ended/i.test(message)) return "本轮持币保底领取已过期";
  if (/Already claimed/i.test(message)) return "本轮持币保底已领取，无需重复操作";
  if (/Root not set/i.test(message)) return "本轮持币保底证明尚未完成同步，请稍后重试";
  if (/Locked/i.test(message)) return "当前已进入封盘阶段，暂不可进攻";
  if (/Max 5/i.test(message)) return "本轮最多只能发起 5 次进攻";
  if (/Duplicate number/i.test(message)) return "本轮该战术路线已使用，请更换号码";
  if (/No prize/i.test(message)) return "当前没有可领取的战利品";
  if (/Not ended/i.test(message)) return "当前轮次尚未结束，请等待倒计时归零后再开奖";
  if (/Resolved/i.test(message)) return "本轮已经开奖，请刷新页面查看下一轮";
  return message || "操作失败，请稍后重试";
}
function isMobileDevice() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "");
}
async function showWalletEntryGuide() {
  const msg = isMobileDevice()
    ? "未检测到可用钱包环境。\n\n请使用 OKX / MetaMask / Trust Wallet / SafePal 等钱包内置浏览器打开当前页面后，再点击连接钱包。"
    : "未检测到可用钱包环境。\n\n请安装支持 EVM 的浏览器钱包，或使用钱包内置浏览器打开页面。";
  await showAlert(msg, "未检测到钱包");
}
function setTone(id, tone) {
  const el = $(id);
  if (el) el.dataset.tone = tone;
}
function setButtonState(id, disabled, hint, tone = "muted") {
  const btn = $(id);
  if (btn) btn.disabled = disabled || busyButtons.has(id);
  const tip = $(`${id.replace("btn", "").toLowerCase()}Hint`);
  if (tip && hint) {
    tip.textContent = hint;
    tip.dataset.tone = tone;
  }
}
function setEligibilityStatus(text, tone = "muted") {
  $("eligibilityStatus").textContent = text;
  setTone("eligibilityStatus", tone);
}
function setGlobalLoading(visible, title = "处理中", text = "请稍候，系统正在同步链上状态...") {
  const mask = $("globalLoading");
  if (!mask) return;
  if (globalLoadingTimer) {
    clearTimeout(globalLoadingTimer);
    globalLoadingTimer = null;
  }
  mask.hidden = !visible;
  if (visible) {
    $("globalLoadingTitle").textContent = title;
    $("globalLoadingText").textContent = text;
    globalLoadingTimer = setTimeout(() => {
      mask.hidden = true;
      globalLoadingTimer = null;
      if (title === "领取持币保底奖励") {
        log(`${title} 等待超时：钱包可能未弹出、当前持仓不足 1000 万，或保底证明模拟校验未通过，请检查钱包扩展窗口后重试。`);
      } else {
        log(`${title} 等待超时，请检查钱包确认窗口或稍后重试。`);
      }
    }, 25000);
  }
}
function setButtonLoading(id, loading, loadingText = "处理中...") {
  const btn = $(id);
  if (!btn) return;
  if (loading) {
    if (!btn.dataset.originalText) btn.dataset.originalText = btn.textContent;
    busyButtons.add(id);
    btn.disabled = true;
    btn.classList.add("is-loading");
    btn.textContent = loadingText;
  } else {
    busyButtons.delete(id);
    btn.disabled = false;
    btn.classList.remove("is-loading");
    btn.textContent = id === "btnConnect" && account
      ? shortAddr(account)
      : (btn.dataset.originalText || btn.textContent);
    delete btn.dataset.originalText;
  }
}
function showSuccessToast(title, text) {
  const toast = $("successToast");
  if (!toast) return;
  $("successToastTitle").textContent = title;
  $("successToastText").textContent = text;
  toast.hidden = false;
  if (successToastTimer) clearTimeout(successToastTimer);
  successToastTimer = setTimeout(() => {
    toast.hidden = true;
    successToastTimer = null;
  }, 3200);
}
async function runButtonAction(id, loadingText, action) {
  if (busyButtons.has(id)) return;
  setButtonLoading(id, true, loadingText);
  try {
    await action();
  } finally {
    setButtonLoading(id, false);
    setGlobalLoading(false);
    updateActionHints();
  }
}

/**
 * 自定义确认弹窗 (替换 window.confirm)
 */
function showConfirm(message, title = "确认操作") {
  return new Promise((resolve) => {
    const modal = $("customConfirm");
    const titleEl = $("confirmTitle");
    const msgEl = $("confirmMessage");
    const btnOk = $("btnConfirmOk");
    const btnCancel = $("btnConfirmCancel");

    titleEl.textContent = title;
    msgEl.textContent = message;
    modal.classList.add("open");

    const cleanup = (result) => {
      modal.classList.remove("open");
      btnOk.onclick = null;
      btnCancel.onclick = null;
      resolve(result);
    };

    btnOk.onclick = () => cleanup(true);
    btnCancel.onclick = () => cleanup(false);
  });
}

/**
 * 自定义警示弹窗 (单按钮)
 */
function showAlert(message, title = "提示") {
  return new Promise((resolve) => {
    const modal = $("customConfirm");
    const titleEl = $("confirmTitle");
    const msgEl = $("confirmMessage");
    const btnOk = $("btnConfirmOk");
    const btnCancel = $("btnConfirmCancel");

    titleEl.textContent = title;
    msgEl.textContent = message;
    btnCancel.style.display = "none"; // 隐藏取消按钮
    modal.classList.add("open");

    const cleanup = () => {
      modal.classList.remove("open");
      btnCancel.style.display = ""; // 恢复显示
      btnOk.onclick = null;
      resolve();
    };

    btnOk.onclick = cleanup;
  });
}

function rememberObservedRound(roundId) {
  observedRoundId = Number(roundId);
}
async function checkRoundTransitionAutoReload() {
  if (drawRefreshBusy || !readVault) return;
  drawRefreshBusy = true;
  try {
    const latestRoundId = Number(await readVault.currentRoundId());
    if (observedRoundId == null) {
      observedRoundId = latestRoundId;
      return;
    }
    if (latestRoundId <= observedRoundId) return;

    const reloadKey = `golden-boot-reloaded-round-${latestRoundId}`;
    if (sessionStorage.getItem(reloadKey)) {
      observedRoundId = latestRoundId;
      return;
    }

    sessionStorage.setItem(reloadKey, "1");
    log(`检测到第 ${latestRoundId} 期已开启，页面将自动刷新同步最新开奖结果...`);
    window.location.reload();
  } catch {}
  finally {
    drawRefreshBusy = false;
  }
}
function renderParticipationInfo() {
  const roundText = $("roundId")?.textContent || "-";
  const picked = currentRoundTickets.length ? currentRoundTickets.map(padRoute).join(" / ") : "暂未出战";
  $("myRoundInfo").textContent = !account
    ? "我的当前出战：未连接钱包"
    : !roundMeta?.endTime
      ? "我的当前出战：比赛尚未开始"
      : `我的当前出战：第 ${roundText} 期 · 已选路线：${picked}`;

  const refs = drawHistory.slice(0, 5);
  $("historyRefInfo").textContent = refs.length
    ? `近 5 期走势看板：最近 ${refs.length} 期开奖号码参考`
    : "近 5 期走势看板：等待首期开奖完成";

  const board = $("historyTrendBoard");
  if (board) {
    if (!refs.length) {
      board.innerHTML = '<div class="trend-empty">暂无历史开奖数据</div>';
    } else {
      board.innerHTML = refs.map((item, idx) => `
        <div class="trend-cell ${idx === 0 ? "is-latest" : ""}">
          <span class="trend-label">第 ${item.roundId} 期</span>
          <strong class="trend-number">${padRoute(item.winningNumber)}</strong>
        </div>
      `).join("");
    }
  }

  const btn = $("btnToggleParticipation");
  if (btn) btn.textContent = "查看出战参考";
}
async function updateRoundStatus() {
  if (!roundMeta?.endTime) {
    $("countdownLabel").textContent = "比赛状态";
    $("roundState").textContent = "待开赛";
    $("lockCountdown").textContent = "等待绑定参赛代币";
    $("roundEndTime").textContent = "-";
    setTone("roundState", "muted");
    setTone("lockCountdown", "muted");
    return;
  }
  const now = getChainNowSec();
  const endTime = Number(roundMeta.endTime);
  const lockTime = Math.max(endTime - 30, 0);
  $("roundEndTime").textContent = fmtDateTime(endTime);

  const streak = await readVault.noWinnerStreak();
  const streakText = streak > 0 ? ` (连续轮空: ${streak}/10)` : "";

  if (now >= endTime) {
    $("countdownLabel").textContent = "距离终场";
    $("roundState").textContent = "等待终场开奖" + streakText;
    $("lockCountdown").textContent = "已结束";
    setTone("roundState", "warn");
    setTone("lockCountdown", "warn");
    return;
  }
  if (now >= lockTime) {
    $("countdownLabel").textContent = "距离终场";
    $("roundState").textContent = "补时封盘中" + streakText;
    $("lockCountdown").textContent = fmtCountdown(endTime - now);
    setTone("roundState", "warn");
    setTone("lockCountdown", "warn");
    return;
  }
  $("countdownLabel").textContent = "距离封盘";
  $("roundState").textContent = "开放进攻中" + streakText;
  $("lockCountdown").textContent = fmtCountdown(lockTime - now);
  setTone("roundState", "ok");
  setTone("lockCountdown", "ok");
}
async function checkReliefClaim(epochId) {
  reliefPending = null;
  $("btnClaimRelief").style.display = "none";
  try {
    const res = await fetch(`${BACKEND_API_BASE}/relief/claim/${account}`, { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      if (!data.ok) {
        setReliefStatus("持币保底状态：接口返回异常", "warn");
        return;
      }
      const isClaimed = await vault.holderReliefClaimed(epochId, account);
      if (isClaimed) {
        setReliefStatus(`持币保底状态：Epoch ${epochId} 已领取`, "ok");
        return;
      }
      reliefPending = data;
      $("btnClaimRelief").style.display = "inline-block";
      setReliefStatus(`持币保底状态：Epoch ${epochId} 可领取 ${fmtBNB(data.amountWei)}`, "ok");
      log(`[保底] 检测到 Epoch ${epochId} 有 ${fmtBNB(data.amountWei)} 奖励待领取！`);
      return;
    }

    if (res.status === 202) setReliefStatus(`持币保底状态：Epoch ${epochId} 奖励名单生成中，请稍后刷新`, "warn");
    else if (res.status === 404) setReliefStatus(`持币保底状态：Epoch ${epochId} 当前暂未查询到可领取奖励，请稍后刷新`, "muted");
    else if (res.status === 400) setReliefStatus("持币保底状态：当前钱包地址无效", "warn");
    else setReliefStatus(`持币保底状态：接口异常 ${res.status}`, "warn");
  } catch (e) {
    setReliefStatus("持币保底状态：后端未启动或接口不可用", "warn");
  }
}

async function updateEligibility(taxToken) {
  if (!account) {
    setEligibilityStatus("未连接钱包", "muted");
    return;
  }
  if (!taxToken || taxToken === ethers.ZeroAddress) {
    setEligibilityStatus("待绑定参赛代币", "muted");
    return;
  }
  const token = new ethers.Contract(taxToken, ERC20_ABI, provider);
  const balance = await token.balanceOf(account);
  isEligible = balance >= minHolding;
  if (isEligible) {
    setEligibilityStatus(`已达标 · ${fmtToken(balance)}`, "ok");
  } else {
    setEligibilityStatus(`未达标 · 还差 ${fmtToken(minHolding - balance)}`, "warn");
  }
}
async function updateLastWinning(roundId) {
  const activeVault = vault || readVault;
  if (!activeVault) return;
  if (roundId <= 1n) {
    $("lastWinningNumber").textContent = "暂无";
    return;
  }
  const prev = await activeVault.rounds(roundId - 1n);
  $("lastWinningNumber").textContent = prev.resolved ? padRoute(prev.winningNumber) : "待揭晓";
}
function updateActionHints() {
  const now = getChainNowSec();
  const endTime = Number(roundMeta?.endTime || 0);
  const started = endTime > 0;
  const locked = started && now >= Math.max(endTime - 30, 0) && now < endTime;
  const ended = started && now >= endTime;
  setButtonState("btnBind", !account, !account ? "请先连接管理钱包后再执行绑定。" : "已连接钱包，可执行参赛代币绑定。", !account ? "muted" : "ok");
  setButtonState("btnBuy", !account || !started || !isEligible || locked || ended, !account ? "请先连接钱包后入场。" : !started ? "比赛尚未开始，请先完成参赛代币绑定。" : !isEligible ? "尚未达到 50 万持仓门槛，暂不可出战。" : locked ? "当前处于封盘阶段，进攻通道已关闭。" : ended ? "本轮补时赛已结束，请等待终场开奖。" : "状态正常，可立即发起进攻。", !account || !started || !isEligible || locked || ended ? "warn" : "ok");
  setButtonState("btnDraw", !account || !started || !ended, !account ? "请先连接钱包后再操作。" : !started ? "比赛尚未开始，暂不可开奖。" : ended ? "比赛结束，可立即触发终场开奖。" : "仅在本轮比赛结束后开放。", !account ? "muted" : ended ? "ok" : "muted");
  setButtonState("btnClaim", !account || currentClaimable <= 0n, !account ? "请先连接钱包后查看战利品。" : currentClaimable > 0n ? "检测到可领取战利品，可直接提取。" : "当前没有可领取的战利品。", !account ? "muted" : currentClaimable > 0n ? "ok" : "muted");
}

async function registerPlayerToBackend(address) {
  if (!address || !ethers.isAddress(address)) return;
  try {
    await fetch(`${BACKEND_API_BASE}/players/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address })
    });
  } catch (e) {
    log(`球员登记失败: ${humanizeError(e?.message || String(e))}`);
  }
}
function renderRankList(elId, rows, valueKey, valueFormatter) {
  const el = $(elId);
  el.innerHTML = "";
  if (!rows.length) {
    el.innerHTML = '<li class="empty-state">等待录入球员地址后生成榜单</li>';
    return;
  }
  rows.forEach((r, idx) => {
    const li = document.createElement("li");
    li.className = "rank-item-ucl";
    li.innerHTML = `
      <div class="rank-num">${idx + 1}</div>
      <div class="rank-info">
        <span class="addr">${shortAddr(r.address)}</span>
        <span class="val">${valueFormatter(r[valueKey], r)}</span>
      </div>
    `;
    el.appendChild(li);
  });
}
function setDrawerOpen(drawerId, open, defaultTab = null) {
  const drawer = $(drawerId);
  if (!drawer) return;
  drawer.classList.toggle("open", open);
  drawer.setAttribute("aria-hidden", open ? "false" : "true");
  document.body.classList.toggle("drawer-open", open);

  // 如果是排行榜弹窗且指定了默认选项卡
  if (drawerId === "rankDrawer" && open && defaultTab) {
    switchRankTab(defaultTab);
  }
}

// 切换排行榜选项卡逻辑
function switchRankTab(tabId) {
  // 更新按钮状态
  document.querySelectorAll('.rank-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });
  // 更新面板显隐
  document.querySelectorAll('.rank-pane').forEach(pane => {
    pane.classList.toggle('active', pane.id === `pane-${tabId}`);
  });
  
  // 切换时自动触发一次刷新（带频率限制的刷新）
  loadRanks();
}
function renderHistory() {
  const el = $("historyList");
  const elDrawer = $("historyList_drawer");
  const board = $("historyBoard");
  const getTemplateCard = (item, idx, template) => {
    const number = Number(item.winningNumber);
    const parity = number % 2 === 0 ? "双" : "单";
    const size = number >= 500 ? "大" : "小";
    const tail = String(number).padStart(3, "0").slice(-1);
    const map = {
      board: { value: padRoute(item.winningNumber), meta: "开奖号码", tone: "number" },
      parity: { value: parity, meta: `${padRoute(item.winningNumber)} · ${number % 2 === 0 ? "偶数" : "奇数"}`, tone: parity === "双" ? "cool" : "hot" },
      size: { value: size, meta: `${padRoute(item.winningNumber)} · ${number >= 500 ? "500以上" : "500以下"}`, tone: size === "大" ? "hot" : "cool" },
      tail: { value: tail, meta: `${padRoute(item.winningNumber)} · 尾号`, tone: "number" }
    };
    const info = map[template] || map.board;
    return `
      <div class="trend-cell history-trend-cell trend-tone-${info.tone} ${idx === 0 ? "is-latest" : ""}">
        <span class="trend-label">第 ${item.roundId} 期</span>
        <strong class="trend-number">${info.value}</strong>
        <span class="trend-meta">${info.meta}</span>
      </div>
    `;
  };
  
  const renderItems = (target, visibleData) => {
    if (!target) return;
    target.innerHTML = "";
    if (!visibleData.length) {
      const currentRoundText = $("roundId")?.textContent || "-";
      target.innerHTML = `<div class="history-empty">暂无记录 (当前: 第 ${currentRoundText} 期)</div>`;
      return;
    }
    visibleData.forEach((item) => {
      const row = document.createElement("div");
      row.className = "ucl-rank-item history-item-ucl";
      row.style.background = "var(--glass)";
      row.style.marginBottom = "8px";
      row.style.padding = "10px";
      row.innerHTML = `
        <div class="ucl-rank-num" style="font-size: 10px; width: auto;">#${item.roundId}</div>
        <div class="ucl-rank-info" style="text-align: center;">
          <strong style="color: var(--gold-bright); font-size: 16px; letter-spacing: 2px;">${padRoute(item.winningNumber)}</strong>
        </div>
        <div class="ucl-rank-info" style="text-align: right; font-size: 10px; color: var(--muted);">
          ${new Date(item.endTime * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      `;
      target.appendChild(row);
    });
  };

  const visibleHistory = historyExpanded ? drawHistory : drawHistory.slice(0, 20);
  if (el) renderItems(el, drawHistory.slice(0, 5));
  if (elDrawer) renderItems(elDrawer, visibleHistory);

  if (board) {
    if (historyTemplate !== "list") {
      board.hidden = false;
      if (elDrawer) elDrawer.hidden = true;
      board.innerHTML = visibleHistory.length
        ? visibleHistory.map((item, idx) => getTemplateCard(item, idx, historyTemplate)).join("")
        : '<div class="trend-empty">暂无历史开奖数据</div>';
    } else {
      board.hidden = true;
      if (elDrawer) elDrawer.hidden = false;
    }
  }

  document.querySelectorAll('.history-template-btn').forEach((btnEl) => {
    btnEl.classList.toggle('active', btnEl.dataset.template === historyTemplate);
  });

  const btn = $("btnToggleHistory");
  if (btn) btn.textContent = historyExpanded ? "收起到 20 期" : "展开到 100 期";
  renderParticipationInfo();
}
async function loadCurrentRoundTickets(roundId) {
  if (!vault || !account) {
    currentRoundTickets = [];
    renderParticipationInfo();
    return;
  }

  const values = [];
  for (let i = 0; i < 5; i++) {
    try {
      const ticket = await vault.userTickets(roundId, account, i);
      values.push(Number(ticket));
    } catch {
      break;
    }
  }
  currentRoundTickets = values;
  renderParticipationInfo();
}
async function loadDrawHistory(currentRoundId) {
  const activeVault = vault || readVault;
  if (!activeVault) return;
  const latestResolvedRound = Number(currentRoundId) - 1;
  if (latestResolvedRound <= 0) {
    drawHistory = [];
    renderHistory();
    return;
  }
  const startRound = Math.max(1, latestResolvedRound - 99);
  const roundIds = [];
  for (let id = latestResolvedRound; id >= startRound; id--) {
    roundIds.push(id);
  }
  const rounds = await Promise.all(roundIds.map((id) => activeVault.rounds(id)));
  drawHistory = roundIds
    .map((id, idx) => {
      const round = rounds[idx];
      return {
        roundId: id,
        resolved: Boolean(round.resolved),
        winningNumber: Number(round.winningNumber),
        endTime: Number(round.endTime)
      };
    })
    .filter((item) => item.resolved);
  renderHistory();
}

function initReadOnlyContext() {
  if (readProvider && readVault) return;
  readProvider = new ethers.JsonRpcProvider(CONFIG.rpcUrls[0]);
  readVault = new ethers.Contract(CONFIG.vaultAddress, VAULT_ABI, readProvider);
}

async function loadPublicData() {
  initReadOnlyContext();
  try {
    await syncChainTime(true);
    const [pool, fortune, roundId, taxToken, round] = await Promise.all([
      readVault.jackpotPool(),
      readVault.fortunePool(),
      readVault.currentRoundId(),
      readVault.taxToken(),
      readVault.currentRoundId().then((id) => readVault.rounds(id))
    ]);
    roundMeta = round;
    $("vaultAddr").textContent = CONFIG.vaultAddress;
    $("jackpotPool").textContent = fmtBNB(pool);
    $("fortunePool").textContent = fmtBNB(fortune);
    $("roundId").textContent = roundId.toString();
    $("taxToken").textContent = taxToken;
    rememberObservedRound(roundId);
    updateRoundStatus();
    await updateLastWinning(roundId);
    await loadDrawHistory(roundId);
    updateActionHints();
  } catch (e) {
    log(`公开数据读取失败: ${humanizeError(e.shortMessage || e.message)}`);
  }
}

async function refreshHomeOverview() {
  log("正在刷新首页轮次与赛事数据...");
  await loadPublicData();
  await loadRanks(true);
  loadLiveFeed(true);
  if (account && vault) {
    refresh().catch((e) => {
      log(`首页附加刷新失败: ${humanizeError(e?.shortMessage || e?.message || String(e))}`);
    });
  }
}

window.refreshHomeOverview = refreshHomeOverview;

async function ensureBscTestnet() {
  const chainId = await window.ethereum.request({ method: "eth_chainId" });
  if (chainId === CONFIG.chainIdHex) return;

  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CONFIG.chainIdHex }]
    });
  } catch {
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: CONFIG.chainIdHex,
        chainName: CONFIG.chainName,
        rpcUrls: CONFIG.rpcUrls,
        nativeCurrency: CONFIG.nativeCurrency,
        blockExplorerUrls: CONFIG.blockExplorerUrls
      }]
    });
  }
}

function resetDashboard() {
  roundMeta = null;
  minHolding = null;
  isEligible = false;
  currentClaimable = 0n;
  reliefPending = null;
  $("vaultAddr").textContent = CONFIG.vaultAddress;
  $("jackpotPool").textContent = "-";
  $("fortunePool").textContent = "-";
  $("roundId").textContent = "-";
  $("myClaimable").textContent = "-";
  $("taxToken").textContent = "-";
  $("myTotalWon").textContent = "-";
  $("myTotalBurned").textContent = "-";
  $("myFortunePoints").textContent = "-";
  $("eligibilityStatus").textContent = "未连接钱包";
  $("lastWinningNumber").textContent = "-";
  $("inputPreview").textContent = "当前战术路线：---";
  $("myRoundInfo").textContent = "我的当前出战：未连接钱包";
  $("historyRefInfo").textContent = "近 5 期参考：等待开奖记录加载";
  if ($("btnClaimRelief")) $("btnClaimRelief").style.display = "none";
  setReliefStatus("持币保底状态：未连接钱包", "muted");
  drawHistory = [];
  participationExpanded = false;
  currentRoundTickets = [];
  historyExpanded = false;
  renderHistory();
  setEligibilityStatus("未连接钱包", "muted");
  setTone("roundState", "muted");
  setTone("lockCountdown", "muted");
  updateRoundStatus();
  updateActionHints();
}

async function restoreAuthorizedConnection(requestAccounts = false) {
  if (!window.ethereum) return false;

  provider = new ethers.BrowserProvider(window.ethereum);
  const accounts = requestAccounts
    ? await provider.send("eth_requestAccounts", [])
    : await provider.send("eth_accounts", []);

  if (!accounts || accounts.length === 0) {
    $("btnConnect").textContent = "球员入场";
    return false;
  }

  await syncChainTime(true);
  account = accounts[0];
  signer = await provider.getSigner(account);
  vault = new ethers.Contract(CONFIG.vaultAddress, VAULT_ABI, signer);

  $("btnConnect").textContent = shortAddr(account);
  $("vaultAddr").textContent = CONFIG.vaultAddress;
  setEligibilityStatus("资格检测中...", "muted");
  registerPlayerToBackend(account).catch((e) => {
    log(`球员登记失败: ${humanizeError(e?.message || String(e))}`);
  });
  refresh().catch((e) => {
    log(`连接后后台刷新失败: ${humanizeError(e?.shortMessage || e?.message || String(e))}`);
  });
  return true;
}

async function connect() {
  await runButtonAction("btnConnect", "连接中...", async () => {
    if (!window.ethereum) {
      await showWalletEntryGuide();
      return;
    }
    setGlobalLoading(true, "连接钱包", "请在钱包中确认连接请求；若为手机端，请确认当前页面已在钱包内置浏览器中打开。");
    try {
      await ensureBscTestnet();
      const connected = await restoreAuthorizedConnection(true);
      if (connected) log(`球员已入场: ${account}`);
    } finally {
      setGlobalLoading(false);
    }
  });
}

async function refresh() {
  if (!vault || !account) return;
  try {
    await syncChainTime(true);
    const [pool, fortune, roundId, claimable, taxToken, streak, epochId] = await Promise.all([
      vault.jackpotPool(),
      vault.fortunePool(),
      vault.currentRoundId(),
      vault.claimableBNB(account),
      vault.taxToken(),
      vault.noWinnerStreak(),
      vault.holderReliefEpochId()
    ]);

    currentClaimable = claimable;
    $("jackpotPool").textContent = fmtBNB(pool);
    $("fortunePool").textContent = fmtBNB(fortune);
    $("roundId").textContent = roundId.toString();
    $("myClaimable").textContent = fmtBNB(claimable);
    $("taxToken").textContent = !taxToken || taxToken === ethers.ZeroAddress ? "待绑定" : taxToken;
    rememberObservedRound(roundId);

    // 检查是否有持币保底奖励可领
    if (epochId > 0n) {
      await checkReliefClaim(Number(epochId));
    } else {
      reliefPending = null;
      $("btnClaimRelief").style.display = "none";
      setReliefStatus(!taxToken || taxToken === ethers.ZeroAddress ? "持币保底状态：比赛尚未开始" : "持币保底状态：当前未触发保底轮", "muted");
    }

    try {
      const [holding, myStats, round] = await Promise.all([
        vault.MIN_HOLDING(),
        vault.stats(account),
        vault.rounds(roundId)
      ]);
      minHolding = holding;
      roundMeta = round;
      
      const won = fmtBNB(myStats.totalWonBNB);
      const burned = `${fmtToken(myStats.totalBurnedToken)} Token`;
      const pts = myStats.fortunePoints.toString();

      $("myTotalWon").textContent = won;
      $("myTotalBurned").textContent = burned;
      $("myFortunePoints").textContent = pts;
      if ($("myFortunePoints_dup")) $("myFortunePoints_dup").textContent = pts;

      // Drawer targets
      if ($("myTotalWon_drawer")) $("myTotalWon_drawer").textContent = won;
      if ($("myTotalBurned_drawer")) $("myTotalBurned_drawer").textContent = burned;
      if ($("myFortunePoints_drawer")) $("myFortunePoints_drawer").textContent = pts;

      updateRoundStatus();
      await updateLastWinning(roundId);
      await loadDrawHistory(roundId);
      await loadCurrentRoundTickets(roundId);
    } catch (e) {
      log(`部分数据读取失败: ${humanizeError(e.shortMessage || e.message)}`);
    }

    try {
      if (minHolding == null) minHolding = await vault.MIN_HOLDING();
      await updateEligibility(taxToken);
    } catch (e) {
      setEligibilityStatus("资格读取失败", "muted");
      log(`资格读取失败: ${humanizeError(e.shortMessage || e.message)}`);
    }

    updateActionHints();
  } catch (e) {
    setEligibilityStatus("资格读取失败", "muted");
    log(`读取失败: ${humanizeError(e.shortMessage || e.message)}`);
  }
}

async function loadRanks(force = false) {
  if (rankLoadBusy) return;
  const now = Date.now();
  if (!force && now - lastRankLoadAt < 10000) return;

  rankLoadBusy = true;

  // 显示加载动画
  const loadingHtml = `
    <div class="loading-state">
      <div class="spinner"></div>
      <div class="loading-text">正在同步球员荣耀数据...</div>
    </div>
  `;
  ['richList_drawer', 'burnList_drawer', 'fortuneList', 'diamondList'].forEach(id => {
    const el = $(id);
    if (el) el.innerHTML = loadingHtml;
  });

  try {
    // 强制不使用缓存获取最新数据
    const res = await fetch(`${BACKEND_API_BASE}/ranks?limit=20`, { cache: "no-store" });
    if (!res.ok) throw new Error(`荣誉榜接口读取失败: ${res.status}`);
    const data = await res.json();

    const renderUCL = (elId, rows, valueKey, valueFormatter) => {
      const el = $(elId);
      if (!el) return;
      el.innerHTML = "";
      if (!rows.length) {
        el.innerHTML = '<li class="empty-state">暂无数据</li>';
        return;
      }
      rows.slice(0, 5).forEach((r, idx) => {
        const item = document.createElement("li");
        item.className = "ucl-rank-item";
        item.innerHTML = `
          <div class="ucl-rank-num">${idx + 1}</div>
          <div class="ucl-rank-avatar">${idx + 1}</div>
          <div class="ucl-rank-info">
            <span class="addr">${shortAddr(r.address)}</span>
            <span class="val">${valueFormatter(r[valueKey], r)}</span>
          </div>
        `;
        el.appendChild(item);
      });
    };

    // Render main grid (UCL style)
    renderUCL("richList", data.rich || [], "totalWonBNB", (_, row) => `${Number(row.totalWonBNB || 0).toFixed(4)} BNB`);
    renderUCL("burnList", data.burn || [], "totalBurnedToken", (v) => `${fmtToken(v)} Token`);
    
    // Render drawer lists (Standard style)
    renderRankList("richList_drawer", data.rich || [], "totalWonBNB", (_, row) => `${Number(row.totalWonBNB || 0).toFixed(6)} BNB`);
    renderRankList("burnList_drawer", data.burn || [], "totalBurnedToken", (v) => `${fmtToken(v)} Token`);
    renderRankList("fortuneList", data.fortune || [], "fortunePoints", (v) => `${v} pts`);
    renderRankList("diamondList", data.diamond || [], "balanceToken", (v) => `${fmtToken(v)} Token`);

    lastRankLoadAt = Date.now();
    log(`荣誉榜刷新完成，已统计 ${(data.counts?.players ?? 0)} 位球员`);
  } catch (e) {
    const errorMsg = '<li class="empty-state">服务暂未启动</li>';
    if ($("richList")) $("richList").innerHTML = errorMsg;
    if ($("burnList")) $("burnList").innerHTML = errorMsg;
    if ($("richList_drawer")) $("richList_drawer").innerHTML = errorMsg;
    if ($("burnList_drawer")) $("burnList_drawer").innerHTML = errorMsg;
    if ($("fortuneList")) $("fortuneList").innerHTML = errorMsg;
    if ($("diamondList")) $("diamondList").innerHTML = errorMsg;
    log(`荣誉榜读取失败: ${humanizeError(e?.message || String(e))}`);
  } finally {
    rankLoadBusy = false;
  }
}


async function sendTx(fn, title) {
  try {
    setGlobalLoading(true, title, "请在钱包中确认操作...");
    const tx = await fn();
    setGlobalLoading(false);
    log(`${title} 已发送: ${tx.hash}`);
    log(`${title} 已提交到链上，正在等待确认，请勿重复点击。`);
    const rc = await tx.wait();
    log(`${title} 已确认: block ${rc.blockNumber}`);
    if (title === "发起进攻") {
      showSuccessToast("进攻成功", `你的出战已上链确认，区块 ${rc.blockNumber}`);
    } else if (title === "领取战利品" || title === "领取持币保底奖励") {
      showSuccessToast("领取成功", `奖励已到账并完成链上确认，区块 ${rc.blockNumber}`);
    }
    refresh().catch((err) => {
      log(`${title} 后台刷新失败: ${humanizeError(err?.shortMessage || err?.message || String(err))}`);
    });
    return rc;
  } catch (e) {
    setGlobalLoading(false);
    const rawMessage = e?.shortMessage || e?.message || String(e);
    const friendlyMsg = humanizeError(rawMessage);
    log(`${title} 失败: ${friendlyMsg}`);
    showAlert(friendlyMsg, `${title}失败`);
    if (isAmbiguousTxError(rawMessage)) {
      refresh().then(() => {
        log(`${title} 状态已重新同步，请确认本轮号码、累计进攻消耗或链上交易记录；若同号码已被占用，通常表示上一笔已成功。`);
      }).catch(() => {});
    }
  }
}

async function ensureAttackAllowance() {
  if (!provider || !signer || !account || !vault) {
    throw new Error("请先连接钱包后再进攻");
  }

  const [taxToken, ticketPrice] = await Promise.all([
    vault.taxToken(),
    vault.TICKET_PRICE()
  ]);

  if (!taxToken || taxToken === ethers.ZeroAddress) {
    throw new Error("参赛代币尚未绑定");
  }

  const token = new ethers.Contract(taxToken, ERC20_ABI, signer);
  const allowance = await token.allowance(account, CONFIG.vaultAddress);
  if (allowance >= ticketPrice) return;

  const approveAmount = ticketPrice * 5n;
  log(`检测到授权不足，正在先授权 ${fmtToken(approveAmount)} Token...`);
  if (!sessionStorage.getItem("golden-boot-approve-tip")) {
    sessionStorage.setItem("golden-boot-approve-tip", "1");
    await showAlert("首次发起进攻可能需要两次确认：先授权参赛代币，再提交进攻交易。完成第一次确认后，请返回钱包继续完成第二次确认。", "进攻提示");
  }
  setGlobalLoading(true, "授权代币", "请在钱包中确认授权请求；首次进攻可能需要完成两次确认。");
  try {
    const tx = await token.approve(CONFIG.vaultAddress, approveAmount);
    setGlobalLoading(false);
    log(`参赛代币授权已发送: ${tx.hash}`);
    log(`参赛代币授权已提交到链上，正在等待确认，请勿重复点击。`);
    const rc = await tx.wait();
    log(`参赛代币授权已确认: block ${rc.blockNumber}`);
  } catch (e) {
    setGlobalLoading(false);
    throw e;
  }
}


resetDashboard();
initReadOnlyContext();
loadPublicData();
loadRanks();
loadLiveFeed();
restoreAuthorizedConnection().catch(() => {});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  loadPublicData().catch(() => {});
  loadLiveFeed().catch(() => {});
  if (account && vault) refresh().catch(() => {});
});
document.querySelectorAll('.rank-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchRankTab(btn.dataset.tab));
  });

  $("btnConnect").onclick = connect;
$("btnOpenPersonal")?.addEventListener("click", () => setDrawerOpen("personalDrawer", true));
$("btnClosePersonal")?.addEventListener("click", () => setDrawerOpen("personalDrawer", false));
$("personalBackdrop")?.addEventListener("click", () => setDrawerOpen("personalDrawer", false));

$("btnOpenRules")?.addEventListener("click", () => setDrawerOpen("rulesDrawer", true));
$("btnCloseRules")?.addEventListener("click", () => setDrawerOpen("rulesDrawer", false));
$("rulesBackdrop")?.addEventListener("click", () => setDrawerOpen("rulesDrawer", false));

$("btnOpenRanks")?.addEventListener("click", async () => {
  setDrawerOpen("rankDrawer", true, "rich");
  await loadRanks();
});
$("btnCloseRanks")?.addEventListener("click", () => setDrawerOpen("rankDrawer", false));
$("drawerBackdrop")?.addEventListener("click", () => setDrawerOpen("rankDrawer", false));
$("btnOpenHistory")?.addEventListener("click", () => setDrawerOpen("historyDrawer", true));
$("btnCloseHistory")?.addEventListener("click", () => setDrawerOpen("historyDrawer", false));
$("historyBackdrop")?.addEventListener("click", () => setDrawerOpen("historyDrawer", false));
$("btnCloseParticipation")?.addEventListener("click", () => setDrawerOpen("participationDrawer", false));
$("participationBackdrop")?.addEventListener("click", () => setDrawerOpen("participationDrawer", false));

$("btnBind")?.addEventListener("click", async () => {
  await runButtonAction("btnBind", "绑定中...", async () => {
    const token = $("inputToken")?.value.trim();
    if (!ethers.isAddress(token)) return alert("请输入正确的代币地址");
    await sendTx(() => vault.bindTaxToken(token), "绑定参赛代币");
  });
});

$("btnBuy").onclick = async () => {
  const n = Number($("inputNumber").value);
  if (!Number.isInteger(n) || n < 0 || n > 999) return alert("号码范围 0-999");
  
  if (busyButtons.has("btnBuy")) return;
  setButtonLoading("btnBuy", true, "进攻提交中...");
  
  try {
    await ensureAttackAllowance();
    const receipt = await sendTx(() => vault.buyTicket(n), "发起进攻");
    if (receipt) {
      registerPlayerToBackend(account).catch(() => {});
    }
  } catch (e) {
    log(`发起进攻失败: ${humanizeError(e.shortMessage || e.message)}`);
  } finally {
    setButtonLoading("btnBuy", false);
    setGlobalLoading(false);
    updateActionHints();
  }
};

async function triggerDrawAction(triggerId = "btnDraw") {
  await runButtonAction(triggerId, "开奖中...", async () => {
    await sendTx(() => vault.draw(), "终场开奖");
  });
}

$("btnDraw")?.addEventListener("click", async () => {
  await triggerDrawAction("btnDraw");
});
$("btnTopDraw")?.addEventListener("click", async () => {
  const confirmed = await showConfirm("如果遇到网络卡顿或轮次未自动切换，你可以手动触发链上开奖/刷新。是否现在发起该操作？", "刷新轮次");
  if (confirmed) {
    await triggerDrawAction("btnTopDraw");
  }
});

$("btnClaimRelief")?.addEventListener("click", async () => {
  await runButtonAction("btnClaimRelief", "领取中...", async () => {
    if (!reliefPending || !vault) return;
    log(`[保底] 准备领取 Epoch ${reliefPending.epochId}，金额 ${fmtBNB(reliefPending.amountWei)}，proof 节点数 ${reliefPending.proof?.length || 0}`);
    await sendTx(
      () => vault.claimHolderRelief(reliefPending.epochId, reliefPending.amountWei, reliefPending.proof),
      "领取持币保底奖励"
    );
    $("btnClaimRelief").style.display = "none";
  });
});

$("btnClaim").onclick = async () => {
  await runButtonAction("btnClaim", "领取中...", async () => {
    await sendTx(() => vault.claim(), "领取战利品");
  });
};

$("btnLoadRanks")?.addEventListener("click", () => loadRanks(true));
$("btnToggleParticipation")?.addEventListener("click", () => {
  renderParticipationInfo();
  setDrawerOpen("participationDrawer", true);
});
$("btnToggleHistory")?.addEventListener("click", () => {
  historyExpanded = !historyExpanded;
  renderHistory();
});
document.querySelectorAll('.history-template-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    historyTemplate = btn.dataset.template;
    renderHistory();
  });
});
$("inputNumber").addEventListener("input", (e) => {
  $("inputPreview").textContent = `当前战术路线：${padRoute(e.target.value)}`;
});
setInterval(async () => {
  try {
    await syncChainTime();
  } catch {}
  updateRoundStatus();
  updateActionHints();
}, 1000);

setInterval(async () => {
  try {
    await checkRoundTransitionAutoReload();
  } catch {}
}, 5000);

setInterval(() => {
  loadLiveFeed();
}, 8000);

setInterval(() => {
  loadLiveFeed();
}, 8000);

// 钱包/网络切换时轻量刷新（避免 reload 循环）
if (window.ethereum) {
  window.ethereum.on("accountsChanged", async (accounts) => {
    if (!accounts || accounts.length === 0) {
      account = null;
      signer = null;
      vault = null;
      $("btnConnect").textContent = "球员入场";
      log("球员已离场");
      resetDashboard();
      await loadPublicData();
      return;
    }
    provider = new ethers.BrowserProvider(window.ethereum);
    account = accounts[0];
    signer = await provider.getSigner(account);
    vault = new ethers.Contract(CONFIG.vaultAddress, VAULT_ABI, signer);
    $("btnConnect").textContent = shortAddr(account);
    setEligibilityStatus("资格检测中...", "muted");
    await registerPlayerToBackend(account);
    await refresh();
  });

  window.ethereum.on("chainChanged", async () => {
    log("检测到赛场切换，正在刷新数据...");
    provider = new ethers.BrowserProvider(window.ethereum);
    signer = await provider.getSigner();
    account = await signer.getAddress();
    vault = new ethers.Contract(CONFIG.vaultAddress, VAULT_ABI, signer);
    await registerPlayerToBackend(account);
    await refresh();
  });
}