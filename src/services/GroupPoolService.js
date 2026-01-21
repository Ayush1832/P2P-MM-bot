const GroupPool = require("../models/GroupPool");
const config = require("../../config");

class GroupPoolService {
  /**
   * Assign an available group to an escrow
   */
  async assignGroup(escrowId, telegram = null, requiredFeePercent = null) {
    try {
      const query = { status: "available" };

      // Filter groups based on system mode (Legacy vs Tiered)
      if (config.ESCROW_FEE_PERCENT === 0) {
        // Legacy Mode: Room 4-23
        query.groupTitle = /^Room ([4-9]|1[0-9]|2[0-3])$/;
      } else {
        // Tiered Mode: Room 24+ (24-99, 100+)
        query.groupTitle = /^Room (2[4-9]|[3-9][0-9]|[1-9][0-9]{2,})$/;
      }

      // CRITICAL: Filter by required fee percent to match bio-based assignment
      if (typeof requiredFeePercent === "number") {
        query.feePercent = requiredFeePercent;
      } else {
        // If no fee specified, exclude 0% groups (disabled groups)
        query.feePercent = { $ne: 0 };
      }

      const updateData = {
        status: "assigned",
        assignedEscrowId: escrowId,
        assignedAt: new Date(),
      };

      // Fee percent is now set in query, not in updateData

      const updatedGroup = await GroupPool.findOneAndUpdate(
        query,
        {
          $set: updateData,
        },
        { new: true, sort: { createdAt: 1 } },
      );

      if (!updatedGroup) {
        // Check if there are any groups at all in the pool
        const checkQuery = {};
        if (config.ESCROW_FEE_PERCENT === 0) {
          checkQuery.groupTitle = { $regex: /^Room ([4-9]|1[0-9]|2[0-3])$/ };
        } else {
          checkQuery.groupTitle = {
            $regex: /^Room (2[4-9]|[3-9][0-9]|[1-9][0-9]{2,})$/,
          };
        }
        const anyGroup = await GroupPool.findOne(checkQuery);
        if (!anyGroup) {
          throw new Error("No groups in pool. Please add a group.");
        }

        // Removed specific fee error since we don't filter by fee anymore

        throw new Error(
          "No available groups in pool. All groups are currently occupied.",
        );
      }

      if (telegram) {
        await this.ensureAdminInGroup(updatedGroup.groupId, telegram);
      }

      return updatedGroup;
    } catch (error) {
      if (
        !error.message ||
        (!error.message.includes("No available groups") &&
          !error.message.includes("All groups are currently occupied"))
      ) {
        console.error("Error assigning group:", error);
      }
      throw error;
    }
  }

