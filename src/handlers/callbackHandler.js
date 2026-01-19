const { Markup } = require("telegraf");
const { ethers } = require("ethers");
const Escrow = require("../models/Escrow");
const BlockchainService = require("../services/BlockchainService");
const AddressAssignmentService = require("../services/AddressAssignmentService");
const GroupPoolService = require("../services/GroupPoolService");
const GroupPool = require("../models/GroupPool");
const Contract = require("../models/Contract");
const config = require("../../config");
const images = require("../config/images");
const UserStatsService = require("../services/UserStatsService");
const CompletionFeedService = require("../services/CompletionFeedService");
const feeConfig = require("../config/feeConfig");
const {
  getParticipants,
  formatParticipant,
  formatParticipantById,
} = require("../utils/participant");
const findGroupEscrow = require("../utils/findGroupEscrow");
const { getAddressExample } = require("../utils/addressValidation");
const { safeAnswerCbQuery } = require("../utils/telegramUtils");

const groupRecyclingTimers = new Map();

/**
 * Update the "Trade started" message in the main group with completion details
 */
async function updateTradeStartedMessage(
  escrow,
  telegram,
  status,
  transactionHash = null
) {
  try {
    if (!escrow.originChatId || !escrow.tradeStartedMessageId) {
      return;
    }

    const buyerLabel =
      escrow.buyerId != null
        ? formatParticipantById(escrow, escrow.buyerId, "Buyer", { html: true })
        : "Not set";
    const sellerLabel =
      escrow.sellerId != null
        ? formatParticipantById(escrow, escrow.sellerId, "Seller", {
            html: true,
          })
        : "Not set";

    const tradeStart = escrow.tradeStartTime || escrow.createdAt || new Date();
    const minutesTaken = Math.max(
      1,
      Math.round((Date.now() - new Date(tradeStart)) / (60 * 1000))
    );

    let amount = 0;
    if (escrow.quantity != null && !isNaN(escrow.quantity)) {
      amount = Number(escrow.quantity);
    } else if (
      escrow.accumulatedDepositAmount != null &&
      !isNaN(escrow.accumulatedDepositAmount)
    ) {
      amount = Number(escrow.accumulatedDepositAmount);
    }
    const token = (escrow.token || "USDT").toUpperCase();
    const amountDisplay = `${amount.toFixed(2)} ${token}`;

    let statusEmoji = "";
    let statusText = "";
    if (status === "completed") {
      statusEmoji = "✅";
      statusText = "Completed Successfully";
    } else if (status === "refunded") {
      statusEmoji = "🔄";
      statusText = "Refunded";
    } else {
      statusEmoji = "❌";
      statusText = "Cancelled";
    }

    const updatedMessage = `${statusEmoji} <b>Trade ${statusText}</b>

👥 <b>Participants:</b>
• Buyer: ${buyerLabel}
• Seller: ${sellerLabel}

💰 <b>Amount:</b> ${amountDisplay}
⏱️ <b>Time Taken:</b> ${minutesTaken} min(s)`;

    const withRetry = require("../utils/retry");

    try {
      await withRetry(() =>
        telegram.editMessageText(
          escrow.originChatId,
          escrow.tradeStartedMessageId,
          null,
          updatedMessage,
          { parse_mode: "HTML" }
        )
      );
    } catch (e) {
      const description =
        e?.response?.description || e?.description || e?.message || "";
      const descLower = description.toLowerCase();
      // Ignore harmless errors
      if (
        descLower.includes("message is not modified") ||
        descLower.includes("message into found") || // Typo handle
        descLower.includes("message to edit not found") ||
        descLower.includes("message identifier is not specified") ||
        // Also suppress if it's a 400 Bad Request which usually means message is gone/invalid
        e?.response?.error_code === 400
      ) {
        return;
      }
      console.error("Error updating trade started message:", e);
    }
  } catch (error) {
    console.error("Error preparing trade started message:", error);
  }
}

async function scheduleGroupRecycling(escrowId, telegram) {
  if (!escrowId || !telegram) {
    return;
  }

  if (groupRecyclingTimers.has(escrowId)) {
    return; // Recycling already scheduled
  }

  const timeoutId = setTimeout(async () => {
    groupRecyclingTimers.delete(escrowId);
    try {
      const finalEscrow = await Escrow.findOne({ escrowId });
      if (!finalEscrow) {
        return;
      }

      const group = await GroupPool.findOne({
        assignedEscrowId: finalEscrow.escrowId,
      });

      if (group) {
        const allUsersRemoved = await GroupPoolService.removeUsersFromGroup(
          finalEscrow,
          group.groupId,
          telegram
        );

        if (allUsersRemoved) {
          try {
            await GroupPoolService.refreshInviteLink(group.groupId, telegram);
          } catch (refreshError) {
            console.error(
              "Error refreshing invite link during recycling:",
              refreshError
            );
          }

          group.status = "available";
          group.assignedEscrowId = null;
          group.assignedAt = null;
          group.completedAt = null;
          await group.save();

          try {
            await telegram.sendMessage(
              finalEscrow.groupId,
              "✅ Group has been recycled and is ready for a new trade."
            );
          } catch (sendError) {
            console.error("Error sending recycled notification:", sendError);
          }
        } else {
          group.status = "completed";
          group.assignedEscrowId = null;
          group.assignedAt = null;
          group.completedAt = new Date();
          await group.save();

          try {
            await telegram.sendMessage(
              finalEscrow.groupId,
              "✅ Trade closed successfully! Both parties have confirmed. Note: Some users could not be removed from the group."
            );
          } catch (sendError) {
            console.error(
              "Error sending partial recycling notification:",
              sendError
            );
          }
        }
      } else {
        try {
          await telegram.sendMessage(
            finalEscrow.groupId,
            "✅ Trade closed successfully! Both parties have confirmed."
          );
        } catch (sendError) {
          console.error("Error sending completion notification:", sendError);
        }
      }
    } catch (error) {
      console.error("Error recycling group after delay:", error);
    }
  }, 5 * 60 * 1000);

  groupRecyclingTimers.set(escrowId, timeoutId);
}

async function recycleGroupImmediately(escrow, telegram) {
  try {
    if (!escrow || !telegram) {
      return;
    }

    let group = await GroupPool.findOne({
      assignedEscrowId: escrow.escrowId,
    });

    if (!group && escrow.groupId) {
      group = await GroupPool.findOne({ groupId: escrow.groupId });
    }

    if (!group) {
      return;
    }

    const allUsersRemoved = await GroupPoolService.removeUsersFromGroup(
      escrow,
      group.groupId,
      telegram
    );

    if (allUsersRemoved) {
      try {
        await GroupPoolService.refreshInviteLink(group.groupId, telegram);
      } catch (refreshError) {
        console.error(
          "Error refreshing invite link during immediate recycle:",
          refreshError
        );
      }

      group.status = "available";
      group.assignedEscrowId = null;
      group.assignedAt = null;
      group.completedAt = null;
      await group.save();
    } else {
      group.status = "completed";
      group.assignedEscrowId = null;
      group.assignedAt = null;
      group.completedAt = new Date();
      await group.save();
    }
  } catch (error) {
    console.error("Error during immediate group recycle:", error);
  }
}

async function announceAndScheduleRecycling(escrow, ctx, messageText) {
  if (!escrow || !ctx || !ctx.telegram) {
    return;
  }

  const announcement =
    messageText ||
    "✅ Trade closed successfully! Group will be recycled in 5 minutes.";

  try {
    await ctx.telegram.sendMessage(escrow.groupId, announcement);
  } catch (sendError) {
    console.error("Error sending recycling announcement:", sendError);
  }

  await scheduleGroupRecycling(escrow.escrowId, ctx.telegram);
}

/**
 * Update the role selection message with current status
 */
async function updateRoleSelectionMessage(ctx, escrow) {
  if (!escrow.roleSelectionMessageId) {
    return; // No message to update
  }

  try {
    const participants = getParticipants(escrow);

    const statusLines = participants.map((participant, index) => {
      const label = formatParticipant(
        participant,
        index === 0 ? "Participant 1" : "Participant 2",
        { html: true }
      );
      const isBuyer =
        participant.id !== null &&
        escrow.buyerId &&
        Number(escrow.buyerId) === Number(participant.id);
      const isSeller =
        participant.id !== null &&
        escrow.sellerId &&
        Number(escrow.sellerId) === Number(participant.id);

      if (isBuyer) {
        return `✅ ${label} - BUYER`;
      }
      if (isSeller) {
        return `✅ ${label} - SELLER`;
      }
      return `⏳ ${label} - Waiting...`;
    });

    if (statusLines.length === 0) {
      const buyerLabel = formatParticipantById(
        escrow,
        escrow.buyerId,
        "Buyer",
        { html: true }
      );
      const sellerLabel = formatParticipantById(
        escrow,
        escrow.sellerId,
        "Seller",
        { html: true }
      );
      statusLines.push(
        escrow.buyerId
          ? `✅ ${buyerLabel} - BUYER`
          : `⏳ ${buyerLabel} - Waiting...`
      );
      statusLines.push(
        escrow.sellerId
          ? `✅ ${sellerLabel} - SELLER`
          : `⏳ ${sellerLabel} - Waiting...`
      );
    }

    const roleDisclaimer = `<b>📋 Step 1 - Select Roles</b>

<b>⚠️ Choose roles accordingly</b>

<b>As release & refund happen according to roles</b>

<b>Refund goes to seller & release to buyer</b>

`;

    const messageText = roleDisclaimer + statusLines.join("\n");

    const replyMarkup =
      escrow.buyerId && escrow.sellerId
        ? undefined
        : {
            inline_keyboard: [
              [
                { text: "💰 I am Buyer", callback_data: "select_role_buyer" },
                { text: "💵 I am Seller", callback_data: "select_role_seller" },
              ],
            ],
          };

    const withRetry = require("../utils/retry");

    try {
      await withRetry(() =>
        ctx.telegram.editMessageCaption(
          escrow.groupId,
          escrow.roleSelectionMessageId,
          null,
          messageText,
          { reply_markup: replyMarkup, parse_mode: "HTML" }
        )
      );
    } catch (editError) {
      const description =
        editError?.response?.description || editError?.message || "";
      if (description.toLowerCase().includes("message is not modified")) {
        return;
      }
      console.error("Error updating role selection message:", editError);
      // throw editError; // Don't throw, just log so flow continues
    }
  } catch (error) {
    console.error("Error updating role selection message:", error);
  }
}

const safeEditMessageText = async (
  ctx,
  chatId,
  messageId,
  text,
  extra = {}
) => {
  try {
    await ctx.telegram.editMessageText(
      chatId,
      messageId,
      undefined,
      text,
      extra
    );
  } catch (error) {
    if (
      error.description &&
      error.description.includes("message is not modified")
    ) {
      return;
    }

    if (
      error.code === 429 ||
      (error.description && error.description.includes("Too Many Requests"))
    ) {
      const retryAfter = error.parameters?.retry_after || 5;
      if (retryAfter < 30) {
        await new Promise((resolve) =>
          setTimeout(resolve, retryAfter * 1000 + 1000)
        );
        try {
          await ctx.telegram.editMessageText(
            chatId,
            messageId,
            undefined,
            text,
            extra
          );
        } catch (retryErr) {
          console.error(`Rate limit retry failed: ${retryErr.message}`);
        }
        return;
      }
    }

    console.error(`Edit Msg Error: ${error.message}`);
  }
};

