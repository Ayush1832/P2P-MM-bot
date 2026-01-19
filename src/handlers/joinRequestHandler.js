const Escrow = require("../models/Escrow");
const {
  getParticipants,
  formatParticipant,
  formatParticipantById,
} = require("../utils/participant");
const config = require("../../config");

let inviteTimeoutMap = null;

function setInviteTimeoutMap(map) {
  inviteTimeoutMap = map;
}

async function joinRequestHandler(ctx) {
  try {
    const request = ctx.update?.chat_join_request;
    if (!request) return;

    const chatId = String(request.chat.id);
    const user = request.from;
    const username = (user.username || "").toLowerCase();

    let escrow = await Escrow.findOne({
      groupId: chatId,
      status: {
        $in: [
          "draft",
          "awaiting_details",
          "awaiting_deposit",
          "deposited",
          "in_fiat_transfer",
          "ready_to_release",
          "disputed",
        ],
      },
      allowedUsernames: { $exists: true },
    });

    if (!escrow) {
      escrow = await Escrow.findOne({
        groupId: chatId,
        status: {
          $in: [
            "draft",
            "awaiting_details",
            "awaiting_deposit",
            "deposited",
            "in_fiat_transfer",
            "ready_to_release",
            "disputed",
          ],
        },
      });
    }
    const normalizedUserId = Number(user.id);
    const lowercaseUsername = (user.username || "").toLowerCase();
    const adminUsernames = (config.getAllAdminUsernames?.() || [])
      .map((name) => (typeof name === "string" ? name.toLowerCase() : null))
      .filter(Boolean);
    const adminIds = (config.getAllAdminIds?.() || []).map(String);
    const isAdminUser =
      adminIds.includes(String(normalizedUserId)) ||
      (lowercaseUsername && adminUsernames.includes(lowercaseUsername));

    if (!escrow) {
      if (isAdminUser) {
        try {
          await ctx.telegram.approveChatJoinRequest(chatId, user.id);

          // Auto-promote admin
          try {
            await ctx.telegram.promoteChatMember(chatId, user.id, {
              is_anonymous: false,
              can_manage_chat: true,
              can_delete_messages: true,
              can_manage_video_chats: true,
              can_restrict_members: true,
              can_promote_members: true,
              can_change_info: true,
              can_invite_users: true,
              can_pin_messages: true,
            });
          } catch (promoteError) {
            console.error(
              `Failed to promote admin ${user.id} in group ${chatId}:`,
              promoteError.message
            );
          }
        } catch (approveError) {
          console.error(
            `Failed to approve admin ${user.id} for group ${chatId}:`,
            approveError
          );
        }
      } else {
        try {
          await ctx.telegram.declineChatJoinRequest(chatId, user.id);
        } catch (_) {}
      }
      return;
    }

    const participants = getParticipants(escrow);
    while (participants.length < 2) {
      participants.push({ username: null, id: null });
    }

    let participantIndex = participants.findIndex(
      (p) => p.id !== null && p.id === normalizedUserId
    );

    if (participantIndex === -1 && lowercaseUsername) {
      participantIndex = participants.findIndex(
        (p) => p.username && p.username.toLowerCase() === lowercaseUsername
      );
    }

    if (
      participantIndex === -1 &&
      escrow.creatorId &&
      Number(escrow.creatorId) === normalizedUserId
    ) {
      const creatorSlotIndex = participants.findIndex(
        (p) => p.id !== null && Number(p.id) === Number(escrow.creatorId)
      );
      participantIndex = creatorSlotIndex !== -1 ? creatorSlotIndex : 0;
    }

    if (participantIndex === -1) {
      const emptySlotIndex = participants.findIndex(
        (p) => p.id === null && (p.username === null || p.username === "")
      );

      const filledSlots = participants.filter((p) => p.id !== null);
      if (emptySlotIndex !== -1 && filledSlots.length === 1) {
        participantIndex = emptySlotIndex;
      }
    }

    if (participantIndex === -1) {
      if (isAdminUser) {
        try {
          await ctx.telegram.approveChatJoinRequest(chatId, user.id);

          try {
            await ctx.telegram.promoteChatMember(chatId, user.id, {
              is_anonymous: false,
              can_manage_chat: true,
              can_delete_messages: true,
              can_manage_video_chats: true,
              can_restrict_members: true,
              can_promote_members: true,
              can_change_info: true,
              can_invite_users: true,
              can_pin_messages: true,
            });
          } catch (promoteError) {
            console.error(
              `Failed to promote admin ${user.id} in group ${chatId}:`,
              promoteError.message
            );
          }
        } catch (approveError) {
          console.error(
            `Failed to approve admin ${user.id} for group ${chatId}:`,
            approveError
          );
        }
        return;
      }
      try {
        await ctx.telegram.declineChatJoinRequest(chatId, user.id);
      } catch (_) {}
      return;
    }

    // Update stored participant info with latest identifiers
    participants[participantIndex].id = normalizedUserId;
    if (user.username) {
      participants[participantIndex].username = user.username;
    }

    const updatedIds = participants.map((p) => {
      if (p.id === null || p.id === undefined) {
        return null;
      }
      const numeric = Number(p.id);
      return Number.isFinite(numeric) ? numeric : null;
    });
    const updatedUsernames = participants.map((p) => p.username || null);

    // Prevent registering more than two distinct user IDs
    const distinctIds = new Set(updatedIds.filter((id) => id !== null));
    if (!distinctIds.has(normalizedUserId) && distinctIds.size >= 2) {
      try {
        await ctx.telegram.declineChatJoinRequest(chatId, user.id);
      } catch (_) {}
      return;
    }

    // Approve allowed user (bot must be admin with approve permissions)
    try {
      await ctx.telegram.approveChatJoinRequest(chatId, user.id);
    } catch (approveError) {
      const description =
        approveError?.response?.description ||
        approveError?.description ||
        approveError?.message ||
        "";

      // If user is already a participant, that's fine - just continue
      const descLower = description.toLowerCase();
      if (
        descLower.includes("user_already_participant") ||
        descLower.includes("user is already a member") ||
        descLower.includes("already_participant")
      ) {
        // Proceed as if approved
      } else {
        // console.error(
        //   `Failed to approve join request for user ${user.id} in group ${chatId}:`,
        //   approveError
        // );
        // Don't save approval if the API call failed (and it wasn't because they're already in)
        return;
      }
    }

    // Use atomic update to avoid race conditions
    try {
      await Escrow.findOneAndUpdate(
        { _id: escrow._id },
        {
          $set: {
            allowedUserIds: updatedIds,
            allowedUsernames: updatedUsernames,
          },
          $addToSet: {
            approvedUserIds: normalizedUserId,
          },
        },
        { new: true }
      );
    } catch (saveError) {
      // If atomic update fails, try one more time with atomic operation (handles edge cases)
      try {
        await Escrow.findOneAndUpdate(
          { _id: escrow._id },
          {
            $set: {
              allowedUserIds: updatedIds,
              allowedUsernames: updatedUsernames,
            },
            $addToSet: {
              approvedUserIds: normalizedUserId,
            },
          }
        );
      } catch (retryError) {
        // If retry also fails, silently continue - the user was already approved via Telegram API
        // The database will be updated on the next operation or when the other user joins
        console.error(
          "Error updating escrow (non-critical, user already approved):",
          retryError.message
        );
      }
    }

    // Re-fetch escrow to get latest state (important for race conditions when both users join simultaneously)
    const currentEscrow = await Escrow.findOne({ escrowId: escrow.escrowId });
    if (!currentEscrow) {
      return; // Escrow was deleted
    }
    escrow = currentEscrow; // Use fresh data

    // Check if initiator (creator) is already a member (e.g., admin was present before)
    let initiatorPresent = false;
    if (escrow.creatorId) {
      try {
        const memberInfo = await ctx.telegram.getChatMember(
          chatId,
          Number(escrow.creatorId)
        );
        initiatorPresent = ["member", "administrator", "creator"].includes(
          memberInfo.status
        );
      } catch (_) {
        initiatorPresent = false;
      }
    }

    // Compute how many of the two parties are in the room now
    // Check if both participants from allowedUserIds have joined
    const approvedUserIdsSet = new Set(
      (escrow.approvedUserIds || []).map((id) => Number(id))
    );

    // Add creator if they're present but not in approvedUserIds
    if (initiatorPresent && escrow.creatorId) {
      approvedUserIdsSet.add(Number(escrow.creatorId));
    }

    // Count how many of the allowed participants have actually joined
    const allowedUserIds = (escrow.allowedUserIds || []).map((id) =>
      Number(id)
    );
    let joinedCount = 0;
    for (const allowedId of allowedUserIds) {
      if (approvedUserIdsSet.has(allowedId)) {
        joinedCount++;
      }
    }

    // If we still don't have 2, verify by checking actual group membership
    // This handles edge cases where IDs might not match exactly or users joined differently
    if (joinedCount < 2 && allowedUserIds.length >= 2) {
      let verifiedJoinedCount = 0;
      for (const allowedId of allowedUserIds) {
        try {
          const memberInfo = await ctx.telegram.getChatMember(
            chatId,
            allowedId
          );
          if (
            ["member", "administrator", "creator"].includes(memberInfo.status)
          ) {
            verifiedJoinedCount++;
          }
        } catch (_) {
          // User not in group or error checking - skip
        }
      }
      // Use verified count if it's higher (more accurate)
      if (verifiedJoinedCount > joinedCount) {
        joinedCount = verifiedJoinedCount;
        // If verification shows both joined, ensure they're in approvedUserIds
        if (verifiedJoinedCount >= 2) {
          for (const allowedId of allowedUserIds) {
            if (!approvedUserIdsSet.has(allowedId)) {
              approvedUserIdsSet.add(allowedId);
            }
          }
          // Update escrow with any missing approved IDs using atomic update
          try {
            await Escrow.findOneAndUpdate(
              { _id: escrow._id },
              {
                $set: {
                  approvedUserIds: Array.from(approvedUserIdsSet),
                },
              }
            );
          } catch (updateError) {
            // If update fails, try one more atomic update
            try {
              await Escrow.findOneAndUpdate(
                { _id: escrow._id },
                {
                  $set: {
                    approvedUserIds: Array.from(approvedUserIdsSet),
                  },
                }
              );
            } catch (retryError) {
              // Non-critical - the IDs will be updated on next operation
              console.error(
                "Error updating approvedUserIds (non-critical):",
                retryError.message
              );
            }
          }
        }
      }
    }

    // Final check: if we have 2 allowed participants and both are in approvedUserIds, proceed
    if (allowedUserIds.length >= 2 && joinedCount < 2) {
      // One more check: count distinct approved users that match allowed participants
      const matchingApproved = allowedUserIds.filter((id) =>
        approvedUserIdsSet.has(id)
      );
      if (matchingApproved.length >= 2) {
        joinedCount = 2;
      }
    }

    if (joinedCount < 2) {
      try {
        const joinedLabel = formatParticipant(
          { username: user.username || null, id: normalizedUserId },
          "User",
          { html: true }
        );
        await ctx.telegram.sendMessage(chatId, `✅ ${joinedLabel} joined.`, {
          parse_mode: "HTML",
        });

        const joinedUserIds = new Set(escrow.approvedUserIds || []);
        const joinedUsernames = new Set();

        // Track joined user IDs
        if (initiatorPresent && escrow.creatorId) {
          joinedUserIds.add(Number(escrow.creatorId));
        }

        // Track joined usernames from approved users
        if (escrow.allowedUsernames && escrow.allowedUserIds) {
          for (let i = 0; i < escrow.allowedUserIds.length; i++) {
            if (
              joinedUserIds.has(Number(escrow.allowedUserIds[i])) &&
              escrow.allowedUsernames[i]
            ) {
              joinedUsernames.add(escrow.allowedUsernames[i].toLowerCase());
            }
          }
        }

        // Also track the current user's username
        if (user.username) {
          joinedUsernames.add(user.username.toLowerCase());
        }

        // Track initiator's username if they're present
        if (
          initiatorPresent &&
          escrow.creatorId &&
          escrow.allowedUsernames &&
          escrow.allowedUserIds
        ) {
          const initiatorIndex = escrow.allowedUserIds.findIndex(
            (id) => Number(id) === Number(escrow.creatorId)
          );
          if (initiatorIndex >= 0 && escrow.allowedUsernames[initiatorIndex]) {
            joinedUsernames.add(
              escrow.allowedUsernames[initiatorIndex].toLowerCase()
            );
          }
        }

        let waitingParticipant = null;
        for (const participant of participants) {
          if (!participant) continue;

          let isJoined = false;

          // Check by ID if available
          if (participant.id !== null && participant.id !== undefined) {
            isJoined = joinedUserIds.has(Number(participant.id));
          }

          // If not joined by ID, check by username
          if (!isJoined && participant.username) {
            isJoined = joinedUsernames.has(participant.username.toLowerCase());
          }

          // If still not joined, this is the waiting participant
          if (!isJoined) {
            waitingParticipant = participant;
            break;
          }
        }

        // Delete any existing waiting message
        if (escrow.waitingForUserMessageId) {
          try {
            await ctx.telegram.deleteMessage(
              chatId,
              escrow.waitingForUserMessageId
            );
          } catch (_) {}
        }

        // Send waiting message - always send if we haven't reached 2 participants
        // Try to identify the waiting participant, otherwise use a generic message
        if (waitingParticipant) {
          const waitingLabel = formatParticipant(
            waitingParticipant,
            "the other participant",
            { html: true }
          );
          const waitingMsg = await ctx.telegram.sendMessage(
            chatId,
            `⏳ Waiting for ${waitingLabel} to join...`,
            { parse_mode: "HTML" }
          );
          // Use atomic update to set waiting message ID
          try {
            await Escrow.findOneAndUpdate(
              { _id: escrow._id },
              { $set: { waitingForUserMessageId: waitingMsg.message_id } }
            );
          } catch (updateError) {
            // If update fails, try one more atomic update
            try {
              await Escrow.findOneAndUpdate(
                { _id: escrow._id },
                { $set: { waitingForUserMessageId: waitingMsg.message_id } }
              );
            } catch (retryError) {
              // Non-critical - message ID will be set on next operation
              console.error(
                "Error setting waitingForUserMessageId (non-critical):",
                retryError.message
              );
            }
          }
        } else {
          // Fallback: If we can't identify the waiting participant, still send a generic message
          // This can happen if participant data is incomplete
          const waitingMsg = await ctx.telegram.sendMessage(
            chatId,
            `⏳ Waiting for the other participant to join...`,
            { parse_mode: "HTML" }
          );
          // Use atomic update to set waiting message ID
          try {
            await Escrow.findOneAndUpdate(
              { _id: escrow._id },
              { $set: { waitingForUserMessageId: waitingMsg.message_id } }
            );
          } catch (updateError) {
            // If update fails, try one more atomic update
            try {
              await Escrow.findOneAndUpdate(
                { _id: escrow._id },
                { $set: { waitingForUserMessageId: waitingMsg.message_id } }
              );
            } catch (retryError) {
              // Non-critical - message ID will be set on next operation
              console.error(
                "Error setting waitingForUserMessageId (non-critical):",
                retryError.message
              );
            }
          }
        }

        // Set timeout to reset group if second user doesn't join within 5 minutes
        // Only set timeout if this is the first user (joinedCount === 1)
        if (joinedCount === 1 && inviteTimeoutMap) {
          // Capture telegram instance for use in timeout callback
          const telegram = ctx.telegram;
          const escrowId = escrow.escrowId;

          // Clear any existing timeout for this escrow
          if (inviteTimeoutMap.has(escrowId)) {
            clearTimeout(inviteTimeoutMap.get(escrowId));
          }

          // Set new timeout starting from now (5 minutes from first user join)
          const timeoutId = setTimeout(async () => {
            try {
              // Re-fetch escrow to get latest state
              const currentEscrow = await Escrow.findOne({ escrowId });
              if (!currentEscrow) {
                inviteTimeoutMap.delete(escrowId);
                return;
              }

              // Check if both parties have joined (trade started)
              if (
                currentEscrow.roleSelectionMessageId ||
                currentEscrow.status !== "draft"
              ) {
                // Trade has progressed, cancel timeout
                inviteTimeoutMap.delete(escrowId);
                return;
              }

              // Check if both parties have joined
              const currentApprovedCount = (currentEscrow.approvedUserIds || [])
                .length;
              let currentInitiatorPresent = false;
              if (currentEscrow.creatorId) {
                try {
                  const memberInfo = await telegram.getChatMember(
                    String(currentEscrow.groupId),
                    Number(currentEscrow.creatorId)
                  );
                  currentInitiatorPresent = [
                    "member",
                    "administrator",
                    "creator",
                  ].includes(memberInfo.status);
                } catch (_) {
                  currentInitiatorPresent = false;
                }
              }

              const currentCreatorAlreadyCounted =
                currentEscrow.approvedUserIds?.includes(
                  Number(currentEscrow.creatorId)
                );
              const currentTotalJoined =
                currentApprovedCount +
                (currentInitiatorPresent && !currentCreatorAlreadyCounted
                  ? 1
                  : 0);

              if (currentTotalJoined >= 2) {
                // Both joined, cancel timeout
                inviteTimeoutMap.delete(escrowId);
                return;
              }

              // Timeout expired - reset the group
              inviteTimeoutMap.delete(escrowId);

              // Get the group
              const GroupPool = require("../models/GroupPool");
              const GroupPoolService = require("../services/GroupPoolService");
              let group = await GroupPool.findOne({
                assignedEscrowId: escrowId,
              });
              if (!group) {
                group = await GroupPool.findOne({
                  groupId: currentEscrow.groupId,
                });
              }

              if (group) {
                // Delete waiting message
                if (currentEscrow.waitingForUserMessageId) {
                  try {
                    await telegram.deleteMessage(
                      String(currentEscrow.groupId),
                      currentEscrow.waitingForUserMessageId
                    );
                  } catch (_) {}
                }

                // Remove the user who joined
                try {
                  await GroupPoolService.removeUsersFromGroup(
                    currentEscrow,
                    group.groupId,
                    telegram
                  );
                } catch (removeError) {
                  console.error(
                    "Error removing users during timeout:",
                    removeError
                  );
                }

                // Refresh invite link
                try {
                  await GroupPoolService.refreshInviteLink(
                    group.groupId,
                    telegram
                  );
                } catch (linkError) {
                  console.error(
                    "Error refreshing invite link during timeout:",
                    linkError
                  );
                }

                // Reset group
                group.status = "available";
                group.assignedEscrowId = null;
                group.assignedAt = null;
                group.completedAt = null;
                await group.save();

                // Send message to group that deal was cancelled
                try {
                  await telegram.sendMessage(
                    String(currentEscrow.groupId),
                    "❌ Deal cancelled: The other participant did not join within 5 minutes. The group has been reset.",
                    { parse_mode: "HTML" }
                  );
                } catch (msgError) {
                  console.error(
                    "Error sending cancellation message to group:",
                    msgError
                  );
                }
              }

              // Delete the escrow
              try {
                await Escrow.deleteOne({ escrowId });
              } catch (deleteError) {
                console.error(
                  "Error deleting escrow during timeout:",
                  deleteError
                );
              }
            } catch (error) {
              console.error("Error in join timeout handler:", error);
              if (inviteTimeoutMap) {
                inviteTimeoutMap.delete(escrowId);
              }
            }
          }, 5 * 60 * 1000); // 5 minutes from first user join

          inviteTimeoutMap.set(escrowId, timeoutId);
        }
      } catch (msgError) {
        // User might not have joined yet, or bot can't send message
        console.error("Failed to send join progress message:", msgError);
      }
      return;
    }

    // Both approved → clean up origin invite and send started notice, then disclaimer + role selection
    // Re-fetch escrow to get latest state (prevent race conditions when both users join simultaneously)
    const freshEscrow = await Escrow.findOne({ escrowId: escrow.escrowId });
    if (!freshEscrow) {
      return; // Escrow was deleted, nothing to do
    }

    // Avoid sending twice
    if (freshEscrow.roleSelectionMessageId) {
      return;
    }

    // Use fresh escrow for the rest of the flow
    escrow = freshEscrow;

    // Mark the actual trade start time now that both parties are present
    try {
      await Escrow.findOneAndUpdate(
        { _id: escrow._id },
        { $set: { tradeStartTime: new Date() } }
      );
    } catch (err) {
      // If update fails, try one more atomic update
      try {
        await Escrow.findOneAndUpdate(
          { _id: escrow._id },
          { $set: { tradeStartTime: new Date() } }
        );
      } catch (retryError) {
        // Non-critical - will be set on next operation
        console.error(
          "Failed to set trade start time (non-critical):",
          retryError.message
        );
      }
    }

    // Send message that second user joined
    try {
      const joinedLabel = formatParticipant(
        { username: user.username || null, id: normalizedUserId },
        "User",
        { html: true }
      );
      await ctx.telegram.sendMessage(chatId, `✅ ${joinedLabel} joined.`, {
        parse_mode: "HTML",
      });
    } catch (msgError) {
      console.error("Failed to send join progress message:", msgError);
    }

    // Delete the waiting message if it exists
    if (escrow.waitingForUserMessageId) {
      try {
        await ctx.telegram.deleteMessage(
          chatId,
          escrow.waitingForUserMessageId
        );
        // Use atomic update to clear waiting message ID
        try {
          await Escrow.findOneAndUpdate(
            { _id: escrow._id },
            { $unset: { waitingForUserMessageId: "" } }
          );
        } catch (updateError) {
          // If update fails, try one more atomic update
          try {
            await Escrow.findOneAndUpdate(
              { _id: escrow._id },
              { $unset: { waitingForUserMessageId: "" } }
            );
          } catch (retryError) {
            // Non-critical - will be cleared on next operation
            console.error(
              "Error clearing waitingForUserMessageId (non-critical):",
              retryError.message
            );
          }
        }
      } catch (_) {
        // Message may already be deleted, ignore
      }
    }

    // Cancel the 5-minute timeout since both parties have joined
    if (inviteTimeoutMap && inviteTimeoutMap.has(escrow.escrowId)) {
      const timeoutId = inviteTimeoutMap.get(escrow.escrowId);
      clearTimeout(timeoutId);
      inviteTimeoutMap.delete(escrow.escrowId);
    }

    // If we posted an invite in the origin chat, delete it and post a started message
    if (escrow.originChatId && escrow.originInviteMessageId) {
      try {
        await ctx.telegram.deleteMessage(
          escrow.originChatId,
          escrow.originInviteMessageId
        );
      } catch (_) {}
      try {
        const telegram = ctx.telegram;
        const originChatId = escrow.originChatId;
        const initiatorLabel = formatParticipantById(
          escrow,
          escrow.allowedUserIds?.[0],
          "buyer",
          { html: true }
        );
        const counterpartyLabel = formatParticipantById(
          escrow,
          escrow.allowedUserIds?.[1],
          "seller",
          { html: true }
        );
        const startedMsg = await safeSendMessage(
          telegram,
          originChatId,
          `✅ Trade started between ${initiatorLabel} and ${counterpartyLabel}.`,
          { parse_mode: "HTML" }
        );
        // Store message ID for later editing (don't delete - will be updated with completion details)
        // Use atomic update to avoid race conditions
        try {
          await Escrow.findOneAndUpdate(
            { _id: escrow._id },
            { $set: { tradeStartedMessageId: startedMsg.message_id } }
          );
        } catch (updateError) {
          // If update fails, try one more atomic update
          try {
            await Escrow.findOneAndUpdate(
              { _id: escrow._id },
              { $set: { tradeStartedMessageId: startedMsg.message_id } }
            );
          } catch (retryError) {
            // Non-critical - will be set on next operation
            console.error(
              "Error setting tradeStartedMessageId (non-critical):",
              retryError.message
            );
          }
        }
      } catch (e) {
        console.error("Error sending trade started message:", e);
      }
    }
    const disclaimer = `⚠️ P2P Deal Disclaimer ⚠️

• Always verify the **admin wallet** before sending any funds.
• Confirm \`@pool\` is present in both the deal room & the main group.
• ❌ Never engage in direct or outside-room deals.
• 💬 Share all details only within this deal room.`;

    // Build initial status with waiting indicators
    const statusLines = getParticipants(escrow).map((participant, index) => {
      const label = formatParticipant(
        participant,
        index === 0 ? "Participant 1" : "Participant 2",
        { html: true }
      );
      return `⏳ ${label} - Waiting...`;
    });

    try {
      const images = require("../config/images");
      await ctx.telegram.sendPhoto(chatId, images.DEAL_DISCLAIMER, {
        caption: disclaimer,
        parse_mode: "Markdown",
      });

      // Role selection disclaimer
      const roleDisclaimer = `<b>📋 Step 1 - Select Roles</b>

<b>⚠️ Choose roles accordingly</b>

<b>As release & refund happen according to roles</b>

<b>Refund goes to seller & release to buyer</b>

`;

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
      // Store message ID for later editing
      // Use atomic update to avoid race conditions
      try {
        await Escrow.findOneAndUpdate(
          { _id: escrow._id },
          { $set: { roleSelectionMessageId: roleSelectionMsg.message_id } }
        );
      } catch (updateError) {
        // If update fails, try one more atomic update
        try {
          await Escrow.findOneAndUpdate(
            { _id: escrow._id },
            { $set: { roleSelectionMessageId: roleSelectionMsg.message_id } }
          );
        } catch (retryError) {
          // Non-critical - will be set on next operation
          console.error(
            "Error setting roleSelectionMessageId (non-critical):",
            retryError.message
          );
        }
      }
    } catch (msgError) {
      console.error("Failed to send disclaimer/role selection:", msgError);
      // Non-critical - users can still proceed
    }
    // Helper for safe message sending (handles 429 rate limits)
    async function safeSendMessage(telegram, chatId, text, extra = {}) {
      try {
        return await telegram.sendMessage(chatId, text, extra);
      } catch (error) {
        if (
          error.code === 429 ||
          (error.description && error.description.includes("Too Many Requests"))
        ) {
          const retryAfter = error.parameters?.retry_after || 5;
          if (retryAfter < 30) {
            // Wait and retry once
            await new Promise((resolve) =>
              setTimeout(resolve, retryAfter * 1000 + 1000)
            );
            try {
              return await telegram.sendMessage(chatId, text, extra);
            } catch (retryErr) {
              console.error(
                `Rate limit retry failed (send): ${retryErr.message}`
              );
              throw retryErr; // Propagate so caller knows it failed
            }
          }
        }
        console.error(`Send Msg Error: ${error.message}`);
        throw error;
      }
    }
  } catch (error) {
    console.error("joinRequestHandler error:", error.message); // Shortened log
    // Silently ignore to avoid spamming
  }
}

// Export both the handler and the setter function
module.exports = joinRequestHandler;
module.exports.setInviteTimeoutMap = setInviteTimeoutMap;
