require("./utils/logger"); // Apply IST timestamp logging globally
const { Telegraf, Markup } = require("telegraf");
const { ethers } = require("ethers");
const mongoose = require("mongoose");
const connectDB = require("./utils/database");
const config = require("../config");

const User = require("./models/User");
const Escrow = require("./models/Escrow");
const GroupPool = require("./models/GroupPool");

const BlockchainService = require("./services/BlockchainService");

const groupDealHandler = require("./handlers/groupDealHandler");
const joinRequestHandler = require("./handlers/joinRequestHandler");
const callbackHandler = require("./handlers/callbackHandler");
const adminHandler = require("./handlers/adminHandler");
const calculatorHandler = require("./handlers/calculatorHandler");
const GroupPoolService = require("./services/GroupPoolService");
const verifyHandler = require("./handlers/verifyHandler");
const images = require("./config/images");
const UserStatsService = require("./services/UserStatsService");
const {
  isValidAddress,
  getAddressErrorMessage,
  getAddressExample,
} = require("./utils/addressValidation");
const findGroupEscrow = require("./utils/findGroupEscrow");
const TronService = require("./services/TronService");
const CompletionFeedService = require("./services/CompletionFeedService");
const { safeAnswerCbQuery } = require("./utils/telegramUtils");
const restartHandler = require("./handlers/restartHandler");
const disputeHandler = require("./handlers/disputeHandler");

class RPCRateLimiter {
  constructor(maxConcurrent = 5, delayBetweenRequests = 100) {
    this.queue = [];
    this.active = 0;
    this.maxConcurrent = maxConcurrent;
    this.delayBetweenRequests = delayBetweenRequests;
    this.lastRequestTime = 0;
  }

  async execute(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.process();
    });
  }

  async process() {
    if (this.active >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    this.active++;
    const { fn, resolve, reject } = this.queue.shift();

    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.delayBetweenRequests) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.delayBetweenRequests - timeSinceLastRequest),
      );
    }
    this.lastRequestTime = Date.now();

    try {
      const result = await fn();
      resolve(result);
    } catch (error) {
      reject(error);
    } finally {
      this.active--;
      this.process();
    }
  }
}

const rpcRateLimiter = new RPCRateLimiter(5, 200);

