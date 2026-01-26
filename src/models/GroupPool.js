const mongoose = require("mongoose");

const groupPoolSchema = new mongoose.Schema({
  groupId: {
    type: String,
    required: true,
    unique: true,
  },
  groupTitle: {
    type: String,
    required: false,
  },
  status: {
    type: String,
    enum: ["available", "assigned", "completed", "archived"],
    default: "available",
  },
  assignedEscrowId: {
    type: String,
    required: false,
  },
  assignedAt: {
    type: Date,
    required: false,
  },
  completedAt: {
    type: Date,
    required: false,
  },
  inviteLink: {
    type: String,
    required: false,
  },
  inviteLinkExpiry: {
    type: Date,
    required: false,
  },
  inviteLinkHasJoinRequest: {
    type: Boolean,
    default: false,
  },
  feePercent: {
    type: Number,
    required: false,
  },
  contracts: {
    type: Map,
    of: new mongoose.Schema(
      {
        address: { type: String, required: true },
        network: { type: String, required: true, default: "BSC" },
      },
      { _id: false },
    ),
    default: {},
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Index for efficient querying
groupPoolSchema.index({ status: 1 });
groupPoolSchema.index({ assignedEscrowId: 1 });

module.exports = mongoose.model("GroupPool", groupPoolSchema);
