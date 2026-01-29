require("dotenv").config();
const mongoose = require("mongoose");
const GroupPool = require("../src/models/GroupPool");

const MONGODB_URI = process.env.MONGODB_URI;

async function setRoomFees() {
  try {
    console.log("Connecting to MongoDB...");
    await mongoose.connect(MONGODB_URI);
    console.log("Connected to MongoDB.");

    // Fetch all groups
    const groups = await GroupPool.find({});
    console.log(`Found ${groups.length} groups in pool.`);

    let updated = 0;

    for (const group of groups) {
      const title = group.groupTitle || "";

      // Extract room number from title like "MM Room 1", "MM Room 15", etc.
      const match = title.match(/MM Room (\d+)/i);
      if (!match) {
        console.log(`Skipping "${title}" - does not match "MM Room X" pattern`);
        continue;
      }

      const roomNumber = parseInt(match[1], 10);
      let feePercent;

      if (roomNumber >= 1 && roomNumber <= 10) {
        feePercent = 0;
      } else if (roomNumber >= 11 && roomNumber <= 15) {
        feePercent = 0.25;
      } else if (roomNumber >= 16 && roomNumber <= 20) {
        feePercent = 0.5;
      } else {
        console.log(
          `Skipping "${title}" - room number ${roomNumber} out of range 1-20`,
        );
        continue;
      }

      // Update the group
      group.feePercent = feePercent;
      await group.save();
      console.log(
        `✅ Set "${title}" (Room ${roomNumber}) → feePercent: ${feePercent}%`,
      );
      updated++;
    }

    console.log(`\nDone! Updated ${updated} groups.`);
    process.exit(0);
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

setRoomFees();