  /**
   * Generate invite link for assigned group
   */
  async generateInviteLink(groupId, telegram, options = {}) {
    try {
      if (!telegram) {
        throw new Error(
          "Telegram API instance is required for generating invite links",
        );
      }

      const group = await GroupPool.findOne({ groupId });
      if (!group) {
        throw new Error("Group not found in pool");
      }

      const chatId = String(groupId);

      if (options.forceRefresh && group.inviteLink) {
        try {
          await telegram.revokeChatInviteLink(chatId, group.inviteLink);
        } catch (revokeError) {}
        group.inviteLink = null;
        group.inviteLinkHasJoinRequest = false;
        await group.save();
      }

      if (options.creates_join_request === true) {
        if (
          group.inviteLink &&
          group.inviteLinkHasJoinRequest &&
          !options.forceRefresh
        ) {
          try {
            await telegram.getChat(chatId);
            return group.inviteLink;
          } catch (verifyError) {
            console.log(
              `Chat verification failed for ${groupId}: ${verifyError.message}`,
            );
            try {
              if (group.inviteLink) {
                await telegram.revokeChatInviteLink(chatId, group.inviteLink);
              }
            } catch (revokeError) {}
            group.inviteLink = null;
            group.inviteLinkHasJoinRequest = false;
            await group.save();
          }
        } else if (group.inviteLink) {
          try {
            await telegram.revokeChatInviteLink(chatId, group.inviteLink);
          } catch (revokeError) {}
          group.inviteLink = null;
          group.inviteLinkHasJoinRequest = false;
          await group.save();
        }
      } else {
        try {
          const primaryLink = await telegram.exportChatInviteLink(chatId);
          if (primaryLink) {
            group.inviteLink = primaryLink;
            await group.save();
            return primaryLink;
          }
        } catch (exportError) {}

        if (group.inviteLink) {
          try {
            await telegram.getChat(chatId);
            return group.inviteLink;
          } catch (verifyError) {
            group.inviteLink = null;
            await group.save();
          }
        }
      }

      let inviteLinkData;
      try {
        const params = {};
        if (options.creates_join_request === true) {
          params.creates_join_request = true;
        } else {
          params.member_limit = options.member_limit ?? 2;
        }
        if (typeof options.expire_date === "number") {
          params.expire_date = options.expire_date;
        }
        inviteLinkData = await telegram.createChatInviteLink(chatId, params);
      } catch (chatError) {
        const migrateId =
          chatError?.on?.payload?.chat_id === chatId &&
          chatError?.response?.parameters?.migrate_to_chat_id
            ? String(chatError.response.parameters.migrate_to_chat_id)
            : null;

        if (migrateId) {
          group.groupId = migrateId;
          await group.save();
          try {
            const retryParams = {};
            if (options.creates_join_request === true) {
              retryParams.creates_join_request = true;
            } else {
              retryParams.member_limit = options.member_limit ?? 2;
            }
            if (typeof options.expire_date === "number") {
              retryParams.expire_date = options.expire_date;
            }
            inviteLinkData = await telegram.createChatInviteLink(
              migrateId,
              retryParams,
            );
          } catch (retryErr) {
            console.error(
              "Error generating invite link after migration retry:",
              retryErr,
            );
            throw retryErr;
          }
        } else if (
          chatError.message.includes("chat not found") ||
          chatError.message.includes("not found")
        ) {
          // User requested NOT to archive groups automatically.
          console.warn(`⚠️ Group ${groupId} is invalid (${chatError.message})`);
          // group.status = "archived";
          // await group.save();
          throw new Error(`Group ${groupId} not found/invalid.`);
        }
        throw chatError;
      }
      group.inviteLink = inviteLinkData.invite_link;
      group.inviteLinkHasJoinRequest = options.creates_join_request === true;
      await group.save();

      return inviteLinkData.invite_link;
    } catch (error) {
      console.error("Error generating invite link:", error);
      throw error;
    }
  }

  /**
   * Release group back to pool after escrow completion
   */
  async releaseGroup(escrowId) {
    try {
      const group = await GroupPool.findOne({
        assignedEscrowId: escrowId,
      });

      if (!group) {
        return null;
      }

      group.status = "completed";
      group.completedAt = new Date();
      group.assignedEscrowId = null;
      group.assignedAt = null;
      group.feePercent = null;
      await group.save();

      return group;
    } catch (error) {
      console.error("Error releasing group:", error);
      throw error;
    }
  }

  /**
   * Reset completed groups back to available (for pool maintenance)
   */
  async resetCompletedGroups() {
    try {
      const result = await GroupPool.updateMany(
        { status: "completed" },
        {
          status: "available",
          assignedEscrowId: null,
          assignedAt: null,
          completedAt: null,
          inviteLink: null,
        },
      );

      return result.modifiedCount;
    } catch (error) {
      console.error("Error resetting completed groups:", error);
      throw error;
    }
  }

  /**
   * Archive a group (for maintenance)
   */
  async archiveGroup(groupId) {
    try {
      const group = await GroupPool.findOne({ groupId });
      if (!group) {
        throw new Error("Group not found");
      }

      group.status = "archived";
      await group.save();

      return group;
    } catch (error) {
      console.error("Error archiving group:", error);
      throw error;
    }
  }

