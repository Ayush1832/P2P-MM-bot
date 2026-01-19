const mongoose = require("mongoose");

const statsSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      unique: true,
      required: true,
    },
    totalCompletedVolume: {
      type: Number,
      default: 0,
    },
    totalCompletedTrades: {
      type: Number,
      default: 0,
    },
    totalRefundedVolume: {
      type: Number,
      default: 0,
    },
    totalRefundedTrades: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Stats", statsSchema);
