const Escrow = require("../models/Escrow");
const Counter = require("../models/Counter");
const GroupPool = require("../models/GroupPool");
const GroupPoolService = require("../services/GroupPoolService");
const config = require("../../config");
const feeConfig = require("../config/feeConfig");
const joinRequestHandler = require("./joinRequestHandler");
const findGroupEscrow = require("../utils/findGroupEscrow");
const {
  formatParticipant,
  formatParticipantByIndex,
} = require("../utils/participant");
const withRetry = require("../utils/retry");

const inviteTimeoutMap = new Map();
joinRequestHandler.setInviteTimeoutMap(inviteTimeoutMap);

module.exports = async (ctx) => {
  try {
    const chatId = ctx.chat.id;
    if (chatId > 0) {
      return ctx.reply("❌ This command can only be used inside a group.");
    }

    if (
      config.ALLOWED_MAIN_GROUP_ID &&
      String(chatId) !== String(config.ALLOWED_MAIN_GROUP_ID)
    ) {
      return ctx.reply(
        "❌ The /deal command is only available in the official main group."
      );
    }

    const tradeGroupEscrow = await findGroupEscrow(chatId, null);

    if (tradeGroupEscrow) {
      return ctx.reply(
        "❌ This command can only be used in the main group, not in trade groups."
      );
    }

    const text = ctx.message?.text || "";

    const initiatorId = ctx.from.id;
    const initiatorUsername = ctx.from.username || null;

    let counterpartyUser = null;
    let counterpartyHandle = null;

    if (ctx.message?.entities) {
      for (const entity of ctx.message.entities) {
        if (entity.type === "text_mention" && entity.user) {
          counterpartyUser = entity.user;
          break;
        }
        if (entity.type === "mention" && !counterpartyHandle) {
          const mention = text.substring(
            entity.offset,
            entity.offset + entity.length
          );
          counterpartyHandle = mention.trim();
        }
      }
    }

    if (!counterpartyUser && ctx.message?.reply_to_message?.from) {
      counterpartyUser = ctx.message.reply_to_message.from;
    }

    if (!counterpartyUser && !counterpartyHandle) {
      const parts = text.trim().split(/\s+/);
      const handleCandidate = parts[1];
      if (
        handleCandidate &&
        handleCandidate.startsWith("@") &&
        handleCandidate.length > 1
      ) {
        counterpartyHandle = handleCandidate;
      }
    }

    if (!counterpartyUser && counterpartyHandle) {
      const handle = counterpartyHandle.startsWith("@")
        ? counterpartyHandle.substring(1)
        : counterpartyHandle;

      let chatInfo = null;

      try {
        chatInfo = await ctx.telegram.getChat(`@${handle}`);
      } catch (getChatError) {
        chatInfo = null;
      }

      if (!counterpartyUser && chatId < 0) {
        try {
          const administrators = await ctx.telegram.getChatAdministrators(
            chatId
          );
          const normalizedHandle = handle.toLowerCase();

          for (const admin of administrators) {
            if (admin.user && admin.user.username) {
              const adminUsername = admin.user.username.toLowerCase();
              if (adminUsername === normalizedHandle) {
                // Found the user in group administrators
                counterpartyUser = {
                  id: Number(admin.user.id),
                  username: admin.user.username || null,
                  first_name: admin.user.first_name,
                  last_name: admin.user.last_name,
                  is_bot: admin.user.is_bot || false,
                };
                break;
              }
            }
          }
        } catch (adminError) {
          // Can't get administrators (bot might not be admin or group doesn't allow it)
          // Silently continue to other methods
        }
      }

      // Method 3: If still not found, try to find the user in our database
      // (if they've done trades before, we'll have their user ID)
      if (!counterpartyUser && (!chatInfo || chatInfo.type !== "private")) {
        try {
          const Escrow = require("../models/Escrow");
          // Search for the user in recent escrows by username
          const escrowWithUser = await Escrow.findOne({
            $or: [
              {
                buyerUsername: {
                  $regex: new RegExp(
                    `^${handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
                    "i"
                  ),
                },
              },
              {
                sellerUsername: {
                  $regex: new RegExp(
                    `^${handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
                    "i"
                  ),
                },
              },
            ],
          }).sort({ createdAt: -1 });

          if (escrowWithUser) {
            // Found the user in database, get their info
            const userId =
              escrowWithUser.buyerUsername?.toLowerCase() ===
              handle.toLowerCase()
                ? escrowWithUser.buyerId
                : escrowWithUser.sellerId;
            const userUsername =
              escrowWithUser.buyerUsername?.toLowerCase() ===
              handle.toLowerCase()
                ? escrowWithUser.buyerUsername
                : escrowWithUser.sellerUsername;

            if (userId) {
              // Try to get chat member info from the group (preferred method)
              try {
                const memberInfo = await ctx.telegram.getChatMember(
                  chatId,
                  userId
                );
                if (memberInfo && memberInfo.user) {
                  counterpartyUser = {
                    id: Number(memberInfo.user.id),
                    username: memberInfo.user.username || userUsername || null,
                    first_name: memberInfo.user.first_name,
                    last_name: memberInfo.user.last_name,
                    is_bot: memberInfo.user.is_bot || false,
                  };
                }
              } catch (memberError) {
                // User not in group or can't get member info
                // Fallback: Use database info to create user object
                // This allows the deal to proceed even if we can't verify group membership
                counterpartyUser = {
                  id: Number(userId),
                  username: userUsername || handle,
                  first_name: null,
                  last_name: null,
                  is_bot: false,
                };
              }
            }
          }
        } catch (dbError) {
          console.error("Error searching database for user:", dbError);
        }
      }

      // Method 4: If we still don't have the user, try getChat one more time
      // (usually won't work if Method 1 failed, but worth a try)
      if (!counterpartyUser && (!chatInfo || chatInfo.type !== "private")) {
        try {
          chatInfo = await ctx.telegram.getChat(`@${handle}`);
        } catch (retryError) {
          // getChat failed again - this is expected for users who haven't interacted with bot
          // Silently continue - don't log as error
          chatInfo = null;
        }
      }

      // If we got chatInfo, validate and use it
      if (!counterpartyUser && chatInfo) {
        // getChat can return different types, we need a user
        if (chatInfo.type !== "private") {
          try {
            await ctx.deleteMessage().catch(() => {});
            const errorMsg = await ctx.reply(
              "❌ Could not retrieve user info. Please tag the user directly (tap their name) or reply to their message when using /deal."
            );
            setTimeout(() => {
              ctx.telegram
                .deleteMessage(ctx.chat.id, errorMsg.message_id)
                .catch(() => {});
            }, 5000);
          } catch (e) {}
          return;
        }

        if (chatInfo.is_bot) {
          return ctx.reply("❌ You cannot start a deal with a bot.");
        }

        counterpartyUser = {
          id: Number(chatInfo.id),
          username: chatInfo.username || null,
          first_name: chatInfo.first_name,
          last_name: chatInfo.last_name,
          is_bot: chatInfo.is_bot,
        };
      }

      // Method 5: If we still don't have the user ID but have a username,
      // allow proceeding with just the username. The join request handler will
      // match them by username when they try to join.
      // This handles cases where the user is in the group but we can't get their ID yet.
      if (!counterpartyUser && handle) {
        // Create a minimal user object with just the username
        // The join request handler will match by username and update with the actual ID
        counterpartyUser = {
          id: null, // Will be set when user joins via join request
          username: handle,
          first_name: null,
          last_name: null,
          is_bot: false,
        };
      }
    }

    if (!counterpartyUser) {
      try {
        await ctx.deleteMessage().catch(() => {});
        const errorMsg = await ctx.reply(
          "❌ Please mention the counterparty (tap their name to tag) or reply to their message when using /deal so we can verify their user ID."
        );
        setTimeout(() => {
          ctx.telegram
            .deleteMessage(ctx.chat.id, errorMsg.message_id)
            .catch(() => {});
        }, 5000);
      } catch (e) {
        // Ignore errors
      }
      return;
    }

    if (counterpartyUser.is_bot) {
      return ctx.reply("❌ You cannot start a deal with a bot.");
    }

    const counterpartyId = counterpartyUser.id;
    const counterpartyUsername = counterpartyUser.username || null;

    // Check if user is trying to deal with themselves (only if we have both IDs)
    if (
      counterpartyId !== null &&
      counterpartyId !== undefined &&
      Number(counterpartyId) === Number(initiatorId)
    ) {
      return ctx.reply("❌ You cannot start a deal with yourself.");
    }

    // Check user bios for "@room" to determine fee
    let feePercent = 0.75;
    let initiatorHasTag = false;
    let counterpartyHasTag = false;

    // If config dictates 0% fee, force it and skip bio checks
    // Dynamic Fee Logic: Check user bios for "@room"
    // Removed legacy check for config.ESCROW_FEE_PERCENT === 0 to enable dynamic fees.
    try {
      // Helper function to check bio with retry logic
      const checkBio = async (userId) => {
        const maxRetries = 3;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            const chat = await ctx.telegram.getChat(userId);
            const bio = chat.bio || "";
            return bio.toLowerCase().includes("@room");
          } catch (e) {
            console.error(
              `Error checking bio for ${userId} (Attempt ${attempt}/${maxRetries}):`,
              e.message
            );
            // Don't retry if user not found (probably invalid ID or deleted account)
            if (
              e.response &&
              e.response.error_code === 400 &&
              e.response.description.includes("chat not found")
            ) {
              return false;
            }
            // Wait 1s before retry
            if (attempt < maxRetries) {
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          }
        }
        return false;
      };

      initiatorHasTag = await checkBio(initiatorId);
      counterpartyHasTag = counterpartyId
        ? await checkBio(counterpartyId)
        : false;

      // Use feeConfig to determine service fee based on bio tags
      feePercent = feeConfig.getServiceFee(initiatorHasTag, counterpartyHasTag);
    } catch (bioError) {
      console.error("Error checking bios:", bioError);
      // Fallback to default high fee (0.75) if bio check fails
    }

    // Network fee will be set based on chain selection (BSC or TRON) and bio status
    // For now, use BSC default (0.2). This will be updated when user selects chain.
    const hasBioTag = initiatorHasTag || counterpartyHasTag;
    const networkFee = feeConfig.getNetworkFee("BSC", hasBioTag);

    // Create a new managed-room escrow and assign a pool group
    // Generate sequential ID
    // Start at 10000000, so first is 10000001
    const counter = await Counter.findByIdAndUpdate(
      { _id: "escrowId" },
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    );
    const escrowId = `P2PMMX${counter.seq}`;

    // Retry logic for assigning group and generating invite link
    // This handles cases where a group in the pool is invalid (bot kicked, etc.)
    // assignGroup picks a group, but generateInviteLink might fail if bot isn't admin/member
    let assignedGroup = null;
    let inviteLink = null;
    let assignmentError = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        assignedGroup = await GroupPoolService.assignGroup(
          escrowId,
          ctx.telegram,
          feePercent // Pass required fee percent
        );

        // Always enforce join-request approval with a freshly generated link
        // If this fails (e.g. group not found/archived), it throws an error
        // causing us to catch it and retry with a new group
        inviteLink = await GroupPoolService.refreshInviteLink(
          assignedGroup.groupId,
          ctx.telegram
        );

        if (!inviteLink) {
          inviteLink = await GroupPoolService.generateInviteLink(
            assignedGroup.groupId,
            ctx.telegram,
            { creates_join_request: true }
          );
        }

        // If we got here, everything worked
        break;
      } catch (err) {
        assignmentError = err;
      }
    }

    if (!assignedGroup || !inviteLink) {
      if (
        assignmentError &&
        assignmentError.message &&
        assignmentError.message.includes("occupied currently")
      ) {
        return ctx.reply(`🚫 ${assignmentError.message}`);
      }
      return ctx.reply(
        `🚫 No functioning rooms available. Please contact support or try again later.`
      );
    }

    // Persist escrow with allowed usernames and user IDs
    // Note: assignedFromPool: true ensures this group will be recycled back to pool after completion
    const participants = [
      { id: initiatorId, username: initiatorUsername },
      { id: counterpartyId, username: counterpartyUsername },
    ];

    const newEscrow = new Escrow({
      escrowId,
      creatorId: initiatorId,
      creatorUsername: initiatorUsername,
      groupId: assignedGroup.groupId, // This is a pool group assigned from GroupPoolService
      assignedFromPool: true, // Mark as pool group for proper recycling
      status: "draft",
      inviteLink, // Join-request link from the pool group
      allowedUsernames: participants.map((p) => p.username || null),
      // Only include valid user IDs (filter out null/undefined)
      // Users without IDs will be matched by username in joinRequestHandler
      allowedUserIds: participants
        .map((p) => (p.id !== null && p.id !== undefined ? Number(p.id) : null))
        .filter((id) => id !== null),
      approvedUserIds: [], // Will be populated as users join via join-request approval
      originChatId: String(chatId),
      // Save fee details
      feeRate: feePercent,
      networkFee: networkFee,
      contractAddress: assignedGroup.contractAddress || null,
    });
    await newEscrow.save();

    // Post the room card in the current group (showing invite link from pool group)
    const images = require("../config/images");

    // Format participants with better handling for users without usernames
    const formatParticipantWithRole = (participant, role) => {
      const formatted = formatParticipant(participant, role, { html: true });
      // If user has username, add role in parentheses. If not, the Telegram link will show their name
      if (participant && participant.username) {
        return `${formatted} (${role})`;
      }
      // For users without username, just show the formatted link (Telegram will display their name)
      return formatted;
    };

    const participantsText = `<b>👥 Participants:</b>\n• ${formatParticipantWithRole(
      participants[0],
      "Initiator"
    )}\n• ${formatParticipantWithRole(participants[1], "Counterparty")}`;
    const noteText =
      "Note: Only the mentioned members can join. Never join any link shared via DM.";
    const feeText = `\n💰 <b>Fee Tier:</b> ${feePercent}%`;
    const message = `<b>🏠 Deal Room Created!</b>\n\n🔗 Join Link: ${inviteLink}\n\n${participantsText}\n${feeText}\n\n${noteText}`;
    const inviteMsg = await withRetry(() =>
      ctx.replyWithPhoto(images.DEAL_ROOM_CREATED, {
        caption: message,
        parse_mode: "HTML",
        protect_content: true,
      })
    );
    try {
      newEscrow.originInviteMessageId = inviteMsg.message_id;
      await newEscrow.save();
    } catch (_) {}

    const telegram = ctx.telegram;
    const originChatId = String(chatId);
    const inviteMessageId = inviteMsg.message_id;
    setTimeout(async () => {
      try {
        await telegram.deleteMessage(originChatId, inviteMessageId);
      } catch (_) {}
    }, 5 * 60 * 1000);
    if (ctx.message && ctx.message.message_id) {
      const commandMessageId = ctx.message.message_id;
      setTimeout(async () => {
        try {
          await telegram.deleteMessage(originChatId, commandMessageId);
        } catch (_) {}
      }, 5 * 60 * 1000);
    }
    const timeoutId = setTimeout(async () => {
      try {
        const currentEscrow = await Escrow.findOne({
          escrowId: newEscrow.escrowId,
        });
        if (!currentEscrow) {
          inviteTimeoutMap.delete(newEscrow.escrowId);
          return;
        }
        if (
          currentEscrow.status !== "draft" ||
          currentEscrow.roleSelectionMessageId
        ) {
          inviteTimeoutMap.delete(newEscrow.escrowId);
          return;
        }
        const approvedCount = (currentEscrow.approvedUserIds || []).length;
        let initiatorPresent = false;
        if (currentEscrow.creatorId) {
          try {
            const memberInfo = await telegram.getChatMember(
              String(currentEscrow.groupId),
              Number(currentEscrow.creatorId)
            );
            initiatorPresent = ["member", "administrator", "creator"].includes(
              memberInfo.status
            );
          } catch (_) {
            initiatorPresent = false;
          }
        }

        const creatorAlreadyCounted = currentEscrow.approvedUserIds?.includes(
          Number(currentEscrow.creatorId)
        );
        const totalJoined =
          approvedCount + (initiatorPresent && !creatorAlreadyCounted ? 1 : 0);

        if (totalJoined >= 2) {
          inviteTimeoutMap.delete(newEscrow.escrowId);
          return;
        }

        inviteTimeoutMap.delete(newEscrow.escrowId);

        if (currentEscrow.originChatId && currentEscrow.originInviteMessageId) {
          try {
            await telegram.deleteMessage(
              currentEscrow.originChatId,
              currentEscrow.originInviteMessageId
            );
          } catch (_) {}
        }

        const initiatorName = formatParticipantByIndex(
          currentEscrow,
          0,
          "initiator",
          { html: true }
        );
        const counterpartyName = formatParticipantByIndex(
          currentEscrow,
          1,
          "counterparty",
          { html: true }
        );
        try {
          const cancellationMsg = await withRetry(() =>
            telegram.sendMessage(
              currentEscrow.originChatId,
              `❌ Deal cancelled between ${initiatorName} and ${counterpartyName} due to inactivity. Both parties must join within 5 minutes.`,
              { parse_mode: "HTML" }
            )
          );

          setTimeout(async () => {
            try {
              await telegram.deleteMessage(
                currentEscrow.originChatId,
                cancellationMsg.message_id
              );
            } catch (_) {}
          }, 5 * 60 * 1000);
        } catch (_) {}

        let group = await GroupPool.findOne({
          assignedEscrowId: currentEscrow.escrowId,
        });

        if (!group) {
          group = await GroupPool.findOne({
            groupId: currentEscrow.groupId,
          });
        }

        if (group) {
          if (currentEscrow.waitingForUserMessageId) {
            try {
              await telegram.deleteMessage(
                String(currentEscrow.groupId),
                currentEscrow.waitingForUserMessageId
              );
            } catch (_) {}
          }

          if (currentEscrow.inviteLink) {
            currentEscrow.inviteLink = null;
            await currentEscrow.save();
          }

          try {
            await GroupPoolService.removeUsersFromGroup(
              currentEscrow,
              group.groupId,
              telegram
            );
          } catch (removeError) {
            console.log(
              "Could not remove users during timeout cancellation:",
              removeError.message
            );
          }

          try {
            await GroupPoolService.refreshInviteLink(group.groupId, telegram);
          } catch (linkError) {
            console.log(
              "Could not refresh invite link during timeout cancellation:",
              linkError.message
            );
          }

          group.status = "available";
          group.assignedEscrowId = null;
          group.assignedAt = null;
          group.completedAt = null;
          await group.save();
        } else {
          console.log(
            `Warning: Could not find group pool entry for escrow ${currentEscrow.escrowId} during timeout cancellation`
          );
        }

        // Delete the escrow
        try {
          await Escrow.deleteOne({ escrowId: currentEscrow.escrowId });
        } catch (deleteError) {
          console.log(
            "Could not delete escrow during timeout cancellation:",
            deleteError.message
          );
        }
      } catch (error) {
        console.error("Error in invite timeout handler:", error);
        inviteTimeoutMap.delete(newEscrow.escrowId);
      }
    }, 5 * 60 * 1000); // 5 minutes

    // Store timeout reference so we can cancel it if both join
    inviteTimeoutMap.set(newEscrow.escrowId, timeoutId);
  } catch (error) {
    return ctx.reply("❌ Failed to create deal room. Please try again.");
  }
};
