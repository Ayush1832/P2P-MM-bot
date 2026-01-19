const mongoose = require("mongoose");
const Contract = require("../src/models/Contract");
const TronService = require("../src/services/TronService");
const config = require("../config");

async function list() {
  await mongoose.connect(config.MONGODB_URI);
  console.log("✅ Connected to DB");

  const contracts = await Contract.find({
    network: "TRON",
    status: "deployed",
  });
  console.log(`Found ${contracts.length} TRON contracts.`);

  for (const c of contracts) {
    try {
      const settings = await TronService.getFeeSettings({
        contractAddress: c.address,
      });
      // Normalized fee
      const fee = settings.feePercent / 100;
      console.log(`[TRON] ${c.address} | Token: ${c.token} | Fee: ${fee}%`);
    } catch (e) {
      console.log(`[TRON] ${c.address} | Error: ${e.message}`);
    }
  }

  await mongoose.disconnect();
}

list().catch(console.error);
