const config = require("../../config");
const GroupPool = require("../models/GroupPool");
const GroupPoolService = require("./GroupPoolService");
const {
  formatParticipantByIndex,
  formatParticipantById,
} = require("../utils/participant");

function escapeHtml(text = "") {
  if (typeof text !== "string") {
    text = String(text);
  }
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

class DisputeService {
  /**
   * Send dispute notification to the dispute channel
   * @param {Object} escrow - The escrow document
   * @param {String} reason - The reason for the dispute
   * @param {Number} reportedByUserId - The user ID who reported the dispute
   * @param {Object} telegram - Telegram bot instance
   */
  static async sendDisputeNotification(
    escrow,
    reason,
    reportedByUserId,
    telegram
  ) {
    try {
      if (!config.DISPUTE_CHANNEL_ID) {
        console.error(
          "DISPUTE_CHANNEL_ID not configured. Cannot send dispute notification."
        );
        return { success: false, error: "Dispute channel not configured" };
      }

      const group = await GroupPool.findOne({
        $or: [
          { assignedEscrowId: escrow.escrowId },
          { groupId: escrow.groupId },
        ],
      });

      const groupTitle = escapeHtml(group?.groupTitle || "Unknown");

      let inviteLink = null;
      if (group && telegram) {
        try {
          inviteLink = await GroupPoolService.generateInviteLink(
            group.groupId,
            telegram,
            {
              creates_join_request: true,
            }
          );
        } catch (linkError) {
          console.error("Error generating invite link for dispute:", linkError);
          try {
            inviteLink = await GroupPoolService.refreshInviteLink(
              group.groupId,
              telegram
            );
          } catch (refreshError) {
            console.error(
              "Error refreshing invite link for dispute:",
              refreshError
            );
            const freshGroup = await GroupPool.findOne({
              groupId: group.groupId,
            });
            inviteLink = freshGroup?.inviteLink || group?.inviteLink || null;
          }
        }
      } else if (group) {
        const freshGroup = await GroupPool.findOne({ groupId: group.groupId });
        inviteLink = freshGroup?.inviteLink || group?.inviteLink || null;
      } else {
        inviteLink = null;
      }

      const inviteLinkDisplay = inviteLink
        ? escapeHtml(inviteLink)
        : "No invite link available";
      const inviteLinkHref = inviteLink ? escapeHtml(inviteLink) : null;

      const buyerParticipant = escrow.buyerId
        ? { id: escrow.buyerId, username: escrow.buyerUsername }
        : null;
      const sellerParticipant = escrow.sellerId
        ? { id: escrow.sellerId, username: escrow.sellerUsername }
        : null;

      const buyerText = buyerParticipant
        ? formatParticipantById(escrow, escrow.buyerId, "Buyer", {
            html: true,
            mask: false,
          })
        : "Not set";
      const sellerText = sellerParticipant
        ? formatParticipantById(escrow, escrow.sellerId, "Seller", {
            html: true,
            mask: false,
          })
        : "Not set";

      let reporterText = "Unknown";
      if (
        escrow.buyerId != null &&
        Number(escrow.buyerId) === Number(reportedByUserId)
      ) {
        reporterText = "Buyer";
      } else if (
        escrow.sellerId != null &&
        Number(escrow.sellerId) === Number(reportedByUserId)
      ) {
        reporterText = "Seller";
      } else {
        const adminIds = config.getAllAdminIds();
        if (adminIds.includes(String(reportedByUserId))) {
          reporterText = "Admin";
        }
      }

      const escapedReason = escapeHtml(reason || "No reason provided");

      const disputeMessage = `🚨 <b>NEW DISPUTE REPORTED</b>

📋 <b>Escrow ID:</b> <code>${escapeHtml(escrow.escrowId || "Unknown")}</code>
👤 <b>Reported By:</b> ${escapeHtml(reporterText)}

👥 <b>Participants:</b>
⚡️ Buyer: ${buyerText}
⚡️ Seller: ${sellerText}

📝 <b>Reason:</b>
${escapedReason}

🏷️ <b>Group Title:</b> ${groupTitle}
🔗 <b>Invite Link:</b> ${
        inviteLinkHref
          ? `<a href="${inviteLinkHref}">${inviteLinkDisplay}</a>`
          : inviteLinkDisplay
      }

💰 <b>Trade Details:</b>
• Amount: ${escapeHtml(String(escrow.quantity))} ${escapeHtml(
        escrow.token || "USDT"
      )}
• Network: ${escapeHtml(escrow.chain || "BSC")}
• Status: ${escapeHtml(escrow.status || "Unknown")}

⏰ <b>Reported At:</b> ${escapeHtml(
        new Date().toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata",
          dateStyle: "short",
          timeStyle: "medium",
        })
      )}`;

      await telegram.sendMessage(config.DISPUTE_CHANNEL_ID, disputeMessage, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });

      return { success: true };
    } catch (error) {
      console.error("Error sending dispute notification:", error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = DisputeService;
