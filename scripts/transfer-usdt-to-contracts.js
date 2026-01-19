const mongoose = require("mongoose");
const path = require("path");
const { ethers } = require("ethers");
require("dotenv").config();

const ContractModel = require(path.join("..", "src", "models", "Contract"));
const BlockchainService = require(path.join(
  "..",
  "src",
  "services",
  "BlockchainService"
));
const config = require("../config");

// ERC20 ABI for transfer function
const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

async function main() {
  const { MONGODB_URI, BSC_RPC_URL, HOT_WALLET_PRIVATE_KEY, USDT_BSC } =
    process.env;

  if (!MONGODB_URI) {
    console.error("❌ MONGODB_URI missing from environment");
    process.exit(1);
  }

  if (!BSC_RPC_URL) {
    console.error("❌ BSC_RPC_URL missing from environment");
    process.exit(1);
  }

  if (!HOT_WALLET_PRIVATE_KEY) {
    console.error("❌ HOT_WALLET_PRIVATE_KEY missing from environment");
    process.exit(1);
  }

  if (!USDT_BSC) {
    console.error("❌ USDT_BSC token address missing from environment");
    process.exit(1);
  }

  // Setup wallet and provider
  const provider = new ethers.JsonRpcProvider(BSC_RPC_URL);
  const privateKey = HOT_WALLET_PRIVATE_KEY.startsWith("0x")
    ? HOT_WALLET_PRIVATE_KEY
    : "0x" + HOT_WALLET_PRIVATE_KEY;
  const wallet = new ethers.Wallet(privateKey, provider);

  console.log("🔌 Connecting to database...");
  await mongoose.connect(MONGODB_URI);
  console.log("✅ Connected to database\n");

  // Get USDT contract instance
  const usdtContract = new ethers.Contract(USDT_BSC, ERC20_ABI, wallet);

  // Get actual decimals from contract or use BlockchainService
  let usdtDecimals = BlockchainService.getTokenDecimals("USDT", "BSC");
  try {
    const contractDecimals = await usdtContract.decimals();
    usdtDecimals = contractDecimals;
    console.log(`📊 USDT decimals (from contract): ${usdtDecimals}`);
  } catch (e) {
    console.log(`📊 USDT decimals (from config): ${usdtDecimals}`);
  }

  // Check wallet balance
  const walletBalance = await usdtContract.balanceOf(wallet.address);
  const walletBalanceFormatted = ethers.formatUnits(
    walletBalance,
    usdtDecimals
  );
  console.log(`💰 Wallet Address: ${wallet.address}`);
  console.log(`💰 Wallet USDT Balance: ${walletBalanceFormatted} USDT\n`);

  // Amount to transfer per contract (0.1 USDT)
  const transferAmount = 0.1;
  const transferAmountWei = ethers.parseUnits(
    transferAmount.toString(),
    usdtDecimals
  );

  // Fetch only USDT contracts on BSC
  const contracts = await ContractModel.find({
    status: "deployed",
    token: "USDT",
    network: "BSC",
  }).sort({
    feePercent: 1,
  });

  if (contracts.length === 0) {
    console.log("❌ No USDT contracts on BSC found");
    await mongoose.disconnect();
    return;
  }

  // Calculate total needed
  const totalNeeded = transferAmount * contracts.length;
  const totalNeededWei = ethers.parseUnits(
    totalNeeded.toString(),
    usdtDecimals
  );

  console.log(`📋 Found ${contracts.length} USDT contract(s) on BSC`);
  console.log(`💵 Amount per contract: ${transferAmount} USDT`);
  console.log(`💵 Total needed: ${totalNeeded} USDT\n`);

  if (walletBalance < totalNeededWei) {
    console.error(
      `❌ Insufficient balance! Need ${totalNeeded} USDT but have ${walletBalanceFormatted} USDT`
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  // Ask for confirmation
  const readline = require("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(
    `⚠️  WARNING: This will transfer ${transferAmount} USDT to ${contracts.length} contract(s)`
  );
  console.log(`💰 Total amount: ${totalNeeded} USDT`);
  console.log(`📍 From: ${wallet.address}\n`);

  const answer = await new Promise((resolve) => {
    rl.question("Do you want to proceed? (yes/no): ", resolve);
  });

  rl.close();

  if (answer.toLowerCase() !== "yes" && answer.toLowerCase() !== "y") {
    console.log("❌ Transfer cancelled by user");
    await mongoose.disconnect();
    return;
  }

  console.log("\n" + "=".repeat(80));
  console.log("🚀 STARTING TRANSFERS");
  console.log("=".repeat(80));
  console.log("");

  let successCount = 0;
  let failCount = 0;
  const results = [];

  // Transfer to each contract (all are USDT on BSC already filtered)
  for (let i = 0; i < contracts.length; i++) {
    const contract = contracts[i];
    const contractAddress = contract.address;
    const token = contract.token;
    const network = contract.network;

    try {
      console.log(
        `${i + 1}/${
          contracts.length
        }. Transferring to ${token} on ${network.toUpperCase()}`
      );
      console.log(`   Contract: ${contractAddress}`);
      console.log(`   Amount: ${transferAmount} USDT`);

      // Get current nonce
      let nonce;
      try {
        nonce = await provider.getTransactionCount(wallet.address, "latest");
      } catch (nonceError) {
        try {
          nonce = await provider.getTransactionCount(wallet.address);
        } catch (fallbackError) {
          throw new Error(
            `Failed to get transaction nonce: ${fallbackError.message}`
          );
        }
      }

      // Transfer USDT
      const tx = await usdtContract.transfer(
        contractAddress,
        transferAmountWei,
        {
          nonce: nonce,
        }
      );

      console.log(`   ⏳ Transaction sent: ${tx.hash}`);
      console.log(`   ⏳ Waiting for confirmation...`);

      // Wait for transaction confirmation
      const receipt = await tx.wait();
      const txHash = receipt.transactionHash || receipt.hash || tx.hash;

      console.log(`   ✅ Success! Transaction: ${txHash}`);
      console.log("");

      successCount++;
      results.push({
        contract: contractAddress,
        token,
        network,
        amount: transferAmount,
        txHash,
        status: "success",
      });

      // Small delay between transactions to avoid nonce issues
      if (i < contracts.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } catch (error) {
      console.log(`   ❌ Failed: ${error.message}`);
      console.log("");

      failCount++;
      results.push({
        contract: contractAddress,
        token,
        network,
        amount: transferAmount,
        txHash: null,
        status: "failed",
        error: error.message,
      });
    }
  }

  // Summary
  console.log("=".repeat(80));
  console.log("📊 TRANSFER SUMMARY");
  console.log("=".repeat(80));
  console.log(`✅ Successful: ${successCount}`);
  console.log(`❌ Failed: ${failCount}`);
  console.log(
    `💰 Total transferred: ${(successCount * transferAmount).toFixed(6)} USDT`
  );
  console.log("");

  if (successCount > 0) {
    console.log("✅ Successful Transfers:");
    results
      .filter((r) => r.status === "success")
      .forEach((result, idx) => {
        console.log(
          `   ${idx + 1}. ${result.token} on ${result.network.toUpperCase()}`
        );
        console.log(`      Contract: ${result.contract}`);
        console.log(`      Amount: ${result.amount} USDT`);
        console.log(`      TX: ${result.txHash}`);
        console.log("");
      });
  }

  if (failCount > 0) {
    console.log("❌ Failed Transfers:");
    results
      .filter((r) => r.status === "failed")
      .forEach((result, idx) => {
        console.log(
          `   ${idx + 1}. ${result.token} on ${result.network.toUpperCase()}`
        );
        console.log(`      Contract: ${result.contract}`);
        console.log(`      Amount: ${result.amount} USDT`);
        console.log(`      Error: ${result.error}`);
        console.log("");
      });
  }

  // Check final wallet balance
  const finalBalance = await usdtContract.balanceOf(wallet.address);
  const finalBalanceFormatted = ethers.formatUnits(finalBalance, usdtDecimals);
  console.log(`💰 Final Wallet Balance: ${finalBalanceFormatted} USDT`);

  console.log("=".repeat(80));

  await mongoose.disconnect();
  console.log("\n✅ Disconnected from database");
}

main().catch((e) => {
  console.error("❌ Error:", e);
  process.exit(1);
});
