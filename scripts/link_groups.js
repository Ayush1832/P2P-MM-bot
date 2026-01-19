const mongoose = require("mongoose");
const GroupPool = require("../src/models/GroupPool");
const Contract = require("../src/models/Contract");
const config = require("../config");

async function main() {
  console.log("Starting group-contract linking (USDT & USDC)...");

  await mongoose.connect(config.MONGODB_URI);
  console.log("Connected to MongoDB.");

  // Fetch groups specifically targeting "Room 24" to "Room 43"
  // Regex: 24-29, 30-39, 40-43
  const targetRegex = /^Room (2[4-9]|3[0-9]|4[0-5])$/;

  const allGroups = await GroupPool.find({ status: "available" }).sort({
    createdAt: 1,
  });
  const groups = allGroups.filter((g) => targetRegex.test(g.groupTitle));

  console.log(`Found ${groups.length} matching groups (Room 24-43).`);

  if (groups.length < 20) {
    console.warn(
      `⚠️ Warning: Found only ${groups.length} matching groups. Logic expects 20.`
    );
  }

  // Fetch Contracts (Newest first)
  const usdtContracts = await Contract.find({
    token: "USDT",
    network: "BSC",
  }).sort({ createdAt: -1 });
  const usdcContracts = await Contract.find({
    token: "USDC",
    network: "BSC",
  }).sort({ createdAt: -1 });
  // Add TRON Contracts fetch
  const tronContracts = await Contract.find({
    token: "USDT",
    network: "TRON",
  }).sort({ createdAt: -1 });

  // Helper to filter by fee
  const getContracts = (list, fee, count) =>
    list.filter((c) => c.feePercent === fee).slice(0, count);

  // USDT Allocations (Unique 1:1) - Scaled for 20 (15 / 3 / 2)
  const usdt025 = getContracts(usdtContracts, 0.25, 15);
  const usdt050 = getContracts(usdtContracts, 0.5, 3);
  const usdt075 = getContracts(usdtContracts, 0.75, 2);

  // USDC Allocations (Shared) - Covers 16 / 4 / 4
  const usdc025 = getContracts(usdcContracts, 0.25, 4);
  const usdc050 = getContracts(usdcContracts, 0.5, 1);
  const usdc075 = getContracts(usdcContracts, 0.75, 1);

  // TRON Allocations (Shared) - Covers 16 / 4 / 4
  const tron025 = getContracts(tronContracts, 0.25, 3);
  const tron050 = getContracts(tronContracts, 0.5, 1);
  const tron075 = getContracts(tronContracts, 0.75, 1);

  console.log(
    `USDT Available: 0.25%(${usdt025.length}/15), 0.50%(${usdt050.length}/3), 0.75%(${usdt075.length}/2)`
  );
  console.log(
    `USDC Available: 0.25%(${usdc025.length}/4), 0.50%(${usdc050.length}/1), 0.75%(${usdc075.length}/1)`
  );
  console.log(
    `TRON Available: 0.25%(${tron025.length}/3), 0.50%(${tron050.length}/1), 0.75%(${tron075.length}/1)`
  );

  let groupIndex = 0;

  // --- Tier 1: 0.25% (15 Groups) ---
  for (let i = 0; i < 15; i++) {
    if (groupIndex >= groups.length) break;
    const group = groups[groupIndex];
    const usdt = usdt025[i];

    // Distribute 4 USDC contracts among 15 groups (1:4 ratio) -> Math.floor(i / 4)
    // Distribute 3 TRON contracts among 15 groups (1:5 ratio) -> Math.floor(i / 5)

    const usdcIndex = Math.floor(i / 4);
    const tronIndex = Math.floor(i / 5);

    const usdc = usdc025[usdcIndex];
    const tron = tron025[tronIndex];

    if (usdt && usdc && tron) {
      group.contracts = {
        USDT: {
          address: usdt.address,
          feePercent: usdt.feePercent,
          network: "BSC",
        },
        USDC: {
          address: usdc.address,
          feePercent: usdc.feePercent,
          network: "BSC",
        },
        USDT_TRON: {
          address: tron.address,
          feePercent: tron.feePercent,
          network: "TRON",
        },
      };

      // Legacy fallback
      group.contractAddress = usdt.address;
      group.feePercent = 0.25;

      await group.save();
      console.log(
        `✅ [${
          group.groupTitle || group.groupId
        }] Linked 0.25%: USDT...${usdt.address.slice(
          -4
        )} / USDC...${usdc.address.slice(-4)} / TRON...${tron.address.slice(
          -4
        )}`
      );
    } else {
      console.error(
        `❌ Missing contracts for 0.25% group ${group.groupTitle} (Index ${i})`
      );
    }
    groupIndex++;
  }

  // --- Tier 2: 0.50% (3 Groups) ---
  for (let i = 0; i < 3; i++) {
    if (groupIndex >= groups.length) break;
    const group = groups[groupIndex];
    const usdt = usdt050[i];

    // 1 Shared Contract for all 3 groups
    const usdc = usdc050[0];
    const tron = tron050[0];

    if (usdt && usdc && tron) {
      group.contracts = {
        USDT: {
          address: usdt.address,
          feePercent: usdt.feePercent,
          network: "BSC",
        },
        USDC: {
          address: usdc.address,
          feePercent: usdc.feePercent,
          network: "BSC",
        },
        USDT_TRON: {
          address: tron.address,
          feePercent: tron.feePercent,
          network: "TRON",
        },
      };
      group.contractAddress = usdt.address;
      group.feePercent = 0.5;
      await group.save();
      console.log(
        `✅ [${
          group.groupTitle || group.groupId
        }] Linked 0.50%: USDT...${usdt.address.slice(
          -4
        )} / USDC...${usdc.address.slice(-4)} / TRON...${tron.address.slice(
          -4
        )}`
      );
    } else {
      console.error(`❌ Missing contracts for 0.50% group ${group.groupTitle}`);
    }
    groupIndex++;
  }

  // --- Tier 3: 0.75% (2 Groups) ---
  for (let i = 0; i < 2; i++) {
    if (groupIndex >= groups.length) break;
    const group = groups[groupIndex];
    const usdt = usdt075[i];

    // 1 Shared Contract for all 2 groups
    const usdc = usdc075[0];
    const tron = tron075[0];

    if (usdt && usdc && tron) {
      group.contracts = {
        USDT: {
          address: usdt.address,
          feePercent: usdt.feePercent,
          network: "BSC",
        },
        USDC: {
          address: usdc.address,
          feePercent: usdc.feePercent,
          network: "BSC",
        },
        USDT_TRON: {
          address: tron.address,
          feePercent: tron.feePercent,
          network: "TRON",
        },
      };
      group.contractAddress = usdt.address;
      group.feePercent = 0.75;
      await group.save();
      console.log(
        `✅ [${
          group.groupTitle || group.groupId
        }] Linked 0.75%: USDT...${usdt.address.slice(
          -4
        )} / USDC...${usdc.address.slice(-4)} / TRON...${tron.address.slice(
          -4
        )}`
      );
    } else {
      console.error(`❌ Missing contracts for 0.75% group ${group.groupTitle}`);
    }
    groupIndex++;
  }

  console.log(`\n🎉 Linking complete. Processed ${groupIndex} groups.`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
