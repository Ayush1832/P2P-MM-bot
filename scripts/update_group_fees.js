require("dotenv").config();
const mongoose = require("mongoose");
const GroupPool = require("../src/models/GroupPool"); // Adjust path if needed
const config = require("../config");

// Migration Logic:
// 0.25 -> 0
// 0.50 -> 0.25
// 0.75 -> 0.50

async function migrateFees() {
  console.log("🚀 Starting Fee Migration...");

  if (mongoose.connection.readyState === 0) {
    if (!config.MONGODB_URI) {
      console.error("❌ MONGODB_URI is missing");
      process.exit(1);
    }
    await mongoose.connect(config.MONGODB_URI);
    console.log("✅ Connected to MongoDB");
  }

  // We fetch all groups first to avoid "chained update" issues
  // (e.g. updating 0.75->0.5, then later incorrectly updating that same group 0.5->0.25)
  // Processing in memory is safer here.

  const groups = await GroupPool.find({});
  console.log(`Found ${groups.length} total groups.`);

  let updatedCount = 0;
  let skippedCount = 0;

  for (const group of groups) {
    let oldFee = group.feePercent;
    let newFee = oldFee; // Default to no change

    // Precise floating point comparison can be tricky, but these are simple decimals
    if (oldFee === 0.25) {
      newFee = 0;
    } else if (oldFee === 0.5) {
      newFee = 0.25;
    } else if (oldFee === 0.75) {
      newFee = 0.5;
    } else {
      // No matching rule (e.g. already 0, or some custom value)
      skippedCount++;
      continue;
    }

    if (oldFee !== newFee) {
      group.feePercent = newFee;
      await group.save();
      console.log(
        `✅ Updated Group ${group.groupId} (${
          group.groupTitle || "No Title"
        }): ${oldFee}% -> ${newFee}%`,
      );
      updatedCount++;
    }
  }

  console.log("\n---- Migration Complete ----");
  console.log(`Updated: ${updatedCount}`);
  console.log(`Skipped: ${skippedCount}`);
}

migrateFees()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Error during migration:", error);
    process.exit(1);
  });