  /**
   * Add a new group to the pool
   * Note: ADMIN_USER_ID2 should already be in the group before adding to pool
   * The admin will never be removed during group recycling
   */
  async addGroup(groupId, groupTitle = null, telegram = null) {
    try {
      const existingGroup = await GroupPool.findOne({ groupId });
      if (existingGroup) {
        // Update title if provided and missing/changed
        if (groupTitle && existingGroup.groupTitle !== groupTitle) {
          existingGroup.groupTitle = groupTitle;
          await existingGroup.save();
        }

        if (telegram) {
          await this.ensureAdminInGroup(groupId, telegram);

          if (!existingGroup.inviteLink) {
            try {
              await this.generateInviteLink(groupId, telegram, {
                creates_join_request: true,
              });
              const refreshed = await GroupPool.findOne({ groupId });
              if (refreshed) {
                return refreshed;
              }
            } catch (linkError) {}
          }
        }
        return existingGroup;
      }

      const group = new GroupPool({
        groupId,
        groupTitle,
        status: "available",
      });

      await group.save();

      if (telegram) {
        await this.ensureAdminInGroup(groupId, telegram);
        await this.checkGroupHistoryVisibility(groupId, telegram);

        try {
          await this.generateInviteLink(groupId, telegram, {
            creates_join_request: true,
          });
          const refreshed = await GroupPool.findOne({ groupId });
          if (refreshed) {
            return refreshed;
          }
        } catch (linkError) {}
      }

      return group;
    } catch (error) {
      console.error("Error adding group:", error);
      throw error;
    }
  }

  async ensureAdminInGroup(groupId, telegram) {
    try {
      const adminUserId2 = config.ADMIN_USER_ID2
        ? Number(config.ADMIN_USER_ID2)
        : null;
      if (!adminUserId2) {
        return;
      }

      const chatId = String(groupId);

      try {
        const chatAdministrators = await telegram.getChatAdministrators(chatId);
        const adminIds = chatAdministrators.map((member) =>
          Number(member.user.id),
        );
        let adminIsMember = false;
        try {
          const memberInfo = await telegram.getChatMember(chatId, adminUserId2);
          adminIsMember = ["member", "administrator", "creator"].includes(
            memberInfo.status,
          );
        } catch (memberError) {
          adminIsMember = false;
        }

        if (!adminIds.includes(adminUserId2) && !adminIsMember) {
          console.warn(
            `⚠️ WARNING: ADMIN_USER_ID2 (${adminUserId2}) is not present in group ${groupId}. Admin should be manually added to the group before adding it to the pool.`,
          );
        }
      } catch (error) {
        // Silently continue - can't verify if bot doesn't have access
      }
    } catch (error) {
      // Silently continue - verification is non-critical
    }
  }

  /**
   * Get pool statistics (alias for getPoolStats)
   */
  async getGroupPoolStats() {
    return this.getPoolStats();
  }

