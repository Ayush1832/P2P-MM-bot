const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config();

const ContractModel = require(path.join("..", "src", "models", "Contract"));
const BlockchainService = require(path.join(
  "..",
  "src",
  "services",
  "BlockchainService"
));

async function main() {
  const { MONGODB_URI } = process.env;

  if (!MONGODB_URI) {
    console.error("❌ MONGODB_URI missing from environment");
    process.exit(1);
  }

  console.log("🔌 Connecting to database...");
  await mongoose.connect(MONGODB_URI);
  console.log("✅ Connected to database\n");

  // Fetch all contracts
  const contracts = await ContractModel.find({ status: "deployed" }).sort({
    network: 1,
    token: 1,
    feePercent: 1,
  });

  if (contracts.length === 0) {
    console.log("❌ No deployed contracts found");
    await mongoose.disconnect();
    return;
  }

  console.log(`📋 Found ${contracts.length} deployed contract(s)\n`);
  console.log("=".repeat(80));
  console.log("💰 CONTRACT BALANCES");
  console.log("=".repeat(80));
  console.log("");

  let totalBalance = 0;
  const balancesByToken = {};

  // Process each contract
  for (let i = 0; i < contracts.length; i++) {
    const contract = contracts[i];
    const contractAddress = contract.address;
    const token = contract.token;
    const network = contract.network;
    const feePercent = contract.feePercent || 0;

    try {
      console.log(`${i + 1}. ${token} on ${network.toUpperCase()}`);
      console.log(`   Contract: ${contractAddress}`);
      console.log(`   Fee: ${feePercent}%`);

      // Get token balance for this contract
      const balance = await BlockchainService.getTokenBalance(
        token,
        network,
        contractAddress
      );

      if (balance > 0) {
        const balanceFormatted = balance.toFixed(6);
        console.log(`   💰 Balance: ${balanceFormatted} ${token}`);

        // Track totals
        totalBalance += balance;
        const key = `${token}-${network}`;
        if (!balancesByToken[key]) {
          balancesByToken[key] = { token, network, total: 0 };
        }
        balancesByToken[key].total += balance;
      } else {
        console.log(`   💰 Balance: 0.000000 ${token}`);
      }

      console.log("");
    } catch (error) {
      console.log(`   ❌ Error fetching balance: ${error.message}`);
      console.log("");
    }
  }

  // Summary
  console.log("=".repeat(80));
  console.log("📊 SUMMARY");
  console.log("=".repeat(80));

  if (Object.keys(balancesByToken).length > 0) {
    console.log("\n💰 Balances by Token/Network:");
    Object.keys(balancesByToken)
      .sort()
      .forEach((key) => {
        const { token, network, total } = balancesByToken[key];
        console.log(
          `   ${token} on ${network.toUpperCase()}: ${total.toFixed(
            6
          )} ${token}`
        );
      });

    console.log(
      `\n💵 Total Balance Across All Contracts: ${totalBalance.toFixed(6)}`
    );
  } else {
    console.log("\nℹ️  No balances found in any contracts");
  }

  console.log("\n" + "=".repeat(80));

  await mongoose.disconnect();
  console.log("\n✅ Disconnected from database");
}

main().catch((e) => {
  console.error("❌ Error:", e);
  process.exit(1);
});
