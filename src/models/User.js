const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  telegramId: {
    type: Number,
    required: true,
    unique: true,
  },
  username: {
    type: String,
    required: false,
  },
  firstName: String,
  lastName: String,
  isAdmin: {
    type: Boolean,
    default: false,
  },
  isBlocked: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  lastActive: {
    type: Date,
    default: Date.now,
  },
  totalParticipatedTrades: {
    type: Number,
    default: 0,
  },
  totalCompletedTrades: {
    type: Number,
    default: 0,
  },
  totalBoughtVolume: {
    type: Number,
    default: 0,
  },
  totalSoldVolume: {
    type: Number,
    default: 0,
  },
  totalTradedVolume: {
    type: Number,
    default: 0,
  },
  totalBoughtTrades: {
    type: Number,
    default: 0,
  },
  totalSoldTrades: {
    type: Number,
    default: 0,
  },
  lastTradeAt: Date,
  lastTradeRole: {
    type: String,
    enum: ["buyer", "seller", null],
    default: null,
  },
  lastTradeAmount: {
    type: Number,
    default: null,
  },
  lastTradeToken: {
    type: String,
    default: null,
  },
  lastTradeEscrowId: {
    type: String,
    default: null,
  },
  lastTradeCounterparty: {
    type: String,
    default: null,
  },
});

module.exports = mongoose.model("User", userSchema);
