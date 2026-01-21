const Escrow = require("../models/Escrow");
const Contract = require("../models/Contract");
const { isValidAddress } = require("../utils/addressValidation");
const config = require("../../config");

module.exports = async (ctx) => {
  try {
    const chatId = ctx.chat.id;
    const text = ctx.message.text.trim();

    if (chatId > 0) {
      return ctx.reply("❌ This command can only be used in a group chat.");
    }

    const allowedGroups = config.getAllowedGroupIds();
    if (allowedGroups.length > 0 && !allowedGroups.includes(String(chatId))) {
      return ctx.reply(
        "❌ This command is only available in the official main group.",
      );
    }

    const tradeGroupEscrow = await Escrow.findOne({
      groupId: chatId.toString(),
    });

    if (tradeGroupEscrow) {
      return ctx.reply(
        "❌ This command can only be used in the main group, not in trade groups.",
      );
    }

    const parts = text.split(/\s+/);
    if (parts.length < 2) {
      return ctx.reply(
        "❌ Usage: /verify <address>\n\nExamples:\n• /verify 0x4dd9c84aD4201d4aDF67eE20508BF622125C515c (EVM)\n• /verify TQn9Y2khEsLMWT4K3LdL8oKbh1Z2HtZqjP (TRON)",
      );
    }

    let address = parts[1].trim();

    const urlPatterns = [
      /bscscan\.com\/address\/(0x[a-fA-F0-9]{40})/i,
      /etherscan\.io\/address\/(0x[a-fA-F0-9]{40})/i,
      /polygonscan\.com\/address\/(0x[a-fA-F0-9]{40})/i,
      /tronscan\.org\/#\/address\/(T[1-9A-HJ-NP-Za-km-z]{33})/i,
    ];

    for (const pattern of urlPatterns) {
      const match = address.match(pattern);
      if (match) {
        address = match[1];
        break;
      }
    }

    const isTRON = address.startsWith("T") && address.length === 34;
    const isEVM = address.startsWith("0x") && address.length === 42;

    if (!isEVM && !isTRON) {
      return ctx.reply(
        "❌ Invalid address format. Please provide:\n• EVM address: 0x followed by 40 hex characters\n• TRON address: T followed by 33 base58 characters",
      );
    }

    const chainType = isTRON ? "TRON" : "BSC";
    if (!isValidAddress(address, chainType)) {
      return ctx.reply(
        "❌ Invalid address format. Please provide a valid address.",
      );
    }

    const normalizedAddress = isTRON ? address : address.toLowerCase();

    const escrows = await Escrow.find({
      $or: [
        {
          depositAddress: { $regex: new RegExp(`^${normalizedAddress}$`, "i") },
        },
        {
          uniqueDepositAddress: {
            $regex: new RegExp(`^${normalizedAddress}$`, "i"),
          },
        },
      ],
    }).sort({ createdAt: -1 });

    if (!escrows || escrows.length === 0) {
      const contract = await Contract.findOne({
        address: { $regex: new RegExp(`^${normalizedAddress}$`, "i") },
        status: "deployed",
      });

      if (contract) {
        const replyMsg = await ctx.reply(
          `✅ Address verified\n\n` +
            `Token: ${contract.token}\n` +
            `Chain: ${contract.network}`,
          { parse_mode: "HTML" },
        );

        const telegram = ctx.telegram;
        const commandMsgId = ctx.message.message_id;

        setTimeout(async () => {
          try {
            await telegram.deleteMessage(chatId, commandMsgId);
          } catch (e) {}
          try {
            await telegram.deleteMessage(chatId, replyMsg.message_id);
          } catch (e) {}
        }, 5 * 60 * 1000);

        return;
      }

      const notFoundMsg = await ctx.reply(
        `⚠️ <b>WARNING: Address Not Verified</b>\n\n` +
          `❌ This address does <b>NOT</b> belong to this bot.\n\n` +
          `🚫 <b>DO NOT send funds to this address!</b>\n\n`,
        { parse_mode: "HTML" },
      );

      const telegram = ctx.telegram;
      const commandMsgId = ctx.message.message_id;

      setTimeout(async () => {
        try {
          await telegram.deleteMessage(chatId, commandMsgId);
        } catch (e) {}
        try {
          await telegram.deleteMessage(chatId, notFoundMsg.message_id);
        } catch (e) {}
      }, 5 * 60 * 1000);

      return;
    }

    const escrow = escrows[0];
    const token = escrow.token || "USDT";
    const chain = escrow.chain || "BSC";

    const replyMsg = await ctx.reply(
      `✅ Address verified\n\n` + `Token: ${token}\n` + `Chain: ${chain}`,
      { parse_mode: "HTML" },
    );

    const telegram = ctx.telegram;
    const commandMsgId = ctx.message.message_id;

    setTimeout(async () => {
      try {
        await telegram.deleteMessage(chatId, commandMsgId);
      } catch (e) {}
      try {
        await telegram.deleteMessage(chatId, replyMsg.message_id);
      } catch (e) {}
    }, 5 * 60 * 1000);
  } catch (error) {
    console.error("Error in verify handler:", error);
    ctx.reply(
      "❌ An error occurred while verifying the address. Please try again.",
    );
  }
};
