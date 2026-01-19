const mongoose = require("mongoose");

const escrowSchema = new mongoose.Schema({
  escrowId: {
    type: String,
    required: true,
    unique: true,
  },
  creatorId: {
    type: Number,
    required: false,
  },
  creatorUsername: {
    type: String,
    required: false,
  },
  groupId: {
    type: String,
    required: true,
  },
  assignedFromPool: {
    type: Boolean,
    default: false,
  },
  status: {
    type: String,
    enum: [
      "draft",
      "awaiting_details",
      "awaiting_deposit",
      "deposited",
      "in_fiat_transfer",
      "ready_to_release",
      "completed",
      "refunded",
      "disputed",
      "cancelled",
    ],
    default: "draft",
  },
  token: {
    type: String,
    default: "USDT",
  },
  chain: {
    type: String,
    default: "BSC",
  },
  quantity: {
    type: Number,
    required: false,
  },
  rate: {
    type: Number,
    required: false,
  },
  paymentMethod: {
    type: String,
    required: false,
  },
  // Track which step in the trade details flow we're on
  tradeDetailsStep: {
    type: String,
    enum: [
      "step2_blockchain",
      "step3_coin",
      "step4_amount",
      "step5_rate",
      "step6_payment",
      "step7_addresses",
      "step8_seller_address",
      "completed",
    ],
    required: false,
  },
  // Store Step 5 message ID for deletion
  step5BuyerAddressMessageId: {
    type: Number,
    required: false,
  },
  // Store Step 6 message ID for deletion
  step6SellerAddressMessageId: {
    type: Number,
    required: false,
  },
  // Store OTC Deal Summary message ID for editing approval status
  dealSummaryMessageId: {
    type: Number,
    required: false,
  },
  // Store pinned deal confirmed message ID for later unpinning
  dealConfirmedMessageId: {
    type: Number,
    required: false,
  },
  // Track deal approvals
  buyerApproved: {
    type: Boolean,
    default: false,
  },
  sellerApproved: {
    type: Boolean,
    default: false,
  },
  // Store transaction hash message ID for editing
  transactionHashMessageId: {
    type: Number,
    required: false,
  },
  // Store partial payment message ID for editing
  partialPaymentMessageId: {
    type: Number,
    required: false,
  },
  // Store waiting for user message ID (when only one user has joined)
  waitingForUserMessageId: {
    type: Number,
    required: false,
  },
  // Store confirmed transaction hash (deposit transaction)
  transactionHash: {
    type: String,
    required: false,
    index: true, // Index for faster duplicate checking
  },
  // Store multiple transaction hashes for partial deposits
  partialTransactionHashes: {
    type: [String],
    default: [],
  },
  // Store accumulated deposit amount from partial deposits
  accumulatedDepositAmount: {
    type: Number,
    default: 0,
  },
  accumulatedDepositAmountWei: {
    type: String,
    default: "0",
  },
  // Store the actual from address of the deposit transaction (can be any address)
  depositTransactionFromAddress: {
    type: String,
    required: false,
  },
  // Store release transaction hash (when funds are released)
  releaseTransactionHash: {
    type: String,
    required: false,
  },
  // Store refund transaction hash (when funds are refunded)
  refundTransactionHash: {
    type: String,
    required: false,
  },
  // Store Step 4 message IDs for deletion
  step4ChainMessageId: {
    type: Number,
    required: false,
  },
  step4CoinMessageId: {
    type: Number,
    required: false,
  },
  buyerId: {
    type: Number,
    required: false,
  },
  buyerUsername: {
    type: String,
    required: false,
  },
  sellerId: {
    type: Number,
    required: false,
  },
  sellerUsername: {
    type: String,
    required: false,
  },
  // Origin message details (main group where /deal was initiated)
  originChatId: {
    type: String,
    required: false,
  },
  originInviteMessageId: {
    type: Number,
    required: false,
  },
  tradeStartedMessageId: {
    type: Number,
    required: false,
  },
  // Allowed usernames for restricted join requests (when room is created via /deal in a group)
  allowedUsernames: {
    type: [String],
    default: undefined,
  },
  // Track which users have been approved and joined (user ids)
  approvedUserIds: {
    type: [Number],
    default: undefined,
  },
  // Allowed user ids (used when initiator has no username)
  allowedUserIds: {
    type: [Number],
    default: undefined,
  },
  // Store role selection message ID for editing
  roleSelectionMessageId: {
    type: Number,
    required: false,
  },
  buyerAddress: String,
  sellerAddress: String,
  depositAddress: String,
  uniqueDepositAddress: String,
  tradeStartTime: {
    type: Date,
    default: null,
  },
  lastCheckedBlock: {
    type: Number,
    default: 0,
  },
  // Track close trade confirmations
  buyerClosedTrade: {
    type: Boolean,
    default: false,
  },
  sellerClosedTrade: {
    type: Boolean,
    default: false,
  },
  // Store close trade message ID for editing
  closeTradeMessageId: {
    type: Number,
    required: false,
  },
  // Store release confirmation message ID for editing
  releaseConfirmationMessageId: {
    type: Number,
    required: false,
  },
  // Store refund confirmation message ID for editing
  refundConfirmationMessageId: {
    type: Number,
    required: false,
  },
  // Store pending refund/release amount (for partial operations)
  pendingRefundAmount: {
    type: Number,
    required: false,
  },
  pendingReleaseAmount: {
    type: Number,
    required: false,
  },
  // Track if release/refund buttons have been used (to prevent reuse)
  // Transaction hashes for partial releases/refunds to maintain history
  partialReleaseTransactionHashes: {
    type: [String],
    default: [],
  },
  partialRefundTransactionHashes: {
    type: [String],
    default: [],
  },

  releaseButtonUsed: {
    type: Boolean,
    default: false,
  },
  refundButtonUsed: {
    type: Boolean,
    default: false,
  },

  buyerStatsParticipationRecorded: {
    type: Boolean,
    default: false,
  },
  sellerStatsParticipationRecorded: {
    type: Boolean,
    default: false,
  },
  // Track if completion log has been sent to prevent duplicates
  completionLogSent: {
    type: Boolean,
    default: false,
  },
  // Track if refund log has been sent to prevent duplicates
  refundLogSent: {
    type: Boolean,
    default: false,
  },
  // Track if partial deposit log has been sent
  partialDepositLogSent: {
    type: Boolean,
    default: false,
  },
  inviteLink: String,
  depositAmount: {
    type: Number,
    default: 0,
  },
  confirmedAmount: {
    type: Number,
    default: 0,
  },
  escrowFee: {
    type: Number,
    default: 0,
  },
  // Fee rate used for calculation (e.g. 0.25, 0.5, 0.75)
  feeRate: {
    type: Number,
    required: false,
  },
  // Specific contract address used for this escrow
  contractAddress: {
    type: String,
    required: false,
  },
  networkFee: {
    type: Number,
    default: 0,
  },
  buyerSentFiat: {
    type: Boolean,
    default: false,
  },
  sellerReceivedFiat: {
    type: Boolean,
    default: false,
  },
  buyerConfirmedRelease: {
    type: Boolean,
    default: false,
  },
  sellerConfirmedRelease: {
    type: Boolean,
    default: false,
  },
  adminConfirmedRelease: {
    type: Boolean,
    default: false,
  },
  buyerConfirmedRefund: {
    type: Boolean,
    default: false,
  },
  sellerConfirmedRefund: {
    type: Boolean,
    default: false,
  },
  buyerConfirmedCancel: {
    type: Boolean,
    default: false,
  },
  sellerConfirmedCancel: {
    type: Boolean,
    default: false,
  },
  cancelConfirmationMessageId: {
    type: Number,
    required: false,
  },
  pendingSellerAddress: {
    type: String,
    default: null,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
  // Timestamp of last activity in the group (for inactivity recycling)
  lastActivityAt: {
    type: Date,
    default: Date.now,
  },
  // Timestamp when recycling warning was sent
  recycleWarningSentAt: {
    type: Date,
    required: false,
  },
  // Timestamp when the deal was completed (for accurate duration stats)
  completedAt: {
    type: Date,
    required: false,
  },
  // Flag if recycling is already scheduled/in progress
  isScheduledForRecycle: {
    type: Boolean,
    default: false,
  },
});

module.exports = mongoose.model("Escrow", escrowSchema);
