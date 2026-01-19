const Escrow = require("../models/Escrow");
const DisputeService = require("../services/DisputeService");
const config = require("../../config");
const findGroupEscrow = require("../utils/findGroupEscrow");

module.exports = async (ctx) => {
  try {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;

    if (chatId > 0) {
      return ctx.reply("❌ This command can only be used in a trade group.");
    }

    // Only allow dispute for valid post-deposit states
    // Draft/Awaiting Deposit are pre-risk, so no dispute needed yet
    let escrow = await findGroupEscrow(chatId, [
      "deposited",
      "in_fiat_transfer",
      "ready_to_release",
      "disputed",
    ]);

    if (!escrow) {
      return ctx.reply(
        "❌ Dispute command is only available after the deposit has been confirmed by the bot."
      );
    }

    const isAdmin =
      config.getAllAdminUsernames().includes(ctx.from.username) ||
      config.getAllAdminIds().includes(String(userId));

    const isBuyer =
      escrow.buyerId != null && Number(escrow.buyerId) === Number(userId);
    const isSeller =
      escrow.sellerId != null && Number(escrow.sellerId) === Number(userId);

    if (!isAdmin && !isBuyer && !isSeller) {
      return ctx.reply(
        "❌ Only the buyer, seller, or admin can report a dispute."
      );
    }

    const commandText = ctx.message.text.trim();
    const parts = commandText.split(/\s+/);
    const reason = parts.slice(1).join(" ").trim();

    if (!reason) {
      return ctx.reply(
        "❌ Please provide a reason for the dispute.\n\n" +
          "Usage: <code>/dispute &lt;reason&gt;</code>\n\n" +
          "Example: <code>/dispute Payment not received from buyer</code>",
        { parse_mode: "HTML" }
      );
    }

    try {
      const updatedEscrow = await Escrow.findOneAndUpdate(
        { _id: escrow._id },
        { $set: { status: "disputed" } },
        { new: true }
      );

      if (!updatedEscrow) {
        throw new Error("Failed to update escrow status");
      }

      escrow = updatedEscrow;
    } catch (saveError) {
      console.error("Error updating escrow status to disputed:", saveError);
      return ctx.reply(
        "❌ Failed to update escrow status. Please try again or contact an admin."
      );
    }

    const result = await DisputeService.sendDisputeNotification(
      escrow,
      reason,
      userId,
      ctx.telegram
    );

    if (result.success) {
      const escapeHtml = (text) =>
        String(text || "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      await ctx.reply(
        "✅ <b>Dispute reported successfully!</b>\n\n" +
          "An admin will review your dispute and join this group to resolve the issue.\n\n" +
          "<b>Reason:</b> " +
          escapeHtml(reason),
        { parse_mode: "HTML" }
      );
    } else {
      console.error(
        "Dispute notification failed but status updated:",
        result.error
      );
      const escapeHtml = (text) =>
        String(text || "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      await ctx.reply(
        "⚠️ <b>Dispute status updated, but notification failed.</b>\n\n" +
          "Your dispute has been recorded. Please contact an admin directly.\n\n" +
          "<b>Reason:</b> " +
          escapeHtml(reason) +
          "\n\n" +
          "<b>Error:</b> " +
          escapeHtml(result.error || "Unknown error"),
        { parse_mode: "HTML" }
      );
    }
  } catch (error) {
    console.error("Error in dispute handler:", error);
    ctx.reply(
      "❌ An error occurred while reporting the dispute. Please try again or contact an admin."
    );
  }
};