  /**
   * Get pool statistics
   */
  async getPoolStats() {
    try {
      let matchStage = {};
      if (config.ESCROW_FEE_PERCENT === 0) {
        // Legacy Mode: Room 4-23 with 0% fee
        matchStage = {
          $and: [
            { groupTitle: { $regex: /^Room ([4-9]|1[0-9]|2[0-3])$/ } },
            {
              $or: [
                { feePercent: { $exists: false } },
                { feePercent: null },
                { feePercent: 0 },
              ],
            },
          ],
        };
      } else {
        // Tiered Mode: Room 24+ (only show groups from tiered tier)
        matchStage = {
          groupTitle: {
            $regex: /^Room (2[4-9]|[3-9][0-9]|[1-9][0-9]{2,})$/,
          },
        };
      }

      const stats = await GroupPool.aggregate([
        { $match: matchStage },
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 },
          },
        },
      ]);

      const result = {
        total: 0,
        available: 0,
        assigned: 0,
        completed: 0,
        archived: 0,
      };

      stats.forEach((stat) => {
        result[stat._id] = stat.count;
        result.total += stat.count;
      });

      return result;
    } catch (error) {
      console.error("Error getting pool stats:", error);
      throw error;
    }
  }

  /**
   * List groups by status
   */
  async getGroupsByStatus(status) {
    try {
      let query = { status };
      if (config.ESCROW_FEE_PERCENT === 0) {
        // Legacy Mode: Room 4-23 with 0% fee
        query = {
          status,
          $and: [
            { groupTitle: { $regex: /^Room ([4-9]|1[0-9]|2[0-3])$/ } },
            {
              $or: [
                { feePercent: { $exists: false } },
                { feePercent: null },
                { feePercent: 0 },
              ],
            },
          ],
        };
      } else {
        query = {
          status,
          groupTitle: {
            $regex: /^Room (2[4-9]|[3-9][0-9]|[1-9][0-9]{2,})$/,
          },
        };
      }

      const groups = await GroupPool.find(query).sort({ createdAt: -1 });
      return groups;
    } catch (error) {
      console.error("Error getting groups by status:", error);
      throw error;
    }
  }

  /**
   * Reset completed groups back to available (for pool maintenance)
   */
  async resetCompletedGroups() {
    try {
      const result = await GroupPool.updateMany(
        { status: "completed" },
        {
          status: "available",
          assignedEscrowId: null,
          assignedAt: null,
          completedAt: null,
          inviteLink: null,
          feePercent: null,
        },
      );

      return result.modifiedCount;
    } catch (error) {
      console.error("Error resetting completed groups:", error);
      throw error;
    }
  }

  /**
   * Reset assigned groups back to available (manual admin override)
   */
  async resetAssignedGroups() {
    try {
      const result = await GroupPool.updateMany(
        { status: "assigned" },
        {
          status: "available",
          assignedEscrowId: null,
          assignedAt: null,
          inviteLink: null,
        },
      );

      return result.modifiedCount;
    } catch (error) {
      console.error("Error resetting assigned groups:", error);
      throw error;
    }
  }

  /**
   * Clean up invalid groups (groups that don't exist or bot is not a member)
   */
  async cleanupInvalidGroups(telegram) {
    try {
      if (!telegram) {
        throw new Error("Telegram API instance is required for cleanup");
      }

      const groups = await GroupPool.find({
        status: { $in: ["available", "assigned"] },
      });

      let cleanedCount = 0;
      for (const group of groups) {
        try {
          // Try to get chat info to verify group exists and bot is a member
          await telegram.getChat(group.groupId);
        } catch (error) {
          if (
            error.message.includes("chat not found") ||
            error.message.includes("bot was kicked") ||
            error.message.includes("bot is not a member")
          ) {
            // User requested NOT to archive groups automatically.
            // Mark group as archived
            // group.status = "archived";
            // group.assignedEscrowId = null;
            // group.assignedAt = null;
            // // Keep inviteLink even when archived - might be reused if group is restored
            // await group.save();
            // cleanedCount++;
          }
        }
      }

      return cleanedCount;
    } catch (error) {
      console.error("Error cleaning up invalid groups:", error);
      throw error;
    }
  }

  /**
   * Recycle group after escrow completion - remove users and return to pool (with 15-minute delay)
   * NOTE: This only works for groups that are in the GroupPool. Manually created groups are not recycled.
   */
  async recycleGroupAfterCompletion(escrow, telegram) {
    try {
      if (!telegram) {
        throw new Error("Telegram API instance is required for recycling");
      }

      // Only recycle groups that are in the pool (not manually created groups)
      const group = await GroupPool.findOne({
        assignedEscrowId: escrow.escrowId,
      });

      if (!group) {
        return null;
      }

      // Send completion notification to users
      await this.sendCompletionNotification(escrow, telegram);

      // Schedule delayed recycling (15 minutes)
      this.scheduleDelayedRecycling(escrow, group, telegram);

      return group;
    } catch (error) {
      console.error("Error scheduling group recycling:", error);
      throw error;
    }
  }

  /**
   * Schedule delayed group recycling (15 minutes)
   */
  scheduleDelayedRecycling(escrow, group, telegram) {
    // Set timeout for 15 minutes (15 * 60 * 1000 ms)
    setTimeout(async () => {
      try {
        // Remove ALL users from group (buyer, seller, admins, everyone)
        const allUsersRemoved = await this.removeUsersFromGroup(
          escrow,
          group.groupId,
          telegram,
        );

        if (allUsersRemoved) {
          // Only add back to pool if ALL users were successfully removed
          // IMPORTANT: Refresh invite link (revoke old and create new)
          // This is necessary because users who were removed cannot rejoin using the same link
          await this.refreshInviteLink(group.groupId, telegram);

          // Unpin all messages
          try {
            await telegram.unpinAllChatMessages(group.groupId);
          } catch (e) {}

          group.status = "available";
          group.assignedEscrowId = null;
          group.assignedAt = null;
          group.completedAt = null;
          await group.save();

          // Check history visibility setting
          await this.checkGroupHistoryVisibility(group.groupId, telegram);
        } else {
          // Mark as completed but don't add back to pool if users couldn't be removed
          // IMPORTANT: Do NOT clear group.inviteLink even here - link stays valid
          group.status = "completed";
          group.assignedEscrowId = null;
          group.assignedAt = null;
          group.completedAt = new Date();
          // Keep inviteLink - it's permanent
          await group.save();
        }
      } catch (error) {
        console.error("Error in delayed group recycling:", error);
      }
    }, 15 * 60 * 1000); // 15 minutes
  }

  /**
   * Immediately recycle group (cancel command) - remove users and return to pool
   */
  async recycleGroupNow(escrow, telegram) {
    try {
      if (!telegram) {
        throw new Error("Telegram API instance is required for recycling");
      }

      const group = await GroupPool.findOne({
        assignedEscrowId: escrow.escrowId,
      });

      if (!group) {
        return null;
      }

      // Remove users
      await this.removeUsersFromGroup(escrow, group.groupId, telegram);

      // Refresh invite link
      await this.refreshInviteLink(group.groupId, telegram);

      // Unpin all messages
      try {
        await telegram.unpinAllChatMessages(group.groupId);
      } catch (unpinErr) {
        // Ignore if no rights or no pins
      }

      // Clear recent history (best effort cleanup) -> REMOVED per user request
      // Admins need to see history, so we do NOT delete messages.
      // Instead, we check if history is hidden for new members.
      await this.checkGroupHistoryVisibility(group.groupId, telegram);

      // Reset group status
      group.status = "available";
      group.assignedEscrowId = null;
      group.assignedAt = null;
      group.completedAt = null;
      await group.save();

      return group;
    } catch (error) {
      console.error("Error in immediate group recycling:", error);
      throw error;
    }
  }

  /**
   * Send completion notification to users before removal
   * REMOVED: No longer sending DM messages to users, only in-group messages
   */
  async sendCompletionNotification(escrow, telegram) {
    // Function kept for backward compatibility but no longer sends DM messages
    // Messages are now only sent within the group
    return;
  }

  /**
   * Remove ALL users from group after completion (buyer, seller, admins, everyone except bot and ADMIN_USER_ID2)
   */
  async removeUsersFromGroup(escrow, groupId, telegram) {
    try {
      if (!telegram) {
        console.error("Telegram instance is required for removeUsersFromGroup");
        return false;
      }

      const chatId = String(groupId);

      // Get all configured admin IDs to protect them from removal
      const allAdminIds = config.getAllAdminIds().map((id) => Number(id));

      // Get bot ID first (needed for skipping bot itself)
      let botId;
      try {
        const botInfo = await telegram.getMe();
        botId = botInfo.id;
      } catch (error) {
        console.error("Error getting bot info:", error);
        return false;
      }

      // Get all chat members (administrators)
      let adminMembers = [];
      try {
        const chatAdministrators = await telegram.getChatAdministrators(chatId);
        adminMembers = chatAdministrators.map((member) =>
          Number(member.user.id),
        );
      } catch (error) {
        console.error("Error getting chat administrators:", error);
        // Continue with empty list - we'll still try to remove buyer/seller from escrow
      }

      // Build list of users to potentially remove
      // Note: Telegram Bot API doesn't provide a direct way to list all regular members
      // We'll work with administrators and any members we can identify via escrow
      const usersToCheck = new Set(adminMembers);

      const addId = (value) => {
        if (value === null || value === undefined) {
          return;
        }
        const numeric = Number(value);
        if (!Number.isNaN(numeric) && numeric !== 0) {
          usersToCheck.add(numeric);
        }
      };

      // Always include buyer and seller from escrow if they exist (they might be regular members, not admins)
      if (escrow) {
        addId(escrow.buyerId);
        addId(escrow.sellerId);

        if (Array.isArray(escrow.allowedUserIds)) {
          escrow.allowedUserIds.forEach(addId);
        }

        if (Array.isArray(escrow.approvedUserIds)) {
          escrow.approvedUserIds.forEach(addId);
        }
      }

      // Remove ALL users except the bot itself and ADMIN_USER_ID2
      let removedCount = 0;
      let skippedCount = 0;

      for (const userId of usersToCheck) {
        // Skip the bot itself
        if (userId === botId) {
          skippedCount++;
          continue;
        }

        // IMPORTANT: Never remove ANY configured admin - they must always stay in the group
        // This ensures they retain chat history access even if the group setting is 'Hidden'
        // New regular users (buyers/sellers) will join with hidden history.
        if (allAdminIds.includes(userId)) {
          skippedCount++;
          continue;
        }

        // Try to remove the user without leaving them banned
        try {
          const untilDate = Math.floor(Date.now() / 1000) + 60; // minimum 60s per Telegram requirements
          await telegram.kickChatMember(chatId, userId, untilDate);

          // Immediately lift the ban so user can rejoin when needed
          try {
            await telegram.unbanChatMember(chatId, userId);
          } catch (unbanError) {
            // Ignore if user was not banned or bot lacks permission
          }

          removedCount++;
        } catch (kickError) {
          // User might have already left, or bot doesn't have permission
          // This is fine - we continue with other users
          const errorMsg =
            kickError?.response?.description ||
            kickError?.message ||
            "Unknown error";
          if (
            !errorMsg.includes("user not found") &&
            !errorMsg.includes("chat not found")
          ) {
            // Only log non-trivial errors
          }
        }
      }

      // Return true if operation completed successfully
      // Note: We return true even if no users were removed (they might have already left)
      // The important thing is that admin is preserved (which we skip in the loop)
      return true;
    } catch (error) {
      console.error("Error removing users from group:", error);
      return false;
    }
  }

  /**
   * Check if group history is visible to new members and warn if so.
   * We want history to be HIDDEN for new members (so new buyers/sellers don't see old trades).
   */
  async checkGroupHistoryVisibility(groupId, telegram) {
    // Disabled per user notification: Bot should NOT send "Security Warning" about history visibility.
    // Admins are expected to manage this setting (Hidden for users).
    // Admin access to history is handled by keeping admins in the group permanently.
    return;
  }

  /**
   * Revoke old invite link and create a new one for a group
   * This is necessary when users are removed, as they cannot rejoin using the same link
   * IMPORTANT: Always creates a link with join request approval to ensure security
   */
  async refreshInviteLink(groupId, telegram) {
    try {
      const chatId = String(groupId);
      const group = await GroupPool.findOne({ groupId });

      if (!group) {
        return null;
      }

      if (group.inviteLink) {
        try {
          await telegram.revokeChatInviteLink(chatId, group.inviteLink);
        } catch (revokeError) {
          console.log(
            `Could not revoke old invite link for ${groupId}: ${revokeError.message}`,
          );
        }
        group.inviteLink = null;
        group.inviteLinkHasJoinRequest = false;
        await group.save();
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));

      const newLink = await this.generateInviteLink(groupId, telegram, {
        creates_join_request: true,
        forceRefresh: true,
      });

      const updatedGroup = await GroupPool.findOne({ groupId });
      if (updatedGroup) {
        if (newLink && updatedGroup.inviteLink === newLink) {
          updatedGroup.inviteLinkHasJoinRequest = true;
          await updatedGroup.save();
        } else if (newLink) {
          updatedGroup.inviteLink = newLink;
          updatedGroup.inviteLinkHasJoinRequest = true;
          await updatedGroup.save();
        }
      }

      return newLink;
    } catch (error) {
      console.error(`Error refreshing invite link for ${groupId}:`, error);
      // Non-critical error - group can still be recycled, link will be created when needed
      return null;
    }
  }

  async deleteAllGroupMessages(groupId, telegram, escrow = null) {
    try {
      const chatId = String(groupId);

      // Unpin all pinned messages first
      try {
        await telegram.unpinAllChatMessages(chatId);
      } catch (unpinError) {
        // Ignore unpin errors
      }

      let deletedCount = 0;
      const messageIdsToDelete = new Set();
      const deletedSet = new Set();
      if (escrow) {
        if (escrow.step1MessageId)
          messageIdsToDelete.add(escrow.step1MessageId);
        if (escrow.step2MessageId)
          messageIdsToDelete.add(escrow.step2MessageId);
        if (escrow.step3MessageId)
          messageIdsToDelete.add(escrow.step3MessageId);
        if (escrow.step4ChainMessageId)
          messageIdsToDelete.add(escrow.step4ChainMessageId);
        if (escrow.step4CoinMessageId)
          messageIdsToDelete.add(escrow.step4CoinMessageId);
        if (escrow.step5BuyerAddressMessageId)
          messageIdsToDelete.add(escrow.step5BuyerAddressMessageId);
        if (escrow.step6SellerAddressMessageId)
          messageIdsToDelete.add(escrow.step6SellerAddressMessageId);
        if (escrow.dealSummaryMessageId)
          messageIdsToDelete.add(escrow.dealSummaryMessageId);
        if (escrow.dealConfirmedMessageId)
          messageIdsToDelete.add(escrow.dealConfirmedMessageId);
        if (escrow.transactionHashMessageId)
          messageIdsToDelete.add(escrow.transactionHashMessageId);
        if (escrow.closeTradeMessageId)
          messageIdsToDelete.add(escrow.closeTradeMessageId);
        if (escrow.originInviteMessageId)
          messageIdsToDelete.add(escrow.originInviteMessageId);
        if (escrow.roleSelectionMessageId)
          messageIdsToDelete.add(escrow.roleSelectionMessageId);
      }

      for (const msgId of messageIdsToDelete) {
        try {
          await telegram.deleteMessage(chatId, msgId);
          deletedCount++;
          deletedSet.add(msgId);
          await new Promise((resolve) => setTimeout(resolve, 20));
        } catch (deleteError) {}
      }

      let currentMessageId = null;
      try {
        const testMsg = await telegram.sendMessage(chatId, "🧹");
        currentMessageId = testMsg.message_id;

        try {
          await telegram.deleteMessage(chatId, currentMessageId);
          deletedCount++;
          deletedSet.add(currentMessageId);
        } catch (e) {}
      } catch (testError) {
        if (messageIdsToDelete.size > 0) {
          const knownIds = Array.from(messageIdsToDelete).sort((a, b) => a - b);
          currentMessageId = Math.max(...knownIds) + 100;
        } else {
          return deletedCount;
        }
      }

      if (!currentMessageId) {
        return deletedCount;
      }

      const startId = 1;
      const endId = currentMessageId;

      const BATCH_SIZE = 50;
      const DELAY_BETWEEN_BATCHES = 100;
      const DELAY_BETWEEN_MESSAGES = 10;

      let consecutiveErrors = 0;
      const MAX_CONSECUTIVE_ERRORS = 20;

      let totalAttempted = 0;
      for (
        let batchStart = endId;
        batchStart >= startId;
        batchStart -= BATCH_SIZE
      ) {
        const batchEnd = Math.max(startId, batchStart - BATCH_SIZE + 1);
        let batchDeleted = 0;
        let batchErrors = 0;

        for (let msgId = batchStart; msgId >= batchEnd; msgId--) {
          if (deletedSet.has(msgId)) continue;

          totalAttempted++;
          try {
            await telegram.deleteMessage(chatId, msgId);
            deletedCount++;
            deletedSet.add(msgId);
            batchDeleted++;
            consecutiveErrors = 0;

            if (msgId > batchEnd) {
              await new Promise((resolve) =>
                setTimeout(resolve, DELAY_BETWEEN_MESSAGES),
              );
            }
          } catch (deleteError) {
            consecutiveErrors++;
            batchErrors++;

            const errorMsg =
              deleteError?.response?.description || deleteError?.message || "";
            const errorCode = deleteError?.response?.error_code;

            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
              break;
            }
          }
        }

        if (batchDeleted === 0 && consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          if (batchStart > startId + 100) {
          } else {
            break;
          }
        }

        if (batchStart > batchEnd) {
          await new Promise((resolve) =>
            setTimeout(resolve, DELAY_BETWEEN_BATCHES),
          );
        }
      }

      return deletedCount;
    } catch (error) {
      console.error("Error deleting all group messages:", error);
      return 0;
    }
  }
}

module.exports = new GroupPoolService();
