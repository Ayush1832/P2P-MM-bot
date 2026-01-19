const mongoose = require("mongoose");

const addressPoolSchema = new mongoose.Schema({
  address: {
    type: String,
    required: true,
    unique: true,
  },
  token: {
    type: String,
    required: true,
  },
  network: {
    type: String,
    required: true,
  },
  contractAddress: {
    type: String,
    required: true,
  },
  feePercent: {
    type: Number,
    required: true,
    default: 0,
  },
  status: {
    type: String,
    enum: ["available", "assigned", "busy"],
    default: "available",
  },
  assignedEscrowId: {
    type: String,
    default: null,
  },
  assignedAmount: {
    type: Number,
    default: null,
  },
  assignedAt: {
    type: Date,
    default: null,
  },
  releasedAt: {
    type: Date,
    default: null,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Index for efficient querying
addressPoolSchema.index({ token: 1, network: 1, feePercent: 1, status: 1 });
addressPoolSchema.index({ assignedEscrowId: 1 });

module.exports = mongoose.model("AddressPool", addressPoolSchema);
