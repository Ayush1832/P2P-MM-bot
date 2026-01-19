const mongoose = require("mongoose");
const GroupPool = require("../src/models/GroupPool");
const config = require("../config");

// Verified TRON Contract Map from Audit
const TRON_CONTRACT_MAP = {
  0.25: "TLut6E4vtz4h3icKfNsFDnewAQNyXaZtdh",
  0.5: "TGAbVNhLwWzqqcgAxPgFoNB45ZbePrcpiL",
  0.75: "TAFWUY8hiNLmD4YfZiMXc1AsidxDem6zWn",
};

// Verified BSC Contract Maps
const BSC_USDT_MAP = {
  0.25: "0x4CfC5023f174fbD0ec6Fcef5e7ab97Ea182Cec09",
  0.5: "0x64760c08392aDA4F4DFe46894c6E1a90C0Ca13Fe",
  0.75: "0xFa7C8DE2d4ae6240E4eFBF13D2E5D1F24e211c8F",
};

const BSC_USDC_MAP = {
  0.25: "0x3B2fe1145D49bD8EbCAe0f674478C4124b6354B2",
  0.5: "0xEd9A4A0A66C269b58f04ACe723433Bf68c18fa60",
  0.75: "0x9721F4be90BF6b1241BD079b5F44fDA57b2D55d7",
};

async function fix() {
  console.log("🔧 Starting Group Fee Fix...");
  await mongoose.connect(config.MONGODB_URI);

  const groups = await GroupPool.find({});
  console.log(`📋 Checking ${groups.length} groups.`);

  let updatedCount = 0;

  for (const group of groups) {
    const fee = group.feePercent || 0;

    // TRON Target
    const tronTarget = TRON_CONTRACT_MAP[fee];
    // BSC Targets
    const bscUsdtTarget = BSC_USDT_MAP[fee];
    const bscUsdcTarget = BSC_USDC_MAP[fee];

    if (!tronTarget && !bscUsdtTarget && !bscUsdcTarget) {
      if (fee > 0)
        console.log(
          `⚠️ Group ${group.groupId}: No known contracts for ${fee}% fee. Skipping.`
        );
      continue;
    }

    let modified = false;
    const contracts = group.contracts; // Mongoose Map

    console.log(`Checking Group ${group.groupId} (Fee: ${fee}%)...`);

    // 1. Fix TRON
    if (tronTarget) {
      if (!contracts.has("USDT_TRON")) {
        console.log(`   🛠 Fixing TRON: Missing USDT_TRON. Adding it.`);
        contracts.set("USDT_TRON", {
          address: tronTarget,
          network: "TRON",
          token: "USDT",
          feePercent: fee,
        });
        modified = true;
      } else {
        const current = contracts.get("USDT_TRON");
        const currentAddress = current.address || current._doc?.address;
        if (currentAddress !== tronTarget) {
          console.log(
            `   🛠 Fixing TRON: USDT_TRON was ${currentAddress} -> Now ${tronTarget}`
          );
          contracts.set("USDT_TRON", {
            address: tronTarget,
            network: "TRON",
            token: "USDT",
            feePercent: fee,
          });
          modified = true;
        }
      }
    }

    // 2. Fix BSC USDT
    if (bscUsdtTarget) {
      if (!contracts.has("USDT")) {
        console.log(`   🛠 Fixing BSC: Missing USDT. Adding it.`);
        contracts.set("USDT", {
          address: bscUsdtTarget,
          network: "BSC",
          token: "USDT",
          feePercent: fee,
        });
        modified = true;
      } else {
        const current = contracts.get("USDT");
        const currentAddress = current.address || current._doc?.address;
        if (currentAddress !== bscUsdtTarget) {
          console.log(
            `   🛠 Fixing BSC: USDT was ${currentAddress} -> Now ${bscUsdtTarget}`
          );
          contracts.set("USDT", {
            address: bscUsdtTarget,
            network: "BSC",
            token: "USDT",
            feePercent: fee,
          });
          modified = true;
        }
      }
    }

    // 3. Fix BSC USDC
    if (bscUsdcTarget) {
      if (!contracts.has("USDC")) {
        console.log(`   🛠 Fixing BSC: Missing USDC. Adding it.`);
        contracts.set("USDC", {
          address: bscUsdcTarget,
          network: "BSC",
          token: "USDC",
          feePercent: fee,
        });
        modified = true;
      } else {
        const current = contracts.get("USDC");
        const currentAddress = current.address || current._doc?.address;
        if (currentAddress !== bscUsdcTarget) {
          console.log(
            `   🛠 Fixing BSC: USDC was ${currentAddress} -> Now ${bscUsdcTarget}`
          );
          contracts.set("USDC", {
            address: bscUsdcTarget,
            network: "BSC",
            token: "USDC",
            feePercent: fee,
          });
          modified = true;
        }
      }
    }

    if (modified) {
      group.markModified("contracts");
      await group.save();
      updatedCount++;
    }
  }

  console.log(`\n✅ Fixed ${updatedCount} groups.`);
  await mongoose.disconnect();
}

fix().catch(console.error);