module.exports = async (ctx) => {
  try {
    const callbackData = ctx.callbackQuery.data;
    const userId = ctx.from.id;
    const chatId = ctx.chat.id;

    // Handle different callback types
    if (
      callbackData === "select_role_buyer" ||
      callbackData === "select_role_seller"
    ) {
      const isBuyer = callbackData === "select_role_buyer";
      await safeAnswerCbQuery(
        ctx,
        isBuyer ? "Buyer role selected" : "Seller role selected"
      );

      const escrow = await findGroupEscrow(chatId, [
        "draft",
        "awaiting_details",
      ]);

      if (!escrow) {
        await safeAnswerCbQuery(ctx, "❌ No active escrow found.");
        return;
      }

      if (isBuyer && escrow.sellerId && escrow.sellerId === userId) {
        await safeAnswerCbQuery(ctx, "❌ You cannot be both buyer and seller.");
        return;
      }
      if (!isBuyer && escrow.buyerId && escrow.buyerId === userId) {
        await safeAnswerCbQuery(ctx, "❌ You cannot be both buyer and seller.");
        return;
      }

      if (isBuyer) {
        if (escrow.buyerId && escrow.buyerId !== userId) {
          await safeAnswerCbQuery(ctx, "❌ Buyer role already taken.");
          return;
        }
        escrow.buyerId = userId;
        escrow.buyerUsername = ctx.from.username;
      } else {
        if (escrow.sellerId && escrow.sellerId !== userId) {
          await safeAnswerCbQuery(ctx, "❌ Seller role already taken.");
          return;
        }
        escrow.sellerId = userId;
        escrow.sellerUsername = ctx.from.username;
      }

      if (escrow.buyerId && escrow.sellerId) {
        if (!escrow.buyerStatsParticipationRecorded && escrow.buyerId) {
          try {
            await UserStatsService.recordParticipation({
              telegramId: escrow.buyerId,
              username: escrow.buyerUsername,
            });
            escrow.buyerStatsParticipationRecorded = true;
          } catch (statsError) {
            console.error("Error recording buyer participation:", statsError);
          }
        }

        if (!escrow.sellerStatsParticipationRecorded && escrow.sellerId) {
          try {
            await UserStatsService.recordParticipation({
              telegramId: escrow.sellerId,
              username: escrow.sellerUsername,
            });
            escrow.sellerStatsParticipationRecorded = true;
          } catch (statsError) {
            console.error("Error recording seller participation:", statsError);
          }
        }
      }

      await escrow.save();

      await updateRoleSelectionMessage(ctx, escrow);

      // After both roles are selected, trigger Step 2 (Blockchain Selection)
      if (escrow.buyerId && escrow.sellerId && escrow.roleSelectionMessageId) {
        escrow.tradeDetailsStep = "step2_blockchain";
        await escrow.save();

        const step2Msg = await ctx.telegram.sendPhoto(
          escrow.groupId,
          images.SELECT_CHAIN,
          {
            caption: "🔗 Step 2 - Choose Blockchain",
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [{ text: "BSC", callback_data: "step2_select_chain_BSC" }],
              ],
            },
          }
        );
        escrow.step2MessageId = step2Msg.message_id;
        await escrow.save();
      }
      return;
    } else if (callbackData.startsWith("step2_select_chain_")) {
      // Step 2: Blockchain selection (new flow)
      const chain = callbackData
        .replace("step2_select_chain_", "")
        .toUpperCase();
      await safeAnswerCbQuery(ctx, `Selected ${chain}`);

      const escrow = await findGroupEscrow(
        chatId,
        ["draft", "awaiting_details"],
        {
          tradeDetailsStep: "step2_blockchain",
        }
      );

      if (!escrow) {
        await safeAnswerCbQuery(ctx, "❌ No active escrow found.");
        return;
      }

      if (escrow.buyerId !== userId && escrow.sellerId !== userId) {
        return safeAnswerCbQuery(ctx, "❌ Only buyer or seller can select.");
      }

      escrow.chain = chain;

      // Update network fee based on chain selection (using centralized config)
      const hasBioTag = escrow.feeRate !== undefined && escrow.feeRate < 0.75;
      escrow.networkFee = feeConfig.getNetworkFee(escrow.chain, hasBioTag);

      await escrow.save();

      // Update blockchain selection message with checkmark
      if (escrow.step2MessageId) {
        const chains = ["BSC"];
        const buttons = chains.map((c) => ({
          text: c === chain ? `✔ ${c}` : c,
          callback_data: `step2_select_chain_${c}`,
        }));

        try {
          await ctx.telegram.editMessageReplyMarkup(
            escrow.groupId,
            escrow.step2MessageId,
            null,
            { inline_keyboard: [buttons] }
          );
        } catch (err) {
          // Ignore if message not modified
        }
      }

      // Step 3: Show coin selection
      const coins = chain === "TRON" ? ["USDT"] : ["USDT", "USDC"];
      const step3Msg = await ctx.telegram.sendPhoto(
        escrow.groupId,
        images.SELECT_CRYPTO,
        {
          caption: "⚪ Step 3 - Select Coin",
          reply_markup: {
            inline_keyboard: [
              coins.map((c) => ({
                text: c,
                callback_data: `step3_select_coin_${c}`,
              })),
            ],
          },
        }
      );
      escrow.step3MessageId = step3Msg.message_id;
      escrow.tradeDetailsStep = "step3_coin";
      await escrow.save();

      return;
    } else if (callbackData.startsWith("step3_select_coin_")) {
      // Step 3: Coin selection (new flow)
      const coin = callbackData.replace("step3_select_coin_", "").toUpperCase();
      await safeAnswerCbQuery(ctx, `Selected ${coin}`);

      const escrow = await findGroupEscrow(
        chatId,
        ["draft", "awaiting_details"],
        {
          tradeDetailsStep: "step3_coin",
        }
      );

      if (!escrow) {
        await safeAnswerCbQuery(ctx, "❌ No active escrow found.");
        return;
      }

      if (escrow.buyerId !== userId && escrow.sellerId !== userId) {
        return safeAnswerCbQuery(ctx, "❌ Only buyer or seller can select.");
      }

      // Validate coin against chain
      const currentChain = (escrow.chain || "BSC").toUpperCase();
      const validCoins = currentChain === "TRON" ? ["USDT"] : ["USDT", "USDC"];

      if (!validCoins.includes(coin)) {
        await safeAnswerCbQuery(
          ctx,
          `❌ ${coin} is not supported on ${currentChain}`
        );
        return;
      }

      escrow.token = coin;

      // Network Fee Logic (using centralized config)
      // Check if any user has @room bio tag (indicated by discounted feeRate)
      const hasBioTag = escrow.feeRate !== undefined && escrow.feeRate < 0.75;
      escrow.networkFee = feeConfig.getNetworkFee(escrow.chain, hasBioTag);

      await escrow.save();

      // Update coin selection message with checkmark
      if (escrow.step3MessageId) {
        const coins = currentChain === "TRON" ? ["USDT"] : ["USDT", "USDC"];
        const buttons = coins.map((c) => ({
          text: c === coin ? `✔ ${c}` : c,
          callback_data: `step3_select_coin_${c}`,
        }));

        try {
          await ctx.telegram.editMessageReplyMarkup(
            escrow.groupId,
            escrow.step3MessageId,
            null,
            { inline_keyboard: [buttons] }
          );
        } catch (err) {
          // Ignore if message not modified
        }
      }

      // Step 4: Show amount input
      const step4Msg = await ctx.telegram.sendPhoto(
        escrow.groupId,
        images.ENTER_QUANTITY,
        {
          caption: `💰 <b>Step 4 - Enter ${coin} Amount</b>\n\nChain: ${escrow.chain}\nNetwork Fee: ${escrow.networkFee} ${coin}\n\nEnter amount including fee → Example: 1000`,
          parse_mode: "HTML",
        }
      );
      escrow.step4MessageId = step4Msg.message_id;
      escrow.tradeDetailsStep = "step4_amount";
      await escrow.save();

      return;
    } else if (callbackData.startsWith("set_token_generic_")) {
      const selectedToken = callbackData.replace("set_token_generic_", "");
      const escrow = await findGroupEscrow(chatId, [
        "draft",
        "awaiting_details",
      ]);

      if (!escrow) return safeAnswerCbQuery(ctx, "❌ No active escrow found.");

      await safeAnswerCbQuery(ctx, `Selected ${selectedToken}`);

      // Store temp token choice in escrow (or just pass it to next step logic)
      escrow.token = selectedToken;

      // Show Chain Selection
      const buttons = [];
      const group = await GroupPool.findOne({ groupId: escrow.groupId });

      if (group && group.contracts) {
        // BSC Button
        if (group.contracts.has(selectedToken)) {
          buttons.push(
            Markup.button.callback(
              "BSC / BEP20",
              `set_chain_${selectedToken}_BSC`
            )
          );
        }
        // TRON Button (Only for USDT usually)
        if (selectedToken === "USDT" && group.contracts.has("USDT_TRON")) {
          buttons.push(
            Markup.button.callback(
              "TRON / TRC20",
              `set_chain_${selectedToken}_TRON`
            )
          );
        }
      }

      // Fallback if no specific config found (Legacy)
      if (buttons.length === 0) {
        buttons.push(
          Markup.button.callback(
            "BSC / BEP20",
            `set_chain_${selectedToken}_BSC`
          )
        );
      }

      await ctx.telegram.sendMessage(
        escrow.groupId,
        `🌐 <b>Select Network for ${selectedToken}</b>`,
        {
          parse_mode: "HTML",
          reply_markup: Markup.inlineKeyboard([buttons]).reply_markup,
        }
      );
      await escrow.save();
      return;
    } else if (callbackData.startsWith("set_chain_")) {
      // Format: set_chain_USDT_BSC or set_chain_USDT_TRON
      const parts = callbackData.split("_"); // ["set", "chain", "USDT", "BSC"]
      const tokenKey = parts[2];
      const chainKey = parts[3];

      const escrow = await findGroupEscrow(chatId, [
        "draft",
        "awaiting_details",
      ]);
      if (!escrow) return safeAnswerCbQuery(ctx, "❌ No active escrow found.");

      await safeAnswerCbQuery(ctx, `Selected ${chainKey}`);

      // Map to internal keys
      // If TRON, internal key in contracts map is "USDT_TRON"
      // If BSC, internal key is just "USDT" (or "USDC")
      let internalContractKey = tokenKey;
      if (chainKey === "TRON") {
        internalContractKey = `${tokenKey}_TRON`;
      }

      const group = await GroupPool.findOne({ groupId: escrow.groupId });
      let contractInfo = null;

      if (
        group &&
        group.contracts &&
        group.contracts.get(internalContractKey)
      ) {
        contractInfo = group.contracts.get(internalContractKey);
      } else if (chainKey === "BSC" && group.contractAddress) {
        contractInfo = {
          address: group.contractAddress,
          feePercent: group.feePercent,
          network: "BSC",
        };
      }

      if (!contractInfo || !contractInfo.address) {
        return ctx.reply(`❌ ${tokenKey} on ${chainKey} is not supported.`);
      }

      escrow.token = tokenKey;
      escrow.chain = chainKey === "TRON" ? "TRON" : "BSC";
      escrow.contractAddress = contractInfo.address;

      // Network Fee Logic (using centralized config)
      const hasBioTag = escrow.feeRate !== undefined && escrow.feeRate < 0.75;
      escrow.networkFee = feeConfig.getNetworkFee(escrow.chain, hasBioTag);

      escrow.tradeDetailsStep = "step1_amount";

      const step1Msg = await ctx.telegram.sendPhoto(
        escrow.groupId,
        images.ENTER_QUANTITY,
        {
          caption: `💰 <b>Step 2 - Enter ${tokenKey} Amount</b>\n\nChain: ${escrow.chain}\nNetwork Fee: ${escrow.networkFee} ${tokenKey}\n\nEnter amount including fee → Example: 1000`,
          parse_mode: "HTML",
        }
      );
      escrow.step1MessageId = step1Msg.message_id;

      await escrow.save();
      return;
    } else if (callbackData.startsWith("set_token_")) {
      // Legacy handler kept for backward compatibility or direct calls
      // Re-route or just handle normally if needed.
      // For now, we rely on the new flow above.
      return;
    } else if (callbackData === "cancel_role_selection") {
      await safeAnswerCbQuery(ctx, "Cancelled");
      return;
    } else if (callbackData === "approve_deal_summary") {
      // First check if there's any escrow with dealSummaryMessageId in this group (any status)
      // This handles cases where the deal has progressed or the message is stale/forwarded
      const anyEscrow = await Escrow.findOne({
        groupId: String(chatId),
        dealSummaryMessageId: { $exists: true, $ne: null },
      }).sort({ _id: -1 });

      // If escrow exists but status is wrong, silently ignore (deal already progressed)
      if (
        anyEscrow &&
        !["draft", "awaiting_details"].includes(anyEscrow.status)
      ) {
        await safeAnswerCbQuery(
          ctx,
          "✅ This deal has already been processed."
        );
        return;
      }

      // If no escrow found at all, silently ignore (message might be old/forwarded)
      if (!anyEscrow) {
        await safeAnswerCbQuery(
          ctx,
          "✅ This deal summary is no longer active."
        );
        return;
      }

      // Now find the escrow with correct status
      const escrow = await findGroupEscrow(
        chatId,
        ["draft", "awaiting_details"],
        { dealSummaryMessageId: { $exists: true } }
      );

      // Final check (shouldn't happen, but safety net)
      if (!escrow) {
        await safeAnswerCbQuery(
          ctx,
          "✅ This deal summary is no longer active."
        );
        return;
      }

      await safeAnswerCbQuery(ctx, "Approving deal...");

      const userId = ctx.from.id;
      const isBuyer = escrow.buyerId === userId;
      const isSeller = escrow.sellerId === userId;

      if (!isBuyer && !isSeller) {
        return safeAnswerCbQuery(ctx, "❌ Only buyer or seller can approve.");
      }

      // Idempotency: prevent double processing
      if (
        (isBuyer && escrow.buyerApproved) ||
        (isSeller && escrow.sellerApproved)
      ) {
        return safeAnswerCbQuery(
          ctx,
          "✅ You have already approved this deal."
        );
      }

      // Update approval status
      if (isBuyer) {
        escrow.buyerApproved = true;
      } else {
        escrow.sellerApproved = true;
      }
      await escrow.save();

      // Reload escrow to get latest state
      const updatedEscrow = await Escrow.findById(escrow._id);

      // Update deal summary message with approval status
      const buildDealSummary = async (escrow) => {
        const amount = escrow.quantity;
        const rate = escrow.rate;
        const paymentMethod = escrow.paymentMethod;
        const chain = escrow.chain;
        const buyerAddress = escrow.buyerAddress;
        const sellerAddress = escrow.sellerAddress;

        const buyerUsername = escrow.buyerUsername || "Buyer";
        const sellerUsername = escrow.sellerUsername || "Seller";

        let approvalStatus = "";
        if (escrow.buyerApproved && escrow.sellerApproved) {
          approvalStatus = "✅ Both parties have approved.";
        } else {
          const approvals = [];
          if (escrow.buyerApproved) {
            approvals.push(`✅ @${buyerUsername} has approved.`);
          } else {
            approvals.push(`⏳ Waiting for @${buyerUsername} to approve.`);
          }
          if (escrow.sellerApproved) {
            approvals.push(`✅ @${sellerUsername} has approved.`);
          } else {
            approvals.push(`⏳ Waiting for @${sellerUsername} to approve.`);
          }
          approvalStatus = approvals.join("\n");
        }

        return `📋 <b> Deal Summary</b>
        
• <b>Trade ID:</b> #${escrow.escrowId}
• <b>Amount:</b> ${amount} ${escrow.token}
• <b>Rate:</b> ₹${rate.toFixed(1)}
• <b>Payment:</b> ${paymentMethod}
• <b>Chain:</b> ${chain}
• <b>Network Fee:</b> ${escrow.networkFee} ${escrow.token}
• <b>Service Fee:</b> ${escrow.feeRate}%
• <b>Buyer Address:</b> <code>${buyerAddress}</code>
• <b>Seller Address:</b> <code>${sellerAddress}</code>

🛑 <b>Do not send funds here</b> 🛑

${approvalStatus}`;
      };

      const summaryText = await buildDealSummary(updatedEscrow);
      const replyMarkup =
        updatedEscrow.buyerApproved && updatedEscrow.sellerApproved
          ? undefined
          : {
              inline_keyboard: [
                [{ text: "Approve", callback_data: "approve_deal_summary" }],
              ],
            };

      try {
        // Try editing as photo caption first (if it's a photo message)
        await ctx.telegram.editMessageCaption(
          updatedEscrow.groupId,
          updatedEscrow.dealSummaryMessageId,
          null,
          summaryText,
          { parse_mode: "HTML", reply_markup: replyMarkup }
        );
      } catch (captionError) {
        const description =
          captionError?.response?.description ||
          captionError?.description ||
          captionError?.message ||
          "";

        // If caption edit failed because message is not modified or not found, do NOT try to edit as text
        // (Editing as text on a photo message causes "there is no text in the message to edit")
        if (
          description.includes("message is not modified") ||
          description.includes("message to edit not found")
        ) {
          // Do nothing, just return/continue
        } else {
          // If that fails (and it's not one of the above errors), try editing as text (if it's a text message)
          try {
            await ctx.telegram.editMessageText(
              updatedEscrow.groupId,
              updatedEscrow.dealSummaryMessageId,
              null,
              summaryText,
              { parse_mode: "HTML", reply_markup: replyMarkup }
            );
          } catch (textError) {
            // If both fail, try sending new message with image
            try {
              await ctx.telegram.sendPhoto(
                updatedEscrow.groupId,
                images.CONFIRM_SUMMARY,
                {
                  caption: summaryText,
                  parse_mode: "HTML",
                  reply_markup: replyMarkup,
                }
              );
            } catch (sendErr) {
              console.error("Error updating deal summary:", textError);
            }
          }
        }
      }

      // Check if both have approved
      if (updatedEscrow.buyerApproved && updatedEscrow.sellerApproved) {
        // Both approved - send DEAL CONFIRMED message
        const buyerTag = updatedEscrow.buyerUsername
          ? `@${updatedEscrow.buyerUsername}`
          : `[${updatedEscrow.buyerId}]`;
        const sellerTag = updatedEscrow.sellerUsername
          ? `@${updatedEscrow.sellerUsername}`
          : `[${updatedEscrow.sellerId}]`;
        const amount = updatedEscrow.quantity;
        const rate = updatedEscrow.rate;
        const paymentMethod = updatedEscrow.paymentMethod;
        const chain = updatedEscrow.chain;

        // Calculate fees
        const networkFee = updatedEscrow.networkFee;
        if (
          updatedEscrow.feeRate === undefined ||
          updatedEscrow.feeRate === null
        ) {
          return ctx.reply("❌ Error: Fee rate missing. Cannot confirm deal.");
        }
        const escrowFeePercent = Number(updatedEscrow.feeRate);
        const escrowFee = (amount * escrowFeePercent) / 100;
        const releaseAmount = amount - networkFee - escrowFee;

        const confirmedText = `<b>P2P MM BOT 🤖</b>

<b>✅ DEAL CONFIRMED</b>

<b>Buyer:</b> ${buyerTag}
<b>Seller:</b> ${sellerTag}

<b>Deal Amount:</b> ${amount.toFixed(1)} ${updatedEscrow.token || "USDT"}
<b>Network Fee:</b> ${networkFee} ${updatedEscrow.token || "USDT"}
<b>Service Fee:</b> ${updatedEscrow.feeRate}%
<b>Release Amount:</b> ${releaseAmount.toFixed(2)} ${updatedEscrow.token}
<b>Rate:</b> ₹${rate.toFixed(1)}
<b>Payment:</b> ${paymentMethod}
<b>Chain:</b> ${chain}

<b>Buyer Address:</b> <code>${updatedEscrow.buyerAddress}</code>
<b>Seller Address:</b> <code>${updatedEscrow.sellerAddress}</code>

🛑 <b>Do not send funds here</b> 🛑`;

        const confirmedMsg = await ctx.telegram.sendPhoto(
          updatedEscrow.groupId,
          images.DEAL_CONFIRMED,
          {
            caption: confirmedText,
            parse_mode: "HTML",
          }
        );

        // Pin the DEAL CONFIRMED message
        // Retry logic for pinning (Max 3 attempts)
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await ctx.telegram.pinChatMessage(
              updatedEscrow.groupId,
              confirmedMsg.message_id,
              { disable_notification: true }
            );
            break; // Success
          } catch (pinErr) {
            const isRateLimit =
              pinErr.code === 429 ||
              pinErr.response?.error_code === 429 ||
              pinErr.description?.includes("Too Many Requests");

            if (isRateLimit && attempt < 3) {
              await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2s
              continue;
            }

            if (!isRateLimit || attempt === 3) {
              console.warn(
                `Failed to pin message: ${pinErr.message} (Attempt ${attempt}/3)`
              );
            }
          }
        }
        updatedEscrow.dealConfirmedMessageId = confirmedMsg.message_id;
        await updatedEscrow.save();

        // Generate deposit address and send deposit instructions
        try {
          // Normalize chain to network (BNB -> BSC, etc.)
          const network = AddressAssignmentService.normalizeChainToNetwork(
            updatedEscrow.chain
          );

          const addressInfo =
            await AddressAssignmentService.assignDepositAddress(
              updatedEscrow.escrowId,
              updatedEscrow.token,
              network,
              updatedEscrow.quantity,
              0, // No longer using config.ESCROW_FEE_PERCENT for deposit address assignment
              updatedEscrow.groupId // Pass groupId explicitly
            );

          updatedEscrow.depositAddress = addressInfo.address;
          updatedEscrow.uniqueDepositAddress = addressInfo.address;
          updatedEscrow.contractAddress = addressInfo.contractAddress; // Explicitly save the assigned contract address
          updatedEscrow.status = "awaiting_deposit";
          await updatedEscrow.save();

          // Send deposit address message with SENT button
          // Use code tag to make address copyable (not clickable link)
          const tokenLabel = (updatedEscrow.token || "USDT").toUpperCase();
          const chainLabel = (updatedEscrow.chain || "BEP-20").toUpperCase();

          const depositAddressText = `💳 ${tokenLabel} ${chainLabel} Deposit

🏦 ${tokenLabel} ${chainLabel} Address: <code>${addressInfo.address}</code>

⚠️ Please Note:
• Double-check the address before sending.
• We are not responsible for any fake, incorrect, or unsupported tokens sent to this address.

Once you’ve sent the amount, tap the button below.`;

          await ctx.telegram.sendPhoto(
            updatedEscrow.groupId,
            images.DEPOSIT_ADDRESS,
            {
              caption: depositAddressText,
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "✅ Payment Sent",
                      callback_data: "confirm_sent_deposit",
                    },
                  ],
                ],
              },
            }
          );
        } catch (depositErr) {
          console.error("Error generating deposit address:", depositErr);
          await ctx.telegram.sendMessage(
            updatedEscrow.groupId,
            "❌ Error generating deposit address. Please contact admin."
          );
        }
      }

      return;
    } else if (callbackData.startsWith("step4_select_chain_")) {
      // Step 4: Blockchain selection
      const chain = callbackData
        .replace("step4_select_chain_", "")
        .toUpperCase();
      await safeAnswerCbQuery(ctx, `Selected ${chain}`);

      const escrow = await findGroupEscrow(
        chatId,
        ["draft", "awaiting_details"],
        { tradeDetailsStep: "step4_chain_coin" }
      );

      if (!escrow) {
        await safeAnswerCbQuery(ctx, "❌ No active escrow found.");
        return;
      }

      // Guard: Check if we are past the chain selection step
      if (
        escrow.tradeDetailsStep !== "step4_chain_coin" &&
        escrow.tradeDetailsStep !== "step3_payment" // Allow re-select if coming from payment
      ) {
        // If we are already at address step or completed, ignore this
        if (
          ["step5_buyer_address", "step6_seller_address", "completed"].includes(
            escrow.tradeDetailsStep
          )
        ) {
          await safeAnswerCbQuery(ctx, "✅ Step already completed.");
          return;
        }
      }

      // Only buyer or seller can select
      if (escrow.buyerId !== userId && escrow.sellerId !== userId) {
        return safeAnswerCbQuery(ctx, "❌ Only buyer or seller can select.");
      }

      escrow.chain = chain;
      await escrow.save();

      // Update blockchain selection message with tick mark
      if (escrow.step4ChainMessageId) {
        const chains = ["BSC"];
        const buttons = chains.map((c) => ({
          text: c === chain ? `✔ ${c}` : c,
          callback_data: `step4_select_chain_${c}`,
        }));

        try {
          await ctx.telegram.editMessageReplyMarkup(
            escrow.groupId,
            escrow.step4ChainMessageId,
            null,
            {
              inline_keyboard: [buttons],
            }
          );
        } catch (err) {
          const description = err?.response?.description || err?.message || "";
          if (description.includes("message is not modified")) {
            // Safe to ignore - user clicked the same option again, message is already in correct state
          } else {
            console.error("Error updating chain selection:", err);
          }
        }
      }

      // Immediately show coin selection after chain is chosen
      const coins = chain === "TRON" ? ["USDT"] : ["USDT", "USDC"];
      try {
        const coinMsg = await ctx.telegram.sendPhoto(
          escrow.groupId,
          images.SELECT_CRYPTO,
          {
            caption: "⚪ Select Coin",
            reply_markup: {
              inline_keyboard: [
                coins.map((c) => ({
                  text: c,
                  callback_data: `step4_select_coin_${c}`,
                })),
              ],
            },
          }
        );
        escrow.step4CoinMessageId = coinMsg.message_id;
        await escrow.save();
      } catch (err) {
        console.error("Error sending coin selection:", err);
      }

      // Do not proceed to Step 5 until coin is selected

      return;
    } else if (callbackData.startsWith("step4_select_coin_")) {
      // Step 4: Coin selection
      const coin = callbackData.replace("step4_select_coin_", "").toUpperCase();
      await safeAnswerCbQuery(ctx, `Selected ${coin}`);

      const escrow = await findGroupEscrow(
        chatId,
        ["draft", "awaiting_details"],
        { tradeDetailsStep: "step4_chain_coin" }
      );

      if (!escrow) {
        await safeAnswerCbQuery(ctx, "❌ No active escrow found.");
        return;
      }

      // Guard: Check if we are past the coin selection step
      if (escrow.tradeDetailsStep !== "step4_chain_coin") {
        if (
          ["step5_buyer_address", "step6_seller_address", "completed"].includes(
            escrow.tradeDetailsStep
          )
        ) {
          await safeAnswerCbQuery(ctx, "✅ Step already completed.");
          return;
        }
      }

      // Only buyer or seller can select
      if (escrow.buyerId !== userId && escrow.sellerId !== userId) {
        return safeAnswerCbQuery(ctx, "❌ Only buyer or seller can select.");
      }

      // Validate coin against chain
      const currentChain = (escrow.chain || "BSC").toUpperCase();
      const validCoins = currentChain === "TRON" ? ["USDT"] : ["USDT", "USDC"];

      if (!validCoins.includes(coin)) {
        await safeAnswerCbQuery(
          ctx,
          `❌ ${coin} is not supported on ${currentChain}`
        );
        console.warn(
          `Invalid coin selection blocked: ${coin} on ${currentChain} (Escrow: ${escrow.escrowId})`
        );
        return;
      }

      escrow.token = coin;
      await escrow.save();

      // Update coin selection message with tick mark
      if (escrow.step4CoinMessageId) {
        const coins =
          escrow.chain && escrow.chain.toUpperCase() === "TRON"
            ? ["USDT"]
            : ["USDT", "USDC"];
        const buttons = coins.map((c) => {
          const text = c === coin ? `✔ ${c}` : c;
          return { text, callback_data: `step4_select_coin_${c}` };
        });

        try {
          await ctx.telegram.editMessageReplyMarkup(
            escrow.groupId,
            escrow.step4CoinMessageId,
            null,
            {
              inline_keyboard: [buttons],
            }
          );
        } catch (err) {
          const description = err?.response?.description || err?.message || "";
          if (description.includes("message is not modified")) {
            // Safe to ignore - user clicked the same option again, message is already in correct state
          } else {
            console.error("Error updating coin selection:", err);
          }
        }
      }

      // Check if both chain and coin are selected (only show Step 5 once)
      // Reload escrow to get latest state (in case chain was just selected)
      const updatedEscrow = await Escrow.findById(escrow._id);
      if (
        updatedEscrow.chain &&
        updatedEscrow.token &&
        updatedEscrow.tradeDetailsStep === "step4_chain_coin"
      ) {
        updatedEscrow.tradeDetailsStep = "step5_buyer_address";
        updatedEscrow.status = "draft";
        await updatedEscrow.save();

        // Step 5: Ask buyer for their wallet address
        const buyerUsername = updatedEscrow.buyerUsername
          ? `@${updatedEscrow.buyerUsername}`
          : "Buyer";
        const chainName = updatedEscrow.chain || "BSC";
        const telegram = ctx.telegram;
        const groupId = updatedEscrow.groupId;

        let addressExample = getAddressExample(chainName);
        addressExample = addressExample
          .replace("{username}", buyerUsername)
          .replace("{chain}", chainName);
        const step5Msg = await telegram.sendPhoto(
          groupId,
          images.ENTER_ADDRESS,
          {
            caption: addressExample,
          }
        );
        updatedEscrow.step5BuyerAddressMessageId = step5Msg.message_id;
        await updatedEscrow.save();
      }

      return;
    } else if (callbackData.startsWith("close_trade_")) {
      await safeAnswerCbQuery(ctx, "Closing trade...");
      const escrowId = callbackData.split("_")[2];
      const escrow = await Escrow.findOne({ escrowId });

      if (!escrow) {
        return safeAnswerCbQuery(ctx, "❌ Escrow not found.");
      }

      // Check if user is buyer, seller, or admin
      const isBuyer = escrow.buyerId === userId;
      const isSeller = escrow.sellerId === userId;
      const isAdmin =
        config.getAllAdminUsernames().includes(ctx.from.username) ||
        config.getAllAdminIds().includes(String(userId));

      if (!isBuyer && !isSeller && !isAdmin) {
        return safeAnswerCbQuery(
          ctx,
          "❌ Only buyer, seller, or admin can close this trade."
        );
      }

      // Check if trade is completed or refunded
      if (escrow.status !== "completed" && escrow.status !== "refunded") {
        return safeAnswerCbQuery(
          ctx,
          "❌ Trade must be completed or refunded before closing."
        );
      }

      // Unpin the deal confirmed message
      if (escrow.dealConfirmedMessageId) {
        try {
          await ctx.telegram.unpinChatMessage(
            escrow.groupId,
            escrow.dealConfirmedMessageId
          );
        } catch (_) {}
        escrow.dealConfirmedMessageId = undefined;
        await escrow.save();
      }

      // Immediately recycle the group (single click from anyone)
      await recycleGroupImmediately(escrow, ctx.telegram);

      try {
        await ctx.telegram.sendMessage(
          escrow.groupId,
          "✅ Trade closed successfully! Group has been recycled and is ready for the next deal."
        );
      } catch (notifyError) {
        console.error("Error notifying group recycle completion:", notifyError);
      }

      return;
    } else if (callbackData === "confirm_sent_deposit") {
      await safeAnswerCbQuery(ctx, "Processing...");

      const escrow = await findGroupEscrow(chatId, [
        "awaiting_deposit",
        "deposited",
      ]);

      if (!escrow || !escrow.depositAddress) {
        return safeAnswerCbQuery(ctx, "❌ No active deposit address found.");
      }

      // Check if seller clicked the button
      const userId = ctx.from.id;
      if (escrow.sellerId !== userId) {
        return safeAnswerCbQuery(
          ctx,
          "❌ Only the seller can click SENT button."
        );
      }

      // Ask seller to paste transaction hash or explorer link
      const sellerUsername = escrow.sellerUsername
        ? `@${escrow.sellerUsername}`
        : "Seller";
      const askTxMsg = await ctx.telegram.sendMessage(
        escrow.groupId,
        `✉️ ${sellerUsername} kindly paste the transaction hash or explorer link.`
      );
      escrow.transactionHashMessageId = askTxMsg.message_id;
      await escrow.save();

      return;
    } else if (callbackData === "check_deposit") {
      await safeAnswerCbQuery(ctx, "Checking for your deposit...");
      const chatId = ctx.chat.id;
      const escrow = await findGroupEscrow(chatId, [
        "awaiting_deposit",
        "deposited",
      ]);
      if (!escrow || !escrow.depositAddress) {
        return ctx.reply("❌ No active deposit address found.");
      }

      if (!escrow.depositAddress) {
        return ctx.reply("❌ Deposit address missing.");
      }

      const checkAddress = escrow.depositAddress;

      // On-chain first: query RPC logs, then fallback to explorer
      // Start from 0 if no previous check, or we can use escrow's last checked block field
      const lastCheckedBlock = escrow.lastCheckedBlock || 0;
      let txs = await BlockchainService.getTokenTransfersViaRPC(
        escrow.token,
        escrow.chain,
        checkAddress,
        lastCheckedBlock
      );
      if (!txs || txs.length === 0) {
        txs = await BlockchainService.getTokenTransactions(
          escrow.token,
          escrow.chain,
          checkAddress
        );
      }

      const sellerAddr = (escrow.sellerAddress || "").toLowerCase();
      const vaultAddr = checkAddress.toLowerCase();

      // Only count new deposits since the last check - filter for deposits TO the vault
      const newDeposits = (txs || []).filter((tx) => {
        const from = (tx.from || "").toLowerCase();
        const to = (tx.to || "").toLowerCase();

        if (to !== vaultAddr) return false;

        // CRITICAL: Check if hash is already recorded (via Paste Hash or previous Check)
        const hash = tx.hash;
        if (!hash) return true; // Fallback if no hash (shouldn't happen with fix)

        // Check main hash
        if (
          escrow.transactionHash &&
          escrow.transactionHash.toLowerCase() === hash.toLowerCase()
        ) {
          return false;
        }

        // Check partials
        if (
          escrow.partialTransactionHashes &&
          escrow.partialTransactionHashes.some(
            (h) => h.toLowerCase() === hash.toLowerCase()
          )
        ) {
          return false;
        }

        return true;
      });

      const newAmount = newDeposits.reduce(
        (sum, tx) => sum + Number(tx.valueDecimal),
        0
      );
      const previousAmount = escrow.depositAmount;
      const totalAmount = previousAmount + newAmount;

      if (newAmount > 0) {
        // Track last checked block from RPC
        try {
          const latest = await BlockchainService.getLatestBlockNumber(
            escrow.chain
          );
          if (latest) escrow.lastCheckedBlock = latest;
        } catch {}

        // Save transaction hashes to prevent reuse
        for (const tx of newDeposits) {
          const hash = tx.hash;
          if (!hash) continue;

          if (!escrow.transactionHash) {
            escrow.transactionHash = hash;
            escrow.depositTransactionFromAddress = tx.from;
          } else {
            if (!escrow.partialTransactionHashes)
              escrow.partialTransactionHashes = [];
            // Avoid adding duplicates to the array
            if (
              !escrow.partialTransactionHashes.includes(hash) &&
              escrow.transactionHash !== hash
            ) {
              escrow.partialTransactionHashes.push(hash);
            }
          }
        }

        escrow.depositAmount = totalAmount;
        escrow.confirmedAmount = totalAmount;
        escrow.status = "deposited";
        await escrow.save();

        await ctx.reply(
          `✅ Deposit confirmed: ${newAmount.toFixed(2)} ${escrow.token}`
        );

        // Begin fiat transfer handshake
        // Ask buyer to confirm they've sent the fiat payment
        if (escrow.buyerId) {
          await ctx.telegram.sendMessage(
            escrow.groupId,
            `💸 Buyer ${
              escrow.buyerUsername
                ? "@" + escrow.buyerUsername
                : "[" + escrow.buyerId + "]"
            }: Please send the agreed fiat amount to the seller via your agreed method and confirm below.`,
            {
              reply_markup: Markup.inlineKeyboard([
                [
                  Markup.button.callback(
                    "✅ I have sent the money",
                    `fiat_sent_buyer_${escrow.escrowId}`
                  ),
                ],
              ]).reply_markup,
            }
          );
        }
      } else {
        await ctx.reply(
          "❌ No new deposit found yet. Please try again in a moment."
        );
      }
    } else if (callbackData.startsWith("fiat_sent_buyer_")) {
      try {
        // Extract escrowId - handle cases where escrowId might have underscores
        const escrowId = callbackData.replace("fiat_sent_buyer_", "");

        // Only buyer can click
        const escrow = await Escrow.findOne({
          escrowId: escrowId,
          status: { $in: ["deposited", "in_fiat_transfer"] },
        });

        if (!escrow) {
          await safeAnswerCbQuery(ctx, "❌ No active escrow found.");
          console.log("❌ Escrow not found for:", escrowId);
          return;
        }

        if (escrow.buyerId !== userId) {
          await safeAnswerCbQuery(ctx, "❌ Only the buyer can confirm this.");
          return;
        }

        escrow.buyerSentFiat = true;
        escrow.status = "in_fiat_transfer";
        await escrow.save();

        await safeAnswerCbQuery(ctx, "✅ Noted.");

        // Ask seller to confirm receipt - send to the group using groupId
        const sellerPrompt = await ctx.telegram.sendMessage(
          escrow.groupId,
          `🏦 Seller ${
            escrow.sellerUsername
              ? "@" + escrow.sellerUsername
              : "[" + escrow.sellerId + "]"
          }: Did you receive the fiat payment?`,
          {
            reply_markup: Markup.inlineKeyboard([
              [
                Markup.button.callback(
                  "✅ Yes, I received",
                  `fiat_received_seller_yes_${escrow.escrowId}`
                ),
                Markup.button.callback(
                  "❌ No, not received",
                  `fiat_received_seller_no_${escrow.escrowId}`
                ),
              ],
              [
                Markup.button.callback(
                  "⚠️ Received less money",
                  `fiat_received_seller_partial_${escrow.escrowId}`
                ),
              ],
            ]).reply_markup,
          }
        );
      } catch (error) {
        console.error("❌ Error in fiat_sent_buyer handler:", error);
        await safeAnswerCbQuery(ctx, "❌ An error occurred. Please try again.");
      }
    } else if (callbackData.startsWith("fiat_received_seller_partial_")) {
      const escrowId = callbackData.replace(
        "fiat_received_seller_partial_",
        ""
      );
      await safeAnswerCbQuery(ctx, "⚠️ Partial payment noted");

      const escrow = await Escrow.findOne({
        escrowId: escrowId,
        status: { $in: ["in_fiat_transfer", "deposited"] },
      });

      if (escrow) {
        try {
          const admins = (config.getAllAdminUsernames?.() || []).filter(
            Boolean
          );
          const adminMentions = admins.length
            ? admins.map((u) => `@${u}`).join(" ")
            : "Admin";
          await ctx.telegram.sendMessage(
            escrow.groupId,
            `⚠️ Seller reported partial fiat payment for escrow ${escrowId}. ${adminMentions} please review and resolve.`
          );
        } catch (e) {
          console.error("Error sending admin notification:", e);
        }
      }
      return;
    } else if (
      callbackData.startsWith("buyer_received_tokens_yes_") ||
      callbackData.startsWith("buyer_received_tokens_no_")
    ) {
      // Buyer confirmation for token receipt
      const escrowId = callbackData.includes("_yes_")
        ? callbackData.replace("buyer_received_tokens_yes_", "")
        : callbackData.replace("buyer_received_tokens_no_", "");

      const escrow = await Escrow.findOne({
        escrowId: escrowId,
        status: "completed",
      });

      if (!escrow) {
        await safeAnswerCbQuery(ctx, "❌ No active escrow found.");
        return;
      }

      if (escrow.buyerId !== userId) {
        await safeAnswerCbQuery(ctx, "❌ Only the buyer can confirm this.");
        return;
      }

      const isYes = callbackData.includes("_yes_");

      if (isYes) {
        await safeAnswerCbQuery(ctx, "✅ Confirmed receipt of tokens.");
        await announceAndScheduleRecycling(
          escrow,
          ctx,
          "✅ Buyer confirmed receipt of tokens. Trade completed successfully! Group will be recycled in 5 minutes."
        );
      } else {
        await safeAnswerCbQuery(ctx, "⚠️ Issue reported.");
        const admins = (config.getAllAdminUsernames?.() || []).filter(Boolean);
        const adminMentions = admins.length
          ? admins.map((u) => `@${u}`).join(" ")
          : "Admin";
        await ctx.telegram.sendMessage(
          escrow.groupId,
          `⚠️ Buyer reported not receiving tokens for escrow ${escrowId}. Transaction hash: ${
            escrow.releaseTransactionHash || "N/A"
          }. ${adminMentions} please review.`
        );
      }
      return;
    } else if (
      callbackData.startsWith("fiat_received_seller_yes_") ||
      callbackData.startsWith("fiat_received_seller_no_")
    ) {
      // Extract escrowId - handle both yes and no cases
      const escrowId = callbackData.includes("_yes_")
        ? callbackData.replace("fiat_received_seller_yes_", "")
        : callbackData.replace("fiat_received_seller_no_", "");
      // Only seller can click
      const escrow = await Escrow.findOne({
        escrowId: escrowId,
        status: { $in: ["in_fiat_transfer", "deposited"] },
      });
      if (!escrow) {
        await safeAnswerCbQuery(ctx, "❌ No active escrow found.");
        return;
      }

      if (escrow.sellerId !== userId) {
        await safeAnswerCbQuery(ctx, "❌ Only the seller can confirm this.");
        return;
      }

      const isYes = callbackData.includes("_yes_");
      if (!isYes) {
        escrow.sellerReceivedFiat = false;
        await escrow.save();

        await safeAnswerCbQuery(ctx, "❌ Marked as not received");

        // Notify admins
        try {
          const admins = (config.getAllAdminUsernames?.() || []).filter(
            Boolean
          );
          const adminMentions = admins.length
            ? admins.map((u) => `@${u}`).join(" ")
            : "Admin";
          await ctx.telegram.sendMessage(
            escrow.groupId,
            `🚨 Seller reported no fiat received for escrow ${escrowId}. ${adminMentions} please review and resolve.`
          );
        } catch (e) {
          console.error("Error sending admin notification:", e);
        }
        return;
      }

      // Step 1: seller selected full amount; ask for final confirmation in the same message
      escrow.sellerReceivedFiat = true;
      await escrow.save();
      await safeAnswerCbQuery(ctx, "✅ Full amount selected");
      try {
        await ctx.editMessageText(
          "✅ Seller reported full amount received. Confirm to complete the trade and release funds to the buyer.",
          {
            reply_markup: Markup.inlineKeyboard([
              [
                Markup.button.callback(
                  "✅ Confirm release",
                  `fiat_release_confirm_${escrow.escrowId}`
                ),
                Markup.button.callback(
                  "❌ Cancel",
                  `fiat_release_cancel_${escrow.escrowId}`
                ),
              ],
            ]).reply_markup,
          }
        );
      } catch (e) {
        const confirmMsg = await ctx.reply(
          "✅ Seller reported full amount received. Confirm to complete the trade and release funds to the buyer.",
          {
            reply_markup: Markup.inlineKeyboard([
              [
                Markup.button.callback(
                  "✅ Confirm release",
                  `fiat_release_confirm_${escrow.escrowId}`
                ),
                Markup.button.callback(
                  "❌ Cancel",
                  `fiat_release_cancel_${escrow.escrowId}`
                ),
              ],
            ]).reply_markup,
          }
        );
      }
    } else if (callbackData.startsWith("release_confirm_no_")) {
      const escrowId = callbackData.replace("release_confirm_no_", "");
      const callbackMessageId = ctx.callbackQuery?.message?.message_id;

      const escrow = await Escrow.findOne({
        escrowId,
        status: {
          $in: [
            "deposited",
            "in_fiat_transfer",
            "ready_to_release",
            "disputed",
          ],
        },
      });

      if (
        escrow &&
        callbackMessageId &&
        escrow.releaseConfirmationMessageId &&
        escrow.releaseConfirmationMessageId !== callbackMessageId
      ) {
        return safeAnswerCbQuery(ctx, "❌ This request has expired.");
      }

      if (!escrow) {
        return safeAnswerCbQuery(ctx, "❌ No active escrow found.");
      }

      const userId = ctx.from.id;
      const normalizedUsername = (ctx.from.username || "").toLowerCase();
      const isBuyerIdMatch =
        escrow.buyerId && Number(escrow.buyerId) === Number(userId);
      const isBuyerUsernameMatch =
        escrow.buyerUsername &&
        escrow.buyerUsername.toLowerCase() === normalizedUsername;
      const isBuyer = Boolean(isBuyerIdMatch || isBuyerUsernameMatch);
      const isSellerIdMatch =
        escrow.sellerId && Number(escrow.sellerId) === Number(userId);
      const isSellerUsernameMatch =
        escrow.sellerUsername &&
        escrow.sellerUsername.toLowerCase() === normalizedUsername;
      const isSeller = Boolean(isSellerIdMatch || isSellerUsernameMatch);
      const isAdmin =
        config
          .getAllAdminUsernames()
          .some((name) => name && name.toLowerCase() === normalizedUsername) ||
        config.getAllAdminIds().includes(String(userId));

      if (!isBuyer && !isSeller && !isAdmin) {
        return safeAnswerCbQuery(
          ctx,
          "❌ Only buyer, seller, or admin can decline."
        );
      }

      // Reset confirmations
      escrow.buyerConfirmedRelease = false;
      escrow.sellerConfirmedRelease = false;
      await escrow.save();

      try {
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      } catch (e) {}

      try {
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      } catch (e) {}

      await safeAnswerCbQuery(ctx, "❌ Release cancelled.");
      await ctx.reply("❌ Release cancelled by user.");
      try {
        await ctx.editMessageCaption(
          escrow.groupId,
          escrow.releaseConfirmationMessageId,
          null,
          "❎ Release cancelled. No action taken.",
          { parse_mode: "HTML" }
        );
      } catch (e) {
        try {
          await ctx.editMessageText("❎ Release cancelled. No action taken.");
        } catch (e2) {}
      }
      return;
    } else if (callbackData.startsWith("admin_release_confirm_no_")) {
      const escrowId = callbackData.replace("admin_release_confirm_no_", "");
      const callbackMessageId = ctx.callbackQuery?.message?.message_id;

      const escrow = await Escrow.findOne({
        escrowId,
        status: {
          $in: [
            "deposited",
            "in_fiat_transfer",
            "ready_to_release",
            "disputed",
          ],
        },
      });

      if (
        escrow &&
        callbackMessageId &&
        escrow.releaseConfirmationMessageId &&
        escrow.releaseConfirmationMessageId !== callbackMessageId
      ) {
        return safeAnswerCbQuery(ctx, "❌ This request has expired.");
      }

      if (!escrow) {
        return safeAnswerCbQuery(ctx, "❌ No active escrow found.");
      }

      const userId = ctx.from.id;
      const isAdmin =
        config.getAllAdminUsernames().includes(ctx.from.username) ||
        config.getAllAdminIds().includes(String(userId));

      if (!isAdmin) {
        return safeAnswerCbQuery(
          ctx,
          "❌ Only admin can cancel admin release."
        );
      }

      // Reset confirmations
      escrow.adminConfirmedRelease = false;
      escrow.pendingReleaseAmount = null;
      await escrow.save();

      await safeAnswerCbQuery(ctx, "❎ Admin release cancelled");
      try {
        await ctx.editMessageCaption(
          escrow.groupId,
          escrow.releaseConfirmationMessageId,
          null,
          "❎ Admin release cancelled. No action taken.",
          { parse_mode: "HTML" }
        );
      } catch (e) {
        try {
          await ctx.editMessageText(
            "❎ Admin release cancelled. No action taken."
          );
        } catch (e2) {}
      }
      return;
    } else if (callbackData.startsWith("admin_release_confirm_yes_")) {
      const escrowId = callbackData.replace("admin_release_confirm_yes_", "");
      const callbackMessageId = ctx.callbackQuery?.message?.message_id;

      const escrow = await Escrow.findOne({
        escrowId,
        status: {
          $in: [
            "deposited",
            "in_fiat_transfer",
            "ready_to_release",
            "disputed",
          ],
        },
      });

      if (!escrow) {
        return safeAnswerCbQuery(ctx, "❌ No active escrow found.");
      }

      // Guard against duplicate / stale confirmations
      if (
        !escrow.releaseConfirmationMessageId ||
        (callbackMessageId &&
          escrow.releaseConfirmationMessageId !== callbackMessageId)
      ) {
        return safeAnswerCbQuery(
          ctx,
          "❌ This release confirmation is no longer valid or has already been processed."
        );
      }

      // Also guard against already-settled deals
      if (["completed", "refunded"].includes(escrow.status)) {
        return safeAnswerCbQuery(ctx, "❌ This deal has already been settled.");
      }

      const userId = ctx.from.id;
      const isAdmin =
        config.getAllAdminUsernames().includes(ctx.from.username) ||
        config.getAllAdminIds().includes(String(userId));

      if (!isAdmin) {
        return safeAnswerCbQuery(
          ctx,
          "❌ Only admin can confirm admin release."
        );
      }

      // Admin confirmed - proceed with release immediately
      escrow.adminConfirmedRelease = true;
      await escrow.save();

      await safeAnswerCbQuery(ctx, "✅ Processing admin release...");

      // Reload to get latest state
      const updatedEscrow = await Escrow.findById(escrow._id);

      const decimals = BlockchainService.getTokenDecimals(
        updatedEscrow.token,
        updatedEscrow.chain
      );
      const totalDepositedWei =
        updatedEscrow.accumulatedDepositAmountWei &&
        updatedEscrow.accumulatedDepositAmountWei !== "0"
          ? updatedEscrow.accumulatedDepositAmountWei
          : null;
      const totalDeposited = Number(
        updatedEscrow.accumulatedDepositAmount ||
          updatedEscrow.depositAmount ||
          updatedEscrow.confirmedAmount ||
          0
      );
      const formattedTotalDeposited = totalDepositedWei
        ? Number(ethers.formatUnits(BigInt(totalDepositedWei), decimals))
        : totalDeposited;

      if (!updatedEscrow.buyerAddress || totalDeposited <= 0) {
        return safeAnswerCbQuery(
          ctx,
          "❌ Cannot release funds: missing buyer address or zero amount."
        );
      }

      // Use pending release amount (should be set for admin partial releases)
      let releaseAmount =
        updatedEscrow.pendingReleaseAmount !== null &&
        updatedEscrow.pendingReleaseAmount !== undefined
          ? updatedEscrow.pendingReleaseAmount
          : formattedTotalDeposited;

      if (
        updatedEscrow.pendingReleaseAmount === null ||
        updatedEscrow.pendingReleaseAmount === undefined
      ) {
        const networkFee = updatedEscrow.networkFee;
        const feeRate =
          typeof updatedEscrow.feeRate === "number"
            ? updatedEscrow.feeRate
            : 0.75; // Strict default, no global config fallback
        const feeRateDecimal = feeRate / 100;

        // Calculate expected payout
        const grossFee = totalDeposited * feeRateDecimal;
        const totalDeductions = networkFee + grossFee;
        let targetPayout = totalDeposited - totalDeductions;

        targetPayout = Math.floor(targetPayout * 100) / 100;

        if (targetPayout <= 0) {
          releaseAmount = totalDeposited - networkFee;
        } else {
          if (feeRateDecimal >= 1) {
            releaseAmount = totalDeposited - networkFee;
          } else {
            releaseAmount = targetPayout / (1 - feeRateDecimal);
          }
        }

        if (releaseAmount > totalDeposited) {
          releaseAmount = totalDeposited;
        }
      }

      // Send (gross - networkFee) to contract, contract will deduct service fee
      const networkFee = updatedEscrow.networkFee || 0;
      const amountToContract = releaseAmount - networkFee;

      const releaseResult = await BlockchainService.releaseFunds(
        updatedEscrow.token,
        updatedEscrow.chain,
        updatedEscrow.buyerAddress,
        amountToContract,
        null,
        updatedEscrow.groupId,
        updatedEscrow.contractAddress
      );

      if (releaseAmount > formattedTotalDeposited) {
        return safeAnswerCbQuery(
          ctx,
          `❌ Release amount exceeds available balance (${formattedTotalDeposited.toFixed(
            5
          )} ${updatedEscrow.token}).`
        );
      }

      if (releaseAmount <= 0) {
        return safeAnswerCbQuery(
          ctx,
          "❌ Release amount must be greater than 0."
        );
      }

      const EPSILON = 0.00001;
      const isFullRelease =
        Math.abs(releaseAmount - formattedTotalDeposited) < EPSILON;

      let amountWeiOverride = null;
      if (isFullRelease && totalDepositedWei) {
        amountWeiOverride = totalDepositedWei;
      } else if (totalDepositedWei && formattedTotalDeposited > 0) {
        try {
          const releaseAmountWei = ethers.parseUnits(
            releaseAmount.toFixed(decimals),
            decimals
          );
          const totalDepositedAmountWei = ethers.parseUnits(
            formattedTotalDeposited.toFixed(decimals),
            decimals
          );
          const proportionalWei =
            (BigInt(totalDepositedWei) * BigInt(releaseAmountWei)) /
            BigInt(totalDepositedAmountWei);
          amountWeiOverride = proportionalWei.toString();
        } catch (e) {
          try {
            amountWeiOverride = ethers
              .parseUnits(releaseAmount.toFixed(decimals), decimals)
              .toString();
          } catch (e2) {
            amountWeiOverride = null;
          }
        }
      } else {
        try {
          amountWeiOverride = ethers
            .parseUnits(releaseAmount.toFixed(decimals), decimals)
            .toString();
        } catch (e) {
          amountWeiOverride = null;
        }
      }

      try {
        await ctx.editMessageText("🚀 Releasing funds to the buyer...");
      } catch (e) {}

      try {
        // Deduct networkFee for admin release as well ensures consistency
        const networkFee = updatedEscrow.networkFee || 0;
        const amountToRelease = releaseAmount - networkFee;

        if (amountToRelease <= 0) {
          throw new Error(
            `Release amount (${amountToRelease}) after network fee (${networkFee}) is <= 0`
          );
        }

        const releaseResult = await BlockchainService.releaseFunds(
          updatedEscrow.token,
          updatedEscrow.chain,
          updatedEscrow.buyerAddress,
          amountToRelease,
          amountWeiOverride,
          updatedEscrow.groupId,
          updatedEscrow.contractAddress // Pass contract address override
        );

        if (!releaseResult || !releaseResult.success) {
          throw new Error("Release transaction failed - no result returned");
        }

        if (!releaseResult.transactionHash) {
          throw new Error(
            "Release transaction succeeded but no transaction hash returned"
          );
        }

        updatedEscrow.releaseTransactionHash = releaseResult.transactionHash;
        updatedEscrow.partialReleaseTransactionHashes.push(
          releaseResult.transactionHash
        );

        const isPartialRelease =
          Math.abs(releaseAmount - formattedTotalDeposited) >= EPSILON;
        const remainingAmount = formattedTotalDeposited - releaseAmount;
        const isActuallyFullRelease = remainingAmount < EPSILON;

        if (isPartialRelease && !isActuallyFullRelease) {
          updatedEscrow.accumulatedDepositAmount = remainingAmount;
          updatedEscrow.depositAmount = remainingAmount;
          updatedEscrow.confirmedAmount = remainingAmount;

          if (totalDepositedWei && amountWeiOverride) {
            const remainingWei =
              BigInt(totalDepositedWei) - BigInt(amountWeiOverride);
            updatedEscrow.accumulatedDepositAmountWei =
              remainingWei < 0 ? "0" : remainingWei.toString();
          }
        } else {
          if (!updatedEscrow.quantity || updatedEscrow.quantity <= 0) {
            updatedEscrow.quantity = releaseAmount;
          }
          updatedEscrow.status = "completed";
          updatedEscrow.completedAt = new Date();
          updatedEscrow.accumulatedDepositAmount = 0;
          updatedEscrow.depositAmount = 0;
          updatedEscrow.confirmedAmount = 0;
          updatedEscrow.accumulatedDepositAmountWei = "0";
        }

        updatedEscrow.pendingReleaseAmount = null;
        updatedEscrow.adminConfirmedRelease = false;
        await updatedEscrow.save();

        const chainUpper = (updatedEscrow.chain || "").toUpperCase();
        let explorerUrl = "";
        if (releaseResult.transactionHash) {
          if (chainUpper === "BSC" || chainUpper === "BNB") {
            explorerUrl = `https://bscscan.com/tx/${releaseResult.transactionHash}`;
          } else if (chainUpper === "ETH" || chainUpper === "ETHEREUM") {
            explorerUrl = `https://etherscan.io/tx/${releaseResult.transactionHash}`;
          } else if (chainUpper === "POLYGON" || chainUpper === "MATIC") {
            explorerUrl = `https://polygonscan.com/tx/${releaseResult.transactionHash}`;
          }
        }

        const linkLine = releaseResult?.transactionHash
          ? explorerUrl
            ? `<a href="${explorerUrl}">Click Here</a>`
            : `<code>${releaseResult.transactionHash}</code>`
          : "Not available";

        const feeRate =
          typeof updatedEscrow.feeRate === "number"
            ? updatedEscrow.feeRate
            : 0.75;
        const feeRateDecimal = feeRate / 100;
        const serviceFee = formattedTotalDeposited * feeRateDecimal;
        const netReleaseAmount = releaseAmount;

        const successText = `✅ <b>Admin Release Complete!</b>

Amount Released: ${releaseAmount.toFixed(5)} ${updatedEscrow.token}
${
  isPartialRelease && !isActuallyFullRelease
    ? `Remaining Balance: ${(formattedTotalDeposited - releaseAmount).toFixed(
        5
      )} ${updatedEscrow.token}\n`
    : ""
}Transaction: ${linkLine}`;

        await ctx.reply(successText, { parse_mode: "HTML" });

        if (!isPartialRelease || isActuallyFullRelease) {
          const finalEscrow = await Escrow.findById(updatedEscrow._id);

          const images = require("../config/images");
          const tradeStart =
            finalEscrow.tradeStartTime || finalEscrow.createdAt || new Date();
          const minutesTaken = Math.max(
            1,
            Math.round((Date.now() - new Date(tradeStart)) / (60 * 1000))
          );

          const completionText = `🎉 <b>Deal Complete!</b> ✅

⏱️ <b>Time Taken:</b> ${minutesTaken} mins
🔗 <b>Release TX Link:</b> ${linkLine}

Thank you for using our safe escrow system.`;

          const closeTradeKeyboard = {
            inline_keyboard: [
              [
                {
                  text: "❌ Close Deal",
                  callback_data: `close_trade_${finalEscrow.escrowId}`,
                },
              ],
            ],
          };

          try {
            const withRetry = require("../utils/retry");
            const summaryMsg = await withRetry(
              () =>
                ctx.telegram.sendPhoto(
                  finalEscrow.groupId,
                  images.DEAL_COMPLETE,
                  {
                    caption: completionText,
                    parse_mode: "HTML",
                    reply_markup: closeTradeKeyboard,
                  }
                ),
              3,
              2000
            );

            if (summaryMsg) {
              finalEscrow.closeTradeMessageId = summaryMsg.message_id;
              await finalEscrow.save();
            }
          } catch (sendError) {
            console.error("Error sending completion summary:", sendError);
          }

          await updateTradeStartedMessage(
            finalEscrow,
            ctx.telegram,
            "completed",
            releaseResult?.transactionHash || null
          );

          const settleAndRecycleGroup = async (escrow, telegram) => {
            try {
              const group = await GroupPool.findOne({
                assignedEscrowId: escrow.escrowId,
              });

              if (group) {
                const allUsersRemoved =
                  await GroupPoolService.removeUsersFromGroup(
                    escrow,
                    group.groupId,
                    telegram
                  );

                if (allUsersRemoved) {
                  const freshEscrow = await Escrow.findOne({
                    escrowId: escrow.escrowId,
                  });
                  if (freshEscrow && freshEscrow.inviteLink) {
                    freshEscrow.inviteLink = null;
                    await freshEscrow.save();
                  }

                  await GroupPoolService.refreshInviteLink(
                    group.groupId,
                    telegram
                  );

                  group.status = "available";
                  group.assignedEscrowId = null;
                  group.assignedAt = null;
                  group.completedAt = null;
                  await group.save();
                }
              }
            } catch (error) {
              console.error("Error settling and recycling group:", error);
            }
          };

          setTimeout(async () => {
            await settleAndRecycleGroup(finalEscrow, ctx.telegram);
          }, 5 * 60 * 1000);
        }

        // Record stats and logs for ALL releases (partial or full)
        try {
          await UserStatsService.recordTrade({
            buyerId: updatedEscrow.buyerId,
            buyerUsername: updatedEscrow.buyerUsername,
            sellerId: updatedEscrow.sellerId,
            sellerUsername: updatedEscrow.sellerUsername,
            amount: releaseAmount,
            token: updatedEscrow.token,
            escrowId: updatedEscrow.escrowId,
          });
        } catch (statsError) {
          console.error("Error recording trade stats:", statsError);
        }

        try {
          // Reload one last time to ensure status is correct for the feed service logic
          const feedEscrow = await Escrow.findById(updatedEscrow._id);
          await CompletionFeedService.handleCompletion({
            escrow: feedEscrow,
            amount: releaseAmount, // Use release amount for this specific transaction
            transactionHash: releaseResult.transactionHash,
            telegram: ctx.telegram,
          });
        } catch (feedError) {
          console.error("Error broadcasting completion feed:", feedError);
        }
      } catch (releaseError) {
        const errStr =
          (releaseError?.message || "") + (releaseError?.toString() || "");
        if (!errStr.includes("Insufficient Vault Balance")) {
          console.error("Error in admin release:", releaseError);
        }

        let errorMsg = `❌ Error releasing funds: ${releaseError.message}`;
        if (releaseError.message.includes("Insufficient Vault Balance")) {
          const match = releaseError.message.match(
            /Contract has ([0-9.]+) but needs ([0-9.]+)/
          );
          const available = match ? match[1] : "???";
          errorMsg = `⚠️ <b>Insufficient Vault Balance</b>
The contract does not have enough funds to release ${releaseAmount} ${updatedEscrow.token}.
<b>Available:</b> ${available} ${updatedEscrow.token}
Please check the contract balance or top up the vault.`;
        }
        await ctx.reply(errorMsg, { parse_mode: "HTML" });
      }

      return;
    } else if (callbackData.startsWith("release_confirm_yes_")) {
      const escrowId = callbackData.replace("release_confirm_yes_", "");
      const callbackMessageId = ctx.callbackQuery?.message?.message_id;

      const escrow = await Escrow.findOne({
        escrowId,
        status: {
          $in: [
            "deposited",
            "in_fiat_transfer",
            "ready_to_release",
            "disputed",
          ],
        },
      });

      if (!escrow) {
        return safeAnswerCbQuery(ctx, "❌ No active escrow found.");
      }

      if (
        !escrow.releaseConfirmationMessageId ||
        (callbackMessageId &&
          escrow.releaseConfirmationMessageId !== callbackMessageId)
      ) {
        return safeAnswerCbQuery(
          ctx,
          "❌ This release confirmation is no longer valid or has already been processed."
        );
      }

      if (["completed", "refunded"].includes(escrow.status)) {
        try {
          await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
        } catch (e) {}
        return safeAnswerCbQuery(ctx, "❌ This deal has already been settled.");
      }

      const userId = ctx.from.id;
      const isBuyer = Number(escrow.buyerId) === Number(userId);
      const isSeller = Number(escrow.sellerId) === Number(userId);
      const isAdmin =
        config.getAllAdminUsernames().includes(ctx.from.username) ||
        config.getAllAdminIds().includes(String(userId));

      if (!isBuyer && !isSeller && !isAdmin) {
        return safeAnswerCbQuery(
          ctx,
          "❌ Only buyer, seller, or admin can approve release."
        );
      }

      if (isBuyer) {
        escrow.buyerConfirmedRelease = true;
      }
      if (isSeller) {
        escrow.sellerConfirmedRelease = true;
      }
      if (isAdmin && !isBuyer && !isSeller) {
        escrow.buyerConfirmedRelease = true;
        escrow.sellerConfirmedRelease = true;
      }
      await escrow.save();

      const updatedEscrow = await Escrow.findById(escrow._id);

      const sellerTag = updatedEscrow.sellerUsername
        ? `@${updatedEscrow.sellerUsername}`
        : `[${updatedEscrow.sellerId}]`;
      const buyerTag = updatedEscrow.buyerUsername
        ? `@${updatedEscrow.buyerUsername}`
        : `[${updatedEscrow.buyerId}]`;

      const isPartialRelease = updatedEscrow.pendingReleaseAmount !== null;
      let approvalNote = "";
      let statusSection = "";

      if (isPartialRelease) {
        approvalNote =
          updatedEscrow.buyerConfirmedRelease &&
          updatedEscrow.sellerConfirmedRelease
            ? "✅ All approvals received. Processing release..."
            : "⚠️ Both requests required for partial release.";

        const sellerLine = updatedEscrow.sellerConfirmedRelease
          ? `✅ ${sellerTag} - Confirmed`
          : `⌛️ ${sellerTag} - Waiting...`;
        const buyerLine = updatedEscrow.buyerConfirmedRelease
          ? `✅ ${buyerTag} - Confirmed`
          : `⌛️ ${buyerTag} - Waiting...`;
        statusSection = `${sellerLine}\n${buyerLine}`;
      } else {
        statusSection = updatedEscrow.sellerConfirmedRelease
          ? `✅ ${sellerTag} - Confirmed`
          : `⌛️ ${sellerTag} - Waiting...`;
        approvalNote = updatedEscrow.sellerConfirmedRelease
          ? "✅ All approvals received. Processing release..."
          : "Only the seller needs to approve to release payment.";
      }

      const releaseCaption = `<b>Release Confirmation${
        isPartialRelease ? " (Partial)" : ""
      }</b>

${statusSection}

${approvalNote}`;

      if (updatedEscrow.releaseConfirmationMessageId) {
        try {
          let showButtons = true;
          if (isPartialRelease) {
            if (
              updatedEscrow.buyerConfirmedRelease &&
              updatedEscrow.sellerConfirmedRelease
            )
              showButtons = false;
          } else {
            if (updatedEscrow.sellerConfirmedRelease) showButtons = false;
          }

          await ctx.telegram.editMessageCaption(
            updatedEscrow.groupId,
            updatedEscrow.releaseConfirmationMessageId,
            null,
            releaseCaption,
            {
              parse_mode: "HTML",
              reply_markup: !showButtons
                ? undefined
                : {
                    inline_keyboard: [
                      [
                        Markup.button.callback(
                          "✅ Approve",
                          `release_confirm_yes_${updatedEscrow.escrowId}`
                        ),
                        Markup.button.callback(
                          "❌ Decline",
                          `release_confirm_no_${updatedEscrow.escrowId}`
                        ),
                      ],
                    ],
                  },
            }
          );
        } catch (e) {
          const description = e?.response?.description || e?.message || "";
          if (description.includes("message is not modified")) {
            // Safe to ignore - message is already in correct state
          } else {
            console.error("Error updating release confirmation message:", e);
          }
        }
      }

      if (
        updatedEscrow.buyerConfirmedRelease &&
        updatedEscrow.sellerConfirmedRelease
      ) {
        await safeAnswerCbQuery(
          ctx,
          "✅ Both parties approved. Processing release..."
        );
      } else {
        await safeAnswerCbQuery(
          ctx,
          "✅ Your approval has been recorded. Waiting for the seller..."
        );
      }

      if (
        updatedEscrow.buyerConfirmedRelease &&
        updatedEscrow.sellerConfirmedRelease
      ) {
        // Final guard to prevent double release if something already settled the deal
        if (
          updatedEscrow.releaseTransactionHash ||
          ["completed", "refunded"].includes(updatedEscrow.status)
        ) {
          return safeAnswerCbQuery(
            ctx,
            "❌ This deal has already been settled."
          );
        }

        const decimals = BlockchainService.getTokenDecimals(
          updatedEscrow.token,
          updatedEscrow.chain
        );
        const totalDepositedWei =
          updatedEscrow.accumulatedDepositAmountWei &&
          updatedEscrow.accumulatedDepositAmountWei !== "0"
            ? updatedEscrow.accumulatedDepositAmountWei
            : null;
        const totalDeposited = Number(
          updatedEscrow.accumulatedDepositAmount ||
            updatedEscrow.depositAmount ||
            updatedEscrow.confirmedAmount ||
            0
        );
        const formattedTotalDeposited = totalDepositedWei
          ? Number(ethers.formatUnits(BigInt(totalDepositedWei), decimals))
          : totalDeposited;

        if (!updatedEscrow.buyerAddress || totalDeposited <= 0) {
          return safeAnswerCbQuery(
            ctx,
            "❌ Cannot release funds: missing buyer address or zero amount."
          );
        }

        let releaseAmount =
          updatedEscrow.pendingReleaseAmount !== null &&
          updatedEscrow.pendingReleaseAmount !== undefined
            ? updatedEscrow.pendingReleaseAmount
            : formattedTotalDeposited;

        if (releaseAmount > formattedTotalDeposited) {
          return safeAnswerCbQuery(
            ctx,
            `❌ Release amount exceeds available balance (${formattedTotalDeposited.toFixed(
              5
            )} ${updatedEscrow.token}).`
          );
        }

        if (releaseAmount <= 0) {
          return safeAnswerCbQuery(
            ctx,
            "❌ Release amount must be greater than 0."
          );
        }

        const EPSILON = 0.00001;
        const isFullRelease =
          Math.abs(releaseAmount - formattedTotalDeposited) < EPSILON;
        let amountWeiOverride = null;
        if (isFullRelease && totalDepositedWei) {
          amountWeiOverride = totalDepositedWei;
        } else if (totalDepositedWei && formattedTotalDeposited > 0) {
          try {
            const releaseAmountWei = ethers.parseUnits(
              releaseAmount.toFixed(decimals),
              decimals
            );
            const totalDepositedAmountWei = ethers.parseUnits(
              formattedTotalDeposited.toFixed(decimals),
              decimals
            );
            const proportionalWei =
              (BigInt(totalDepositedWei) * BigInt(releaseAmountWei)) /
              BigInt(totalDepositedAmountWei);
            amountWeiOverride = proportionalWei.toString();
          } catch (e) {
            try {
              amountWeiOverride = ethers
                .parseUnits(releaseAmount.toFixed(decimals), decimals)
                .toString();
            } catch (e2) {
              amountWeiOverride = null;
            }
          }
        } else {
          try {
            amountWeiOverride = ethers
              .parseUnits(releaseAmount.toFixed(decimals), decimals)
              .toString();
          } catch (e) {
            amountWeiOverride = null;
          }
        }

        // Fee Calculation
        const feeRateVal = updatedEscrow.feeRate;
        const networkFee = updatedEscrow.networkFee;
        const grossReleaseAmount = releaseAmount;

        // Amount sent to contract (after network fee)
        const amountToContract = grossReleaseAmount - networkFee;

        // Contract will deduct service fee from this amount
        const serviceFeeOnNet = (amountToContract * feeRateVal) / 100;

        // This is what user will ACTUALLY receive
        const actualAmountToUser = amountToContract - serviceFeeOnNet;

        if (actualAmountToUser <= 0) {
          console.warn(
            `Warning: Actual amount to user ${actualAmountToUser} is <= 0.`
          );
        }

        try {
          const releaseResult = await BlockchainService.releaseFunds(
            updatedEscrow.token,
            updatedEscrow.chain,
            updatedEscrow.buyerAddress,
            amountToContract,
            null,
            updatedEscrow.groupId,
            updatedEscrow.contractAddress
          );

          if (!releaseResult || !releaseResult.success) {
            throw new Error("Release transaction failed - no result returned");
          }

          if (!releaseResult.transactionHash) {
            throw new Error(
              "Release transaction succeeded but no transaction hash returned"
            );
          }

          updatedEscrow.releaseTransactionHash = releaseResult.transactionHash;
          updatedEscrow.partialReleaseTransactionHashes.push(
            releaseResult.transactionHash
          );

          const EPSILON = 0.00001;

          const maxAmountToContract = formattedTotalDeposited - networkFee;
          const maxServiceFee = (maxAmountToContract * feeRateVal) / 100;
          const maxReceivable = maxAmountToContract - maxServiceFee;

          const isPartialRelease =
            Math.abs(actualAmountToUser - maxReceivable) > EPSILON;

          if (isPartialRelease) {
            const remainingAmount =
              formattedTotalDeposited - grossReleaseAmount;

            if (remainingAmount < EPSILON) {
              if (!updatedEscrow.quantity || updatedEscrow.quantity <= 0) {
                updatedEscrow.quantity = actualAmountToUser;
              }
              updatedEscrow.status = "completed";
              updatedEscrow.completedAt = new Date();
              updatedEscrow.buyerClosedTrade = false;
              updatedEscrow.sellerClosedTrade = false;
              updatedEscrow.accumulatedDepositAmount = 0;
              updatedEscrow.depositAmount = 0;
              updatedEscrow.confirmedAmount = 0;
              updatedEscrow.accumulatedDepositAmountWei = "0";
            } else {
              updatedEscrow.accumulatedDepositAmount = remainingAmount;
              updatedEscrow.depositAmount = remainingAmount;
              updatedEscrow.confirmedAmount = remainingAmount;

              if (totalDepositedWei && amountWeiOverride) {
                const remainingWei =
                  BigInt(totalDepositedWei) - BigInt(amountWeiOverride);
                if (remainingWei < 0) {
                  updatedEscrow.accumulatedDepositAmountWei = "0";
                } else {
                  updatedEscrow.accumulatedDepositAmountWei =
                    remainingWei.toString();
                }
              }
            }
          } else {
            if (!updatedEscrow.quantity || updatedEscrow.quantity <= 0) {
              updatedEscrow.quantity = actualAmountToUser;
            }
            updatedEscrow.status = "completed";
            updatedEscrow.completedAt = new Date();
            updatedEscrow.buyerClosedTrade = false;
            updatedEscrow.sellerClosedTrade = false;
            updatedEscrow.accumulatedDepositAmount = 0;
            updatedEscrow.depositAmount = 0;
            updatedEscrow.confirmedAmount = 0;
            updatedEscrow.accumulatedDepositAmountWei = "0";
          }
          updatedEscrow.pendingReleaseAmount = null;
          await updatedEscrow.save();

          // Record stats and logs for ALL releases (partial or full)
          try {
            await UserStatsService.recordTrade({
              buyerId: updatedEscrow.buyerId,
              buyerUsername: updatedEscrow.buyerUsername,
              sellerId: updatedEscrow.sellerId,
              sellerUsername: updatedEscrow.sellerUsername,
              quantity: grossReleaseAmount,
              token: updatedEscrow.token,
              escrowId: updatedEscrow.escrowId,
            });
          } catch (statsError) {
            console.error("Error recording trade stats:", statsError);
          }

          try {
            // Reload one last time to ensure status is correct for the feed service logic
            const feedEscrow = await Escrow.findById(updatedEscrow._id);
            await CompletionFeedService.handleCompletion({
              escrow: feedEscrow,
              amount: actualAmountToUser,
              transactionHash: releaseResult.transactionHash,
              telegram: ctx.telegram,
            });
          } catch (feedError) {
            console.error("Error broadcasting completion feed:", feedError);
          }

          const tradeStart =
            updatedEscrow.tradeStartTime ||
            updatedEscrow.createdAt ||
            new Date();
          const minutesTaken = Math.max(
            1,
            Math.round((Date.now() - new Date(tradeStart)) / (60 * 1000))
          );

          const chainUpper = (updatedEscrow.chain || "").toUpperCase();
          let explorerUrl = "";
          if (releaseResult.transactionHash) {
            if (chainUpper === "BSC" || chainUpper === "BNB") {
              explorerUrl = `https://bscscan.com/tx/${releaseResult.transactionHash}`;
            } else if (chainUpper === "ETH" || chainUpper === "ETHEREUM") {
              explorerUrl = `https://etherscan.io/tx/${releaseResult.transactionHash}`;
            } else if (chainUpper === "POLYGON" || chainUpper === "MATIC") {
              explorerUrl = `https://polygonscan.com/tx/${releaseResult.transactionHash}`;
            } else if (chainUpper === "TRON" || chainUpper === "TRX") {
              explorerUrl = `https://tronscan.org/#/transaction/${releaseResult.transactionHash}`;
            }
          }

          const linkLine = releaseResult?.transactionHash
            ? explorerUrl
              ? `<a href="${explorerUrl}">Click Here</a>`
              : `<code>${releaseResult.transactionHash}</code>`
            : "Not available";

          const reloadedEscrow = await Escrow.findById(updatedEscrow._id);
          const isActuallyFullRelease = reloadedEscrow.status === "completed";

          if (isActuallyFullRelease) {
            const completionText = `🎉 <b>Deal Complete!</b> ✅

⏱️ <b>Time Taken:</b> ${minutesTaken} mins
🔗 <b>Release TX Link:</b> ${linkLine}

Thank you for using our safe escrow system.`;

            const closeTradeKeyboard = {
              inline_keyboard: [
                [
                  {
                    text: "❌ Close Deal",
                    callback_data: `close_trade_${updatedEscrow.escrowId}`,
                  },
                ],
              ],
            };

            let summaryMsg;
            try {
              summaryMsg = await ctx.telegram.sendPhoto(
                updatedEscrow.groupId,
                images.DEAL_COMPLETE,
                {
                  caption: completionText,
                  parse_mode: "HTML",
                  reply_markup: closeTradeKeyboard,
                }
              );
            } catch (sendError) {
              console.error("Error sending completion summary:", sendError);
              summaryMsg = await ctx.replyWithPhoto(images.DEAL_COMPLETE, {
                caption: completionText,
                parse_mode: "HTML",
                reply_markup: closeTradeKeyboard,
              });
            }

            if (summaryMsg) {
              updatedEscrow.closeTradeMessageId = summaryMsg.message_id;
              await updatedEscrow.save();
            }

            await updateTradeStartedMessage(
              updatedEscrow,
              ctx.telegram,
              "completed",
              releaseResult?.transactionHash || null
            );

            const settleAndRecycleGroup = async (escrow, telegram) => {
              try {
                const group = await GroupPool.findOne({
                  assignedEscrowId: escrow.escrowId,
                });

                if (group) {
                  const allUsersRemoved =
                    await GroupPoolService.removeUsersFromGroup(
                      escrow,
                      group.groupId,
                      telegram
                    );

                  if (allUsersRemoved) {
                    const freshEscrow = await Escrow.findOne({
                      escrowId: escrow.escrowId,
                    });
                    if (freshEscrow && freshEscrow.inviteLink) {
                      freshEscrow.inviteLink = null;
                      await freshEscrow.save();
                    }

                    await GroupPoolService.refreshInviteLink(
                      group.groupId,
                      telegram
                    );

                    group.status = "available";
                    group.assignedEscrowId = null;
                    group.assignedAt = null;
                    group.completedAt = null;
                    await group.save();
                  }
                }
              } catch (error) {
                console.error("Error settling and recycling group:", error);
              }
            };

            setTimeout(async () => {
              await settleAndRecycleGroup(reloadedEscrow, ctx.telegram);
            }, 5 * 60 * 1000);
          } else {
            const partialReleaseText = `✅ Partial Release Complete!

Amount Released: ${actualAmountToUser.toFixed(5)} ${updatedEscrow.token}
🔗 Transaction: ${linkLine}`;

            try {
              await ctx.telegram.sendMessage(
                updatedEscrow.groupId,
                partialReleaseText,
                { parse_mode: "HTML" }
              );
            } catch (e) {
              console.error("Error sending partial release message:", e);
            }
          }

          try {
            const releaseStatusText = isPartialRelease
              ? `✅ Partial release completed: ${actualAmountToUser.toFixed(
                  5
                )} ${updatedEscrow.token}`
              : "✅ Release completed.";
            await ctx.editMessageCaption(
              updatedEscrow.groupId,
              updatedEscrow.releaseConfirmationMessageId,
              null,
              releaseStatusText,
              { parse_mode: "HTML" }
            );
          } catch (e) {
            const description = e?.response?.description || e?.message || "";
            if (description.toLowerCase().includes("message is not modified")) {
            } else {
              try {
                const releaseStatusText = isPartialRelease
                  ? `✅ Partial release completed: ${releaseAmount.toFixed(
                      5
                    )} ${updatedEscrow.token}`
                  : "✅ Release completed.";
                await ctx.editMessageText(releaseStatusText);
              } catch (e2) {
                const desc2 = e2?.response?.description || e2?.message || "";
                if (!desc2.toLowerCase().includes("message is not modified")) {
                }
              }
            }
          }
        } catch (error) {
          const errStr = (error?.message || "") + (error?.toString() || "");

          // Log error appropriately
          if (errStr.includes("Insufficient Vault Balance")) {
          } else {
            console.error("Error releasing funds via confirmation:", error);
          }

          let errorText =
            "❌ Release failed. Please try again or contact support.";
          if (errStr.includes("Insufficient Vault Balance")) {
            const match = errStr.match(
              /Contract has ([0-9.]+) but needs ([0-9.]+)/
            );
            const available = match ? match[1] : "???";
            errorText = `⚠️ <b>Insufficient Vault Balance</b>
The contract does not have enough funds to complete this release.
<b>Available:</b> ${available} ${updatedEscrow.token}
Please contact support to resolve this vault balance issue.`;
          }

          // Try to update UI - handle both Photo (caption) and Text messages
          try {
            await ctx.editMessageCaption(errorText, { parse_mode: "HTML" });
          } catch (captionError) {
            // Fallback if editCaption fails (e.g. not a photo message)
            try {
              await ctx.editMessageText(errorText, { parse_mode: "HTML" });
            } catch (textError) {
              // If editing fails completely (e.g. message deleted), send a new reply
              try {
                await ctx.reply(errorText, { parse_mode: "HTML" });
              } catch (replyError) {}
            }
          }

          if (!errStr.includes("Insufficient Vault Balance")) {
            await safeAnswerCbQuery(ctx, "❌ Release failed");
          } else {
            await safeAnswerCbQuery(ctx, "❌ Insufficient Balance");
          }
          return;
        }
      }

      return;
    } else if (callbackData.startsWith("release_confirm_no_")) {
      const escrowId = callbackData.replace("release_confirm_no_", "");
      const escrow = await Escrow.findOne({ escrowId });
      if (!escrow) return safeAnswerCbQuery(ctx, "❌ Escrow not found.");

      const userId = ctx.from.id;
      const { isAdmin } = require("../middleware/adminAuth");
      const isUserAdmin = isAdmin(ctx);

      const canDecline =
        escrow.buyerId == userId || escrow.sellerId == userId || isUserAdmin;
      if (!canDecline) return safeAnswerCbQuery(ctx, "❌ Access denied.");

      escrow.buyerConfirmedRelease = false;
      escrow.sellerConfirmedRelease = false;
      escrow.pendingReleaseAmount = null;
      await escrow.save();

      if (escrow.releaseConfirmationMessageId) {
        try {
          await ctx.telegram.editMessageCaption(
            escrow.groupId,
            escrow.releaseConfirmationMessageId,
            null,
            "❌ Release request was declined/cancelled.",
            { parse_mode: "HTML" }
          );
        } catch (e) {}
      }
      await safeAnswerCbQuery(ctx, "❌ Request declined.");
    } else if (callbackData.startsWith("refund_confirm_yes_")) {
      const escrowId = callbackData.replace("refund_confirm_yes_", "");
      const callbackMessageId = ctx.callbackQuery?.message?.message_id;
      const escrow = await Escrow.findOne({ escrowId });
      if (!escrow) return safeAnswerCbQuery(ctx, "❌ Escrow not found.");

      if (
        !escrow.refundConfirmationMessageId ||
        (callbackMessageId &&
          escrow.refundConfirmationMessageId !== callbackMessageId)
      ) {
        return safeAnswerCbQuery(ctx, "❌ Expired request.");
      }

      const userId = ctx.from.id;
      const isBuyer = Number(escrow.buyerId) === Number(userId);
      const isSeller = Number(escrow.sellerId) === Number(userId);
      const { isAdmin } = require("../middleware/adminAuth");
      const isUserAdmin = isAdmin(ctx);

      if (!isBuyer && !isSeller && !isUserAdmin)
        return safeAnswerCbQuery(ctx, "❌ Access denied.");

      if (isBuyer) escrow.buyerConfirmedRefund = true;
      if (isSeller) escrow.sellerConfirmedRefund = true;
      if (isUserAdmin && !isBuyer && !isSeller) {
        escrow.buyerConfirmedRefund = true;
        escrow.sellerConfirmedRefund = true;
      }
      await escrow.save();

      const updatedEscrow = await Escrow.findById(escrow._id);
      const sellerTag = updatedEscrow.sellerUsername
        ? `@${updatedEscrow.sellerUsername}`
        : `[Seller]`;
      const buyerTag = updatedEscrow.buyerUsername
        ? `@${updatedEscrow.buyerUsername}`
        : `[Buyer]`;

      const isPartialRefund = updatedEscrow.pendingRefundAmount !== null;

      let statusSection = "";
      if (isPartialRefund) {
        const sLine = updatedEscrow.sellerConfirmedRefund
          ? `✅ ${sellerTag} - Confirmed`
          : `⌛️ ${sellerTag} - Waiting...`;
        const bLine = updatedEscrow.buyerConfirmedRefund
          ? `✅ ${buyerTag} - Confirmed`
          : `⌛️ ${buyerTag} - Waiting...`;
        statusSection = `${sLine}\n${bLine}`;
      }

      const refundCaption = `<b>Refund Confirmation${
        isPartialRefund ? " (Partial)" : ""
      }</b>\n\n${statusSection}`;

      let showButtons = true;
      if (
        updatedEscrow.buyerConfirmedRefund &&
        updatedEscrow.sellerConfirmedRefund
      )
        showButtons = false;

      if (showButtons) {
        try {
          await ctx.telegram.editMessageCaption(
            updatedEscrow.groupId,
            updatedEscrow.refundConfirmationMessageId,
            null,
            refundCaption,
            {
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [
                  [
                    Markup.button.callback(
                      "✅ Confirm Refund",
                      `refund_confirm_yes_${escrowId}`
                    ),
                    Markup.button.callback(
                      "❌ Cancel",
                      `refund_confirm_no_${escrowId}`
                    ),
                  ],
                ],
              },
            }
          );
          return safeAnswerCbQuery(
            ctx,
            "✅ Confirmed. Waiting for other party..."
          );
        } catch (e) {}
      }

      if (
        updatedEscrow.buyerConfirmedRefund &&
        updatedEscrow.sellerConfirmedRefund
      ) {
        await safeAnswerCbQuery(ctx, "🔄 Processing refund...");

        const totalDeposited = Number(
          updatedEscrow.accumulatedDepositAmount ||
            updatedEscrow.depositAmount ||
            0
        );
        const pendingAmt = updatedEscrow.pendingRefundAmount || totalDeposited;
        const refundAmount = Math.min(pendingAmt, totalDeposited);

        if (refundAmount <= 0)
          return safeAnswerCbQuery(ctx, "❌ Invalid amount.");

        const decimals = BlockchainService.getTokenDecimals(
          updatedEscrow.token,
          updatedEscrow.chain
        );
        let amountWeiOverride = null;
        const EPSILON = 0.00001;
        const isFullAmount = Math.abs(refundAmount - totalDeposited) < EPSILON;

        if (
          isFullAmount &&
          updatedEscrow.accumulatedDepositAmountWei &&
          updatedEscrow.accumulatedDepositAmountWei !== "0"
        ) {
          amountWeiOverride = updatedEscrow.accumulatedDepositAmountWei;
        }

        const refundAmountStr = refundAmount.toFixed(decimals);

        try {
          await ctx.editMessageCaption(
            updatedEscrow.groupId,
            updatedEscrow.refundConfirmationMessageId,
            null,
            "🔄 Refund in progress...",
            { parse_mode: "HTML" }
          );
        } catch (e) {}

        const refundAmountNum = parseFloat(refundAmountStr);
        // Admin initiated refund: Calculate amount to send to contract
        const networkFee = updatedEscrow.networkFee || 0;
        let amountToContract = refundAmountNum - networkFee;

        if (amountToContract <= 0) {
          console.warn(
            `Warning: Refund amount ${refundAmountNum} is less than or equal to network fee ${networkFee}. Using full amount.`
          );
          amountToContract = refundAmountNum;
        }

        // Contract will deduct service fee from amountToContract
        const serviceFeeOnNet =
          (amountToContract * (updatedEscrow.feeRate || 0)) / 100;
        const actualAmountToUser = amountToContract - serviceFeeOnNet;

        try {
          const refundResult = await BlockchainService.refundFunds(
            updatedEscrow.token,
            updatedEscrow.chain,
            updatedEscrow.sellerAddress,
            amountToContract,
            null,
            updatedEscrow.groupId,
            updatedEscrow.contractAddress
          );

          updatedEscrow.refundTransactionHash = refundResult.transactionHash;

          const isPartial = !isFullAmount;

          if (isPartial) {
            const remaining = totalDeposited - refundAmount;
            if (remaining < EPSILON) {
              updatedEscrow.status = "refunded";
              updatedEscrow.accumulatedDepositAmount = 0;
              updatedEscrow.depositAmount = 0;
              updatedEscrow.confirmedAmount = 0;
            } else {
              updatedEscrow.accumulatedDepositAmount = remaining;
              updatedEscrow.depositAmount = remaining;
              updatedEscrow.confirmedAmount = remaining;
              // Status stays
            }
          } else {
            updatedEscrow.status = "refunded";
            updatedEscrow.accumulatedDepositAmount = 0;
            updatedEscrow.depositAmount = 0;
            updatedEscrow.confirmedAmount = 0;
          }
          updatedEscrow.pendingRefundAmount = null;
          await updatedEscrow.save();

          // Success Message
          const explorerUrl = CompletionFeedService.getExplorerLink(
            updatedEscrow.chain || "BSC",
            refundResult.transactionHash
          );
          const linkLine = explorerUrl
            ? `<a href="${explorerUrl}">Click Here</a>`
            : `<code>${refundResult.transactionHash}</code>`;

          const successText = `✅ <b>Refund Partial/Full Complete!</b>
Amount Refunded: ${refundAmount.toFixed(5)} ${updatedEscrow.token}
Transaction: ${linkLine}`;

          await ctx.telegram.sendMessage(updatedEscrow.groupId, successText, {
            parse_mode: "HTML",
          });

          // Stats & Feed
          await CompletionFeedService.handleRefund({
            escrow: updatedEscrow,
            refundAmount: refundAmount,
            transactionHash: refundResult.transactionHash,
            telegram: ctx.telegram,
          });

          // Update Trade Started Msg
          await updateTradeStartedMessage(
            updatedEscrow,
            ctx.telegram,
            updatedEscrow.status,
            refundResult.transactionHash
          );
        } catch (error) {
          console.error("Refund failed:", error);
          await ctx.telegram.sendMessage(
            updatedEscrow.groupId,
            "❌ Refund failed: " + error.message
          );
        }
      }
    } else if (callbackData.startsWith("refund_confirm_no_")) {
      const escrowId = callbackData.replace("refund_confirm_no_", "");
      const escrow = await Escrow.findOne({ escrowId });
      if (!escrow) return safeAnswerCbQuery(ctx, "❌ Not found.");

      const userId = ctx.from.id;
      const { isAdmin } = require("../middleware/adminAuth");
      // Allow participants to cancel
      const can =
        escrow.buyerId == userId || escrow.sellerId == userId || isAdmin(ctx);
      if (!can) return safeAnswerCbQuery(ctx, "❌ Denied.");

      escrow.buyerConfirmedRefund = false;
      escrow.sellerConfirmedRefund = false;
      escrow.pendingRefundAmount = null;
      await escrow.save();

      try {
        await ctx.editMessageCaption(
          escrow.groupId,
          escrow.refundConfirmationMessageId,
          null,
          "❌ Refund cancelled.",
          { parse_mode: "HTML" }
        );
      } catch (e) {}
      await safeAnswerCbQuery(ctx, "❌ Cancelled.");
    } else if (callbackData.startsWith("partial_continue_")) {
      const escrowId = callbackData.replace("partial_continue_", "");
      const escrow = await Escrow.findOne({
        escrowId,
        status: { $in: ["awaiting_deposit", "deposited"] },
      });

      if (!escrow) {
        return safeAnswerCbQuery(ctx, "❌ No active escrow found.");
      }

      // Only seller can click
      if (escrow.sellerId !== userId) {
        return safeAnswerCbQuery(
          ctx,
          "❌ Only the seller can choose this option."
        );
      }

      await safeAnswerCbQuery(ctx, "✅ Continuing with partial amount...");

      // Update escrow to proceed with partial amount
      const partialAmount =
        escrow.accumulatedDepositAmount || escrow.depositAmount;
      escrow.confirmedAmount = partialAmount;
      escrow.depositAmount = partialAmount;
      escrow.status = "deposited";
      await escrow.save();

      // Delete the transaction hash message if it exists
      try {
        if (escrow.transactionHashMessageId) {
          await ctx.telegram.deleteMessage(
            escrow.groupId,
            escrow.transactionHashMessageId
          );
        }
      } catch (e) {}

      // Update partial payment message
      try {
        if (escrow.partialPaymentMessageId) {
          await ctx.editMessageText(
            "✅ Continuing with partial amount. Trade will proceed with the received amount."
          );
        }
      } catch (e) {}

      // Send deposit confirmation message
      const txHashShort = escrow.transactionHash
        ? escrow.transactionHash.substring(0, 10) + "..."
        : "N/A";
      const totalTxCount =
        1 +
        (escrow.partialTransactionHashes
          ? escrow.partialTransactionHashes.length
          : 0);
      const fromAddress = escrow.depositTransactionFromAddress || "N/A";
      const depositAddress = escrow.depositAddress || "N/A";

      let confirmedTxText = `<b>P2P MM Bot 🤖</b>

🟢 Partial ${escrow.token} accepted

<b>Total Amount:</b> ${partialAmount.toFixed(2)} ${escrow.token}
<b>Transactions:</b> ${totalTxCount} transaction(s)
<b>From:</b> <code>${fromAddress}</code>
<b>To:</b> <code>${depositAddress}</code>
<b>Main Tx:</b> <code>${txHashShort}</code>`;

      if (totalTxCount > 1) {
        confirmedTxText += `\n\n✅ Amount received through ${totalTxCount} transaction(s)`;
      }

      const txDetailsMsg = await ctx.telegram.sendPhoto(
        escrow.groupId,
        images.DEPOSIT_FOUND,
        {
          caption: confirmedTxText,
          parse_mode: "HTML",
        }
      );

      escrow.transactionHashMessageId = txDetailsMsg.message_id;
      await escrow.save();

      // Send buyer instruction
      if (escrow.buyerId) {
        const buyerMention = escrow.buyerUsername
          ? `@${escrow.buyerUsername}`
          : escrow.buyerId
          ? `[${escrow.buyerId}]`
          : "Buyer";

        const buyerInstruction = `✅ Payment Received!

Use /release After Fund Transfer to Seller

⚠️ Please note:
• Don't share payment details on private chat
• Please share all deals in group`;

        await ctx.telegram.sendMessage(escrow.groupId, buyerInstruction);
      }

      return;
    } else if (callbackData.startsWith("partial_pay_remaining_")) {
      const escrowId = callbackData.replace("partial_pay_remaining_", "");
      const escrow = await Escrow.findOne({
        escrowId,
        status: { $in: ["awaiting_deposit", "deposited"] },
      });

      if (!escrow) {
        return safeAnswerCbQuery(ctx, "❌ No active escrow found.");
      }

      // Only seller can click
      if (escrow.sellerId !== userId) {
        return safeAnswerCbQuery(
          ctx,
          "❌ Only the seller can choose this option."
        );
      }

      await safeAnswerCbQuery(ctx, "💰 Please send the remaining amount...");

      // Ensure status is 'awaiting_deposit' so next transaction hash can be processed
      escrow.status = "awaiting_deposit";
      await escrow.save();

      // Calculate remaining amount
      const expectedAmount = escrow.quantity;
      const currentAmount =
        escrow.accumulatedDepositAmount || escrow.depositAmount;
      const remainingAmount = expectedAmount - currentAmount;
      const remainingFormatted = remainingAmount.toFixed(2);

      // Update message to show seller should send remaining amount
      try {
        if (escrow.partialPaymentMessageId) {
          await ctx.editMessageText(
            `✅ Partial deposit received: ${currentAmount.toFixed(2)} ${
              escrow.token
            }\n\n` +
              `📊 Total received so far: ${currentAmount.toFixed(2)} ${
                escrow.token
              }\n` +
              `💰 Remaining amount needed: ${remainingFormatted} ${escrow.token}\n\n` +
              `Please send the remaining ${remainingFormatted} ${escrow.token} to the same deposit address:\n` +
              `<code>${escrow.depositAddress}</code>\n\n` +
              `After sending, provide the new transaction hash.`,
            { parse_mode: "HTML" }
          );
        }
      } catch (e) {
        // If editing fails, send a new message
        await ctx.reply(
          `💰 Please send the remaining ${remainingFormatted} ${escrow.token} to:\n` +
            `<code>${escrow.depositAddress}</code>\n\n` +
            `After sending, provide the new transaction hash.`,
          { parse_mode: "HTML" }
        );
      }

      return;
    } else if (callbackData.startsWith("fiat_release_cancel_")) {
      await safeAnswerCbQuery(ctx, "❎ Cancelled");
      try {
        await ctx.editMessageText("❎ Release cancelled. No action taken.");
      } catch (e) {}
      return;
    } else if (callbackData.startsWith("refund_confirm_no_")) {
      const escrowId = callbackData.replace("refund_confirm_no_", "");
      const escrow = await Escrow.findOne({
        escrowId,
        status: {
          $in: [
            "deposited",
            "in_fiat_transfer",
            "ready_to_release",
            "disputed",
          ],
        },
      });

      if (!escrow) {
        return safeAnswerCbQuery(ctx, "❌ No active escrow found.");
      }

      // Check if user is admin
      const isAdmin =
        config.getAllAdminUsernames().includes(ctx.from.username) ||
        config.getAllAdminIds().includes(String(ctx.from.id));

      if (!isAdmin) {
        return safeAnswerCbQuery(ctx, "❌ Only admin can cancel refund.");
      }

      // Delete confirmation message
      if (escrow.refundConfirmationMessageId) {
        try {
          await ctx.telegram.deleteMessage(
            escrow.groupId,
            escrow.refundConfirmationMessageId
          );
        } catch (e) {}
        escrow.refundConfirmationMessageId = null;
        await escrow.save();
      }

      await safeAnswerCbQuery(ctx, "❌ Refund cancelled.");
      return;
    } else if (callbackData.startsWith("refund_confirm_yes_")) {
      const escrowId = callbackData.replace("refund_confirm_yes_", "");
      const callbackMessageId = ctx.callbackQuery?.message?.message_id;

      const escrow = await Escrow.findOne({
        escrowId,
        status: {
          $in: [
            "deposited",
            "in_fiat_transfer",
            "ready_to_release",
            "disputed",
          ],
        },
      });

      if (!escrow) {
        return safeAnswerCbQuery(ctx, "❌ No active escrow found.");
      }

      // Guard against duplicate / stale confirmations:
      // - If the stored confirmation message ID is missing or does not match
      //   the message that triggered this callback, treat it as already
      //   processed / cancelled and do NOT issue another refund.
      if (
        !escrow.refundConfirmationMessageId ||
        (callbackMessageId &&
          escrow.refundConfirmationMessageId !== callbackMessageId)
      ) {
        return safeAnswerCbQuery(
          ctx,
          "❌ This refund confirmation is no longer valid or has already been processed."
        );
      }

      // Check if user is admin
      const isAdmin =
        config.getAllAdminUsernames().includes(ctx.from.username) ||
        config.getAllAdminIds().includes(String(ctx.from.id));

      if (!isAdmin) {
        return safeAnswerCbQuery(ctx, "❌ Only admin can confirm refund.");
      }

      if (!escrow.sellerAddress) {
        return safeAnswerCbQuery(ctx, "❌ Seller address is not set.");
      }

      // Calculate amount - use pendingRefundAmount if set, otherwise use full deposited amount
      const decimals = BlockchainService.getTokenDecimals(
        escrow.token,
        escrow.chain
      );
      const totalDepositedWei =
        escrow.accumulatedDepositAmountWei &&
        escrow.accumulatedDepositAmountWei !== "0"
          ? escrow.accumulatedDepositAmountWei
          : null;
      const totalDeposited = Number(
        escrow.accumulatedDepositAmount ||
          escrow.depositAmount ||
          escrow.confirmedAmount ||
          0
      );
      const formattedTotalDeposited = totalDepositedWei
        ? Number(ethers.formatUnits(BigInt(totalDepositedWei), decimals))
        : totalDeposited;

      if (totalDeposited <= 0) {
        return safeAnswerCbQuery(ctx, "❌ No confirmed deposit found.");
      }

      // Use pending refund amount if set (partial refund), otherwise use full amount
      let refundAmount =
        escrow.pendingRefundAmount !== null &&
        escrow.pendingRefundAmount !== undefined
          ? escrow.pendingRefundAmount
          : formattedTotalDeposited;

      // Validate amount doesn't exceed available balance (re-check to handle race conditions)
      if (refundAmount > formattedTotalDeposited) {
        return safeAnswerCbQuery(
          ctx,
          `❌ Refund amount exceeds available balance (${formattedTotalDeposited.toFixed(
            5
          )} ${escrow.token}).`
        );
      }

      // Validate minimum amount
      if (refundAmount <= 0) {
        return safeAnswerCbQuery(
          ctx,
          "❌ Refund amount must be greater than 0."
        );
      }

      // Use epsilon for floating point comparison
      const EPSILON = 0.00001;
      const isFullRefund =
        Math.abs(refundAmount - formattedTotalDeposited) < EPSILON;

      // Calculate wei amount for refund
      let amountWeiOverride = null;
      if (isFullRefund && totalDepositedWei) {
        // Full refund: use full wei amount (exact amount in contract)
        amountWeiOverride = totalDepositedWei;
      } else if (totalDepositedWei && formattedTotalDeposited > 0) {
        // Partial refund with stored wei: calculate proportional wei amount for precision
        // Use BigInt arithmetic to maintain precision: (totalWei * refundAmount * 10^decimals) / (totalAmount * 10^decimals)
        try {
          const refundAmountWei = ethers.parseUnits(
            refundAmount.toFixed(decimals),
            decimals
          );
          const totalDepositedAmountWei = ethers.parseUnits(
            formattedTotalDeposited.toFixed(decimals),
            decimals
          );
          // Calculate proportional wei: (totalDepositedWei * refundAmountWei) / totalDepositedAmountWei
          const proportionalWei =
            (BigInt(totalDepositedWei) * BigInt(refundAmountWei)) /
            BigInt(totalDepositedAmountWei);
          amountWeiOverride = proportionalWei.toString();
        } catch (e) {
          // Fallback to direct conversion if proportional calculation fails
          try {
            amountWeiOverride = ethers
              .parseUnits(refundAmount.toFixed(decimals), decimals)
              .toString();
          } catch (e2) {
            amountWeiOverride = null;
          }
        }
      } else {
        // No wei stored: convert amount to wei
        try {
          amountWeiOverride = ethers
            .parseUnits(refundAmount.toFixed(decimals), decimals)
            .toString();
        } catch (e) {
          amountWeiOverride = null;
        }
      }

      await safeAnswerCbQuery(ctx, "🔄 Processing refund...");

      try {
        // Refund funds to seller's address
        const refundResult = await BlockchainService.refundFunds(
          escrow.token,
          escrow.chain,
          escrow.sellerAddress,
          refundAmount,
          amountWeiOverride,
          escrow.groupId
        );

        if (!refundResult || !refundResult.success) {
          throw new Error("Refund transaction failed - no result returned");
        }

        // Ensure transaction hash exists (should always exist if transaction succeeded)
        if (!refundResult.transactionHash) {
          throw new Error(
            "Refund transaction succeeded but no transaction hash returned"
          );
        }

        // Always set transaction hash when refund succeeds
        escrow.refundTransactionHash = refundResult.transactionHash;

        // Delete confirmation message first (before clearing the ID)
        const confirmationMsgId = escrow.refundConfirmationMessageId;
        if (confirmationMsgId) {
          try {
            await ctx.telegram.deleteMessage(escrow.groupId, confirmationMsgId);
          } catch (e) {}
        }

        // Use epsilon for floating point comparison
        const EPSILON = 0.00001;
        const isPartialRefund =
          Math.abs(refundAmount - formattedTotalDeposited) >= EPSILON;
        const remainingAmount = formattedTotalDeposited - refundAmount;
        const isActuallyFullRefund = remainingAmount < EPSILON; // Check if remaining is essentially 0

        if (isPartialRefund && !isActuallyFullRefund) {
          // True partial refund: reduce the deposited amounts
          escrow.accumulatedDepositAmount = remainingAmount;
          escrow.depositAmount = remainingAmount;
          escrow.confirmedAmount = remainingAmount;

          // Update wei amount if we have it
          if (totalDepositedWei && amountWeiOverride) {
            const remainingWei =
              BigInt(totalDepositedWei) - BigInt(amountWeiOverride);
            // Ensure wei doesn't go negative
            if (remainingWei < 0) {
              escrow.accumulatedDepositAmountWei = "0";
            } else {
              escrow.accumulatedDepositAmountWei = remainingWei.toString();
            }
          }
          // Keep status as deposited/ready_to_release since there's still funds
        } else {
          // Full refund (either explicitly full or partial that emptied the balance)
          // Ensure quantity is preserved for statistics (use refunded amount if quantity is missing)
          if (!escrow.quantity || escrow.quantity <= 0) {
            escrow.quantity = refundAmount;
          }
          escrow.status = "refunded";
          escrow.accumulatedDepositAmount = 0;
          escrow.depositAmount = 0;
          escrow.confirmedAmount = 0;
          escrow.accumulatedDepositAmountWei = "0";
        }
        escrow.refundConfirmationMessageId = null;
        escrow.pendingRefundAmount = null;

        await escrow.save();

        // Reload escrow to get latest state
        const updatedEscrow = await Escrow.findById(escrow._id);

        try {
          // Log refund to completion feed (supports both full and partial)
          await CompletionFeedService.handleRefund({
            escrow: updatedEscrow,
            refundAmount: refundAmount,
            transactionHash: refundResult.transactionHash,
            telegram: ctx.telegram,
          });
        } catch (feedError) {
          console.error("Error logging refund to feed:", feedError);
        }

        let successMessage = `✅ ${refundAmount.toFixed(5)} ${
          updatedEscrow.token
        } has been refunded to seller's address!`;
        if (refundResult.transactionHash) {
          // Generate explorer link based on chain
          let explorerUrl = "";
          const chainUpper = updatedEscrow.chain.toUpperCase();
          if (chainUpper === "BSC" || chainUpper === "BNB") {
            explorerUrl = `https://bscscan.com/tx/${refundResult.transactionHash}`;
          } else if (chainUpper === "ETH" || chainUpper === "ETHEREUM") {
            explorerUrl = `https://etherscan.io/tx/${refundResult.transactionHash}`;
          } else if (chainUpper === "POLYGON" || chainUpper === "MATIC") {
            explorerUrl = `https://polygonscan.com/tx/${refundResult.transactionHash}`;
          } else if (chainUpper === "TRON" || chainUpper === "TRX") {
            explorerUrl = `https://tronscan.org/#/transaction/${refundResult.transactionHash}`;
          }

          if (explorerUrl) {
            successMessage += `\n\n🔗 Transaction: ${explorerUrl}`;
          }
        }

        await ctx.telegram.sendMessage(updatedEscrow.groupId, successMessage);

        // Send completion messages if it's actually a full refund (balance is 0)
        if (!isPartialRefund || isActuallyFullRefund) {
          // Reload to get latest state
          const finalEscrow = await Escrow.findById(updatedEscrow._id);

          // Update the "Trade started" message in the main group
          await updateTradeStartedMessage(
            finalEscrow,
            ctx.telegram,
            "refunded",
            refundResult?.transactionHash || null
          );

          // Send completion message with close deal button
          const images = require("../config/images");
          const tradeStart =
            finalEscrow.tradeStartTime || finalEscrow.createdAt || new Date();
          const minutesTaken = Math.max(
            1,
            Math.round((Date.now() - new Date(tradeStart)) / (60 * 1000))
          );

          const chainUpper = (finalEscrow.chain || "").toUpperCase();
          let explorerUrl = "";
          if (refundResult.transactionHash) {
            if (chainUpper === "BSC" || chainUpper === "BNB") {
              explorerUrl = `https://bscscan.com/tx/${refundResult.transactionHash}`;
            } else if (chainUpper === "ETH" || chainUpper === "ETHEREUM") {
              explorerUrl = `https://etherscan.io/tx/${refundResult.transactionHash}`;
            } else if (chainUpper === "POLYGON" || chainUpper === "MATIC") {
              explorerUrl = `https://polygonscan.com/tx/${refundResult.transactionHash}`;
            }
          }

          const linkLine = refundResult?.transactionHash
            ? explorerUrl
              ? `<a href="${explorerUrl}">Click Here</a>`
              : `<code>${refundResult.transactionHash}</code>`
            : "Not available";

          const completionText = `🔄 <b>Deal Refunded!</b>

⏱️ <b>Time Taken:</b> ${minutesTaken} mins
🔗 <b>Refund TX Link:</b> ${linkLine}

Thank you for using our safe escrow system.`;

          const closeTradeKeyboard = {
            inline_keyboard: [
              [
                {
                  text: "❌ Close Deal",
                  callback_data: `close_trade_${finalEscrow.escrowId}`,
                },
              ],
            ],
          };

          try {
            const summaryMsg = await ctx.telegram.sendPhoto(
              finalEscrow.groupId,
              images.DEAL_COMPLETE,
              {
                caption: completionText,
                parse_mode: "HTML",
                reply_markup: closeTradeKeyboard,
              }
            );

            if (summaryMsg) {
              finalEscrow.closeTradeMessageId = summaryMsg.message_id;
              await finalEscrow.save();
            }
          } catch (sendError) {
            console.error(
              "Error sending refund completion summary:",
              sendError
            );
          }

          // Remove users and recycle group after 5 minutes delay
          const settleAndRecycleGroup = async (escrow, telegram) => {
            try {
              const group = await GroupPool.findOne({
                assignedEscrowId: escrow.escrowId,
              });

              if (group) {
                const allUsersRemoved =
                  await GroupPoolService.removeUsersFromGroup(
                    escrow,
                    group.groupId,
                    telegram
                  );

                if (allUsersRemoved) {
                  const freshEscrow = await Escrow.findOne({
                    escrowId: escrow.escrowId,
                  });
                  if (freshEscrow && freshEscrow.inviteLink) {
                    freshEscrow.inviteLink = null;
                    await freshEscrow.save();
                  }

                  await GroupPoolService.refreshInviteLink(
                    group.groupId,
                    telegram
                  );

                  group.status = "available";
                  group.assignedEscrowId = null;
                  group.assignedAt = null;
                  group.completedAt = null;
                  await group.save();
                }
              }
            } catch (error) {
              console.error("Error settling and recycling group:", error);
            }
          };

          // Delay user removal by 5 minutes (300,000 milliseconds)
          setTimeout(async () => {
            await settleAndRecycleGroup(finalEscrow, ctx.telegram);
          }, 5 * 60 * 1000);
        }
      } catch (error) {
        console.error("Error refunding funds:", error);
        const errorMessage =
          error?.message || error?.toString() || "Unknown error";
        await ctx.telegram.sendMessage(
          escrow.groupId,
          `❌ Error refunding funds: ${errorMessage}`
        );
      }
      return;
    } else if (callbackData.startsWith("fiat_release_confirm_")) {
      const escrowId = callbackData.replace("fiat_release_confirm_", "");
      const escrow = await Escrow.findOne({
        escrowId,
        status: {
          $in: [
            "in_fiat_transfer",
            "deposited",
            "ready_to_release",
            "disputed",
          ],
        },
      });
      if (!escrow) return safeAnswerCbQuery(ctx, "❌ No active escrow found.");
      if (escrow.sellerId !== userId)
        return safeAnswerCbQuery(
          ctx,
          "❌ Only the seller can confirm release."
        );
      const decimals = BlockchainService.getTokenDecimals(
        escrow.token,
        escrow.chain
      );
      const amountWeiOverride =
        escrow.accumulatedDepositAmountWei &&
        escrow.accumulatedDepositAmountWei !== "0"
          ? escrow.accumulatedDepositAmountWei
          : null;
      let amount = Number(
        escrow.accumulatedDepositAmount ||
          escrow.depositAmount ||
          escrow.confirmedAmount ||
          0
      );
      if (amountWeiOverride) {
        amount = Number(
          ethers.formatUnits(BigInt(amountWeiOverride), decimals)
        );
      }
      if (!escrow.buyerAddress || amount <= 0) {
        return ctx.reply(
          "⚠️ Cannot proceed: missing buyer address or zero amount."
        );
      }
      await safeAnswerCbQuery(ctx, "🚀 Releasing...");
      try {
        await ctx.editMessageText("🚀 Releasing funds to the buyer...");
      } catch (e) {}
      try {
        // Send (gross - networkFee) to contract, contract will deduct service fee
        const networkFee = escrow.networkFee || 0;
        const amountToContract = amount - networkFee;

        const releaseResult = await BlockchainService.releaseFunds(
          escrow.token,
          escrow.chain,
          escrow.buyerAddress,
          amountToContract,
          null,
          escrow.groupId
        );
        // Ensure transaction hash exists (should always exist if transaction succeeded)
        if (!releaseResult || !releaseResult.transactionHash) {
          throw new Error(
            "Release transaction succeeded but no transaction hash returned"
          );
        }

        // Ensure quantity is preserved for statistics (use released amount if quantity is missing)
        if (!escrow.quantity || escrow.quantity <= 0) {
          escrow.quantity = amount;
        }
        escrow.status = "completed";
        escrow.completedAt = new Date();
        escrow.releaseTransactionHash = releaseResult.transactionHash;
        // Zero out deposit amounts after preserving quantity
        escrow.accumulatedDepositAmount = 0;
        escrow.depositAmount = 0;
        escrow.confirmedAmount = 0;
        escrow.accumulatedDepositAmountWei = "0";
        await escrow.save();

        try {
          await UserStatsService.recordTrade({
            buyerId: escrow.buyerId,
            buyerUsername: escrow.buyerUsername,
            sellerId: escrow.sellerId,
            sellerUsername: escrow.sellerUsername,
            amount,
            token: escrow.token,
            escrowId: escrow.escrowId,
          });
        } catch (statsError) {
          console.error("Error recording trade stats:", statsError);
        }

        try {
          await CompletionFeedService.handleCompletion({
            escrow,
            amount,
            transactionHash: releaseResult?.transactionHash,
            telegram: ctx.telegram,
          });
        } catch (feedError) {
          console.error("Error broadcasting completion feed:", feedError);
        }

        // Update the "Trade started" message in the main group
        await updateTradeStartedMessage(
          escrow,
          ctx.telegram,
          "completed",
          releaseResult?.transactionHash
        );

        // Send release confirmation message to the group (not as a reply to callback)
        try {
          const chain = escrow.chain || "BSC";
          let explorerUrl = "";
          if (releaseResult && releaseResult.transactionHash) {
            if (
              chain.toUpperCase() === "BSC" ||
              chain.toUpperCase() === "BNB"
            ) {
              explorerUrl = `https://bscscan.com/tx/${releaseResult.transactionHash}`;
            } else if (
              chain.toUpperCase() === "ETH" ||
              chain.toUpperCase() === "ETHEREUM"
            ) {
              explorerUrl = `https://etherscan.io/tx/${releaseResult.transactionHash}`;
            } else if (
              chain.toUpperCase() === "POLYGON" ||
              chain.toUpperCase() === "MATIC"
            ) {
              explorerUrl = `https://polygonscan.com/tx/${releaseResult.transactionHash}`;
            } else if (
              chain.toUpperCase() === "TRON" ||
              chain.toUpperCase() === "TRX"
            ) {
              explorerUrl = `https://tronscan.org/#/transaction/${releaseResult.transactionHash}`;
            }
          }

          const linkLine = releaseResult?.transactionHash
            ? explorerUrl
              ? `<a href="${explorerUrl}">Click Here</a>`
              : `<code>${releaseResult.transactionHash}</code>`
            : "Not available";

          const releaseConfirmationCaption = `✅ <b>Release Confirmation</b>

💰 Amount Released: ${amount.toFixed(5)} ${escrow.token}
🔗 Transaction: ${linkLine}

Trade completed successfully.`;

          console.log(
            "Sending release confirmation with caption:",
            releaseConfirmationCaption
          );
          const sentMessage = await ctx.telegram.sendPhoto(
            escrow.groupId,
            images.RELEASE_CONFIRMATION,
            {
              caption: releaseConfirmationCaption,
              parse_mode: "HTML",
            }
          );
          console.log(
            "Release confirmation message sent successfully. Message ID:",
            sentMessage.message_id
          );
        } catch (sendError) {
          console.error(
            "Error sending release confirmation message:",
            sendError
          );
          console.error("Error details:", {
            message: sendError.message,
            response: sendError.response,
          });
        }

        // Ask buyer to confirm receipt of tokens
        const buyerConfirmationMsg = await ctx.telegram.sendMessage(
          escrow.groupId,
          `👤 Buyer ${
            escrow.buyerUsername
              ? "@" + escrow.buyerUsername
              : "[" + escrow.buyerId + "]"
          }: Did you receive the tokens?`,
          {
            reply_markup: Markup.inlineKeyboard([
              [
                Markup.button.callback(
                  "✅ Yes, I received",
                  `buyer_received_tokens_yes_${escrow.escrowId}`
                ),
                Markup.button.callback(
                  "❌ No, not received",
                  `buyer_received_tokens_no_${escrow.escrowId}`
                ),
              ],
            ]).reply_markup,
          }
        );

        // Reload escrow to get latest state
        const finalEscrowForFiat = await Escrow.findById(escrow._id);

        // Schedule automatic user removal after 5 minutes (same as other completion flows)
        const settleAndRecycleGroup = async (escrow, telegram) => {
          try {
            const group = await GroupPool.findOne({
              assignedEscrowId: escrow.escrowId,
            });

            if (group) {
              const allUsersRemoved =
                await GroupPoolService.removeUsersFromGroup(
                  escrow,
                  group.groupId,
                  telegram
                );

              if (allUsersRemoved) {
                const freshEscrow = await Escrow.findOne({
                  escrowId: escrow.escrowId,
                });
                if (freshEscrow && freshEscrow.inviteLink) {
                  freshEscrow.inviteLink = null;
                  await freshEscrow.save();
                }

                await GroupPoolService.refreshInviteLink(
                  group.groupId,
                  telegram
                );

                group.status = "available";
                group.assignedEscrowId = null;
                group.assignedAt = null;
                group.completedAt = null;
                await group.save();
              }
            }
          } catch (error) {
            console.error("Error settling and recycling group:", error);
          }
        };

        // Delay user removal by 5 minutes (300,000 milliseconds)
        setTimeout(async () => {
          await settleAndRecycleGroup(finalEscrowForFiat, ctx.telegram);
        }, 5 * 60 * 1000);
      } catch (error) {
        console.error("Auto-release error:", error);
        await ctx.reply("❌ Error releasing funds. Please contact admin.");
        // Don't recycle group if release failed
        return;
      }
      return;
    } else if (callbackData.startsWith("confirm_")) {
      const [, action, role, amount] = callbackData.split("_");

      // Find active escrow
      const escrow = await findGroupEscrow(chatId, [
        "deposited",
        "in_fiat_transfer",
        "ready_to_release",
        "disputed",
      ]);

      if (!escrow) {
        return safeAnswerCbQuery(ctx, "❌ No active escrow found.");
      }

      // Check if user is authorized
      if (role === "buyer" && escrow.buyerId !== userId) {
        return safeAnswerCbQuery(
          ctx,
          "❌ Only the buyer can confirm this action."
        );
      }
      if (role === "seller" && escrow.sellerId !== userId) {
        return safeAnswerCbQuery(
          ctx,
          "❌ Only the seller can confirm this action."
        );
      }

      // Only release is supported (refunds require seller address which is no longer set)
      if (action === "refund") {
        return safeAnswerCbQuery(
          ctx,
          "❌ Refund functionality requires seller address. Please contact admin for refunds."
        );
      }

      // Update confirmation status (only for release)
      if (action === "release") {
        if (role === "buyer") {
          escrow.buyerConfirmedRelease = true;
        } else {
          escrow.sellerConfirmedRelease = true;
        }
      }

      await escrow.save();

      // Check if both parties confirmed (only for release)
      const bothConfirmed =
        action === "release" &&
        escrow.buyerConfirmedRelease &&
        escrow.sellerConfirmedRelease;

      if (bothConfirmed) {
        // Execute the transaction
        const decimals = BlockchainService.getTokenDecimals(
          escrow.token,
          escrow.chain
        );
        const amountWeiOverride =
          escrow.accumulatedDepositAmountWei &&
          escrow.accumulatedDepositAmountWei !== "0"
            ? escrow.accumulatedDepositAmountWei
            : null;
        const actualAmount = amountWeiOverride
          ? Number(ethers.formatUnits(BigInt(amountWeiOverride), decimals))
          : parseFloat(amount);

        // Fee Calculation Logic
        // Use the specific rate assigned to this deal (e.g. 0.25, 0.5, 0.75) from bio tags
        // Fallback to standard 0.75% ONLY if deal rate is missing (legacy data).
        // WE DO NOT USE config.ESCROW_FEE_PERCENT here as it is for group filtering only.
        // Fee Calculation Logic - STRICT NO FALLBACKS
        if (escrow.feeRate === undefined || escrow.feeRate === null) {
          return ctx.reply(
            "❌ Critical Error: Deal fee rate is missing. Cannot calculate fees."
          );
        }
        if (escrow.networkFee === undefined || escrow.networkFee === null) {
          return ctx.reply(
            "❌ Critical Error: Network fee is missing. Cannot calculate fees."
          );
        }

        const escrowFeePercent = escrow.feeRate;
        const escrowFee = (actualAmount * escrowFeePercent) / 100;
        const networkFee = escrow.networkFee;

        // Send (gross - networkFee) to contract, contract will deduct service fee
        const amountToContract = actualAmount - networkFee;

        // Calculate what user will ACTUALLY receive after contract deducts service fee
        const serviceFeeOnNet = (amountToContract * escrowFeePercent) / 100;
        const actualAmountToUser = amountToContract - serviceFeeOnNet;

        if (actualAmountToUser <= 0) {
          return ctx.reply(
            "❌ Error: Calculated release amount (after fees) is zero or negative."
          );
        }

        const targetAddress = escrow.buyerAddress;
        if (!targetAddress) {
          return ctx.reply(
            "❌ Buyer address is not set. Cannot proceed with release."
          );
        }

        try {
          const releaseResult = await BlockchainService.releaseFunds(
            escrow.token,
            escrow.chain,
            targetAddress,
            amountToContract,
            null,
            escrow.groupId
          );

          if (!releaseResult || !releaseResult.transactionHash) {
            throw new Error(
              "Release transaction succeeded but no transaction hash returned"
            );
          }

          if (!escrow.quantity || escrow.quantity <= 0) {
            escrow.quantity = actualAmount;
          }
          escrow.status = "completed";
          escrow.completedAt = new Date();
          escrow.releaseTransactionHash = releaseResult.transactionHash;
          escrow.accumulatedDepositAmount = 0;
          escrow.depositAmount = 0;
          escrow.confirmedAmount = 0;
          escrow.accumulatedDepositAmountWei = "0";
          await escrow.save();

          try {
            await UserStatsService.recordTrade({
              buyerId: escrow.buyerId,
              buyerUsername: escrow.buyerUsername,
              sellerId: escrow.sellerId,
              sellerUsername: escrow.sellerUsername,
              amount: actualAmount,
              token: escrow.token,
              escrowId: escrow.escrowId,
            });
          } catch (statsError) {
            console.error("Error recording trade stats:", statsError);
          }

          // Send completion log
          try {
            await CompletionFeedService.handleCompletion({
              escrow,
              amount: actualAmount,
              transactionHash: releaseResult.transactionHash,
              telegram: ctx.telegram,
            });
          } catch (feedError) {
            console.error("Error broadcasting completion feed:", feedError);
          }

          const successText = `
${netAmount.toFixed(5)} ${escrow.token} [$${netAmount.toFixed(
            2
          )}] 💸 + NETWORK FEE has been released to the Buyer's address! 🚀

Approved By: ${
            escrow.sellerUsername
              ? "@" + escrow.sellerUsername
              : "[" + escrow.sellerId + "]"
          }
          `;

          await ctx.reply(successText);

          // Send transaction explorer link if available
          if (releaseResult && releaseResult.transactionHash) {
            const chain = escrow.chain || "BSC";
            let explorerUrl = "";
            if (
              chain.toUpperCase() === "BSC" ||
              chain.toUpperCase() === "BNB"
            ) {
              explorerUrl = `https://bscscan.com/tx/${releaseResult.transactionHash}`;
            } else if (
              chain.toUpperCase() === "ETH" ||
              chain.toUpperCase() === "ETHEREUM"
            ) {
              explorerUrl = `https://etherscan.io/tx/${releaseResult.transactionHash}`;
            } else if (
              chain.toUpperCase() === "POLYGON" ||
              chain.toUpperCase() === "MATIC"
            ) {
              explorerUrl = `https://polygonscan.com/tx/${releaseResult.transactionHash}`;
            } else if (
              chain.toUpperCase() === "TRON" ||
              chain.toUpperCase() === "TRX"
            ) {
              explorerUrl = `https://tronscan.org/#/transaction/${releaseResult.transactionHash}`;
            }

            if (explorerUrl) {
              await ctx.reply(`🔗 Transaction: ${explorerUrl}`);
            }
          }

          // Ask buyer to confirm receipt of tokens
          const buyerConfirmationMsg = await ctx.telegram.sendMessage(
            escrow.groupId,
            `👤 Buyer ${
              escrow.buyerUsername
                ? "@" + escrow.buyerUsername
                : "[" + escrow.buyerId + "]"
            }: Did you receive the tokens?`,
            {
              reply_markup: Markup.inlineKeyboard([
                [
                  Markup.button.callback(
                    "✅ Yes, I received",
                    `buyer_received_tokens_yes_${escrow.escrowId}`
                  ),
                  Markup.button.callback(
                    "❌ No, not received",
                    `buyer_received_tokens_no_${escrow.escrowId}`
                  ),
                ],
              ]).reply_markup,
            }
          );

          // Send trade completion message with close trade button
          // Initialize close trade tracking
          escrow.buyerClosedTrade = false;
          escrow.sellerClosedTrade = false;
          await escrow.save();

          const buyerUsername = escrow.buyerUsername || "Buyer";
          const sellerUsername = escrow.sellerUsername || "Seller";

          const closeTradeText = `✅ The trade has been completed successfully!

⏳ Waiting for @${buyerUsername} to confirm.
⏳ Waiting for @${sellerUsername} to confirm.`;

          const closeMsg = await ctx.replyWithPhoto(images.DEAL_COMPLETE, {
            caption: closeTradeText,
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "🔒 Close Trade",
                    callback_data: `close_trade_${escrow.escrowId}`,
                  },
                ],
              ],
            },
          });

          escrow.closeTradeMessageId = closeMsg.message_id;
          await escrow.save();

          // Reload escrow to get latest state
          const finalEscrow = await Escrow.findById(escrow._id);

          // Schedule automatic user removal after 5 minutes (same as refund)
          const settleAndRecycleGroup = async (escrow, telegram) => {
            try {
              const group = await GroupPool.findOne({
                assignedEscrowId: escrow.escrowId,
              });

              if (group) {
                const allUsersRemoved =
                  await GroupPoolService.removeUsersFromGroup(
                    escrow,
                    group.groupId,
                    telegram
                  );

                if (allUsersRemoved) {
                  const freshEscrow = await Escrow.findOne({
                    escrowId: escrow.escrowId,
                  });
                  if (freshEscrow && freshEscrow.inviteLink) {
                    freshEscrow.inviteLink = null;
                    await freshEscrow.save();
                  }

                  await GroupPoolService.refreshInviteLink(
                    group.groupId,
                    telegram
                  );

                  group.status = "available";
                  group.assignedEscrowId = null;
                  group.assignedAt = null;
                  group.completedAt = null;
                  await group.save();
                }
              }
            } catch (error) {
              console.error("Error settling and recycling group:", error);
            }
          };

          // Delay user removal by 5 minutes (300,000 milliseconds)
          setTimeout(async () => {
            await settleAndRecycleGroup(finalEscrow, ctx.telegram);
          }, 5 * 60 * 1000);
        } catch (error) {
          console.error("Error executing transaction:", error);
          await ctx.reply(
            "❌ Error executing transaction. Please try again or contact support."
          );
        }
      } else {
        const waitingText = `Release confirmation received. Waiting for the other party to confirm.`;
        await ctx.reply(waitingText);
      }

      await safeAnswerCbQuery(ctx, "✅ Confirmation recorded");
    } else if (callbackData.startsWith("reject_")) {
      const [, action] = callbackData.split("_");

      // Only release is supported, but handle both for safety
      if (action === "refund") {
        return safeAnswerCbQuery(
          ctx,
          "❌ Refund functionality requires seller address. Please contact admin for refunds."
        );
      }

      // Find active escrow and reset confirmations
      const escrow = await findGroupEscrow(chatId, [
        "deposited",
        "in_fiat_transfer",
        "ready_to_release",
        "disputed",
      ]);

      if (escrow) {
        escrow.buyerConfirmedRelease = false;
        escrow.sellerConfirmedRelease = false;
        escrow.buyerConfirmedRefund = false;
        escrow.sellerConfirmedRefund = false;
        await escrow.save();
      }

      await safeAnswerCbQuery(ctx, "❌ Transaction rejected");
      await ctx.reply(
        "❌ Transaction has been rejected by one of the parties. Please restart the process if needed."
      );

      return;
    } else if (callbackData === "withdraw_cancel") {
      // Handle withdrawal cancellation - must be in private chat
      const callbackChatId =
        ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
      if (!callbackChatId || callbackChatId <= 0) {
        await safeAnswerCbQuery(
          ctx,
          "❌ This command can only be used in private chat."
        );
        return;
      }

      await safeAnswerCbQuery(ctx, "❌ Withdrawal cancelled");
      try {
        await ctx.editMessageText("❌ Withdrawal cancelled by admin.");
      } catch (editError) {
        // Message might have been deleted, ignore
      }
      return;
    } else if (callbackData === "withdraw_proceed") {
      // Handle proceed anyway button - check if admin and private chat first
      const callbackChatId =
        ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
      if (!callbackChatId || callbackChatId <= 0) {
        await safeAnswerCbQuery(
          ctx,
          "❌ This command can only be used in private chat."
        );
        return;
      }

      const { isAdmin } = require("../middleware/adminAuth");
      if (!isAdmin(ctx)) {
        await safeAnswerCbQuery(
          ctx,
          "❌ Access denied. Admin privileges required."
        );
        return;
      }

      await safeAnswerCbQuery(ctx, "⚠️ Proceeding to confirmation...");

      // Import and call the confirmation request function
      const { requestWithdrawConfirmation } = require("./adminHandler");
      await requestWithdrawConfirmation(ctx);

      return;
    } else if (callbackData === "withdraw_confirm") {
      // Handle final confirmation - check if admin and private chat first
      const callbackChatId =
        ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
      if (!callbackChatId || callbackChatId <= 0) {
        await safeAnswerCbQuery(
          ctx,
          "❌ This command can only be used in private chat."
        );
        return;
      }

      const { isAdmin } = require("../middleware/adminAuth");
      if (!isAdmin(ctx)) {
        await safeAnswerCbQuery(
          ctx,
          "❌ Access denied. Admin privileges required."
        );
        return;
      }

      await safeAnswerCbQuery(ctx, "🔄 Executing withdrawal...");

      // Update message to show processing
      try {
        await ctx.editMessageText("🔄 Processing withdrawal... Please wait.");
      } catch (e) {
        // Message might already be edited or deleted, ignore
      }

      // Import and execute the withdrawal
      const { executeWithdrawExcess } = require("./adminHandler");
      await executeWithdrawExcess(ctx);

      return;
    } else if (callbackData === "leaderboard_buyers") {
      const topBuyers = await UserStatsService.getTopBuyers(10);
      const message = UserStatsService.formatTopBuyers(topBuyers);

      await ctx.editMessageText(message, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🔙 Back to Leaderboard",
                callback_data: "leaderboard_main",
              },
            ],
          ],
        },
      });
      await safeAnswerCbQuery(ctx);
      return;
    } else if (callbackData === "leaderboard_sellers") {
      const topSellers = await UserStatsService.getTopSellers(10);
      const message = UserStatsService.formatTopSellers(topSellers);

      await ctx.editMessageText(message, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🔙 Back to Leaderboard",
                callback_data: "leaderboard_main",
              },
            ],
          ],
        },
      });
      await safeAnswerCbQuery(ctx);
      return;
    } else if (callbackData === "leaderboard_main") {
      const stats = await UserStatsService.getHighLevelStats();
      const message = UserStatsService.formatMainLeaderboard(stats);

      await safeEditMessageText(
        ctx,
        ctx.callbackQuery.message.chat.id,
        ctx.callbackQuery.message.message_id,
        message,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "🔴 Sellers", callback_data: "leaderboard_sellers" },
                { text: "🌍 Overall", callback_data: "leaderboard_overall" },
              ],
              [{ text: "📊 Deal Stats", callback_data: "leaderboard_stats" }],
              [{ text: "🔄 Refresh", callback_data: "leaderboard_buyers" }],
            ],
          },
        }
      );
      await safeAnswerCbQuery(ctx);
      return;
    }
  } catch (error) {
    if (
      error.description &&
      error.description.includes("message is not modified")
    ) {
      return;
    }
    await safeAnswerCbQuery(ctx, "❌ An error occurred");
  }
};