async function executeRPCWithRetry(fn, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await rpcRateLimiter.execute(fn);
    } catch (error) {
      const isLastAttempt = attempt === maxRetries;
      const isRetryableError =
        error.code === "ECONNRESET" ||
        error.code === "ETIMEDOUT" ||
        error.code === "SERVER_ERROR" ||
        error.message?.includes("timeout") ||
        error.message?.includes("network");

      if (!isRetryableError || isLastAttempt) {
        throw error;
      }

      const delay = Math.pow(2, attempt - 1) * 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function buildDealSummary(escrow) {
  const amount = escrow.quantity;
  const rate = escrow.rate;
  const paymentMethod = escrow.paymentMethod;
  const chain = escrow.chain;
  const buyerAddress = escrow.buyerAddress;
  const sellerAddress = escrow.sellerAddress;

  const buyerUsername = escrow.buyerUsername || "Buyer";
  const sellerUsername = escrow.sellerUsername || "Seller";

  // Calculate release amount
  const networkFee = escrow.networkFee || 0;
  const escrowFeePercent = escrow.feeRate;
  const escrowFee = ((amount - networkFee) * escrowFeePercent) / 100;
  const releaseAmount = amount - networkFee - escrowFee;

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

• <b>Amount:</b> ${amount} ${escrow.token}
• <b>Rate:</b> ₹${rate.toFixed(1)}
• <b>Payment:</b> ${paymentMethod}
• <b>Chain:</b> ${chain}
• <b>Network Fee:</b> ${networkFee} ${escrow.token}
• <b>Service Fee:</b> ${escrowFeePercent}%
• <b>Release Amount:</b> ${releaseAmount.toFixed(4)} ${escrow.token}
• <b>Buyer Address:</b> <code>${buyerAddress}</code>
• <b>Seller Address:</b> <code>${sellerAddress}</code>

🛑 <b>Do not send funds here</b> 🛑

${approvalStatus}`;
}

function parseFlexibleNumber(value) {
  if (value === null || value === undefined) {
    return NaN;
  }
  let str = String(value).trim();
  if (!str) {
    return NaN;
  }
  str = str.replace(/[^\d.,-]/g, "");
  if (!str) {
    return NaN;
  }
  const isNegative = str.startsWith("-");
  if (isNegative) {
    str = str.slice(1);
  }

  const lastComma = str.lastIndexOf(",");
  const lastDot = str.lastIndexOf(".");

  let decimalSeparator = null;
  let hasBothSeparators = lastComma > -1 && lastDot > -1;

  if (hasBothSeparators) {
    decimalSeparator = lastComma > lastDot ? "," : ".";
  } else if (lastComma > -1) {
    const afterComma = str.slice(lastComma + 1);
    if (
      afterComma.length === 3 &&
      /^\d{3}$/.test(afterComma) &&
      lastComma > 0
    ) {
      decimalSeparator = null;
    } else if (afterComma.length === 2 && /^00$/.test(afterComma)) {
      decimalSeparator = null;
    } else if (
      afterComma.length <= 2 &&
      /^\d{1,2}$/.test(afterComma) &&
      !/^0+$/.test(afterComma)
    ) {
      decimalSeparator = ",";
    } else if (afterComma.length === 1 && afterComma === "0") {
      decimalSeparator = ",";
    } else {
      decimalSeparator = null;
    }
  } else if (lastDot > -1) {
    // Check if there are multiple dots (likely thousands separators)
    const dotCount = (str.match(/\./g) || []).length;
    if (dotCount > 1) {
      decimalSeparator = null;
    } else {
      // Single dot is treated as decimal separator (US/English standard)
      // This fixes issues where 1.234 or 0.123 were parsed as 1234 or 123
      decimalSeparator = ".";
    }
  }

  let normalized = str;
  if (decimalSeparator) {
    const otherSeparator = decimalSeparator === "." ? "," : ".";
    const otherSepRegex = new RegExp("\\" + otherSeparator, "g");
    normalized = normalized.replace(otherSepRegex, "");
    const lastDecimalIndex = normalized.lastIndexOf(decimalSeparator);
    const integerPart = normalized
      .slice(0, lastDecimalIndex)
      .replace(new RegExp("\\" + decimalSeparator, "g"), "");
    const decimalPart = normalized.slice(lastDecimalIndex + 1);
    normalized = `${integerPart}.${decimalPart}`;
  } else {
    normalized = normalized.replace(/[.,]/g, "");
  }

  const parsed = parseFloat(normalized);
  if (Number.isNaN(parsed)) {
    return NaN;
  }
  return isNegative ? -parsed : parsed;
}

class EscrowBot {
  constructor() {
    this.bot = new Telegraf(config.BOT_TOKEN);
    this.setupMiddleware();
    this.setupHandlers();
    this.setupErrorHandling();
  }

  setupGroupMonitoring() {
    setInterval(async () => {
      try {
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

        const inactiveRecyclable = await Escrow.find({
          status: { $in: ["draft", "awaiting_details", "awaiting_deposit"] },
          lastActivityAt: { $lt: twoHoursAgo },
          isScheduledForRecycle: false,
        });

        for (const escrow of inactiveRecyclable) {
          try {
            let message =
              "⚠️ <b>Inactivity Alert:</b> This group has been inactive for more than 2 hours.\n\nIt will be recycled and closed in 10 minutes if no activity is detected.";

            if (escrow.status === "awaiting_deposit") {
              message =
                "⚠️ <b>Deposit Timeout Warning:</b> We are waiting for a deposit, but none has been detected for over 2 hours.\n\nTo free up the deposit address, this session will be recycled in 10 minutes if no funds are received.";
            }

            await this.bot.telegram.sendMessage(escrow.groupId, message, {
              parse_mode: "HTML",
            });

            escrow.isScheduledForRecycle = true;
            escrow.recycleWarningSentAt = new Date();
            await escrow.save();
          } catch (e) {
            console.error(
              `Error sending inactivity warning to ${escrow.groupId}:`,
              e.message,
            );
          }
        }

        const inactiveFunded = await Escrow.find({
          status: {
            $in: ["deposited", "in_fiat_transfer", "ready_to_release"],
          },
          lastActivityAt: { $lt: twoHoursAgo },
        });

        for (const escrow of inactiveFunded) {
          try {
            if (
              escrow.recycleWarningSentAt &&
              escrow.recycleWarningSentAt > escrow.lastActivityAt
            ) {
              continue;
            }

            await this.bot.telegram.sendMessage(
              escrow.groupId,
              "⚠️ <b>Action Required:</b> This transaction has been inactive for over 2 hours.\n\n💰 Funds are secure in escrow.\n\nPlease proceed with the trade steps, or use /cancel (if valid) or ask an admin for help if stuck.",
              { parse_mode: "HTML" },
            );

            escrow.recycleWarningSentAt = new Date();
            escrow.isScheduledForRecycle = false;
            await escrow.save();
          } catch (e) {
            console.error(
              `Error sending funded inactivity warning to ${escrow.groupId}:`,
              e.message,
            );
          }
        }

        const pendingRecycle = await Escrow.find({
          status: { $in: ["draft", "awaiting_details", "awaiting_deposit"] },
          isScheduledForRecycle: true,
          recycleWarningSentAt: { $lt: tenMinutesAgo },
        });

        for (const escrow of pendingRecycle) {
          try {
            if (escrow.lastActivityAt > escrow.recycleWarningSentAt) {
              escrow.isScheduledForRecycle = false;
              escrow.recycleWarningSentAt = null;
              await escrow.save();
              await this.bot.telegram.sendMessage(
                escrow.groupId,
                "✅ Activity detected. Group recycling cancelled.",
              );
              continue;
            }

            await this.bot.telegram.sendMessage(
              escrow.groupId,
              "⏳ Session expired. Recycling group...",
            );

            escrow.status = "cancelled";
            await escrow.save();

            await GroupPoolService.recycleGroupNow(escrow, this.bot.telegram);
          } catch (e) {
            console.error(
              `Error processing pending recycle for ${escrow.groupId}:`,
              e,
            );
          }
        }
      } catch (error) {
        console.error("Error in setupGroupMonitoring loop:", error);
      }
    }, 5 * 60 * 1000);
  }

  setupMiddleware() {
    this.bot.use(async (ctx, next) => {
      const user = ctx.from;
      if (user) {
        await this.ensureUser(user);
      }

      if (
        ctx.chat &&
        (ctx.chat.type === "group" || ctx.chat.type === "supergroup")
      ) {
        const chatId = String(ctx.chat.id);

        (async () => {
          try {
            await Escrow.updateOne(
              {
                groupId: chatId,
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
              },
              { $set: { lastActivityAt: new Date() } },
            );
          } catch (e) {}
        })();
      }

      return next();
    });
  }

  setupHandlers() {
    this.bot.use(calculatorHandler);

    this.bot.command("cancel", async (ctx) => {
      try {
        const chat = ctx.chat;
        const from = ctx.from;
        if (!chat || !from) return;

        const chatId = chat.id;
        const escrow = await findGroupEscrow(chatId, [
          "draft",
          "awaiting_details",
          "awaiting_deposit",
        ]);

        if (!escrow) {
          return;
        }

        // Strict check: Cannot cancel if deposit address is already generated
        if (escrow.depositAddress || escrow.uniqueDepositAddress) {
          return ctx.reply(
            "❌ Trade cannot be cancelled after the deposit address has been generated.",
          );
        }

        const userId = from.id;
        const adminUserId = config.ADMIN_USER_ID
          ? Number(config.ADMIN_USER_ID)
          : null;
        const adminUserId2 = config.ADMIN_USER_ID2
          ? Number(config.ADMIN_USER_ID2)
          : null;

        const isBuyer = escrow.buyerId === userId;
        const isSeller = escrow.sellerId === userId;
        const isAdmin = userId === adminUserId || userId === adminUserId2;

        if (!isBuyer && !isSeller && !isAdmin) {
          return ctx.reply(
            "❌ Only the buyer, seller, or admin can cancel the deal.",
          );
        }

        // If Admin, cancel immediately
        if (isAdmin) {
          await ctx.reply("⚠️ Admin cancelled the deal. Resetting group...");
          escrow.status = "cancelled";
          await escrow.save();
          await GroupPoolService.recycleGroupNow(escrow, ctx.telegram);
          return;
        }

        // For Buyer/Seller, require confirmation from BOTH
        escrow.buyerConfirmedCancel = false;
        escrow.sellerConfirmedCancel = false;

        // No auto-confirm. Both must explicitly click.

        await escrow.save();

        const buyerTag = escrow.buyerUsername
          ? `@${escrow.buyerUsername}`
          : "Buyer";
        const sellerTag = escrow.sellerUsername
          ? `@${escrow.sellerUsername}`
          : "Seller";

        const buyerStatus = escrow.buyerConfirmedCancel
          ? "✅ Confirmed"
          : "qWaiting...";
        const sellerStatus = escrow.sellerConfirmedCancel
          ? "✅ Confirmed"
          : "⌛️ Waiting...";

        const msg = `⚠️ <b>Cancel Request Initiated</b>
        
The ${isBuyer ? "Buyer" : "Seller"} wants to cancel this trade.
Both parties must confirm to proceed.

<b>Buyer (${buyerTag}):</b> ${buyerStatus}
<b>Seller (${sellerTag}):</b> ${sellerStatus}`;

        const cancelMsg = await ctx.reply(msg, {
          parse_mode: "HTML",
          reply_markup: Markup.inlineKeyboard([
            [
              Markup.button.callback(
                "✅ Confirm Cancel",
                `cancel_confirm_yes_${escrow.escrowId}`,
              ),
              Markup.button.callback(
                "❌ Abort",
                `cancel_confirm_no_${escrow.escrowId}`,
              ),
            ],
          ]).reply_markup,
        });

        escrow.cancelConfirmationMessageId = cancelMsg.message_id;
        await escrow.save();
      } catch (error) {
        console.error("Error in cancel command:", error);
        ctx.reply("❌ An error occurred while processing cancel request.");
      }
    });

    this.bot.action(/^cancel_confirm_yes_(.+)$/, async (ctx) => {
      try {
        const escrowId = ctx.match[1];
        const escrow = await Escrow.findOne({ escrowId });
        if (!escrow) return ctx.reply("❌ Deal not found.");

        if (escrow.status === "cancelled") {
          try {
            await ctx.editMessageText("⚠️ Deal already cancelled.");
          } catch (e) {}
          return;
        }

        if (escrow.depositAddress || escrow.uniqueDepositAddress) {
          return ctx.reply(
            "❌ Trade cannot be cancelled after deposit address is generated.",
          );
        }

        const userId = ctx.from.id;
        const isBuyer = escrow.buyerId === userId;
        const isSeller = escrow.sellerId === userId;

        if (!isBuyer && !isSeller) {
          return ctx.answerCbQuery("❌ Only buyer or seller can confirm.");
        }

        if (isBuyer) escrow.buyerConfirmedCancel = true;
        if (isSeller) escrow.sellerConfirmedCancel = true;
        await escrow.save();

        // Update message
        const buyerTag = escrow.buyerUsername
          ? `@${escrow.buyerUsername}`
          : "Buyer";
        const sellerTag = escrow.sellerUsername
          ? `@${escrow.sellerUsername}`
          : "Seller";
        const buyerStatus = escrow.buyerConfirmedCancel
          ? "✅ Confirmed"
          : "⌛️ Waiting...";
        const sellerStatus = escrow.sellerConfirmedCancel
          ? "✅ Confirmed"
          : "⌛️ Waiting...";

        const msg = `⚠️ <b>Cancel Request Initiated</b>
        
The ${isBuyer ? "Buyer" : "Seller"} wants to cancel this trade.
Both parties must confirm to proceed.

<b>Buyer (${buyerTag}):</b> ${buyerStatus}
<b>Seller (${sellerTag}):</b> ${sellerStatus}`;

        if (escrow.buyerConfirmedCancel && escrow.sellerConfirmedCancel) {
          await ctx.editMessageText(
            `⚠️ <b>Deal Cancelled</b>\n\nBoth parties confirmed. Resetting group...`,
            { parse_mode: "HTML" },
          );
          escrow.status = "cancelled";
          await escrow.save();
          await GroupPoolService.recycleGroupNow(escrow, ctx.telegram);
        } else {
          await ctx.editMessageText(msg, {
            parse_mode: "HTML",
            reply_markup: Markup.inlineKeyboard([
              [
                Markup.button.callback(
                  "✅ Confirm Cancel",
                  `cancel_confirm_yes_${escrow.escrowId}`,
                ),
                Markup.button.callback(
                  "❌ Abort",
                  `cancel_confirm_no_${escrow.escrowId}`,
                ),
              ],
            ]).reply_markup,
          });
        }
      } catch (e) {
        console.error("Cancel Yes Error", e);
      }
    });

    this.bot.action(/^cancel_confirm_no_(.+)$/, async (ctx) => {
      try {
        const escrowId = ctx.match[1];
        const escrow = await Escrow.findOne({ escrowId });
        if (!escrow) return ctx.reply("❌ Deal not found.");

        const userId = ctx.from.id;
        if (escrow.buyerId !== userId && escrow.sellerId !== userId) {
          return ctx.answerCbQuery("❌ Only parties can abort.");
        }

        escrow.buyerConfirmedCancel = false;
        escrow.sellerConfirmedCancel = false;
        await escrow.save();

        await ctx.editMessageText("❌ Cancel request aborted by user.");
      } catch (e) {
        console.error("Cancel No Error", e);
      }
    });

    this.bot.command("add", async (ctx) => {
      try {
        const chatId = ctx.chat.id;
        const escrow = await findGroupEscrow(chatId, [
          "deposited",
          "in_fiat_transfer",
          "ready_to_release",
        ]);

        if (!escrow) {
          return ctx.reply(
            "❌ This command can only be used when a deposit is already confirmed and before release.",
          );
        }

        const networkName = (escrow.chain || "BSC").toUpperCase();
        const address =
          escrow.uniqueDepositAddress || escrow.depositAddress || "N/A";

        await ctx.reply(
          `💰 <b>ADD MORE FUNDS</b>\n\nTo deposit additional funds, send ${escrow.token} to:\n\n<code>${address}</code>\n\nNetwork: ${networkName}\n\n⚠️ <b>After sending, please paste the Transaction Hash (TXID) here to automatically update the balance.</b>`,
          { parse_mode: "HTML" },
        );
      } catch (error) {
        console.error("Error in add command:", error);
      }
    });

    this.bot.use(async (ctx, next) => {
      try {
        const chat = ctx.chat;
        const from = ctx.from;
        if (!chat || !from) {
          return next();
        }
        const chatId = chat.id;
        if (chatId > 0 || !ctx.message || !ctx.message.text) return next();

        if (ctx.message.text.startsWith("/")) return next();

        const escrow = await findGroupEscrow(
          chatId,
          ["draft", "awaiting_details"],
          { tradeDetailsStep: "step8_seller_address" },
        );

        if (!escrow) {
          return next();
        }

        const userId = from.id;
        const text = ctx.message.text.trim();

        if (!escrow.sellerId || escrow.sellerId !== userId) {
          return next();
        }

        const telegram = ctx.telegram;
        const groupId = escrow.groupId;

        if (!isValidAddress(text, escrow.chain)) {
          await ctx.reply(getAddressErrorMessage(escrow.chain));
          return;
        }

        escrow.sellerAddress = text;
        escrow.tradeDetailsStep = "completed";
        escrow.status = "draft";
        escrow.buyerApproved = false;
        escrow.sellerApproved = false;
        await escrow.save();

        const summaryText = await buildDealSummary(escrow);
        const summaryMsg = await telegram.sendPhoto(
          groupId,
          images.CONFIRM_SUMMARY,
          {
            caption: summaryText,
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [{ text: "Approve", callback_data: "approve_deal_summary" }],
              ],
            },
          },
        );
        escrow.dealSummaryMessageId = summaryMsg.message_id;
        await escrow.save();

        return;
      } catch (e) {
        console.error("Step 6 seller address error", e);
      }
      return next();
    });

    this.bot.use(async (ctx, next) => {
      try {
        const chat = ctx.chat;
        const from = ctx.from;
        if (!chat || !from) {
          return next();
        }
        const chatId = chat.id;
        if (chatId > 0 || !ctx.message || !ctx.message.text) return next();

        if (ctx.message.text.startsWith("/")) return next();

        const escrow = await findGroupEscrow(
          chatId,
          ["draft", "awaiting_details"],
          { tradeDetailsStep: "step7_addresses" },
        );

        if (!escrow) {
          return next();
        }

        const userId = from.id;
        const text = ctx.message.text.trim();

        if (!escrow.buyerId || escrow.buyerId !== userId) {
          return;
        }

        const telegram = ctx.telegram;
        const groupId = escrow.groupId;

        if (!isValidAddress(text, escrow.chain)) {
          await ctx.reply(getAddressErrorMessage(escrow.chain));
          return;
        }

        escrow.buyerAddress = text;
        escrow.tradeDetailsStep = "step8_seller_address";
        escrow.status = "draft";
        await escrow.save();

        const sellerUsername = escrow.sellerUsername
          ? `@${escrow.sellerUsername}`
          : "Seller";
        const chainName = escrow.chain || "BSC";

        const addressExample = getAddressExample(chainName)
          .replace("Step 5", "Step 8")
          .replace("{username}", sellerUsername)
          .replace("{chain}", chainName);

        const step8Msg = await telegram.sendPhoto(
          groupId,
          images.ENTER_ADDRESS,
          {
            caption: addressExample,
          },
        );
        escrow.step8SellerAddressMessageId = step8Msg.message_id;
        await escrow.save();

        return;
      } catch (e) {
        console.error("Step 5 buyer address error", e);
      }
      return next();
    });

    this.bot.use(async (ctx, next) => {
      try {
        const chat = ctx.chat;
        const ctxFrom = ctx.from;
        if (!chat || !ctxFrom) {
          return next();
        }
        const chatId = chat.id;
        if (chatId > 0 || !ctx.message || !ctx.message.text) return next();

        if (ctx.message.text.startsWith("/")) return next();

        const escrow = await findGroupEscrow(
          chatId,
          [
            "awaiting_deposit",
            "deposited",
            "in_fiat_transfer",
            "ready_to_release",
          ],
          { transactionHashMessageId: { $exists: true } },
        );

        if (!escrow) {
          return next();
        }

        if (
          escrow.status !== "awaiting_deposit" &&
          !["deposited", "in_fiat_transfer", "ready_to_release"].includes(
            escrow.status,
          )
        ) {
          return next();
        }

        if (escrow.status !== "awaiting_deposit") {
          const potentialHash = ctx.message.text.trim();
          if (
            !/^(0x)?[a-fA-F0-9]{64}$/.test(potentialHash) &&
            !potentialHash.includes("scan")
          ) {
            return next();
          }
        }

        const text = ctx.message.text.trim();
        const userId = ctxFrom.id;

        if (escrow.sellerId !== userId) {
          return next();
        }

        let txHash = text.trim();
        const hashMatch = text.match(/(?:0x)?([a-fA-F0-9]{64})/);
        if (hashMatch) {
          txHash = hashMatch[1];
        }

        // Normalize to lowercase to ensure global uniqueness check works case-insensitively
        txHash = txHash.toLowerCase();

        const txChainUpper = (escrow.chain || "").toUpperCase();
        if (txChainUpper === "TRON" || txChainUpper === "TRX") {
          if (!/^[a-f0-9]{64}$/.test(txHash)) {
            await ctx.reply(
              "❌ Invalid TRON transaction hash format. Please provide a valid transaction hash or explorer link.",
            );
            return;
          }
        } else {
          if (!/^(0x)?[a-f0-9]{64}$/.test(txHash)) {
            await ctx.reply(
              "❌ Invalid transaction hash format. Please provide a valid transaction hash or explorer link.",
            );
            return;
          }
          txHash = "0x" + txHash;
        }

        // 15-Minute Age Validation
        try {
          // Use 'await' to get timestamp (in ms)
          const txTimestamp = await BlockchainService.getTransactionTimestamp(
            escrow.chain,
            txHash,
          );
          const timeDiff = Date.now() - txTimestamp;

          // 15 minutes = 15 * 60 * 1000 = 900000 ms
          const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

          // If timestamp is 0, it means fetch failed. We can either block or warn.
          // Blocking is safer for security.
          if (txTimestamp === 0) {
            await ctx.reply(
              "⚠️ Could not verify transaction time. Please try again in a moment or contact support.",
            );
            return;
          }

          if (timeDiff > FIFTEEN_MINUTES_MS) {
            const minutesOld = Math.floor(timeDiff / 60000);
            await ctx.reply(
              `❌ Transaction Expired.\n\nThis transaction is ${minutesOld} minutes old.`,
            );
            return;
          }
        } catch (timeError) {
          console.error("Time validation error:", timeError);
          await ctx.reply(
            "❌ Error validating transaction time. Please try again.",
          );
          return;
        }

        // Use case-insensitive regex to catch duplicates even if legacy data has mixed case
        const txHashRegex = new RegExp(`^${txHash}$`, "i");
        const existingEscrow = await Escrow.findOne({
          $or: [
            { transactionHash: { $regex: txHashRegex } },
            { partialTransactionHashes: { $regex: txHashRegex } },
          ],
        });

        if (existingEscrow) {
          await ctx.reply(
            "❌ This transaction hash has already been used in a previous trade. Each transaction can only be used once.",
          );
          return;
        }

        if (
          escrow.transactionHash === txHash ||
          (escrow.partialTransactionHashes &&
            escrow.partialTransactionHashes.includes(txHash))
        ) {
          await ctx.reply(
            "❌ This transaction has already been submitted for this trade. Please wait for confirmation or contact support if there's an issue.",
          );
          return;
        }

        const chainUpper = (escrow.chain || "").toUpperCase();
        let txFrom = null;
        let amount = 0;
        let amountWeiBigInt = 0n;

        if (chainUpper === "TRON" || chainUpper === "TRX") {
          try {
            const tokenAddress = BlockchainService.getTokenAddress(
              escrow.token,
              escrow.chain,
            );
            if (!tokenAddress) {
              await ctx.reply(
                "❌ Token address not found. Please contact admin.",
              );
              return;
            }

            await TronService.init();
            const tronWeb = TronService.tronWeb;
            const tx = await tronWeb.trx.getTransaction(txHash);

            if (!tx || !tx.ret) {
              await ctx.reply(
                "❌ Transaction not found or not confirmed. Please check the transaction hash.",
              );
              return;
            }

            const txInfo = await tronWeb.trx.getTransactionInfo(txHash);
            if (!txInfo || !txInfo.log) {
              await ctx.reply(
                "❌ Transaction info not found. Transaction may still be pending.",
              );
              return;
            }

            const depositAddr = escrow.depositAddress;
            let transferLog = null;
            const decimals = BlockchainService.getTokenDecimals(
              escrow.token,
              escrow.chain,
            );
            let fromAddr = null;
            let toAddr = null;

            for (const log of txInfo.log || []) {
              try {
                const logContractHex = log.address;
                const expectedTokenHex = tronWeb.address.toHex(tokenAddress);

                if (
                  logContractHex.toLowerCase().replace(/^0x/, "41") !==
                  expectedTokenHex.toLowerCase().replace(/^0x/, "41")
                ) {
                  continue;
                }

                if (log.topics && log.topics.length >= 3) {
                  const transferEventSig =
                    "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
                  if (
                    log.topics[0] === transferEventSig ||
                    log.topics[0].toLowerCase() === transferEventSig
                  ) {
                    const fromHex = "41" + log.topics[1].slice(-40);
                    const toHex = "41" + log.topics[2].slice(-40);

                    const depositAddrHex = tronWeb.address.toHex(depositAddr);

                    if (toHex.toLowerCase() === depositAddrHex.toLowerCase()) {
                      fromAddr = tronWeb.address.fromHex(fromHex);
                      toAddr = tronWeb.address.fromHex(toHex);

                      const valueHex = log.data || "0";
                      const value = BigInt("0x" + valueHex);

                      transferLog = { from: fromAddr, to: toAddr, value };
                      amountWeiBigInt = value;
                      amount = Number(amountWeiBigInt) / Math.pow(10, decimals);
                      break;
                    }
                  }
                }
              } catch (e) {
                console.error("Error parsing TRON log:", e);
                continue;
              }
            }

            if (!transferLog) {
              await ctx.reply(
                "❌ No transfer to deposit address found in this transaction.",
              );
              return;
            }

            txFrom = fromAddr;
          } catch (error) {
            console.error("Error processing TRON transaction:", error);
            await ctx.reply(
              "❌ Error processing TRON transaction. Please check the transaction hash and try again.",
            );
            return;
          }
        } else {
          const provider =
            BlockchainService.providers[escrow.chain?.toUpperCase()] ||
            BlockchainService.providers["BSC"];

          try {
            let tx = null;
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                tx = await executeRPCWithRetry(async () => {
                  return await provider.getTransaction(txHash);
                });
                if (tx) break;
              } catch (ignore) {}
              if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
            }

            if (!tx) {
              await ctx.reply(
                "❌ Transaction not found. Please check the transaction hash.",
              );
              return;
            }

            const receipt = await executeRPCWithRetry(async () => {
              return await provider.getTransactionReceipt(txHash);
            });

            if (!receipt) {
              await ctx.reply(
                "❌ Transaction receipt not found. Transaction may still be pending. Please wait a moment and try again.",
              );
              return;
            }

            const tokenAddress = BlockchainService.getTokenAddress(
              escrow.token,
              escrow.chain,
            );
            if (!tokenAddress) {
              await ctx.reply(
                "❌ Token address not found. Please contact admin.",
              );
              return;
            }

            const iface = new ethers.Interface([
              "event Transfer(address indexed from, address indexed to, uint256 value)",
            ]);
            const logs = receipt.logs.filter(
              (log) => log.address.toLowerCase() === tokenAddress.toLowerCase(),
            );

            if (logs.length === 0) {
              await ctx.reply(
                "❌ No token transfer found in this transaction.",
              );
              return;
            }

            const depositAddr = escrow.depositAddress.toLowerCase();
            let transferLog = null;
            const decimals = BlockchainService.getTokenDecimals(
              escrow.token,
              escrow.chain,
            );
            let fromAddr = null;
            let toAddr = null;

            for (const log of logs) {
              try {
                const parsed = iface.parseLog({
                  topics: log.topics,
                  data: log.data,
                });
                if (parsed && parsed.name === "Transfer") {
                  fromAddr = parsed.args[0];
                  toAddr = parsed.args[1];
                  const value = parsed.args[2];

                  if (toAddr.toLowerCase() === depositAddr) {
                    transferLog = parsed;
                    amountWeiBigInt = BigInt(value.toString());
                    amount = Number(amountWeiBigInt) / Math.pow(10, decimals);
                    break;
                  }
                }
              } catch (e) {
                continue;
              }
            }

            if (!transferLog) {
              await ctx.reply(
                "❌ No transfer to deposit address found in this transaction.",
              );
              return;
            }

            txFrom = fromAddr;
          } catch (err) {
            console.error("Error fetching transaction:", err);
            await ctx.reply(
              "❌ Error fetching transaction details. Please check the transaction hash and try again.",
            );
            return;
          }
        }

        const expectedAmount = escrow.quantity;
        const tolerance = 0.01;

        const freshEscrow = await Escrow.findById(escrow._id);

        const currentAccumulated = freshEscrow.accumulatedDepositAmount;
        const newAccumulated = currentAccumulated + amount;
        const remainingAmount = expectedAmount - newAccumulated;

        if (
          freshEscrow.transactionHash === txHash ||
          (freshEscrow.partialTransactionHashes &&
            freshEscrow.partialTransactionHashes.includes(txHash))
        ) {
          await ctx.reply(
            "❌ This transaction has already been submitted for this trade. Please wait for confirmation.",
          );
          return;
        }

        freshEscrow.accumulatedDepositAmount = newAccumulated;
        const currentAccumulatedWei = BigInt(
          freshEscrow.accumulatedDepositAmountWei || "0",
        );
        const newAccumulatedWei = currentAccumulatedWei + amountWeiBigInt;
        freshEscrow.accumulatedDepositAmountWei = newAccumulatedWei.toString();

        if (!freshEscrow.transactionHash) {
          freshEscrow.transactionHash = txHash;
          freshEscrow.depositTransactionFromAddress = txFrom;
        } else {
          if (!freshEscrow.partialTransactionHashes) {
            freshEscrow.partialTransactionHashes = [];
          }
          freshEscrow.partialTransactionHashes.push(txHash);
        }

        freshEscrow.depositAmount = newAccumulated;
        if (
          newAccumulated < expectedAmount - tolerance &&
          freshEscrow.status !== "awaiting_deposit"
        ) {
        }
        await freshEscrow.save();

        if (newAccumulated < expectedAmount - tolerance) {
          try {
            await CompletionFeedService.handlePartialDeposit({
              escrow: freshEscrow,
              partialAmount: amount,
              transactionHash: txHash,
              telegram: ctx.telegram,
            });
          } catch (partialLogError) {
            console.error("Error logging partial deposit:", partialLogError);
          }
        }

        if (newAccumulated >= expectedAmount - tolerance) {
          if (freshEscrow.transactionHashMessageId) {
            try {
              await ctx.telegram.deleteMessage(
                chatId,
                freshEscrow.transactionHashMessageId,
              );
            } catch (e) {
              const desc = e?.response?.description || e?.message || "";
              const descLower = desc.toLowerCase();
              if (
                !descLower.includes("message identifier is not specified") &&
                !descLower.includes("message to delete not found")
              ) {
                console.error("Failed to delete transaction hash message:", e);
              }
            }
          }

          if (ctx.message && ctx.message.message_id) {
            try {
              await ctx.telegram.deleteMessage(chatId, ctx.message.message_id);
            } catch (e) {
              const desc = e?.response?.description || e?.message || "";
              if (
                !desc.includes("message identifier is not specified") &&
                !desc.includes("message to delete not found")
              ) {
                console.error("Failed to delete transaction link message:", e);
              }
            }
          }

          const txHashShort = txHash.substring(0, 10) + "...";
          const totalTxCount =
            1 +
            (freshEscrow.partialTransactionHashes
              ? freshEscrow.partialTransactionHashes.length
              : 0);
          const fromAddress =
            freshEscrow.depositTransactionFromAddress || from || "N/A";
          const depositAddress = freshEscrow.depositAddress || "N/A";
          const expectedAmountDisplay = freshEscrow.quantity.toFixed(2);
          const overDelivered =
            expectedAmount > 0 && newAccumulated - expectedAmount > tolerance;

          freshEscrow.confirmedAmount = newAccumulated;
          if (
            ["draft", "awaiting_details", "awaiting_deposit"].includes(
              freshEscrow.status,
            )
          ) {
            freshEscrow.status = "deposited";
          }
          await freshEscrow.save();

          const isTopUp = currentAccumulated >= expectedAmount - tolerance;

          if (isTopUp) {
            const topUpMessage = `💰 <b>ADDITIONAL FUNDS RECEIVED</b>
             
✅ <b>Recieved:</b> ${amount.toFixed(2)} ${freshEscrow.token}
📊 <b>New Total:</b> ${newAccumulated.toFixed(2)} ${freshEscrow.token}
Transactions: ${totalTxCount}
Main Tx: <code>${txHashShort}</code>`;

            await ctx.reply(topUpMessage, { parse_mode: "HTML" });
            return;
          }

          const statusLine = overDelivered
            ? `🟢 Extra ${
                freshEscrow.token
              } received (expected ${expectedAmount.toFixed(
                2,
              )}, got ${newAccumulated.toFixed(2)})`
            : `🟢 Exact ${freshEscrow.token} found`;

          let confirmedTxText = `<b>P2P MM Bot 🤖</b>

${statusLine}

<b>Total Amount:</b> ${newAccumulated.toFixed(2)} ${freshEscrow.token}
<b>Transactions:</b> ${totalTxCount} transaction(s)
<b>From:</b> <code>${fromAddress}</code>
<b>To:</b> <code>${depositAddress}</code>
<b>Main Tx:</b> <code>${txHashShort}</code>`;

          if (overDelivered) {
            confirmedTxText += `\n<b>Original Deal Amount:</b> ${expectedAmountDisplay} ${freshEscrow.token}`;
          }

          if (totalTxCount > 1) {
            confirmedTxText += `\n\n✅ Full amount received through ${totalTxCount} transaction(s)`;
          }

          const txDetailsMsg = await ctx.telegram.sendPhoto(
            chatId,
            images.DEPOSIT_FOUND,
            {
              caption: confirmedTxText,
              parse_mode: "HTML",
            },
          );

          freshEscrow.transactionHashMessageId = txDetailsMsg.message_id;
          await freshEscrow.save();

          if (freshEscrow.buyerId) {
            const buyerMention = freshEscrow.buyerUsername
              ? `@${freshEscrow.buyerUsername}`
              : freshEscrow.buyerId
              ? `[${freshEscrow.buyerId}]`
              : "Buyer";

            const buyerInstruction = `✅ Payment Received!

Use /release After Fund Transfer to Seller

⚠️ Please note:
• Don't share payment details on private chat
• Please share all deals in group`;

            await ctx.telegram.sendMessage(chatId, buyerInstruction);
          }

          return;
        } else {
          if (newAccumulated < expectedAmount - tolerance) {
            const remainingFormatted = remainingAmount.toFixed(2);
            const partialMessage = await ctx.reply(
              `✅ Partial deposit received: ${amount.toFixed(2)} ${
                escrow.token
              }\n\n` +
                `📊 Total received so far: ${newAccumulated.toFixed(2)} ${
                  escrow.token
                }\n` +
                `💰 Remaining amount needed: ${remainingFormatted} ${escrow.token}\n\n` +
                `Please choose an option:`,
              {
                parse_mode: "HTML",
                reply_markup: Markup.inlineKeyboard([
                  [
                    Markup.button.callback(
                      "✅ Continue with this amount",
                      `partial_continue_${freshEscrow.escrowId}`,
                    ),
                    Markup.button.callback(
                      "💰 Pay remaining amount",
                      `partial_pay_remaining_${freshEscrow.escrowId}`,
                    ),
                  ],
                ]).reply_markup,
              },
            );

            freshEscrow.partialPaymentMessageId = partialMessage.message_id;
            await freshEscrow.save();
          }
          return;
        }
      } catch (e) {
        console.error("Transaction hash handler error:", e);
      }
      return next();
    });

    this.bot.use(async (ctx, next) => {
      try {
        const chat = ctx.chat;
        const from = ctx.from;
        if (!chat || !from) {
          return next();
        }
        const chatId = chat.id;
        if (chatId > 0 || !ctx.message || !ctx.message.text) return next();

        if (ctx.message.text.startsWith("/")) return next();

        const escrow = await findGroupEscrow(
          chatId,
          ["draft", "awaiting_details"],
          {
            tradeDetailsStep: {
              $in: ["step4_amount", "step5_rate", "step6_payment"],
            },
          },
        );

        if (!escrow) {
          return next();
        }

        const text = ctx.message.text.trim();
        const userId = from.id;

        if (escrow.buyerId !== userId && escrow.sellerId !== userId) {
          return;
        }

        const telegram = ctx.telegram;
        const groupId = escrow.groupId;

        if (escrow.tradeDetailsStep === "step4_amount") {
          // Strict validation: No commas allowed, only numbers and dot
          if (text.includes(",") || !/^\d+(\.\d+)?$/.test(text)) {
            await ctx.reply(
              "❌ Invalid format.\n\nPlease enter the amount using ONLY numbers and '.' (dot) for decimals.\n\nExample: 1500.50\n(Do not use ',' commas)",
            );
            return;
          }

          const amount = parseFloat(text);
          if (isNaN(amount) || amount <= 0) {
            await ctx.reply(
              "❌ Please enter a valid amount greater than 0.\n\nExample: 1500.50",
            );
            return;
          }

          escrow.quantity = amount;
          escrow.tradeDetailsStep = "step5_rate";
          await escrow.save();

          const tokenName = escrow.token || "USDT";
          const step5Msg = await ctx.replyWithPhoto(images.ENTER_RATE, {
            caption: `📊 Step 5 - Rate per ${tokenName} → Example: 89.5`,
          });
          escrow.step5MessageId = step5Msg.message_id;
          await escrow.save();
          return;
        } else if (escrow.tradeDetailsStep === "step5_rate") {
          const rate = parseFlexibleNumber(text);
          if (isNaN(rate) || rate <= 0) {
            await ctx.reply(
              "❌ Please enter a valid rate. Examples: 89.5 or 89,50",
            );
            return;
          }

          escrow.rate = rate;
          escrow.tradeDetailsStep = "step6_payment";
          await escrow.save();

          const step6Msg = await ctx.replyWithPhoto(images.PAYMENT_METHOD, {
            caption: "💳 Step 6 - Payment method → Examples: CDM, CASH, CCW",
          });
          escrow.step6MessageId = step6Msg.message_id;
          await escrow.save();
          return;
        } else if (escrow.tradeDetailsStep === "step6_payment") {
          const paymentMethod = text.toUpperCase().trim();
          if (!paymentMethod || paymentMethod.length < 2) {
            await ctx.reply(
              "❌ Please enter a valid payment method. Examples: CDM, CASH, CCW",
            );
            return;
          }

          escrow.paymentMethod = paymentMethod;
          escrow.tradeDetailsStep = "step7_addresses";
          escrow.status = "draft";
          if (!escrow.tradeStartTime) {
            escrow.tradeStartTime = escrow.createdAt || new Date();
          }
          await escrow.save();

          const buyerUsername = escrow.buyerUsername
            ? `@${escrow.buyerUsername}`
            : "Buyer";
          const chainName = escrow.chain || "BSC";

          const addressExample = getAddressExample(chainName)
            .replace("Step 5", "Step 7")
            .replace("{username}", buyerUsername)
            .replace("{chain}", chainName);

          const step7Msg = await ctx.replyWithPhoto(images.ENTER_ADDRESS, {
            caption: addressExample,
          });
          escrow.step7MessageId = step7Msg.message_id;
          await escrow.save();

          return;
        }
      } catch (e) {
        console.error("step-by-step trade details error", e);
      }
      return next();
    });

    const settleAndRecycleGroup = async (escrow, telegram) => {
      try {
        const group = await GroupPool.findOne({
          assignedEscrowId: escrow.escrowId,
        });

        if (group) {
          const allUsersRemoved = await GroupPoolService.removeUsersFromGroup(
            escrow,
            group.groupId,
            telegram,
          );

          if (allUsersRemoved) {
            const freshEscrow = await Escrow.findOne({
              escrowId: escrow.escrowId,
            });
            if (freshEscrow && freshEscrow.inviteLink) {
              freshEscrow.inviteLink = null;
              await freshEscrow.save();
            }

            await GroupPoolService.refreshInviteLink(group.groupId, telegram);

            group.status = "available";
            group.assignedEscrowId = null;
            group.assignedAt = null;
            group.completedAt = null;
            await group.save();

            await telegram.sendMessage(
              escrow.groupId,
              "✅ Settlement completed! Group has been recycled and is ready for a new deal.",
            );
          }
        }
      } catch (error) {
        console.error("Error settling and recycling group:", error);
      }
    };

    this.bot.command("deal", groupDealHandler);
    this.bot.command("verify", verifyHandler);
    this.bot.command("restart", restartHandler);
    this.bot.command("dispute", disputeHandler);
    this.bot.command("release", async (ctx) => {
      try {
        const chatId = ctx.chat.id;
        const userId = ctx.from.id;

        if (chatId > 0) {
          return ctx.reply("❌ This command can only be used in a group chat.");
        }

        const escrow = await findGroupEscrow(chatId, [
          "deposited",
          "in_fiat_transfer",
          "ready_to_release",
          "disputed",
        ]);

        if (!escrow) {
          return;
        }

        const normalizedUsername = (ctx.from.username || "").toLowerCase();
        const isAdmin =
          config
            .getAllAdminUsernames()
            .some(
              (name) => name && name.toLowerCase() === normalizedUsername,
            ) || config.getAllAdminIds().includes(String(userId));
        const isSellerIdMatch =
          escrow.sellerId && Number(escrow.sellerId) === Number(userId);
        const isSellerUsernameMatch =
          escrow.sellerUsername &&
          escrow.sellerUsername.toLowerCase() === normalizedUsername;
        const isSeller = Boolean(isSellerIdMatch || isSellerUsernameMatch);

        if (!isAdmin && escrow.tradeStartTime) {
          const startTime = new Date(escrow.tradeStartTime).getTime();
          const now = Date.now();
          const tenMinutes = 10 * 60 * 1000;
          const timeDiff = now - startTime;

          if (timeDiff < tenMinutes) {
            const remainingMinutes = Math.ceil((tenMinutes - timeDiff) / 60000);
            return ctx.reply(
              `⏳ <b>Security Cooldown:</b> Funds can only be released 10 minutes after the deal starts.\n\nPlease wait approximately <b>${remainingMinutes} minute(s)</b>.`,
              { parse_mode: "HTML" },
            );
          }
        }

        const commandText = ctx.message.text.trim();
        const parts = commandText.split(/\s+/);
        const hasAmount = parts.length > 1;

        if (hasAmount && !isAdmin && !isSeller) {
          return ctx.reply(
            "❌ Only admins or the seller can use partial release.",
          );
        }

        if (!isAdmin && !isSeller) {
          return ctx.reply(
            "❌ Only admins or the seller can use this command.",
          );
        }

        if (!escrow.buyerAddress) {
          return ctx.reply("❌ Buyer address is not set.");
        }

        let requestedAmount = null;

        if (hasAmount) {
          requestedAmount = parseFloat(parts[1]);
          if (isNaN(requestedAmount) || requestedAmount <= 0) {
            return ctx.reply(
              "❌ Invalid amount. Usage: /release or /release <amount>",
            );
          }
        }

        const decimals = BlockchainService.getTokenDecimals(
          escrow.token,
          escrow.chain,
        );
        const amountWeiOverride =
          escrow.accumulatedDepositAmountWei &&
          escrow.accumulatedDepositAmountWei !== "0"
            ? escrow.accumulatedDepositAmountWei
            : null;
        const totalDeposited = Number(
          escrow.accumulatedDepositAmount ||
            escrow.depositAmount ||
            escrow.confirmedAmount ||
            0,
        );
        const formattedTotalDeposited = amountWeiOverride
          ? Number(ethers.formatUnits(BigInt(amountWeiOverride), decimals))
          : totalDeposited;

        if (totalDeposited <= 0) {
          return ctx.reply("❌ No confirmed deposit found.");
        }

        const releaseAmount =
          requestedAmount !== null ? requestedAmount : formattedTotalDeposited;

        if (releaseAmount > formattedTotalDeposited) {
          return ctx.reply(
            `❌ Release amount (${releaseAmount.toFixed(
              5,
            )}) exceeds available balance (${formattedTotalDeposited.toFixed(
              5,
            )} ${escrow.token}).`,
          );
        }

        if (releaseAmount <= 0) {
          return ctx.reply("❌ Release amount must be greater than 0.");
        }

        // NET CALCULATION: Deduct fees from the gross release amount
        // NET CALCULATION: For display only.
        // We store the GROSS amount in pendingReleaseAmount so callbackHandler can deduct fees properly.
        const currentFeeRate =
          escrow.feeRate !== undefined ? Number(escrow.feeRate) : 0.75;
        const currentNetworkFee =
          escrow.networkFee !== undefined ? Number(escrow.networkFee) : 0.2;

        const grossReleaseAmount =
          requestedAmount !== null ? requestedAmount : formattedTotalDeposited;

        // Fee is percentage of the GROSS amount being released (for estimation display)
        // Actual fee logic in callbackHandler is: (Gross - NetworkFee) * FeeRate
        const estimatedAmountToContract =
          grossReleaseAmount - currentNetworkFee;
        const estimatedServiceFee =
          (estimatedAmountToContract * currentFeeRate) / 100;

        // Net amount = Gross - NetworkFee - ServiceFee
        const netReleaseAmount = Math.max(
          0,
          estimatedAmountToContract - estimatedServiceFee,
        );

        if (netReleaseAmount <= 0) {
          return ctx.reply(
            `❌ Release amount too small to cover fees (Service: ${estimatedServiceFee.toFixed(
              4,
            )}, Network: ${currentNetworkFee}).`,
          );
        }

        // CRITICAL FIX: Store GROSS amount here. callbackHandler will deduct fees.
        escrow.pendingReleaseAmount = grossReleaseAmount;
        escrow.pendingRefundAmount = null;

        const isPartialReleaseByAdmin = hasAmount && isAdmin;
        const isPartialReleaseBySeller = hasAmount && isSeller && !isAdmin;
        const isFullAmount =
          grossReleaseAmount >= formattedTotalDeposited - 0.000001;
        const releaseType = isFullAmount ? "Full" : "Partial";

        if (isPartialReleaseByAdmin) {
          escrow.adminConfirmedRelease = false;
          escrow.buyerConfirmedRelease = false;
          escrow.sellerConfirmedRelease = false;
          await escrow.save();

          const releaseCaption = `<b>Admin Release Confirmation (${releaseType})</b>

Amount: ${grossReleaseAmount.toFixed(4)} ${escrow.token}
Total Deposited: ${formattedTotalDeposited.toFixed(4)} ${escrow.token}

⚠️ Admin approval required for partial release.`;

          const releaseMsg = await ctx.replyWithPhoto(
            images.RELEASE_CONFIRMATION,
            {
              caption: releaseCaption,
              parse_mode: "HTML",
              reply_markup: Markup.inlineKeyboard([
                [
                  Markup.button.callback(
                    "✅ Confirm Release",
                    `admin_release_confirm_yes_${escrow.escrowId}`,
                  ),
                  Markup.button.callback(
                    "❌ Cancel",
                    `admin_release_confirm_no_${escrow.escrowId}`,
                  ),
                ],
              ]).reply_markup,
            },
          );

          escrow.releaseConfirmationMessageId = releaseMsg.message_id;
          await escrow.save();
        } else {
          escrow.adminConfirmedRelease = false;

          if (isPartialReleaseBySeller) {
            escrow.buyerConfirmedRelease = false;
            escrow.sellerConfirmedRelease = false;
          } else {
            escrow.buyerConfirmedRelease = true;
            escrow.sellerConfirmedRelease = false;
          }
          await escrow.save();

          const sellerTag = escrow.sellerUsername
            ? `@${escrow.sellerUsername}`
            : `[${escrow.sellerId}]`;
          const buyerTag = escrow.buyerUsername
            ? `@${escrow.buyerUsername}`
            : `[${escrow.buyerId}]`;

          const isPartial = !isFullAmount;

          let approvalNote =
            "Only the seller needs to approve to release payment.";
          let statusSection = "";

          if (isPartial) {
            approvalNote =
              "⚠️ Both Seller and Buyer must confirm this partial release.";
            escrow.sellerConfirmedRelease = false;
            escrow.buyerConfirmedRelease = false;

            const sellerLine = escrow.sellerConfirmedRelease
              ? `✅ ${sellerTag} - Confirmed`
              : `⌛️ ${sellerTag} - Waiting...`;
            const buyerLine = escrow.buyerConfirmedRelease
              ? `✅ ${buyerTag} - Confirmed`
              : `⌛️ ${buyerTag} - Waiting...`;
            statusSection = `${sellerLine}\n${buyerLine}`;
          } else {
            // Full release
            const sellerLine = escrow.sellerConfirmedRelease
              ? `✅ ${sellerTag} - Confirmed`
              : `⌛️ ${sellerTag} - Waiting...`;
            statusSection = sellerLine;
          }

          const releaseCaption = `<b>Release Confirmation (${releaseType})</b>

Amount: ${grossReleaseAmount.toFixed(5)} ${escrow.token}
<b>Net to Seller:</b> ${netReleaseAmount.toFixed(5)} ${escrow.token}
<i>(Fees: ${currentFeeRate}% + ${currentNetworkFee})</i>

${statusSection}

${approvalNote}`;

          const releaseMsg = await ctx.replyWithPhoto(
            images.RELEASE_CONFIRMATION,
            {
              caption: releaseCaption,
              parse_mode: "HTML",
              reply_markup: Markup.inlineKeyboard([
                [
                  Markup.button.callback(
                    "✅ Approve",
                    `release_confirm_yes_${escrow.escrowId}`,
                  ),
                  Markup.button.callback(
                    "❌ Decline",
                    `release_confirm_no_${escrow.escrowId}`,
                  ),
                ],
              ]).reply_markup,
            },
          );

          escrow.releaseConfirmationMessageId = releaseMsg.message_id;
          await escrow.save();
        }
      } catch (error) {
        console.error("Error in release command:", error);
        ctx.reply("❌ An error occurred.");
      }
    });

    this.bot.command("refund", async (ctx) => {
      try {
        const chatId = ctx.chat.id;
        const userId = ctx.from.id;

        if (chatId > 0) {
          return ctx.reply("❌ This command can only be used in a group chat.");
        }

        const escrow = await findGroupEscrow(chatId, [
          "deposited",
          "in_fiat_transfer",
          "ready_to_release",
          "disputed",
        ]);

        if (!escrow) {
          return ctx.reply(
            "❌ No active trade available for refund in this group.",
          );
        }

        const normalizedUsername = ctx.from.username
          ? ctx.from.username.toLowerCase()
          : "";
        const isAdmin =
          config.getAllAdminUsernames().includes(ctx.from.username) ||
          config.getAllAdminIds().includes(String(userId));

        const isBuyerIdMatch =
          escrow.buyerId && Number(escrow.buyerId) === Number(userId);
        const isBuyerUsernameMatch =
          escrow.buyerUsername &&
          escrow.buyerUsername.toLowerCase() === normalizedUsername;
        const isBuyer = Boolean(isBuyerIdMatch || isBuyerUsernameMatch);

        if (!isAdmin && !isBuyer) {
          return ctx.reply("❌ Only admins or the buyer can use this command.");
        }

        if (!escrow.sellerAddress) {
          return ctx.reply("❌ Seller address is not set.");
        }

        const commandText = ctx.message.text.trim();
        const parts = commandText.split(/\s+/);
        let requestedAmount = null;

        if (parts.length > 1) {
          const amountStr = parts[1].replace(/^-/, "");
          requestedAmount = parseFloat(amountStr);
          if (isNaN(requestedAmount) || requestedAmount <= 0) {
            return ctx.reply(
              "❌ Invalid amount. Usage: /refund or /refund <amount>",
            );
          }
        }

        const decimals = BlockchainService.getTokenDecimals(
          escrow.token,
          escrow.chain,
        );
        const amountWeiOverride =
          escrow.accumulatedDepositAmountWei &&
          escrow.accumulatedDepositAmountWei !== "0"
            ? escrow.accumulatedDepositAmountWei
            : null;
        const totalDeposited = Number(
          escrow.accumulatedDepositAmount ||
            escrow.depositAmount ||
            escrow.confirmedAmount ||
            0,
        );
        const formattedTotalDeposited = amountWeiOverride
          ? Number(ethers.formatUnits(BigInt(amountWeiOverride), decimals))
          : totalDeposited;

        if (totalDeposited <= 0) {
          return ctx.reply("❌ No confirmed deposit found.");
        }

        const refundAmount =
          requestedAmount !== null ? requestedAmount : formattedTotalDeposited;

        if (refundAmount <= 0) {
          return ctx.reply("❌ Refund amount must be greater than 0.");
        }

        escrow.pendingRefundAmount =
          requestedAmount !== null ? refundAmount : null;
        escrow.pendingReleaseAmount = null;

        escrow.adminConfirmedRelease = false;
        escrow.buyerConfirmedRelease = false;
        escrow.sellerConfirmedRelease = false;
        await escrow.save();

        const buyerTag = escrow.buyerUsername
          ? `@${escrow.buyerUsername}`
          : `[${escrow.buyerId}]`;

        const refundType = requestedAmount !== null ? "Partial" : "Full";

        const isPartialRefund = requestedAmount !== null;
        let approvalNote =
          "⚠️ Buyer, please confirm you want to return these funds to the Seller.";
        let statusSection = `⌛️ ${buyerTag} - Waiting for confirmation...`;

        if (isAdmin) {
          approvalNote =
            "⚠️ Admin Action: Confirming this will refund funds to the Seller immediately.";
          statusSection = `⚠️ Admin initiated refund. Waiting for admin confirmation...`;
        }

        if (isPartialRefund) {
          approvalNote =
            "⚠️ Both Buyer and Seller must confirm this partial refund.";
          escrow.buyerConfirmedRefund = false;
          escrow.sellerConfirmedRefund = false;

          const sellerTag = escrow.sellerUsername
            ? `@${escrow.sellerUsername}`
            : `[Seller]`;

          const sellerLine = escrow.sellerConfirmedRefund
            ? `✅ ${sellerTag} - Confirmed`
            : `⌛️ ${sellerTag} - Waiting...`;
          const buyerLine = escrow.buyerConfirmedRefund
            ? `✅ ${buyerTag} - Confirmed`
            : `⌛️ ${buyerTag} - Waiting...`;
          statusSection = `${sellerLine}\n${buyerLine}`;
        }

        const refundCaption = `<b>Refund Confirmation (${refundType})</b>

<b>Refund Amount:</b> ${refundAmount.toFixed(5)} ${escrow.token}
<b>Available Balance:</b> ${formattedTotalDeposited.toFixed(5)} ${escrow.token}

${statusSection}

${approvalNote}`;

        const refundMsg = await ctx.replyWithPhoto(
          images.REFUND_CONFIRMATION || images.RELEASE_CONFIRMATION,
          {
            caption: refundCaption,
            parse_mode: "HTML",
            reply_markup: Markup.inlineKeyboard([
              [
                Markup.button.callback(
                  "✅ Confirm Refund",
                  `refund_confirm_yes_${escrow.escrowId}`,
                ),
                Markup.button.callback(
                  "❌ Cancel",
                  `refund_confirm_no_${escrow.escrowId}`,
                ),
              ],
            ]).reply_markup,
          },
        );

        escrow.releaseConfirmationMessageId = refundMsg.message_id;
        await escrow.save();
      } catch (error) {
        console.error("Error in refund command:", error);
        ctx.reply("❌ An error occurred.");
      }
    });

    this.bot.action(/^refund_confirm_yes_(.+)$/, async (ctx) => {
      try {
        const escrowId = ctx.match[1];
        const Escrow = require("./models/Escrow");
        const BlockchainService = require("./services/BlockchainService");
        const CompletionFeedService = require("./services/CompletionFeedService");
        const GroupPool = require("./models/GroupPool");
        const GroupPoolService = require("./services/GroupPoolService");
        const { ethers } = require("ethers");
        const config = require("../config");
        const { safeAnswerCbQuery } = require("./utils/telegramUtils");

        const escrow = await Escrow.findOne({ escrowId });
        if (!escrow) {
          return ctx.reply("❌ Escrow not found.");
        }

        const isUserAdmin = config
          .getAllAdminIds()
          .includes(String(ctx.from.id));

        // Idempotency: prevent double refund
        const callbackMessageId = ctx.callbackQuery?.message?.message_id;
        if (
          escrow.refundConfirmationMessageId &&
          callbackMessageId &&
          escrow.refundConfirmationMessageId !== callbackMessageId
        ) {
          return safeAnswerCbQuery(ctx, "❌ This request has expired.");
        }

        if (escrow.status === "refunded") {
          try {
            // Remove the buttons to prevent further clicks
            await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
            await ctx.reply("✅ Refund already processed.");
          } catch (e) {}
          return;
        }

        if (escrow.buyerId !== ctx.from.id && !isUserAdmin) {
          try {
            await ctx.answerCbQuery(
              "❌ Only the buyer or admin can confirm refund.",
            );
          } catch (e) {}
          return;
        }

        const decimals = BlockchainService.getTokenDecimals(
          escrow.token,
          escrow.chain,
        );
        const amountWeiOverride =
          escrow.accumulatedDepositAmountWei &&
          escrow.accumulatedDepositAmountWei !== "0"
            ? escrow.accumulatedDepositAmountWei
            : null;

        let refundAmount = escrow.pendingRefundAmount;
        const totalDeposited = Number(
          escrow.accumulatedDepositAmount ||
            escrow.depositAmount ||
            escrow.confirmedAmount ||
            0,
        );

        if (!refundAmount || refundAmount <= 0) {
          const amountWeiOverride =
            escrow.accumulatedDepositAmountWei &&
            escrow.accumulatedDepositAmountWei !== "0"
              ? escrow.accumulatedDepositAmountWei
              : null;
          refundAmount = amountWeiOverride
            ? Number(ethers.formatUnits(BigInt(amountWeiOverride), decimals))
            : totalDeposited;
        }

        const networkFee = escrow.networkFee;
        const amountToContract = refundAmount - networkFee;

        // Contract will deduct service fee from this amount
        const serviceFeeOnNet = (amountToContract * escrow.feeRate) / 100;
        const actualAmountToUser = amountToContract - serviceFeeOnNet;

        if (actualAmountToUser <= 0) {
          return ctx.reply(
            `❌ Refund amount too small to cover fees (Network: ${networkFee}, Service: ~${serviceFeeOnNet.toFixed(
              2,
            )} ${escrow.token}).`,
          );
        }

        await ctx.reply("🔄 Processing refund... please wait.");

        try {
          if (!escrow.sellerAddress) {
            return ctx.reply("❌ Seller address missing.");
          }

          const refundResult = await BlockchainService.refundFunds(
            escrow.token,
            escrow.chain,
            escrow.sellerAddress,
            amountToContract, // Send amount after network fee, contract deducts service fee
            null,
            escrow.groupId,
            escrow.contractAddress, // Pass explicit contract address to avoid lookup error
          );

          if (!refundResult || !refundResult.transactionHash) {
            throw new Error("Refund transaction failed (no hash).");
          }

          const isPartialRefund =
            Math.abs(totalDeposited - actualAmountToUser) > 0.00001;

          if (isPartialRefund) {
            const remaining = totalDeposited - refundAmount;
            if (remaining < 0.00001) {
              escrow.status = "refunded";
              escrow.accumulatedDepositAmount = 0;
              escrow.depositAmount = 0;
              escrow.confirmedAmount = 0;
              escrow.accumulatedDepositAmountWei = "0";
            } else {
              escrow.accumulatedDepositAmount = remaining;
              escrow.depositAmount = remaining;
              escrow.confirmedAmount = remaining;
              // Status stays 'deposited' or whatever previous state was
            }
          } else {
            escrow.status = "refunded";
            escrow.accumulatedDepositAmount = 0;
            escrow.depositAmount = 0;
            escrow.confirmedAmount = 0;
            escrow.accumulatedDepositAmountWei = "0";
          }
          await escrow.save();

          try {
            await CompletionFeedService.handleRefund({
              escrow,
              refundAmount: actualAmountToUser, // Log ACTUAL amount user receives
              transactionHash: refundResult.transactionHash,
              telegram: ctx.telegram,
            });
          } catch (e) {
            console.error("Feed error", e);
          }

          const successMsg = `✅ <b>Refund Successful!</b>
            
💸 <b>Refunded:</b> ${actualAmountToUser.toFixed(5)} ${escrow.token}
🔗 <b>TX:</b> <code>${refundResult.transactionHash}</code>

Funds returned to Seller.`;

          await ctx.reply(successMsg, { parse_mode: "HTML" });

          if (escrow.status === "refunded") {
            setTimeout(async () => {
              try {
                const group = await GroupPool.findOne({
                  assignedEscrowId: escrow.escrowId,
                });
                if (group) {
                  await GroupPoolService.removeUsersFromGroup(
                    escrow,
                    group.groupId,
                    ctx.telegram,
                  );
                  await GroupPoolService.refreshInviteLink(
                    group.groupId,
                    ctx.telegram,
                  );
                  group.status = "available";
                  group.assignedEscrowId = null;
                  await group.save();
                  await ctx.reply("♻️ Group recycled.");
                }
              } catch (e) {
                console.error("Recycle error", e);
              }
            }, 5 * 60 * 1000);
          }
        } catch (err) {
          if (!err.message.includes("Insufficient Vault Balance")) {
            console.error("Refund Execution Error:", err);
          }
          await ctx.reply(`❌ Refund Failed: ${err.message}`);
        }
      } catch (error) {
        console.error("Refund Action Error:", error);
      }
    });

    this.bot.action(/^refund_confirm_no_(.+)$/, async (ctx) => {
      try {
        const escrowId = ctx.match[1];

        const escrow = await Escrow.findOne({ escrowId });

        const callbackMessageId = ctx.callbackQuery?.message?.message_id;
        if (
          escrow &&
          escrow.refundConfirmationMessageId &&
          callbackMessageId &&
          escrow.refundConfirmationMessageId !== callbackMessageId
        ) {
          return safeAnswerCbQuery(ctx, "❌ This request has expired.");
        }

        // Remove buttons
        try {
          await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
        } catch (e) {}

        if (!escrow) {
          return safeAnswerCbQuery(ctx, "❌ Escrow not found.");
        }

        // Reset confirmations
        escrow.buyerConfirmedRefund = false;
        escrow.sellerConfirmedRefund = false;
        await escrow.save();

        await safeAnswerCbQuery(ctx, "❌ Refund cancelled.");
        await ctx.reply("❌ Refund cancelled by user.");
      } catch (error) {
        console.error("Refund Cancel Error:", error);
      }
    });

    this.bot.command("balance", async (ctx) => {
      try {
        const chatId = ctx.chat.id;

        if (chatId > 0) {
          return ctx.reply("❌ This command can only be used in a group chat.");
        }

        const escrow = await findGroupEscrow(chatId, [
          "deposited",
          "in_fiat_transfer",
          "ready_to_release",
        ]);

        if (!escrow) {
          return;
        }

        const decimals = BlockchainService.getTokenDecimals(
          escrow.token,
          escrow.chain,
        );
        const amountWeiOverride =
          escrow.accumulatedDepositAmountWei &&
          escrow.accumulatedDepositAmountWei !== "0"
            ? escrow.accumulatedDepositAmountWei
            : null;
        const totalDeposited = Number(
          escrow.accumulatedDepositAmount ||
            escrow.depositAmount ||
            escrow.confirmedAmount ||
            0,
        );
        let availableBalance = amountWeiOverride
          ? Number(ethers.formatUnits(BigInt(amountWeiOverride), decimals))
          : totalDeposited;

        if (availableBalance <= 0) {
          return ctx.reply("❌ No available balance found.");
        }

        // Validate real on-chain balance
        const bs = BlockchainService;
        let realChainBalance = availableBalance;
        let isMismatch = false;

        try {
          if (escrow.contractAddress) {
            realChainBalance = await bs.getTokenBalance(
              escrow.token,
              escrow.chain,
              escrow.contractAddress,
            );

            // Allow small buffer (0.001) for float inconsistencies
            if (realChainBalance < availableBalance - 0.001) {
              isMismatch = true;
              availableBalance = realChainBalance; // Clamp to actual
            }
          }
        } catch (e) {
          console.error("Balance check error:", e.message);
        }

        const networkName = (escrow.chain || "BSC").toUpperCase();

        if (escrow.feeRate === undefined || escrow.feeRate === null) {
          return ctx.reply(
            "❌ Critical Error: Deal fee rate is missing (0.25%, 0.5%, or 0.75% not set). Cannot calculate balance.",
          );
        }
        if (escrow.networkFee === undefined || escrow.networkFee === null) {
          return ctx.reply(
            "❌ Critical Error: Network fee is missing. Cannot calculate balance.",
          );
        }

        const escrowFeePercent = escrow.feeRate;
        const networkFee = escrow.networkFee;
        const amountSubjectToFee = Math.max(0, availableBalance - networkFee);
        const escrowFee = (amountSubjectToFee * escrowFeePercent) / 100;
        const netBalance = Math.max(
          0,
          availableBalance - escrowFee - networkFee,
        );

        const balanceMessage = `<b>💰 Balance Information</b>
${
  isMismatch
    ? "\n⚠️ <b>Warning:</b> Database mismatch detected. Showing actual vault balance.\n"
    : ""
}


<b>Gross Amount:</b> ${availableBalance.toFixed(5)} ${escrow.token}
<b>Net Release Amount:</b> ${netBalance.toFixed(5)} ${escrow.token} (After Fees)
<b>Token:</b> ${escrow.token}
<b>Network:</b> ${networkName}
<b>Fees:</b> ${escrowFeePercent}% + ${networkFee} ${escrow.token}

This is the current available balance for this trade.`;

        await ctx.reply(balanceMessage, { parse_mode: "HTML" });
      } catch (error) {
        console.error("Error in balance command:", error);
        ctx.reply("❌ An error occurred.");
      }
    });

    this.bot.command("stats", async (ctx) => {
      try {
        const chatId = ctx.chat.id;

        if (chatId > 0) {
          return ctx.reply("❌ This command can only be used in a group chat.");
        }

        const allowedGroups = config.getAllowedGroupIds();
        if (
          allowedGroups.length > 0 &&
          !allowedGroups.includes(String(chatId))
        ) {
          return ctx.reply(
            "❌ This command is only available in the official main group.",
          );
        }

        const messageText = ctx.message.text || "";
        const parts = messageText.trim().split(/\s+/);
        let targetUsername = null;
        let targetTelegramId = null;

        if (parts.length > 1 && parts[1]) {
          targetUsername = parts[1].replace(/^@/, "");
        } else {
          targetTelegramId = ctx.from.id;
        }

        let userStats = await UserStatsService.getUserStats({
          telegramId: targetTelegramId,
          username: targetUsername,
        });

        let foundTelegramIdFromEscrow = null;
        if (targetUsername) {
          const Escrow = require("./models/Escrow");
          const escrowWithUser = await Escrow.findOne({
            $or: [
              {
                buyerUsername: {
                  $regex: new RegExp(
                    `^${targetUsername.replace(
                      /[.*+?^${}()|[\]\\]/g,
                      "\\$&",
                    )}$`,
                    "i",
                  ),
                },
              },
              {
                sellerUsername: {
                  $regex: new RegExp(
                    `^${targetUsername.replace(
                      /[.*+?^${}()|[\]\\]/g,
                      "\\$&",
                    )}$`,
                    "i",
                  ),
                },
              },
            ],
          }).sort({ createdAt: -1 });

          if (escrowWithUser) {
            foundTelegramIdFromEscrow =
              escrowWithUser.buyerUsername?.toLowerCase() ===
              targetUsername.toLowerCase()
                ? escrowWithUser.buyerId
                : escrowWithUser.sellerId;
          }
        }

        if (!userStats && foundTelegramIdFromEscrow) {
          userStats = await UserStatsService.getUserStats({
            telegramId: foundTelegramIdFromEscrow,
            username: null,
          });
        }

        let finalTelegramId = null;
        if (userStats) {
          const userStatsObj = userStats.toObject
            ? userStats.toObject()
            : userStats;
          const userTelegramId =
            userStatsObj.telegramId || userStats.telegramId;
          finalTelegramId =
            userTelegramId || foundTelegramIdFromEscrow || targetTelegramId;

          if (!userTelegramId && userStats) {
            console.log("WARNING: User found but telegramId is missing!", {
              hasTelegramId: !!userStatsObj.telegramId,
              hasUserStatsTelegramId: !!userStats.telegramId,
              username: userStatsObj.username,
              foundTelegramIdFromEscrow,
            });
          }
          userStatsObj.telegramId = finalTelegramId;
          userStats = userStatsObj;
        } else {
          finalTelegramId = foundTelegramIdFromEscrow || targetTelegramId;
          userStats = {
            telegramId: finalTelegramId || null,
            username: targetUsername || null,
            totalBoughtVolume: 0,
            totalSoldVolume: 0,
            totalTradedVolume: 0,
            totalBoughtTrades: 0,
            totalSoldTrades: 0,
            totalParticipatedTrades: 0,
            totalCompletedTrades: 0,
          };
        }

        if (userStats) {
          if (
            !userStats.telegramId ||
            userStats.telegramId === null ||
            userStats.telegramId === undefined
          ) {
            if (finalTelegramId) {
              userStats.telegramId = finalTelegramId;
            }
          }
          if (userStats.telegramId) {
            userStats.telegramId = Number(userStats.telegramId);
          }
        }

        const statsMessage = UserStatsService.formatStatsMessage(userStats);
        await ctx.reply(statsMessage, { parse_mode: "HTML" });
      } catch (error) {
        console.error("Error in stats command:", error);
        ctx.reply("❌ Unable to fetch stats right now.");
      }
    });

    this.bot.command("leaderboard", async (ctx) => {
      try {
        const chatId = ctx.chat.id;

        if (chatId > 0) {
          return ctx.reply("❌ This command can only be used in a group chat.");
        }

        const allowedGroups = config.getAllowedGroupIds();
        if (
          allowedGroups.length > 0 &&
          !allowedGroups.includes(String(chatId))
        ) {
          return ctx.reply(
            "❌ This command is only available in the official main group.",
          );
        }

        const stats = await UserStatsService.getHighLevelStats();
        const message = UserStatsService.formatMainLeaderboard(stats);

        await ctx.reply(message, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "Top Buyers", callback_data: "leaderboard_buyers" },
                { text: "Top Sellers", callback_data: "leaderboard_sellers" },
              ],
            ],
          },
        });
      } catch (error) {
        console.error("Error in leaderboard command:", error);
        ctx.reply("❌ Unable to fetch leaderboard right now.");
      }
    });

    const {
      adminStats,
      adminGroupPool,
      adminPoolAdd,
      adminPoolList,
      adminPoolDeleteAll,
      adminPoolDelete,
      adminHelp,
      adminTradeStats,
      adminExportTrades,
      adminRecentTrades,
      adminAddressPool,
      adminInitAddresses,
      adminCleanupAddresses,
      adminGroupReset,
      adminResetForce,
      adminResetAllGroups,
      adminWithdrawAllBsc,
      adminWithdrawAllTron,
      setupAdminActions,
    } = adminHandler;

    this.bot.command("admin_stats", adminStats);
    this.bot.command("admin_pool", adminGroupPool);
    this.bot.command("admin_pool_add", adminPoolAdd);
    this.bot.command("admin_pool_list", adminPoolList);
    this.bot.command("admin_pool_delete_all", adminPoolDeleteAll);
    this.bot.command("admin_pool_delete", adminPoolDelete);
    this.bot.command("admin_help", adminHelp);
    this.bot.command("admin_trade_stats", adminTradeStats);
    this.bot.command("admin_export_trades", adminExportTrades);
    this.bot.command("admin_recent_trades", adminRecentTrades);
    this.bot.command("admin_address_pool", adminAddressPool);
    this.bot.command("admin_init_addresses", adminInitAddresses);
    this.bot.command("admin_cleanup_addresses", adminCleanupAddresses);
    this.bot.command("admin_group_reset", adminGroupReset);
    this.bot.command("admin_reset_force", adminResetForce);
    this.bot.command("admin_reset_all_groups", adminResetAllGroups);

    // Consolidated Withdrawal Commands
    this.bot.command("withdraw_all_bsc", adminWithdrawAllBsc);
    this.bot.command("withdraw_all_tron", adminWithdrawAllTron);

    // Setup admin actions (callbacks)
    setupAdminActions(this.bot);

    this.bot.on("callback_query", callbackHandler);
    this.bot.on("chat_join_request", joinRequestHandler);

    // Handle user leaving the group
    this.bot.on("left_chat_member", async (ctx) => {
      try {
        const chatId = String(ctx.chat.id);
        const leftMember = ctx.message.left_chat_member;

        // Ignore if bot itself left (handle elsewhere)
        if (leftMember.id === ctx.botInfo.id) return;

        // Use findGroupEscrow to locate any relevant escrow for this group
        // We only care about stages BEFORE deposit is confirmed
        const escrow = await findGroupEscrow(chatId, [
          "draft",
          "awaiting_details",
          "awaiting_deposit",
        ]);

        if (!escrow) return;

        // Check if the user who left is a party to the deal
        const isBuyer = escrow.buyerId && escrow.buyerId === leftMember.id;
        const isSeller = escrow.sellerId && escrow.sellerId === leftMember.id;

        if (isBuyer || isSeller) {
          // If a party leaves, trigger recycling logic
          if (escrow.isScheduledForRecycle) return;

          const role = isBuyer ? "Buyer" : "Seller";
          await ctx.reply(
            `⚠️ <b>Alert:</b> The ${role} has left the group.\n\nThis deal will be cancelled and the group recycled in 10 minutes if they do not return.`,
            { parse_mode: "HTML" },
          );

          escrow.recycleWarningSentAt = new Date();
          escrow.isScheduledForRecycle = true;
          await escrow.save();

          // Schedule immediate check/recycle in 10 minutes via simple timeout
          // We also have the background poller as backup
          setTimeout(async () => {
            try {
              const freshEscrow = await Escrow.findById(escrow._id);
              // conditions might have changed in 10 mins (e.g., user re-joined? or status changed?)
              // For simplicity, if status is still same and not updated recently, recycle.
              if (
                freshEscrow &&
                ["draft", "awaiting_details", "awaiting_deposit"].includes(
                  freshEscrow.status,
                )
              ) {
                await ctx.reply("⏳ Time is up. Recycling group...");
                freshEscrow.status = "cancelled";
                await freshEscrow.save();
                await GroupPoolService.recycleGroupNow(
                  freshEscrow,
                  ctx.telegram,
                );
              }
            } catch (e) {
              console.error("Error in scheduled recycle after user left:", e);
            }
          }, 10 * 60 * 1000);
        }
      } catch (e) {
        console.error("Error in left_chat_member handler:", e);
      }
    });
  }

  setupErrorHandling() {
    this.bot.catch((err, ctx) => {
      console.error("Bot error:", err);
      ctx.reply("❌ An error occurred. Please try again or contact support.");
    });
  }

  async ensureUser(telegramUser) {
    try {
      let user = await User.findOne({ telegramId: telegramUser.id });
      if (!user) {
        try {
          const fallbackUsername =
            telegramUser.username ||
            (telegramUser.first_name
              ? `${telegramUser.first_name}`
              : `user_${telegramUser.id}`);
          user = new User({
            telegramId: telegramUser.id,
            username: fallbackUsername,
            firstName: telegramUser.first_name,
            lastName: telegramUser.last_name,
            isAdmin: config
              .getAllAdminUsernames()
              .includes(telegramUser.username || fallbackUsername),
          });
          await user.save();
        } catch (duplicateError) {
          if (duplicateError.code === 11000) {
            user = await User.findOne({ telegramId: telegramUser.id });
          } else {
            throw duplicateError;
          }
        }
      } else {
        const currentUsername =
          telegramUser.username ||
          (telegramUser.first_name
            ? `${telegramUser.first_name}`
            : `user_${telegramUser.id}`);

        user.username = currentUsername;
        user.firstName = telegramUser.first_name;
        user.lastName = telegramUser.last_name;
        user.lastActive = new Date();
        await user.save();
      }
      return user;
    } catch (error) {
      console.error("Error ensuring user:", error);
    }
  }

  async start() {
    try {
      console.log("🚀 Starting Escrow Bot...");

      // Start background monitoring for inactivity
      this.setupGroupMonitoring();

      await connectDB();

      try {
        const addr = await BlockchainService.initialize();
      } catch (e) {
        console.warn(
          "⚠️ EscrowVault not found. Bot will work in limited mode. Deploy with `npm run deploy:sepolia`",
        );
      }

      await this.bot.launch();
      console.log("🤖 Escrow Bot started successfully!");

      process.once("SIGINT", () => this.bot.stop("SIGINT"));
      process.once("SIGTERM", () => this.bot.stop("SIGTERM"));
    } catch (error) {
      console.error("Failed to start bot:", error);
      process.exit(1);
    }
  }
}

const bot = new EscrowBot();
bot.start();

setTimeout(async () => {
  try {
    if (mongoose.connection.readyState !== 1) {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("MongoDB connection timeout during cleanup"));
        }, 15000);

        if (mongoose.connection.readyState === 1) {
          clearTimeout(timeout);
          resolve();
        } else {
          mongoose.connection.once("open", () => {
            clearTimeout(timeout);
            resolve();
          });
          mongoose.connection.once("error", (error) => {
            clearTimeout(timeout);
            reject(error);
          });
        }
      });
    }
  } catch (error) {
    console.error("❌ Startup cleanup error:", error);
  }
}, 5000);
