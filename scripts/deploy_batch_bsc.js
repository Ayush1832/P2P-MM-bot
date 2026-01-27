const hre = require("hardhat");
const mongoose = require("mongoose");
const config = require("../config");
const Contract = require("../src/models/Contract");
const GroupPool = require("../src/models/GroupPool");

async function main() {
  console.log("🚀 Starting Batch Deployment on BSC...");

  // 1. Connect to MongoDB
  if (mongoose.connection.readyState === 0) {
    if (!config.MONGODB_URI) {
      console.error("❌ MONGODB_URI is missing in config");
      process.exit(1);
    }
    await mongoose.connect(config.MONGODB_URI);
    console.log("✅ Connected to MongoDB");
  }

  // 2. Configuration
  const usdtAddress = config.USDT_BSC;
  const usdcAddress = config.USDC_BSC;
  const feeWallet = config.FEE_WALLET_BSC;

  if (!usdtAddress || !usdcAddress || !feeWallet) {
    console.error(
      "❌ Missing configuration addresses (USDT, USDC, or Fee Wallet)",
    );
    console.log({ usdtAddress, usdcAddress, feeWallet });
    process.exit(1);
  }

  const USDT_COUNT = 20;
  const USDC_COUNT = 20;

  const deployedUSDT = [];
  const deployedUSDC = [];

  // 3. Deploy USDT Contracts
  console.log(`\n📦 Deploying ${USDT_COUNT} USDT Contracts...`);
  const EscrowVault = await hre.ethers.getContractFactory("EscrowVault");

  for (let i = 0; i < USDT_COUNT; i++) {
    const contract = await EscrowVault.deploy(usdtAddress, feeWallet);
    await contract.waitForDeployment();
    const address = await contract.getAddress();

    console.log(`   [${i + 1}/${USDT_COUNT}] USDT Vault Deployed: ${address}`);

    // Save to Contract DB
    await Contract.create({
      name: "EscrowVault",
      token: "USDT",
      network: "BSC",
      address: address,
      feePercent: 0, // Fee logic removed from contract, but schema requires field
      status: "deployed",
    });

    deployedUSDT.push(address);
    // Add small delay to avoid rate limits
    await new Promise((r) => setTimeout(r, 1000));
  }

  // 4. Deploy USDC Contracts
  console.log(`\n📦 Deploying ${USDC_COUNT} USDC Contracts...`);

  for (let i = 0; i < USDC_COUNT; i++) {
    const contract = await EscrowVault.deploy(usdcAddress, feeWallet);
    await contract.waitForDeployment();
    const address = await contract.getAddress();

    console.log(`   [${i + 1}/${USDC_COUNT}] USDC Vault Deployed: ${address}`);

    // Save to Contract DB
    await Contract.create({
      name: "EscrowVault",
      token: "USDC",
      network: "BSC",
      address: address,
      feePercent: 0,
      status: "deployed",
    });

    deployedUSDC.push(address);
    await new Promise((r) => setTimeout(r, 1000));
  }

  // 5. Assign to Groups
  console.log("\n👥 Assigning Contracts to Groups...");

  // Get all available groups
  const groups = await GroupPool.find({ status: { $ne: "archived" } });
  console.log(`Found ${groups.length} active groups.`);

  let assignedCount = 0;

  for (const group of groups) {
    if (deployedUSDT.length === 0 || deployedUSDC.length === 0) {
      console.log("⚠️ Ran out of deployed contracts!");
      break;
    }

    const usdt = deployedUSDT.shift();
    const usdc = deployedUSDC.shift();

    if (!group.contracts) {
      group.contracts = new Map();
    }

    // Assign USDT (BSC)
    group.contracts.set("USDT_BSC", {
      address: usdt,
      network: "BSC",
    });

    // Assign USDC (BSC)
    group.contracts.set("USDC_BSC", {
      address: usdc,
      network: "BSC",
    });

    await group.save();
    console.log(
      `   ✅ Assigned to Group ${group.groupId} (${
        group.groupTitle || "No Title"
      }):`,
    );
    console.log(`      USDT: ${usdt}`);
    console.log(`      USDC: ${usdc}`);

    assignedCount++;
  }

  console.log(
    `\n🎉 Process Complete! Assigned contracts to ${assignedCount} groups.`,
  );
  console.log(`   Unused USDT Contracts: ${deployedUSDT.length}`);
  console.log(`   Unused USDC Contracts: ${deployedUSDC.length}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
