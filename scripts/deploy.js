import hre from "hardhat";

async function main() {
  console.log("Starting deployment of JackpotVault...");

  const { chainId, name } = await hre.ethers.provider.getNetwork();
  if (chainId !== 56n) {
    throw new Error(`Wrong network: ${name} (${chainId}). Please use --network bsc`);
  }

  const treasuryWallet = process.env.TREASURY_WALLET;
  if (!treasuryWallet) {
    throw new Error("Missing TREASURY_WALLET in .env");
  }

  const Vault = await hre.ethers.getContractFactory("JackpotVault");
  const vault = await Vault.deploy(treasuryWallet);
  await vault.waitForDeployment();

  const vaultAddress = await vault.getAddress();
  console.log(`JackpotVault deployed to: ${vaultAddress}`);
  console.log("Use this vault address as FLAP funds recipient wallet (mainnet).");
  console.log("After token launch, call bindTaxToken(tokenAddress) once.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});