const mongoose = require("mongoose");
const GroupPool = require("../src/models/GroupPool");
const Contract = require("../src/models/Contract");
const BlockchainService = require("../src/services/BlockchainService");
const config = require("../config");

async function showGroupAndContractFees() {
  console.log("📊 Group Fee vs Contract Fee Report\n");
  await mongoose.connect(config.MONGODB_URI);

  const groups = await GroupPool.find({}).sort({ groupId: 1 });

  console.log(`Found ${groups.length} groups\n`);
  console.log("=".repeat(80));

  for (const group of groups) {
    const groupName = group.groupId.toString();
    const groupFee = group.feePercent;

    console.log(`\n📋 Group ID: ${group.groupId}`);
    console.log(`   Group Fee (DB): ${groupFee}%`);
    console.log(`   Status: ${group.status}`);

    // Check if group has contracts map
    if (group.contracts && group.contracts.size > 0) {
      console.log(`   Contracts:`);

      for (const [key, value] of group.contracts) {
        const contractFee = value.feePercent;
        const match = contractFee === groupFee ? "✅" : "❌";

        console.log(
          `      ${match} ${key}: ${value.address.substring(
            0,
            10
          )}... (Contract Fee: ${contractFee}%)`
        );
      }
    } else {
      console.log(`   ⚠️  No contracts assigned`);
    }

    console.log("-".repeat(80));
  }

  // Summary
  console.log("\n\n📊 SUMMARY BY FEE TIER:");
  const feeGroups = {};

  for (const group of groups) {
    const fee = group.feePercent || "undefined";
    if (!feeGroups[fee]) {
      feeGroups[fee] = [];
    }
    feeGroups[fee].push(group.groupId);
  }

  for (const [fee, groupIds] of Object.entries(feeGroups)) {
    console.log(`\n${fee}% Fee: ${groupIds.length} groups`);
    groupIds.forEach((id) => console.log(`   - ${id}`));
  }

  await mongoose.disconnect();
}

showGroupAndContractFees().catch(console.error);
