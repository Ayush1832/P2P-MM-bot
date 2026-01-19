const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config();

const ContractModel = require(path.join("..", "src", "models", "Contract"));

async function main() {
  const { MONGODB_URI } = process.env;

  if (!MONGODB_URI) {
    console.error("MONGODB_URI missing from environment");
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI);

  const contracts = await ContractModel.find({ name: "EscrowVault" }).sort({
    token: 1,
    network: 1,
    feePercent: 1,
  });

  if (contracts.length === 0) {
    console.log("❌ No contracts found");
  } else {
    contracts.forEach((contract, index) => {
      const feeDisplay =
        contract.feePercent !== undefined && contract.feePercent !== null
          ? `${contract.feePercent}%`
          : "Unknown";
      console.log(`${index + 1}. ${contract.token} on ${contract.network}`);
      console.log(`   Address: ${contract.address}`);
      console.log(`   Fee: ${feeDisplay}`);
      console.log(`   Deployed: ${contract.deployedAt.toISOString()}`);
      console.log("");
    });

    // Group by fee percentage
    const feeGroups = {};
    contracts.forEach((contract) => {
      const fee = contract.feePercent;
      if (!feeGroups[fee]) feeGroups[fee] = [];
      feeGroups[fee].push(`${contract.token}-${contract.network}`);
    });

    console.log("📊 Contracts by Fee Percentage:");
    Object.keys(feeGroups)
      .sort((a, b) => Number(a) - Number(b))
      .forEach((fee) => {
        console.log(`  ${fee}%: ${feeGroups[fee].join(", ")}`);
      });
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
