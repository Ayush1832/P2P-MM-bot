const mongoose = require("mongoose");

const contractSchema = new mongoose.Schema({
  name: { type: String, required: true },
  token: { type: String, required: true },
  network: { type: String, required: true },
  address: { type: String, required: true },
  feePercent: { type: Number, required: true, default: 0 },
  status: { type: String, default: "deployed" },
  groupId: { type: String, required: false },
  deployedAt: { type: Date, default: Date.now },
});

// Each contract address should be unique
contractSchema.index({ address: 1 }, { unique: true });
// Index for efficient querying by token, network, and feePercent
contractSchema.index({ token: 1, network: 1, feePercent: 1 });

module.exports = mongoose.model("Contract", contractSchema);
