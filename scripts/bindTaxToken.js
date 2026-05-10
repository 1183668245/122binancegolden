import hre from "hardhat";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  console.log("Starting bindTaxToken...");

  const { chainId, name } = await hre.ethers.provider.getNetwork();
  if (chainId !== 56n) {
    throw new Error(`Wrong network: ${name} (${chainId}). Please use --network bsc`);
  }

  const vaultAddress = process.env.VAULT_ADDRESS;
  const tokenAddress = process.env.TOKEN_ADDRESS;

  if (!vaultAddress || !hre.ethers.isAddress(vaultAddress)) {
    throw new Error(`Invalid VAULT_ADDRESS: ${vaultAddress}`);
  }

  if (!tokenAddress || !hre.ethers.isAddress(tokenAddress)) {
    throw new Error(`Invalid TOKEN_ADDRESS: ${tokenAddress}`);
  }

  const [signer] = await hre.ethers.getSigners();
  const signerAddress = await signer.getAddress();

  const vault = await hre.ethers.getContractAt("JackpotVault", vaultAddress, signer);
  const owner = await vault.owner();
  const currentTaxToken = await vault.taxToken();

  console.log(`Network:        ${name} (${chainId})`);
  console.log(`Signer:         ${signerAddress}`);
  console.log(`Vault:          ${vaultAddress}`);
  console.log(`Owner:          ${owner}`);
  console.log(`Current token:  ${currentTaxToken}`);
  console.log(`Target token:   ${tokenAddress}`);

  if (signerAddress.toLowerCase() !== owner.toLowerCase()) {
    throw new Error("Current signer is not the contract owner");
  }

  if (currentTaxToken !== hre.ethers.ZeroAddress) {
    throw new Error(`Tax token already bound: ${currentTaxToken}`);
  }

  const tx = await vault.bindTaxToken(tokenAddress);
  console.log(`bindTaxToken tx sent: ${tx.hash}`);

  const rc = await tx.wait();
  console.log(`bindTaxToken confirmed in block: ${rc.blockNumber}`);

  const updatedTaxToken = await vault.taxToken();
  console.log(`Updated taxToken: ${updatedTaxToken}`);
  console.log("bindTaxToken completed successfully.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});