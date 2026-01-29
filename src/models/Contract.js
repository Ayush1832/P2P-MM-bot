const mongoose = require("mongoose");

const contractSchema = new mongoose.Schema({
  name: { type: String, required: true },
  token: { type: String, required: true },
  network: { type: String, required: true },
  address: { type: String, required: true },
  status: { type: String, default: "deployed" },
  deployedAt: { type: Date, default: Date.now },
});

// Each contract address should be unique
contractSchema.index({ address: 1 }, { unique: true });
// Index for efficient querying by token and network
contractSchema.index({ token: 1, network: 1 });

module.exports = mongoose.model("Contract", contractSchema);
