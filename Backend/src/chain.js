import { ethers } from "ethers";

const BSC_NETWORK = { chainId: 56, name: "bsc" };

export function createChain({ rpcUrl, rpcUrls = [], vaultAddress, botPrivateKey = null }) {
  const urls = (rpcUrls.length ? rpcUrls : [rpcUrl]).filter(Boolean);
  const providers = urls.map((url) => new ethers.JsonRpcProvider(url, BSC_NETWORK, {
    staticNetwork: true,
    batchMaxCount: 1,
    polling: true
  }));
  const provider = providers.length === 1
    ? providers[0]
    : new ethers.FallbackProvider(
        providers.map((p, index) => ({ provider: p, priority: index + 1, weight: 1, stallTimeout: 1200 })),
        undefined,
        { quorum: 1 }
      );
  const VAULT_ABI = [
    "function taxToken() view returns (address)",
    "function jackpotPool() view returns (uint256)",
    "function fortunePool() view returns (uint256)",
    "function noWinnerStreak() view returns (uint256)",
    "function holderReliefEpochId() view returns (uint256)",
    "function currentRoundId() view returns (uint256)",
    "function rounds(uint256) view returns (uint256 startTime, uint256 endTime, uint16 winningNumber, bool resolved)",
    "function stats(address) view returns (uint256 totalWonBNB, uint256 totalBurnedToken, uint256 fortunePoints)",
    "function claimableBNB(address) view returns (uint256)",
    "function draw()",
    "function setHolderReliefMerkleRoot(uint256 epochId, bytes32 root)",
    // 严格匹配合约 struct HolderReliefEpoch 顺序:
    // 0:poolAmount, 1:remainingAmount, 2:snapshotBlock, 3:triggeredAt, 4:merkleRoot, 5:claimDeadline
    "function holderReliefEpochs(uint256) view returns (uint256 poolAmount, uint256 remainingAmount, uint256 snapshotBlock, uint256 triggeredAt, bytes32 merkleRoot, uint256 claimDeadline)",
  ];
  const vault = new ethers.Contract(vaultAddress, VAULT_ABI, provider);
  const botWallet = botPrivateKey ? new ethers.Wallet(botPrivateKey, provider) : null;
  const drawVault = botWallet ? new ethers.Contract(vaultAddress, VAULT_ABI, botWallet) : null;
  return { provider, vault, botWallet, drawVault, rpcUrls: urls };
}

export function buyTicketSelector() {
  return ethers.id("buyTicket(uint16)").slice(0, 10);
}
