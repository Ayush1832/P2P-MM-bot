const Escrow = require("../models/Escrow");
const { isAdmin } = require("../middleware/adminAuth");
const config = require("../../config");
const { getParticipants, formatParticipant } = require("../utils/participant");

module.exports = async (ctx) => {
  try {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;

    if (chatId > 0) {
      return ctx.reply("❌ This command can only be used in a group chat.");
    }

    const escrow = await Escrow.findOne({
      groupId: chatId.toString(),
      status: {
        $in: [
          "draft",
          "awaiting_details",
          "awaiting_deposit",
          "deposited",
          "in_fiat_transfer",
          "ready_to_release",
        ],
      },
    });

    if (!escrow) {
      return;
    }

    const isDealConfirmed = !!escrow.dealConfirmedMessageId;

    const userIsAdmin = isAdmin(ctx);
    const userIsBuyer = escrow.buyerId && escrow.buyerId === userId;
    const userIsSeller = escrow.sellerId && escrow.sellerId === userId;

    if (isDealConfirmed && !userIsAdmin) {
      return ctx.reply(
        "❌ Only admin can restart the trade after deal confirmation."
      );
    }

    if (!isDealConfirmed && !userIsAdmin && !userIsBuyer && !userIsSeller) {
      return ctx.reply(
        "❌ Only admin, buyer, or seller can restart the trade."
      );
    }

    const hasDeposits =
      (escrow.depositAmount && escrow.depositAmount > 0) ||
      (escrow.confirmedAmount && escrow.confirmedAmount > 0) ||
      (escrow.accumulatedDepositAmount && escrow.accumulatedDepositAmount > 0);

    if (hasDeposits && !userIsAdmin) {
      return ctx.reply(
        "❌ Cannot restart: Deposits have been made. Only admin can restart after deposits."
      );
    }

    if (escrow.dealConfirmedMessageId) {
      try {
        await ctx.telegram.unpinChatMessage(
          chatId,
          escrow.dealConfirmedMessageId
        );
      } catch (unpinError) {}
      escrow.dealConfirmedMessageId = null;
    }

    escrow.tradeDetailsStep = null;
    escrow.status = "draft";
    escrow.quantity = null;
    escrow.rate = null;
    escrow.paymentMethod = null;
    escrow.chain = null;
    escrow.token = "USDT";
    escrow.buyerAddress = null;
    escrow.sellerAddress = null;
    escrow.pendingSellerAddress = null;
    escrow.buyerApproved = false;
    escrow.sellerApproved = false;
    escrow.depositAmount = 0;
    escrow.confirmedAmount = 0;
    escrow.accumulatedDepositAmount = 0;
    escrow.accumulatedDepositAmountWei = null;
    escrow.transactionHash = null;
    escrow.partialTransactionHashes = [];
    escrow.depositTransactionFromAddress = null;
    escrow.releaseTransactionHash = null;
    escrow.refundTransactionHash = null;
    escrow.depositAddress = null;
    escrow.uniqueDepositAddress = null;
    escrow.escrowFee = 0;
    escrow.networkFee = 0;
    escrow.tradeStartTime = null;
    escrow.lastCheckedBlock = 0;
    escrow.transactionHashMessageId = null;
    escrow.partialPaymentMessageId = null;
    escrow.releaseConfirmationMessageId = null;
    escrow.refundConfirmationMessageId = null;
    escrow.pendingRefundAmount = null;
    escrow.pendingReleaseAmount = null;
    escrow.closeTradeMessageId = null;
    escrow.buyerClosedTrade = false;
    escrow.sellerClosedTrade = false;
    escrow.buyerSentFiat = false;
    escrow.sellerReceivedFiat = false;
    escrow.buyerConfirmedRelease = false;
    escrow.sellerConfirmedRelease = false;
    escrow.buyerConfirmedRefund = false;
    escrow.sellerConfirmedRefund = false;
    escrow.step1MessageId = null;
    escrow.step2MessageId = null;
    escrow.step3MessageId = null;
    escrow.step4ChainMessageId = null;
    escrow.step4CoinMessageId = null;
    escrow.step5BuyerAddressMessageId = null;
    escrow.step6SellerAddressMessageId = null;
    escrow.dealSummaryMessageId = null;
    escrow.waitingForUserMessageId = null;
    escrow.buyerStatsParticipationRecorded = false;
    escrow.sellerStatsParticipationRecorded = false;

    escrow.buyerId = null;
    escrow.sellerId = null;
    escrow.buyerUsername = null;
    escrow.sellerUsername = null;
    escrow.roleSelectionMessageId = null;

    await escrow.save();

    await ctx.reply(
      "✅ Trade has been restarted. Please select your roles again to begin."
    );

    const images = require("../config/images");
    const statusLines = getParticipants(escrow).map((participant, index) => {
      const label = formatParticipant(
        participant,
        index === 0 ? "Participant 1" : "Participant 2",
        { html: true }
      );
      return `⏳ ${label} - Waiting...`;
    });

    const roleDisclaimer = `<b>📋 Step 1 - Select Roles</b>

<b>⚠️ Choose roles accordingly</b>

<b>As release & refund happen according to roles</b>

<b>Refund goes to seller & release to buyer</b>

`;

    try {
      const roleSelectionMsg = await ctx.telegram.sendPhoto(
        chatId,
        images.SELECT_ROLES,
        {
          caption: roleDisclaimer + statusLines.join("\n"),
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "💰 I am Buyer", callback_data: "select_role_buyer" },
                { text: "💵 I am Seller", callback_data: "select_role_seller" },
              ],
            ],
          },
        }
      );
      escrow.roleSelectionMessageId = roleSelectionMsg.message_id;
      await escrow.save();
    } catch (msgError) {
      console.error("Failed to send role selection after restart:", msgError);
    }
  } catch (error) {
    console.error("Error in restart handler:", error);
    ctx.reply(
      "❌ Error restarting trade. Please try again or contact support."
    );
  }
};
