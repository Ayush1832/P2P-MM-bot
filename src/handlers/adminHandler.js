const Escrow = require("../models/Escrow");
const GroupPool = require("../models/GroupPool");
const Contract = require("../models/Contract");
const BlockchainService = require("../services/BlockchainService");
const GroupPoolService = require("../services/GroupPoolService");
const AddressAssignmentService = require("../services/AddressAssignmentService");
const { isAdmin } = require("../middleware/adminAuth");
const config = require("../../config");
const { ethers } = require("ethers");

/**
 * Format a number to avoid scientific notation and ensure proper decimal places
 * Handles very large numbers by converting scientific notation to fixed decimal format
 * @param {number|string} num - The number to format
 * @param {number} decimals - Number of decimal places (default: 2)
 * @returns {string} Formatted number string
 */
function formatNumber(num, decimals = 2) {
  if (num === null || num === undefined || isNaN(num)) {
    return "0." + "0".repeat(decimals);
  }

  let value = typeof num === "string" ? parseFloat(num) : num;

  if (isNaN(value)) {
    return "0." + "0".repeat(decimals);
  }

  if (value === 0) {
    return "0." + "0".repeat(decimals);
  }

  const sign = value < 0 ? "-" : "";
  const absValue = Math.abs(value);
  const numStr = absValue.toString();

  let fixedStr;
  if (numStr.includes("e") || numStr.includes("E")) {
    const match = numStr.toLowerCase().match(/([\d.]+)e([+-]?\d+)/);
    if (match) {
      const base = parseFloat(match[1]);
      const exponent = parseInt(match[2]);
      const baseStr = Math.abs(base).toString().replace(".", "");
      const baseDecimalPos = Math.abs(base).toString().indexOf(".");
      const baseDecimals =
        baseDecimalPos === -1
          ? 0
          : Math.abs(base).toString().length - baseDecimalPos - 1;

      let resultDigits = baseStr;
      let decimalPosition = baseDecimals;

      if (exponent > 0) {
        decimalPosition = baseDecimals - exponent;
        if (decimalPosition <= 0) {
          resultDigits = baseStr + "0".repeat(-decimalPosition);
          decimalPosition = -1;
        }
      } else if (exponent < 0) {
        decimalPosition = baseDecimals - exponent;
        if (decimalPosition >= resultDigits.length) {
          resultDigits =
            "0".repeat(decimalPosition - resultDigits.length) + resultDigits;
          decimalPosition = resultDigits.length;
        }
      }

      if (decimalPosition === -1 || decimalPosition >= resultDigits.length) {
        fixedStr = resultDigits;
      } else {
        fixedStr =
          resultDigits.substring(0, decimalPosition) +
          "." +
          resultDigits.substring(decimalPosition);
      }
    } else {
      fixedStr = absValue.toFixed(decimals);
    }
  } else {
    fixedStr = absValue.toFixed(decimals);
  }

  const parts = fixedStr.split(".");
  let integerPart = parts[0] || "0";
  let fractionalPart = parts[1] || "";

  if (fractionalPart.length < decimals) {
    fractionalPart =
      fractionalPart + "0".repeat(decimals - fractionalPart.length);
  } else if (fractionalPart.length > decimals) {
    fractionalPart = fractionalPart.substring(0, decimals);
  }

  integerPart = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const formatted = fractionalPart
    ? `${integerPart}.${fractionalPart}`
    : integerPart;

  return sign + formatted;
}

async function adminStats(ctx) {
  try {
    if (!isAdmin(ctx)) {
      return ctx.reply("❌ Access denied. Admin privileges required.");
    }

    const activeEscrows = await Escrow.countDocuments({
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

    const completedEscrows = await Escrow.countDocuments({
      status: "completed",
      releaseTransactionHash: { $exists: true, $ne: null, $ne: "" },
    });

    const refundedEscrows = await Escrow.countDocuments({
      status: "refunded",
      refundTransactionHash: { $exists: true, $ne: null, $ne: "" },
    });

    const totalEscrows = completedEscrows + refundedEscrows;

    const statsMessage = `
📊 <b>ADMIN STATISTICS</b>

📈 <b>Escrows:</b>
• Total: ${totalEscrows}
• Active: ${activeEscrows}
• Completed: ${completedEscrows}
• Refunded: ${refundedEscrows}
    `;

    await ctx.reply(statsMessage, { parse_mode: "HTML" });
  } catch (error) {
    console.error("Error in admin stats:", error);
    ctx.reply("❌ Error loading statistics.");
  }
}

async function adminGroupPool(ctx) {
  try {
    const stats = await GroupPoolService.getPoolStats();

    const message = `
🏊‍♂️ <b>GROUP POOL STATUS</b>

📊 <b>Statistics:</b>
• Total Groups: ${stats.total}
• Available: ${stats.available} 🟢
• Assigned: ${stats.assigned} 🟡
• Completed: ${stats.completed} 🔵
• Archived: ${stats.archived} ⚫

⚡ <b>Commands:</b>
• <code>/admin_pool_add &lt;groupId&gt;</code> - Add group to pool
• <code>/admin_pool_list</code> - List all groups
    `;

    await ctx.reply(message, { parse_mode: "HTML" });
  } catch (error) {
    console.error("Error in admin group pool:", error);
    ctx.reply("❌ Error loading group pool status.");
  }
}

async function adminPoolAdd(ctx) {
  try {
    const groupId = ctx.message.text.split(" ")[1];
    if (!groupId) {
      return ctx.reply(
        "❌ Please provide group ID.\nUsage: `/admin_pool_add <groupId>`",
        {
          parse_mode: "Markdown",
        },
      );
    }

    let groupTitle = null;

    try {
      const chatInfo = await ctx.telegram.getChat(groupId);
      if (chatInfo && chatInfo.title) {
        groupTitle = chatInfo.title;
      }
    } catch (e) {
      console.warn(`Could not fetch group title for ${groupId}:`, e.message);
      // Fallback: Continue without title or use "Unknown" if desired,
      // but null allows addGroup to handle it or leave as is.
    }

    await GroupPoolService.addGroup(groupId, groupTitle, ctx.telegram);
    await ctx.reply(
      `✅ Added group ${groupId} to pool.\nFetched Title: ${
        groupTitle || "Unknown (Could not fetch)"
      }`,
    );
  } catch (error) {
    console.error("Error adding group to pool:", error);
    await ctx.reply(`❌ Error adding group: ${error.message}`);
  }
}

async function adminPoolList(ctx) {
  try {
    const availableGroups = await GroupPoolService.getGroupsByStatus(
      "available",
    );
    const assignedGroups = await GroupPoolService.getGroupsByStatus("assigned");
    const completedGroups = await GroupPoolService.getGroupsByStatus(
      "completed",
    );

    let message = "🏊‍♂️ <b>GROUP POOL LIST</b>\n\n";

    if (availableGroups.length > 0) {
      message += `🟢 <b>Available (${availableGroups.length}):</b>\n`;
      availableGroups.forEach((group) => {
        const title = group.groupTitle || "Unknown";
        message += `• ${title} [ID: ${group.groupId}]\n`;
      });
      message += "\n";
    }

    if (assignedGroups.length > 0) {
      message += `🟡 <b>Assigned (${assignedGroups.length}):</b>\n`;
      assignedGroups.forEach((group) => {
        const title = group.groupTitle || "Unknown";
        message += `• ${title} [ID: ${group.groupId}] - Escrow: ${group.assignedEscrowId}\n`;
      });
      message += "\n";
    }

    if (completedGroups.length > 0) {
      message += `🔵 <b>Completed (${completedGroups.length}):</b>\n`;
      completedGroups.forEach((group) => {
        const title = group.groupTitle || "Unknown";
        const completedAgo = group.completedAt
          ? Math.floor((Date.now() - group.completedAt) / (1000 * 60 * 60))
          : "Unknown";
        message += `• ${title} [ID: ${group.groupId}] - ${completedAgo}h ago\n`;
      });
    }

    if (
      availableGroups.length === 0 &&
      assignedGroups.length === 0 &&
      completedGroups.length === 0
    ) {
      message += "No groups in pool.";
    }

    await ctx.reply(message, { parse_mode: "HTML" });
  } catch (error) {
    console.error("Error listing groups:", error);
    ctx.reply("❌ Error listing groups.");
  }
}

/**
 * Manually send inactivity warnings to currently-inactive groups
 */
async function adminWarnInactive(ctx) {
  try {
    if (!isAdmin(ctx)) {
      return ctx.reply("❌ Access denied. Admin privileges required.");
    }

    const ActivityMonitoringService = require("../services/ActivityMonitoringService");
    const thresholds = ActivityMonitoringService.getThresholds();
    const cutoff = new Date(Date.now() - thresholds.inactivityMs);

    const candidates = [];

    let attempted = 0;
    let success = 0;
    for (const tracking of candidates) {
      attempted++;
      const ok = await ActivityMonitoringService.sendInactivityWarning(
        tracking,
      );
      if (ok) success++;
    }

    await ctx.reply(
      `⚠️ Attempted: ${attempted}, Successfully warned: ${success}.`,
    );
  } catch (error) {
    console.error("Error in adminWarnInactive:", error);
    await ctx.reply("❌ Error sending warnings.");
  }
}

/**
 * Manually remove users from groups pending removal (warning sent + delay passed)
 */
async function adminRemoveInactive(ctx) {
  try {
    if (!isAdmin(ctx)) {
      return ctx.reply("❌ Access denied. Admin privileges required.");
    }

    const ActivityMonitoringService = require("../services/ActivityMonitoringService");
    const thresholds = ActivityMonitoringService.getThresholds();
    const cutoff = new Date(Date.now() - thresholds.warningDelayMs);

    const candidates = [];

    let removed = 0;
    for (const tracking of candidates) {
      await ActivityMonitoringService.handleInactiveGroup(tracking);
      removed++;
    }

    await ctx.reply(`🚪 Removed users from ${removed} groups pending removal.`);
  } catch (error) {
    console.error("Error in adminRemoveInactive:", error);
    await ctx.reply("❌ Error removing users.");
  }
}

/**
 * Admin command to show address pool statistics
 */
async function adminAddressPool(ctx) {
  try {
    if (!isAdmin(ctx)) {
      return ctx.reply("❌ Access denied. Admin privileges required.");
    }

    const stats = await AddressAssignmentService.getAddressPoolStats();

    if (!stats.singleAddress) {
      return ctx.reply(
        "📊 No deposit address configured. Please set HOT_WALLET_PRIVATE_KEY in config.",
      );
    }

    let message = `🏦 <b>DEPOSIT ADDRESS</b>\n\n`;
    message += `📍 Single Address (All Tokens):\n<code>${stats.singleAddress}</code>\n\n`;
    message += `ℹ️ This address accepts deposits for all tokens and networks.\n`;
    message += `Transaction hashes are validated to ensure unique deposits.`;

    await ctx.reply(message, { parse_mode: "HTML" });
  } catch (error) {
    console.error("Error getting address pool stats:", error);
    ctx.reply("❌ Error loading address pool statistics.");
  }
}

/**
 * Admin command to verify deployed contracts
 * (Previously: initialize address pool - now obsolete, replaced by contract verification)
 */
async function adminInitAddresses(ctx) {
  try {
    if (!isAdmin(ctx)) {
      return ctx.reply("❌ Access denied. Admin privileges required.");
    }

    const contracts = await Contract.find({
      name: "EscrowVault",
      status: "deployed",
    }).sort({ network: 1, token: 1 });

    if (contracts.length === 0) {
      return ctx.reply(
        `❌ No EscrowVault contracts found in database.\n\n` +
          `⚠️ Please deploy contracts using:\n` +
          `\`npm run deploy\`\n\n` +
          `This will deploy USDT and USDC contracts on BSC with ${desiredFeePercent}% fee.`,
      );
    }

    const contractsByNetwork = {};
    const requiredTokens = ["USDT", "USDC"];

    contracts.forEach((contract) => {
      if (!contractsByNetwork[contract.network]) {
        contractsByNetwork[contract.network] = [];
      }
      contractsByNetwork[contract.network].push(contract);
    });

    let message = `📋 **CONTRACT VERIFICATION**\n\n`;

    const bscContracts = contracts.filter((c) => c.network === "BSC");
    const bscTokens = bscContracts.map((c) => c.token);

    message += `🔗 **BSC Contracts:**\n`;
    if (bscContracts.length === 0) {
      message += `❌ No BSC contracts found.\n`;
    } else {
      bscContracts.forEach((contract) => {
        const deployedDate = contract.deployedAt
          ? new Date(contract.deployedAt).toLocaleString()
          : "Unknown";
        message += `✅ ${contract.token} (${contract.feePercent}%): \`${contract.address}\`\n`;
        message += `   📅 Deployed: ${deployedDate}\n`;
      });
    }

    const missingTokens = requiredTokens.filter(
      (token) => !bscTokens.includes(token),
    );
    if (missingTokens.length > 0) {
      message += `\n⚠️ **Missing Tokens:** ${missingTokens.join(", ")}\n`;
      message += `Please deploy missing contracts.\n`;
    } else {
      message += `\n✅ All required tokens (${requiredTokens.join(
        ", ",
      )}) are deployed.\n`;
    }

    const otherNetworks = Object.keys(contractsByNetwork).filter(
      (n) => n !== "BSC",
    );
    if (otherNetworks.length > 0) {
      message += `\n📡 **Other Networks:**\n`;
      otherNetworks.forEach((network) => {
        const networkContracts = contractsByNetwork[network];
        message += `• ${network}: ${networkContracts.length} contract(s)\n`;
      });
    }

    message += `\n💡 **Note:** Address pool initialization is no longer needed. The system uses EscrowVault contracts directly.`;

    await ctx.reply(message, { parse_mode: "Markdown" });
  } catch (error) {
    console.error("Error verifying contracts:", error);
    ctx.reply("❌ Error verifying contracts. Please check the logs.");
  }
}

async function adminCleanupAddresses(ctx) {
  try {
    if (!isAdmin(ctx)) {
      return ctx.reply("❌ Access denied. Admin privileges required.");
    }

    await ctx.reply("🧹 Cleaning up abandoned addresses...");

    await ctx.reply(
      "ℹ️ Address cleanup is no longer needed. Addresses are managed via EscrowVault contracts.",
    );
  } catch (error) {
    console.error("Error cleaning up addresses:", error);
    ctx.reply("❌ Error cleaning up abandoned addresses.");
  }
}

/**
 * Admin command to withdraw accumulated network fees (surplus) from contracts.
 * Safely sweeps idle contracts to the Hot Wallet.
 */
async function adminWithdrawNetworkFees(ctx) {
  try {
    if (!isAdmin(ctx)) {
      return ctx.reply("❌ Access denied. Admin privileges required.");
    }

    await ctx.reply("🔍 Scanning contracts for surplus network fees...");

    const contracts = await Contract.find({ status: "deployed" });
    const BlockchainService = require("../services/BlockchainService");
    const bs = new BlockchainService();
    // Get Hot Wallet Address from the service instance (BSC wallet used as reference)
    const hotWalletAddress = bs.getWallet("BSC").address;

    let sweptCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    let message = `💸 **NETWORK FEE WITHDRAWAL**\n\nSweeping excess funds to configured Fee Wallets (BSC/TRON).\n\n`;

    for (const contract of contracts) {
      // Skip TRON check removed - fully supported
      // if (contract.network === "TRON") { ... }

      // Check for active escrows
      const activeCount = await Escrow.countDocuments({
        contractAddress: contract.address,
        status: {
          $in: [
            "awaiting_deposit",
            "deposited",
            "in_fiat_transfer",
            "ready_to_release",
          ],
        },
      });

      if (activeCount > 0) {
        skippedCount++;
        // message += `• [${contract.network}] ${contract.address.slice(0,6)}: ⚠️ Skipped (${activeCount} active deals)\n`;
        continue;
      }

      // Determine target wallet based on network
      const targetWallet =
        contract.network === "TRON" || contract.network === "TRX"
          ? config.FEE_WALLET_TRC
          : config.FEE_WALLET_BSC;

      if (!targetWallet) {
        skippedCount++;
        message += `• [${contract.network}] ${contract.address.slice(
          0,
          6,
        )}: ⚠️ Skipped (No Fee Wallet Configured)\n`;
        continue;
      }

      // Attempt Sweep
      try {
        await bs.withdrawToken(
          contract.token,
          contract.network,
          contract.address,
          targetWallet,
        );
        sweptCount++;
        message += `• [${contract.network}] ${contract.address.slice(
          0,
          6,
        )}: ✅ Swept\n`;
      } catch (err) {
        errorCount++;
        console.error(`Failed to sweep ${contract.address}:`, err.message);
        message += `• [${contract.network}] ${contract.address.slice(
          0,
          6,
        )}: ❌ Error\n`;
      }
    }

    message += `\n📊 Summary:\n✅ Swept: ${sweptCount}\n⚠️ Skipped (Active): ${skippedCount}\n❌ Errors: ${errorCount}`;

    await ctx.reply(message, { parse_mode: "Markdown" });
  } catch (error) {
    console.error("Error withdrawing network fees:", error);
    ctx.reply("❌ Error processing withdrawal: " + error.message);
  }
}

/**
 * Delete ALL groups from pool (dangerous)
 */
async function adminPoolDeleteAll(ctx) {
  try {
    if (!isAdmin(ctx)) {
      return ctx.reply("❌ Access denied. Admin privileges required.");
    }

    const GroupPool = require("../models/GroupPool");
    const res = await GroupPool.deleteMany({});
    await ctx.reply(`🗑️ Deleted ${res.deletedCount} groups from pool.`);
  } catch (error) {
    console.error("Error deleting all groups:", error);
    await ctx.reply("❌ Error deleting groups.");
  }
}

/**
 * Delete a specific group from the pool by groupId
 */
async function adminPoolDelete(ctx) {
  try {
    if (!isAdmin(ctx)) {
      return ctx.reply("❌ Access denied. Admin privileges required.");
    }

    const groupId = ctx.message.text.split(" ")[1];
    if (!groupId) {
      return ctx.reply(
        "❌ Please provide group ID.\nUsage: `/admin_pool_delete <groupId>`",
        {
          parse_mode: "Markdown",
        },
      );
    }

    const GroupPool = require("../models/GroupPool");
    const res = await GroupPool.deleteOne({ groupId });
    if (res.deletedCount === 0) {
      return ctx.reply(`ℹ️ No group found for id ${groupId}.`);
    }
    await ctx.reply(`🗑️ Deleted group ${groupId} from pool.`);
  } catch (error) {
    console.error("Error deleting group from pool:", error);
    await ctx.reply("❌ Error deleting group from pool.");
  }
}

/**
 * Admin command to show all available admin commands and their usage
 */
async function adminHelp(ctx) {
  try {
    if (!isAdmin(ctx)) {
      return ctx.reply("❌ Access denied. Admin privileges required.");
    }

    const helpMessage = `🤖 **ADMIN COMMANDS HELP**

📊 **STATISTICS:**
• \`/admin_stats\` - View escrow statistics
• \`/admin_trade_stats\` - View comprehensive trade statistics by fee percentage
• \`/admin_recent_trades [limit]\` - View recent trades (max 50)
• \`/admin_export_trades\` - Export all trades to CSV file

🏊‍♂️ **GROUP POOL MANAGEMENT:**
• \`/admin_pool\` - View group pool status and statistics
• \`/admin_pool_add <groupId>\` - Add group to pool
• \`/admin_pool_list\` - List all groups in pool
• \`/admin_group_reset\` - Reset group when no deposits were made (removes users, recycles group)
• \`/admin_reset_force\` - Force reset group regardless of status (removes users, recycles group)
• \`/admin_reset_all_groups\` - Force reset ALL groups at once (ignores escrows, removes users, recycles all)
• \`/admin_pool_delete <groupId>\` - Delete specific group from pool
• \`/admin_pool_delete_all\` - Delete ALL groups from pool (dangerous)

🔄 **AUTOMATIC GROUP RECYCLING:**
✅ **Automatic 15-minute delayed recycling** after trade completion

🧹 **MAINTENANCE:**
• \`/admin_address_pool\` - View address pool status
• \`/admin_init_addresses\` - Verify deployed EscrowVault contracts
• \`/admin_cleanup_addresses\` - Cleanup abandoned addresses
• \`/admin_withdraw_bsc_usdt\` - Withdraw excess USDT from BSC escrow contracts to admin wallet (private chat only)
• \`/withdraw_fees [chain] [token]\` - Withdraw accumulated fees (e.g., /withdraw_fees BSC USDT)

📋 **AUTOMATIC FEATURES:**
✅ **Group Recycling**: Automatic 15-minute delayed recycling after trade completion
✅ **User Management**: Automatic user removal after recycling delay
✅ **Pool Management**: Automatic group status updates

💡 **TIPS:**
• Most operations are automatic - no manual intervention needed
• Use manual commands only for special cases or maintenance
• Group recycling happens automatically with 15-minute delay

🔧 **QUICK REFERENCE:**
• Pool status: \`/admin_pool\`
• Recent trades: \`/admin_recent_trades 20\`
• Export all trades: \`/admin_export_trades\`
• Trade statistics: \`/admin_trade_stats\`
• Address pool status: \`/admin_address_pool\`

💰 **SETTLEMENT COMMANDS (in groups):**
• \`/release\` - Release funds to buyer (admin only)
• \`/refund\` - Refund funds to seller (admin only)
`;

    await ctx.reply(helpMessage, { parse_mode: "Markdown" });
  } catch (error) {
    console.error("Error in admin help:", error);
    ctx.reply("❌ Error loading admin help.");
  }
}

/**
 * Admin command to show comprehensive trade statistics by fee percentage
 */
async function adminTradeStats(ctx) {
  try {
    if (!isAdmin(ctx)) {
      return ctx.reply("❌ Access denied. Admin privileges required.");
    }

    const completedEscrows = await Escrow.find({
      status: { $in: ["completed", "refunded"] },
    });

    const Contract = require("../models/Contract");
    const contracts = await Contract.find({ name: "EscrowVault" });

    const getSettledAmount = (escrow) => {
      let amount = 0;

      if (escrow.status === "completed" || escrow.status === "refunded") {
        const q = parseFloat(escrow.quantity);
        if (!isNaN(q) && q > 0) {
          amount = q;
        }
      }

      if (amount === 0) {
        const c = parseFloat(escrow.confirmedAmount);
        const d = parseFloat(escrow.depositAmount);
        const q = parseFloat(escrow.quantity);
        amount =
          !isNaN(c) && c > 0
            ? c
            : !isNaN(d) && d > 0
            ? d
            : !isNaN(q) && q > 0
            ? q
            : 0;
      }

      if (amount > 1e15) {
        const token = escrow.token || "USDT";
        const chain = escrow.chain || "BSC";
        const decimals = BlockchainService.getTokenDecimals(token, chain);
        amount = amount / Math.pow(10, decimals);
      }

      return amount;
    };

    const validCompletedEscrows = completedEscrows.filter((escrow) => {
      const amt = getSettledAmount(escrow);
      if (amt <= 0) {
        return false;
      }

      const hasReleaseHash =
        escrow.status === "completed" &&
        escrow.releaseTransactionHash &&
        escrow.releaseTransactionHash.trim() !== "";
      const hasRefundHash =
        escrow.status === "refunded" &&
        escrow.refundTransactionHash &&
        escrow.refundTransactionHash.trim() !== "";

      return (
        hasReleaseHash ||
        hasRefundHash ||
        (escrow.quantity && escrow.quantity > 0)
      );
    });

    const contractsByFee = {};
    contracts.forEach((contract) => {
      const feePercent = contract.feePercent;
      if (!contractsByFee[feePercent]) {
        contractsByFee[feePercent] = [];
      }
      contractsByFee[feePercent].push(contract);
    });

    const statsByFee = {};
    const allTokens = new Set();
    const allNetworks = new Set();

    for (const [feePercent, contractList] of Object.entries(contractsByFee)) {
      const contractAddresses = contractList.map((c) =>
        c.address.toLowerCase(),
      );

      const escrowsWithFee = validCompletedEscrows.filter((escrow) => {
        // Correctly link escrow to the contract it was settled on
        if (!escrow.contractAddress) return false;
        return contractAddresses.includes(escrow.contractAddress.toLowerCase());
      });

      const totalTrades = escrowsWithFee.length;
      const totalAmount = escrowsWithFee.reduce((sum, escrow) => {
        return sum + getSettledAmount(escrow);
      }, 0);

      const tokenBreakdown = {};
      escrowsWithFee.forEach((escrow) => {
        const token = escrow.token || "Unknown";
        const amount = getSettledAmount(escrow);

        if (!tokenBreakdown[token]) {
          tokenBreakdown[token] = { count: 0, amount: 0 };
        }
        tokenBreakdown[token].count++;
        tokenBreakdown[token].amount += amount;

        allTokens.add(token);
        allNetworks.add(escrow.chain || "Unknown");
      });

      statsByFee[feePercent] = {
        totalTrades,
        totalAmount,
        tokenBreakdown,
        contracts: contractList.length,
      };
    }

    const totalTrades = validCompletedEscrows.length;
    const totalAmount = validCompletedEscrows.reduce((sum, escrow) => {
      return sum + getSettledAmount(escrow);
    }, 0);

    const completedCount = validCompletedEscrows.filter(
      (e) => e.status === "completed",
    ).length;
    const refundedCount = validCompletedEscrows.filter(
      (e) => e.status === "refunded",
    ).length;

    let statsMessage = `📊 **COMPREHENSIVE TRADE STATISTICS**

🎯 **OVERALL SUMMARY:**
• **Total Trades:** ${totalTrades}
• **Total Volume:** ${formatNumber(totalAmount)} tokens
• **Completed:** ${completedCount} trades
• **Refunded:** ${refundedCount} trades
• **Success Rate:** ${
      totalTrades > 0
        ? formatNumber((completedCount / totalTrades) * 100, 1)
        : 0
    }%

📈 **BY FEE PERCENTAGE:**`;

    const sortedFees = Object.keys(statsByFee).sort(
      (a, b) => parseFloat(a) - parseFloat(b),
    );

    for (const feePercent of sortedFees) {
      const stats = statsByFee[feePercent];
      const feeDisplay = feePercent === "0" ? "0% (Free)" : `${feePercent}%`;
      const avgPerTrade =
        stats.totalTrades > 0 ? stats.totalAmount / stats.totalTrades : 0;

      statsMessage += `\n\n💰 **${feeDisplay} FEE STRUCTURE:**
• **Trades:** ${stats.totalTrades}
• **Volume:** ${formatNumber(stats.totalAmount)} tokens
• **Avg per Trade:** ${formatNumber(avgPerTrade)} tokens`;

      if (stats.totalTrades > 0) {
        statsMessage += `\n• **Token Breakdown:**`;
        Object.entries(stats.tokenBreakdown).forEach(([token, data]) => {
          statsMessage += `\n  - ${token}: ${data.count} trades, ${formatNumber(
            data.amount,
          )} tokens`;
        });
      }
    }

    statsMessage += `📅 **Last Updated:** ${new Date().toLocaleString()}`;

    await ctx.reply(statsMessage, { parse_mode: "Markdown" });
  } catch (error) {
    console.error("Error in admin trade stats:", error);
    ctx.reply("❌ Error loading trade statistics.");
  }
}

/**
 * Admin command to export all trades to CSV format
 */
async function adminExportTrades(ctx) {
  try {
    if (!isAdmin(ctx)) {
      return ctx.reply("❌ Access denied. Admin privileges required.");
    }

    // Get all fully completed/refunded escrows with transaction hashes only
    // Transaction hash must exist and be a non-empty string
    const allEscrows = await Escrow.find({
      $or: [
        {
          status: "completed",
          releaseTransactionHash: { $exists: true, $ne: null, $ne: "" },
        },
        {
          status: "refunded",
          refundTransactionHash: { $exists: true, $ne: null, $ne: "" },
        },
      ],
    }).sort({ createdAt: -1 }); // Most recent first

    if (allEscrows.length === 0) {
      return ctx.reply("📊 No trades found in the database.");
    }

    // CSV-safe helper
    const csvSafe = (v) => {
      const s = String(v == null ? "" : v);
      const escaped = s.replace(/"/g, '""');
      return `"${escaped}"`;
    };

    // Create organized CSV content with clear sections
    let csvContent = `# ESCROW TRADES EXPORT
# Generated: ${new Date().toLocaleString()}
# Total Trades: ${allEscrows.length}
#
# COLUMNS:
# ID, Status, Created Date, Token, Network, Quantity, Rate, Buyer, Seller, Completed Date
#
# DATA:
`;

    allEscrows.forEach((escrow, index) => {
      const buyerName = escrow.buyerUsername
        ? `@${escrow.buyerUsername}`
        : escrow.buyerId
        ? `[${escrow.buyerId}]`
        : "Not Set";
      const sellerName = escrow.sellerUsername
        ? `@${escrow.sellerUsername}`
        : escrow.sellerId
        ? `[${escrow.sellerId}]`
        : "Not Set";

      const dealDetails = escrow.dealDetails
        ? escrow.dealDetails.replace(/\n/g, " | ").replace(/,/g, ";")
        : "Not Set";

      const completedDate = escrow.completedAt
        ? new Date(escrow.completedAt).toLocaleString()
        : "";

      const createdDate = new Date(escrow.createdAt).toLocaleString();
      const quantity =
        typeof escrow.quantity === "number"
          ? escrow.quantity
          : parseFloat(escrow.quantity);
      const rate = escrow.rate != null && escrow.rate !== "" ? escrow.rate : "";

      // Add separator for readability
      if (index > 0) {
        csvContent += `\n`;
      }

      const buyerOut =
        buyerName || (escrow.buyerId ? `[${escrow.buyerId}]` : "Unknown");
      const sellerOut =
        sellerName || (escrow.sellerId ? `[${escrow.sellerId}]` : "Unknown");

      csvContent += [
        csvSafe(escrow._id),
        csvSafe(escrow.status),
        csvSafe(createdDate),
        csvSafe(escrow.token || "N/A"),
        csvSafe(escrow.chain || "N/A"),
        csvSafe(quantity),
        csvSafe(rate),
        csvSafe(buyerOut),
        csvSafe(sellerOut),
        csvSafe(completedDate),
      ].join(",");
    });

    // Create filename with timestamp
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .split("T")[0];
    const filename = `trades-export-${timestamp}.csv`;

    // Save to file
    const fs = require("fs");
    const path = require("path");
    const filePath = path.join(__dirname, "..", "..", "exports", filename);

    // Ensure exports directory exists
    const exportsDir = path.dirname(filePath);
    if (!fs.existsSync(exportsDir)) {
      fs.mkdirSync(exportsDir, { recursive: true });
    }

    fs.writeFileSync(filePath, csvContent);

    // Send file to admin
    await ctx.replyWithDocument(
      {
        source: filePath,
        filename: filename,
      },
      {
        caption: `📊 **TRADE EXPORT COMPLETE**\n\n📈 **Statistics:**\n• Total Trades: ${
          allEscrows.length
        }\n• File: ${filename}\n• Generated: ${new Date().toLocaleString()}\n• Location: ${filePath}\n\n💡 **Usage:**\n• Open in Excel, Google Sheets, or any CSV viewer\n• Sort and filter by any column\n• Analyze trading patterns and performance\n• File saved permanently for your records`,
      },
    );
  } catch (error) {
    console.error("Error in admin export trades:", error);
    ctx.reply("❌ Error exporting trades.");
  }
}

/**
 * Admin command to get recent trades with pagination
 */
async function adminRecentTrades(ctx) {
  try {
    if (!isAdmin(ctx)) {
      return ctx.reply("❌ Access denied. Admin privileges required.");
    }

    const args = ctx.message.text.split(" ");
    const limit = parseInt(args[1]) || 10; // Default to 10, max 50

    if (limit > 50) {
      return ctx.reply(
        "❌ Maximum 50 trades per request. Use /admin_export_trades for complete data.",
      );
    }

    // Get recent trades - only fully completed/refunded trades with transaction hashes
    // Transaction hash must exist and be a non-empty string
    const recentTrades = await Escrow.find({
      $or: [
        {
          status: "completed",
          releaseTransactionHash: { $exists: true, $ne: null, $ne: "" },
        },
        {
          status: "refunded",
          refundTransactionHash: { $exists: true, $ne: null, $ne: "" },
        },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("buyerId", "username first_name")
      .populate("sellerId", "username first_name");

    if (recentTrades.length === 0) {
      return ctx.reply("📊 No trades found in the database.");
    }

    // Helper to escape HTML (preserve numeric 0)
    const esc = (s) => {
      const v = s === 0 ? "0" : String(s == null ? "" : s);
      return v
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    };

    let message = `📊 <b>RECENT TRADES (${recentTrades.length})</b>\n\n`;

    recentTrades.forEach((escrow, index) => {
      // Prefer stored usernames on escrow, fallback to IDs
      const buyerName = escrow.buyerUsername
        ? `@${escrow.buyerUsername}`
        : escrow.buyerId
        ? `[${escrow.buyerId}]`
        : "Not Set";
      const sellerName = escrow.sellerUsername
        ? `@${escrow.sellerUsername}`
        : escrow.sellerId
        ? `[${escrow.sellerId}]`
        : "Not Set";

      const c = parseFloat(escrow.confirmedAmount);
      const d = parseFloat(escrow.depositAmount);
      const q = parseFloat(escrow.quantity);
      let amount = 0;
      let amountSource = "none";
      if (!isNaN(c) && c > 0) {
        amount = c;
        amountSource = "confirmed";
      } else if (!isNaN(d) && d > 0) {
        amount = d;
        amountSource = "deposit";
      } else if (
        !isNaN(q) &&
        q > 0 &&
        ["completed", "refunded"].includes(escrow.status)
      ) {
        // Safe backfill from deal quantity for finalized trades
        amount = q;
        amountSource = "quantity";
      }
      const statusEmoji =
        {
          completed: "✅",
          refunded: "🔄",
          draft: "📝",
          awaiting_details: "⏳",
        }[escrow.status] || "❓";

      const amountNote =
        amountSource === "quantity" ? " (backfilled from quantity)" : "";
      const amountText =
        amount > 0
          ? `${esc(amount)} ${esc(escrow.token || "N/A")}${amountNote}`
          : `— ${esc(escrow.token || "N/A")} (no on-chain amount)`;

      message += `${
        index + 1
      }. ${statusEmoji} <b>${escrow.status.toUpperCase()}</b>\n`;
      message += `   💰 ${amountText} (${esc(escrow.chain || "N/A")})\n`;
      message += `   👤 Buyer: ${esc(buyerName)}\n`;
      message += `   🏪 Seller: ${esc(sellerName)}\n`;
      message += `   📅 ${esc(new Date(escrow.createdAt).toLocaleString())}\n`;
      message += `   🆔 ID: <code>${esc(escrow._id)}</code>\n\n`;
    });

    message += `💡 <b>Commands:</b>\n`;
    message += `• <code>/admin_recent_trades 20</code> - Show 20 recent trades\n`;
    message += `• <code>/admin_export_trades</code> - Export all trades to CSV\n`;
    message += `• <code>/admin_help</code> - Show admin commands\n`;
    message += `• <code>/withdraw_fees [chain] [token]</code> - Withdraw accumulated fees (e.g., /withdraw_fees BSC USDT)\n`;
    message += `• <code>/admin_trade_stats</code> - View statistics by fee percentage`;

    await ctx.reply(message, { parse_mode: "HTML" });
  } catch (error) {
    console.error("Error in admin recent trades:", error);
    ctx.reply("❌ Error loading recent trades.");
  }
}

/**
 * Admin group reset - Reset a group when no deposits were made
 * Only works if escrow has no deposits (status: draft, awaiting_details, or awaiting_deposit)
 * and depositAmount/confirmedAmount are 0
 */
async function adminGroupReset(ctx) {
  try {
    if (!isAdmin(ctx)) {
      return ctx.reply("❌ Access denied. Admin privileges required.");
    }

    const chatId = ctx.chat.id;

    // Must be in a group
    if (chatId > 0) {
      return ctx.reply("❌ This command can only be used in a group chat.");
    }

    // Delete command message after 1 minute
    const commandMsgId = ctx.message.message_id;
    setTimeout(async () => {
      try {
        await ctx.telegram.deleteMessage(chatId, commandMsgId);
      } catch (e) {
        // Ignore errors (message may already be deleted)
      }
    }, 60 * 1000);

    // First, try to find the group in pool to get assignedEscrowId
    let group = await GroupPool.findOne({ groupId: chatId.toString() });

    // Find escrow for this group (any status)
    let escrow = null;

    if (group && group.assignedEscrowId) {
      // Try to find escrow by assignedEscrowId first
      escrow = await Escrow.findOne({
        escrowId: group.assignedEscrowId,
      });
    }

    // If not found, try to find the most recent escrow by groupId
    if (!escrow) {
      escrow = await Escrow.findOne({
        groupId: chatId.toString(),
      }).sort({ createdAt: -1 });
    }

    if (!escrow) {
      const errorMsg = await ctx.reply("❌ No escrow found for this group.");
      setTimeout(async () => {
        try {
          await ctx.telegram.deleteMessage(chatId, errorMsg.message_id);
        } catch (e) {}
      }, 60 * 1000);
      return;
    }

    // Only check for deposits if trade is NOT completed/refunded
    // If trade is completed, allow reset to clean up the group
    const isCompleted = ["completed", "refunded"].includes(escrow.status);
    if (!isCompleted) {
      // Check if deposits were made (only for active trades)
      const depositAmount = Number(escrow.depositAmount);
      const confirmedAmount = Number(escrow.confirmedAmount);
      const hasDeposit = depositAmount > 0 || confirmedAmount > 0;

      if (hasDeposit) {
        const errorMsg = await ctx.reply(
          "❌ Cannot reset: Deposits were made. Use /release or /refund to settle.",
        );
        setTimeout(async () => {
          try {
            await ctx.telegram.deleteMessage(chatId, errorMsg.message_id);
          } catch (e) {}
        }, 60 * 1000);
        return;
      }
    }

    // Find the group in pool (we may have already found it above)
    if (!group) {
      group = await GroupPool.findOne({
        assignedEscrowId: escrow.escrowId,
      });
    }

    if (!group) {
      group = await GroupPool.findOne({ groupId: chatId.toString() });
    }

    if (!group) {
      const errorMsg = await ctx.reply("❌ Group not found in pool.");
      setTimeout(async () => {
        try {
          await ctx.telegram.deleteMessage(chatId, errorMsg.message_id);
        } catch (e) {}
      }, 60 * 1000);
      return;
    }

    const processingMsg = await ctx.reply("🔄 Resetting group...");
    // Delete processing message after 1 minute
    setTimeout(async () => {
      try {
        await ctx.telegram.deleteMessage(chatId, processingMsg.message_id);
      } catch (e) {
        // Ignore errors (message may already be deleted)
      }
    }, 60 * 1000);

    try {
      // Unpin the deal confirmed message if it exists
      if (escrow.dealConfirmedMessageId) {
        try {
          await ctx.telegram.unpinChatMessage(
            chatId,
            escrow.dealConfirmedMessageId,
          );
        } catch (unpinError) {
          // Ignore errors (message may already be unpinned or deleted)
        }
      }

      // Remove buyer and seller from group
      const allUsersRemoved = await GroupPoolService.removeUsersFromGroup(
        escrow,
        group.groupId,
        ctx.telegram,
      );

      // For completed trades, continue even if some users can't be removed
      // For active trades, be more strict
      if (!allUsersRemoved && !isCompleted) {
        const errorMsg = await ctx.reply(
          "⚠️ Some users could not be removed from the group. Please check manually.",
        );
        // Delete error message after 1 minute
        setTimeout(async () => {
          try {
            await ctx.telegram.deleteMessage(chatId, errorMsg.message_id);
          } catch (e) {}
        }, 60 * 1000);
        return;
      }

      // For completed trades, log warning but continue
      if (!allUsersRemoved && isCompleted) {
        // console.log(
        //   "⚠️ Some users could not be removed during reset of completed trade, continuing anyway..."
        // );
      }

      // Refresh invite link (revoke old and create new) so removed users can rejoin
      await GroupPoolService.refreshInviteLink(group.groupId, ctx.telegram);

      // Reset group pool entry
      group.status = "available";
      group.assignedEscrowId = null;
      group.assignedAt = null;
      group.completedAt = null;
      await group.save();

      // Delete the escrow since no deposits were made
      // Note: If deletion fails, the group is already reset and available.
      // The old escrow won't cause issues since it has no deposits and the group is available.
      try {
        await Escrow.deleteOne({ escrowId: escrow.escrowId });
      } catch (deleteError) {
        console.error("Error deleting escrow after group reset:", deleteError);
        // Continue anyway - group is already reset and available
      }

      const successMsg = await ctx.reply(
        "✅ Group reset successfully. Ready for new deals.",
      );
      // Delete success message after 1 minute
      setTimeout(async () => {
        try {
          await ctx.telegram.deleteMessage(chatId, successMsg.message_id);
        } catch (e) {}
      }, 60 * 1000);
    } catch (error) {
      console.error("Error resetting group:", error);
      const errorMsg = await ctx.reply(
        "❌ Error resetting group. Please check the logs.",
      );
      // Delete error message after 1 minute
      setTimeout(async () => {
        try {
          await ctx.telegram.deleteMessage(chatId, errorMsg.message_id);
        } catch (e) {}
      }, 60 * 1000);
    }
  } catch (error) {
    console.error("Error in admin group reset:", error);
    const errorMsg = await ctx.reply("❌ Error resetting group.");
    setTimeout(async () => {
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, errorMsg.message_id);
      } catch (e) {}
    }, 60 * 1000);
  }
}

/**
 * Force reset group - resets group regardless of trade status or deposits
 * Removes buyer and seller, recycles group back to pool
 */
async function adminResetForce(ctx) {
  try {
    if (!isAdmin(ctx)) {
      return ctx.reply("❌ Access denied. Admin privileges required.");
    }

    const chatId = ctx.chat.id;

    // Must be in a group
    if (chatId > 0) {
      return ctx.reply("❌ This command can only be used in a group chat.");
    }

    // Delete command message after 1 minute
    const commandMsgId = ctx.message.message_id;
    setTimeout(async () => {
      try {
        await ctx.telegram.deleteMessage(chatId, commandMsgId);
      } catch (e) {
        // Ignore errors (message may already be deleted)
      }
    }, 60 * 1000);

    // First, try to find the group in pool to get assignedEscrowId
    let group = await GroupPool.findOne({ groupId: chatId.toString() });

    // Find escrow for this group (any status)
    let escrow = null;

    if (group && group.assignedEscrowId) {
      // Try to find escrow by assignedEscrowId first
      escrow = await Escrow.findOne({
        escrowId: group.assignedEscrowId,
      });
    }

    // If not found, try to find by groupId (most recent escrow)
    if (!escrow) {
      escrow = await Escrow.findOne({
        groupId: chatId.toString(),
      }).sort({ createdAt: -1 });
    }

    if (!escrow) {
      const errorMsg = await ctx.reply("❌ No escrow found for this group.");
      setTimeout(async () => {
        try {
          await ctx.telegram.deleteMessage(chatId, errorMsg.message_id);
        } catch (e) {}
      }, 60 * 1000);
      return;
    }

    // Find the group in pool (we may have already found it above)
    if (!group) {
      group = await GroupPool.findOne({
        assignedEscrowId: escrow.escrowId,
      });
    }

    if (!group) {
      group = await GroupPool.findOne({ groupId: chatId.toString() });
    }

    if (!group) {
      const errorMsg = await ctx.reply("❌ Group not found in pool.");
      setTimeout(async () => {
        try {
          await ctx.telegram.deleteMessage(chatId, errorMsg.message_id);
        } catch (e) {}
      }, 60 * 1000);
      return;
    }

    const processingMsg = await ctx.reply("🔄 Force resetting group...");
    // Delete processing message after 1 minute
    setTimeout(async () => {
      try {
        await ctx.telegram.deleteMessage(chatId, processingMsg.message_id);
      } catch (e) {
        // Ignore errors (message may already be deleted)
      }
    }, 60 * 1000);

    try {
      // Unpin the deal confirmed message if it exists
      if (escrow.dealConfirmedMessageId) {
        try {
          await ctx.telegram.unpinChatMessage(
            chatId,
            escrow.dealConfirmedMessageId,
          );
        } catch (unpinError) {
          // Ignore errors (message may already be unpinned or deleted)
        }
      }

      // Remove buyer and seller from group (not admin)
      const allUsersRemoved = await GroupPoolService.removeUsersFromGroup(
        escrow,
        group.groupId,
        ctx.telegram,
      );

      if (!allUsersRemoved) {
      }

      // Clear escrow invite link (but keep group invite link - it's permanent)
      escrow.inviteLink = null;
      await escrow.save();

      // Refresh invite link (revoke old and create new) so removed users can rejoin
      await GroupPoolService.refreshInviteLink(group.groupId, ctx.telegram);

      // Reset group pool entry
      group.status = "available";
      group.assignedEscrowId = null;
      group.assignedAt = null;
      group.completedAt = null;
      await group.save();

      // Delete the escrow (force reset - regardless of status or deposits)
      try {
        await Escrow.deleteOne({ escrowId: escrow.escrowId });
      } catch (deleteError) {
        console.error("Error deleting escrow during force reset:", deleteError);
        // Continue anyway - group is already reset and available
      }

      const successMsg = await ctx.reply(
        "✅ Group force reset successfully. Ready for new deals.",
      );
      // Delete success message after 1 minute
      setTimeout(async () => {
        try {
          await ctx.telegram.deleteMessage(chatId, successMsg.message_id);
        } catch (e) {}
      }, 60 * 1000);
    } catch (error) {
      console.error("Error force resetting group:", error);
      const errorMsg = await ctx.reply(
        "❌ Error force resetting group. Please check the logs.",
      );
      // Delete error message after 1 minute
      setTimeout(async () => {
        try {
          await ctx.telegram.deleteMessage(chatId, errorMsg.message_id);
        } catch (e) {}
      }, 60 * 1000);
    }
  } catch (error) {
    console.error("Error in admin force reset:", error);
    const errorMsg = await ctx.reply("❌ Error force resetting group.");
    setTimeout(async () => {
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, errorMsg.message_id);
      } catch (e) {}
    }, 60 * 1000);
  }
}

/**
 * Admin reset all groups - Force reset ALL groups in the pool at once
 * Ignores escrow status and deposits - resets everything
 * Processes groups in background to avoid timeout
 */
async function adminResetAllGroups(ctx) {
  try {
    if (!isAdmin(ctx)) {
      return ctx.reply("❌ Access denied. Admin privileges required.");
    }

    const processingMsg = await ctx.reply(
      "🔄 Resetting all groups... This may take a while.",
    );

    // Store telegram instance and message info for background processing
    const telegram = ctx.telegram;
    const chatId = ctx.chat.id;
    const messageId = processingMsg.message_id;

    // Process groups in background to avoid timeout
    (async () => {
      try {
        // Get all groups from pool
        let query = {}; // Select ALL groups

        const allGroups = await GroupPool.find(query);

        if (!allGroups || allGroups.length === 0) {
          await telegram.editMessageText(
            chatId,
            messageId,
            null,
            "❌ No groups found in pool.",
          );
          setTimeout(async () => {
            try {
              await telegram.deleteMessage(chatId, messageId);
            } catch (e) {}
          }, 60 * 1000);
          return;
        }

        let successCount = 0;
        let failCount = 0;
        const results = [];

        // Helper function to update progress
        const updateProgress = async (current, total) => {
          try {
            const progressText = `🔄 Resetting all groups...\n\n📊 Progress: ${current}/${total} groups processed\n✅ Successful: ${successCount}\n❌ Failed: ${failCount}`;
            await telegram.editMessageText(
              chatId,
              messageId,
              null,
              progressText,
            );
          } catch (e) {
            // Ignore edit errors - message might be deleted or edited too frequently
          }
        };

        // Process each group
        for (let i = 0; i < allGroups.length; i++) {
          const group = allGroups[i];
          const groupId = group.groupId;

          // Update progress every 5 groups or on last group
          if ((i + 1) % 5 === 0 || i === allGroups.length - 1) {
            await updateProgress(i + 1, allGroups.length);
          }

          try {
            // Find associated escrow (if any)
            let escrow = null;
            if (group.assignedEscrowId) {
              escrow = await Escrow.findOne({
                escrowId: group.assignedEscrowId,
              });
            }

            if (!escrow) {
              escrow = await Escrow.findOne({
                groupId: groupId.toString(),
              }).sort({ createdAt: -1 });
            }

            // Verify group exists in Telegram before attempting operations
            let groupExists = false;
            try {
              await telegram.getChat(String(groupId));
              groupExists = true;
            } catch (chatError) {
              // console.log(
              //   `⚠️ Group ${groupId} does not exist in Telegram or bot has no access`
              // );
              // Group doesn't exist - just reset database entry and continue
              groupExists = false;
            }

            // Remove users from group (only if group exists)
            if (groupExists) {
              if (escrow) {
                try {
                  await GroupPoolService.removeUsersFromGroup(
                    escrow,
                    groupId,
                    telegram,
                  );
                } catch (removeError) {
                  // Continue even if user removal fails
                  // console.log(
                  //   `⚠️ Could not remove users from group ${groupId}:`,
                  //   removeError.message
                  // );
                }
              } else {
                // Try to remove users even without escrow (get admins and remove them)
                try {
                  const chatIdStr = String(groupId);
                  const adminUserId2 = config.ADMIN_USER_ID2
                    ? Number(config.ADMIN_USER_ID2)
                    : null;

                  // Get bot ID (cache it to avoid multiple calls)
                  let botId;
                  if (!adminResetAllGroups.botIdCache) {
                    try {
                      const botInfo = await telegram.getMe();
                      botId = botInfo.id;
                      adminResetAllGroups.botIdCache = botId;
                    } catch (e) {
                      botId = null;
                      adminResetAllGroups.botIdCache = null;
                    }
                  } else {
                    botId = adminResetAllGroups.botIdCache;
                  }

                  // Get all chat administrators
                  let adminMembers = [];
                  try {
                    const chatAdministrators =
                      await telegram.getChatAdministrators(chatIdStr);
                    adminMembers = chatAdministrators.map((member) =>
                      Number(member.user.id),
                    );
                  } catch (e) {
                    // Continue with empty list - group might not have admins or bot lacks permission
                  }

                  // Remove all users except bot and ADMIN_USER_ID2
                  for (const userId of adminMembers) {
                    if (
                      userId === botId ||
                      (adminUserId2 && userId === adminUserId2)
                    ) {
                      continue;
                    }
                    try {
                      const untilDate = Math.floor(Date.now() / 1000) + 60;
                      await telegram.kickChatMember(
                        chatIdStr,
                        userId,
                        untilDate,
                      );
                      // Immediately unban so they can rejoin
                      await telegram.unbanChatMember(chatIdStr, userId);
                    } catch (e) {
                      // Ignore errors - user might have already left or bot lacks permission
                    }
                  }
                } catch (removeError) {
                  // Continue even if user removal fails
                  // console.log(
                  //   `⚠️ Could not remove users from group ${groupId}:`,
                  //   removeError.message
                  // );
                }
              }
            }

            // Refresh invite link (has built-in 2 second delay) - only if group exists
            if (groupExists) {
              try {
                await GroupPoolService.refreshInviteLink(groupId, telegram);
              } catch (linkError) {
                // Continue anyway - group can still be reset
              }
            } else {
              // Group doesn't exist - just clear the invite link in database
              const freshGroupForLink = await GroupPool.findOne({
                groupId: groupId,
              });
              if (freshGroupForLink && freshGroupForLink.inviteLink) {
                freshGroupForLink.inviteLink = null;
                freshGroupForLink.inviteLinkHasJoinRequest = false;
                try {
                  await freshGroupForLink.save();
                } catch (e) {
                  // Ignore save errors
                }
              }
            }

            // Reset group pool entry - re-fetch to ensure we have latest state
            const freshGroup = await GroupPool.findOne({ groupId: groupId });
            if (freshGroup) {
              freshGroup.status = "available";
              freshGroup.assignedEscrowId = null;
              freshGroup.assignedAt = null;
              freshGroup.completedAt = null;
              try {
                await freshGroup.save();
              } catch (saveError) {
                console.error(
                  `⚠️ Could not save group ${groupId}:`,
                  saveError.message,
                );
                // Continue - try to reset next group
              }
            } else {
            }

            if (escrow) {
              try {
                await Escrow.deleteOne({ escrowId: escrow.escrowId });
              } catch (deleteError) {}
            }

            successCount++;
            results.push({ groupId, status: "success" });
          } catch (error) {
            failCount++;
            results.push({ groupId, status: "failed", error: error.message });
            console.error(`Error resetting group ${groupId}:`, error);
          }

          if (i < allGroups.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }

        const summary = `✅ Reset Complete!

📊 Results:
• Total Groups: ${allGroups.length}
• ✅ Successful: ${successCount}
• ❌ Failed: ${failCount}

All groups have been reset to 'available' status.`;

        await telegram.editMessageText(chatId, messageId, null, summary);

        setTimeout(async () => {
          try {
            await telegram.deleteMessage(chatId, messageId);
          } catch (e) {}
        }, 120 * 1000);
      } catch (error) {
        console.error("Error in admin reset all groups (background):", error);
        try {
          await telegram.editMessageText(
            chatId,
            messageId,
            null,
            `❌ Error resetting groups: ${error.message}`,
          );
          setTimeout(async () => {
            try {
              await telegram.deleteMessage(chatId, messageId);
            } catch (e) {}
          }, 60 * 1000);
        } catch (editError) {
          console.error("Error editing message:", editError);
        }
      }
    })();

    return;
  } catch (error) {
    console.error("Error in admin reset all groups:", error);
    ctx.reply("❌ Error resetting all groups. Please check the logs.");
  }
}

async function adminWithdrawExcess(ctx) {
  try {
    if (!isAdmin(ctx)) {
      return ctx.reply("❌ Access denied. Admin privileges required.");
    }

    const chatId = ctx.chat.id;

    if (chatId <= 0) {
      return ctx.reply(
        "❌ This command can only be used in a private chat with the bot.",
      );
    }

    const activeEscrows = await Escrow.countDocuments({
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

    let groupQuery = { status: "assigned" };

    const assignedGroups = await GroupPool.countDocuments(groupQuery);

    const hasActiveTrades = activeEscrows > 0 || assignedGroups > 0;

    if (hasActiveTrades) {
      const warningMessage = `⚠️ **WARNING: Active Trades Detected**

📊 **Status:**
• Active Escrows: ${activeEscrows}
• Assigned Groups: ${assignedGroups}

🔴 **Proceeding with withdrawal while trades are active may result in user funds being withdrawn!**

Please wait until all trades are completed, or proceed at your own risk.

**Choose an action:**`;

      const { Markup } = require("telegraf");
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("❌ Cancel", "withdraw_cancel")],
        [Markup.button.callback("⚠️ Proceed Anyway", "withdraw_proceed")],
      ]);

      await ctx.reply(warningMessage, {
        parse_mode: "Markdown",
        ...keyboard,
      });

      return;
    }

    await requestWithdrawConfirmation(ctx);
  } catch (error) {
    console.error("Error in admin withdraw excess:", error);
    ctx.reply("❌ Error processing withdrawal request. Please check the logs.");
  }
}

async function requestWithdrawConfirmation(ctx) {
  try {
    const adminWallet = config.FEE_WALLET_BSC;

    if (!adminWallet) {
      return ctx.reply(
        "❌ FEE_WALLET_BSC is not set in environment variables.",
      );
    }

    const confirmationMessage = `⚠️ **CONFIRM WITHDRAWAL**

📋 **Withdrawal Details:**
• Target Wallet: \`${adminWallet}\`
• Token: USDT (BSC)
• Reserve Amount: ${config.CONTRACT_USDT_RESERVE} USDT per contract

This will withdraw excess USDT from all escrow contracts (above reserve amount) to the admin wallet.

⚠️ **This action cannot be undone!**

Please confirm to proceed:`;

    const { Markup } = require("telegraf");
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback("❌ Cancel", "withdraw_cancel")],
      [Markup.button.callback("✅ Confirm Withdrawal", "withdraw_confirm")],
    ]);

    await ctx.reply(confirmationMessage, {
      parse_mode: "Markdown",
      ...keyboard,
    });
  } catch (error) {
    console.error("Error requesting withdrawal confirmation:", error);
    ctx.reply("❌ Error requesting confirmation.");
  }
}

async function executeWithdrawExcess(ctx) {
  try {
    const {
      MONGODB_URI,
      BSC_RPC_URL,
      HOT_WALLET_PRIVATE_KEY,
      FEE_WALLET_BSC,
      CONTRACT_USDT_RESERVE,
    } = config;

    if (!MONGODB_URI) {
      throw new Error("MONGODB_URI missing");
    }
    if (!BSC_RPC_URL) {
      throw new Error("BSC_RPC_URL missing");
    }
    if (!HOT_WALLET_PRIVATE_KEY) {
      throw new Error("HOT_WALLET_PRIVATE_KEY missing");
    }
    if (!FEE_WALLET_BSC) {
      throw new Error("FEE_WALLET_BSC missing");
    }

    const reserveAmount = CONTRACT_USDT_RESERVE;
    if (!Number.isFinite(reserveAmount) || reserveAmount < 0) {
      throw new Error("Invalid reserve amount");
    }

    const tokenAddress = config.USDT_BSC;
    if (!tokenAddress || !ethers.isAddress(tokenAddress)) {
      throw new Error("USDT_BSC address missing/invalid in config");
    }

    if (!ethers.isAddress(FEE_WALLET_BSC)) {
      throw new Error("FEE_WALLET_BSC address is invalid");
    }

    const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
    if (!chatId || chatId <= 0) {
      throw new Error(
        "Invalid chat context - command must be used in private chat",
      );
    }

    const processingMsg = await ctx.reply(
      "🔄 Processing withdrawal... This may take a few minutes.",
    );

    const mongoose = require("mongoose");

    const ESCROW_VAULT_ABI = [
      "function owner() view returns (address)",
      "function withdrawToken(address erc20Token, address to) external",
    ];

    const ERC20_ABI = [
      "function balanceOf(address account) view returns (uint256)",
      "function decimals() view returns (uint8)",
      "function symbol() view returns (string)",
      "function transfer(address to, uint256 amount) returns (bool)",
    ];

    const provider = new ethers.JsonRpcProvider(BSC_RPC_URL);
    const privateKey = HOT_WALLET_PRIVATE_KEY.startsWith("0x")
      ? HOT_WALLET_PRIVATE_KEY
      : `0x${HOT_WALLET_PRIVATE_KEY}`;
    const wallet = new ethers.Wallet(privateKey, provider);

    // console.log(`👤 Hot wallet: ${wallet.address}`);
    // console.log(`👤 Fee wallet (BSC): ${FEE_WALLET_BSC}`);
    // console.log(`🔄 Target reserve per contract: ${reserveAmount} USDT\n`);

    await mongoose.connect(MONGODB_URI);

    const ContractModel = require("../models/Contract");
    const contracts = await ContractModel.find({
      name: "EscrowVault",
      token: "USDT",
      network: "BSC",
      status: "deployed",
    }).sort({ createdAt: 1 });

    if (!contracts.length) {
      try {
        await ctx.telegram.editMessageText(
          chatId,
          processingMsg.message_id,
          null,
          "❌ No USDT EscrowVault contracts found.",
        );
      } catch (editError) {
        // Fallback to reply if edit fails
        await ctx.reply("❌ No USDT EscrowVault contracts found.");
      }
      await mongoose.disconnect();
      return;
    }

    const tokenContract = new ethers.Contract(
      tokenAddress,
      ERC20_ABI,
      provider,
    );
    const tokenWithSigner = tokenContract.connect(wallet);
    const decimals = await tokenContract.decimals();
    const decimalsNum = Number(decimals);
    const reserveWei = ethers.parseUnits(reserveAmount.toString(), decimals);
    const epsilon = Number(1 / 10 ** Math.min(decimalsNum, 8));

    let processed = 0;
    let skipped = 0;
    let totalWithdrawn = 0n;

    for (const contract of contracts) {
      const contractAddress = contract.address;

      const vaultContract = new ethers.Contract(
        contractAddress,
        ESCROW_VAULT_ABI,
        wallet,
      );
      const owner = await vaultContract.owner();
      if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
        // console.log(`⚠️  Skipping ${contractAddress}: wallet is not the owner`);
        skipped += 1;
        continue;
      }

      const balanceRaw = await tokenContract.balanceOf(contractAddress);
      const balance = Number(ethers.formatUnits(balanceRaw, decimals));

      if (balance <= reserveAmount + epsilon) {
        skipped += 1;
        continue;
      }

      // Calculate excess amount (BigInt subtraction)
      const excessRaw = balanceRaw - reserveWei;
      if (excessRaw <= 0n) {
        skipped += 1;
        continue;
      }

      try {
        const withdrawTx = await vaultContract.withdrawToken(
          tokenAddress,
          wallet.address,
        );
        await withdrawTx.wait();

        const transferTx = await tokenWithSigner.transfer(
          FEE_WALLET_BSC,
          excessRaw,
        );
        await transferTx.wait();

        const depositTx = await tokenWithSigner.transfer(
          contractAddress,
          reserveWei,
        );
        await depositTx.wait();

        totalWithdrawn += excessRaw;
        processed += 1;

        // Small delay to avoid nonce contention
        await new Promise((resolve) => setTimeout(resolve, 1500));
      } catch (error) {
        console.error(`❌ Error processing ${contractAddress}:`, error.message);
        skipped += 1;
      }
    }

    await mongoose.disconnect();

    const totalWithdrawnFormatted =
      totalWithdrawn > 0n ? ethers.formatUnits(totalWithdrawn, decimals) : "0";
    const summary = `✅ **WITHDRAWAL COMPLETE**

📊 **Summary:**
• Contracts processed: ${processed}
• Contracts skipped: ${skipped}
• Total withdrawn: ${parseFloat(totalWithdrawnFormatted).toFixed(6)} USDT
• Sent to: \`${FEE_WALLET_BSC}\`

All excess funds have been withdrawn successfully.`;

    try {
      await ctx.telegram.editMessageText(
        chatId,
        processingMsg.message_id,
        null,
        summary,
        { parse_mode: "Markdown" },
      );
    } catch (editError) {
      // Fallback to reply if edit fails (message might have been deleted)
      await ctx.reply(summary, { parse_mode: "Markdown" });
    }
  } catch (error) {
    console.error("❌ Error executing withdrawal:", error);
    try {
      await ctx.reply(`❌ Error executing withdrawal: ${error.message}`);
    } catch (replyError) {
      console.error("Error sending error message:", replyError);
    }
    // Ensure mongoose is disconnected on error
    try {
      if (mongoose.connection.readyState === 1) {
        await mongoose.disconnect();
      }
    } catch (disconnectError) {
      console.error("Error disconnecting mongoose:", disconnectError);
    }
  }
}

/**
 * Admin command to withdraw excess USDT from BSC escrow contracts
 */
async function adminWithdrawBscUsdt(ctx) {
  await executeWithdrawExcess(ctx);
}

/**
 * Generic handler for checking and withdrawing accumulated fees
 */
const handleWithdrawFees = async (ctx, networkInput, tokenInput) => {
  if (!isAdmin(ctx)) return;

  const network = networkInput ? networkInput.toUpperCase() : "BSC";
  const token = tokenInput ? tokenInput.toUpperCase() : "USDT";

  try {
    const blockchainService = new BlockchainService();
    await blockchainService.initialize();

    const settings = await blockchainService.getFeeSettings(token, network);
    const accumulated = settings.accumulated;

    if (parseFloat(accumulated) === 0) {
      return ctx.reply(`⚠️ No fees accumulated for ${token} on ${network}.`);
    }

    let msg = `💰 <b>Withdraw Fee Confirmation</b>\n\n`;
    msg += `<b>Chain:</b> ${network}\n`;
    msg += `<b>Token:</b> ${token}\n`;
    msg += `<b>Total Fees:</b> ${accumulated}\n\n`;
    msg += `<b>Target Fees Wallet:</b> <code>${settings.feeWallet}</code>\n`;
    msg += `└ Share: 100%\n\n`;
    msg += `❓ Do you confirm this withdrawal?`;

    await ctx.reply(msg, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "✅ Yes, Withdraw",
              callback_data: `confirm_withdraw_${network}_${token}`,
            },
            {
              text: "❌ Cancel",
              callback_data: `cancel_withdraw`,
            },
          ],
        ],
      },
    });
  } catch (error) {
    console.error("Fee check error:", error);
    const errParams = error?.message || "Unknown error";
    await ctx.reply(`❌ Failed to fetch fee details: ${errParams}`);
  }
};

async function adminWithdrawFees(ctx) {
  const args = ctx.message.text.split(" ").slice(1);
  await handleWithdrawFees(ctx, args[0], args[1]);
}

async function adminWithdrawFeesBscUsdt(ctx) {
  await handleWithdrawFees(ctx, "BSC", "USDT");
}

async function adminWithdrawFeesBscUsdc(ctx) {
  await handleWithdrawFees(ctx, "BSC", "USDC");
}

/**
 * Withdraw all funds from all contracts in a specific room
 * Usage: /withdraw_room_10 (withdraws from MM Room 10)
 */
async function adminWithdrawRoom(ctx) {
  if (!isAdmin(ctx)) return;

  const text = ctx.message.text.trim();
  const match = text.match(/^\/withdraw_room_(\d+)$/i);

  if (!match) {
    return ctx.reply(
      "❌ Invalid command format.\n\nUsage: `/withdraw_room_X`\nExample: `/withdraw_room_10`",
      { parse_mode: "Markdown" },
    );
  }

  const roomNumber = parseInt(match[1], 10);

  try {
    const statusMsg = await ctx.reply(
      `🔍 Finding MM Room ${roomNumber} and scanning contracts...`,
    );

    // Find group by title
    const group = await GroupPool.findOne({
      groupTitle: { $regex: new RegExp(`^MM Room ${roomNumber}$`, "i") },
    });

    if (!group) {
      return ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        `❌ MM Room ${roomNumber} not found in database.`,
      );
    }

    if (!group.contracts || group.contracts.size === 0) {
      return ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        `❌ MM Room ${roomNumber} has no contracts assigned.`,
      );
    }

    const FEE_WALLET_BSC = config.FEE_WALLET_BSC;
    const FEE_WALLET_TRC = config.FEE_WALLET_TRC;

    if (!FEE_WALLET_BSC && !FEE_WALLET_TRC) {
      return ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        "❌ No fee wallets configured. Set FEE_WALLET_BSC or FEE_WALLET_TRC in .env",
      );
    }

    const results = [];
    let successCount = 0;
    let skipCount = 0;
    let errorCount = 0;

    // Iterate over all contracts in the group
    for (const [key, contract] of group.contracts) {
      const { address, network } = contract;
      const networkUpper = (network || "BSC").toUpperCase();

      // Determine token from key (e.g., "USDT", "USDC", "USDT_TRON")
      const token = key.includes("_") ? key.split("_")[0] : key;

      try {
        // Determine fee wallet based on network
        const feeWallet =
          networkUpper === "TRON" || networkUpper === "TRX"
            ? FEE_WALLET_TRC
            : FEE_WALLET_BSC;

        if (!feeWallet) {
          results.push(
            `⚠️ [${key}] Skipped - No fee wallet for ${networkUpper}`,
          );
          skipCount++;
          continue;
        }

        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          null,
          `🔄 Processing ${key} (${networkUpper})...\n\nContract: \`${address.slice(
            0,
            10,
          )}...\``,
          { parse_mode: "Markdown" },
        );

        // Call appropriate withdrawal method
        const result = await BlockchainService.withdrawToken(
          token,
          networkUpper,
          address,
          feeWallet,
        );

        if (result && result.success) {
          results.push(
            `✅ [${key}] Withdrawn → ${
              result.transactionHash
                ? result.transactionHash.slice(0, 16) + "..."
                : "Success"
            }`,
          );
          successCount++;
        } else {
          results.push(`⚠️ [${key}] No funds or already empty`);
          skipCount++;
        }

        // Small delay to avoid nonce issues
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch (error) {
        console.error(
          `Error withdrawing ${key} from Room ${roomNumber}:`,
          error.message,
        );
        results.push(`❌ [${key}] Error: ${error.message.slice(0, 50)}`);
        errorCount++;
      }
    }

    // Build summary
    const summary = `🏠 **Withdraw Complete - MM Room ${roomNumber}**

📊 **Summary:**
• ✅ Success: ${successCount}
• ⚠️ Skipped: ${skipCount}
• ❌ Errors: ${errorCount}

📋 **Details:**
${results.join("\n")}`;

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      summary,
      { parse_mode: "Markdown" },
    );
  } catch (error) {
    console.error("Error in adminWithdrawRoom:", error);
    await ctx.reply(`❌ Error: ${error.message}`);
  }
}

// Action handlers need to be registered in the bot setup or exported if index.js handles them
// implementation_plan calls for registering commands in index.js, but actions are usually handled via regex in main bot.
// Since we are changing to object export, we can't register actions here unless we expose a setup function OR index.js does it.
// We will export a setup function for actions/listeners AND the individual commands.

function setupAdminActions(bot) {
  bot.action(/^confirm_withdraw_([^_]+)_([^_]+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized");

    // We match network (group 1) and token (group 2)
    const network = ctx.match[1];
    const token = ctx.match[2];

    try {
      await ctx.answerCbQuery("Processing withdrawal...");
      await ctx.editMessageText(
        `⏳ Withdrawing fees for ${token} on ${network}...`,
        { parse_mode: "HTML" },
      );

      const blockchainService = new BlockchainService();
      await blockchainService.initialize();

      // Use sweep logic (withdrawToken) instead of specific withdrawFees
      // The fee wallet is already defined in config/contract
      const settings = await blockchainService.getFeeSettings(token, network);
      const targetWallet = settings.feeWallet;

      // We need to know contract address to sweep from
      const vault = await blockchainService.getVaultForNetwork(network, token);
      const contractAddress = await vault.getAddress();

      const result = await blockchainService.withdrawToken(
        token,
        network,
        contractAddress,
        targetWallet,
      );

      let msg = `✅ <b>Fees Withdrawn Successfully!</b>\n\n`;
      msg += `<b>Chain:</b> ${network}\n`;
      msg += `<b>Token:</b> ${token}\n`;
      msg += `<b>Block:</b> ${result.blockNumber}\n`;
      msg += `<b>Tx Hash:</b> <code>${result.transactionHash}</code>`;
      msg += `\n<b>Sent to:</b> <code>${targetWallet}</code>`;

      await ctx.editMessageText(msg, { parse_mode: "HTML" });
    } catch (error) {
      console.error("Withdraw fees error:", error);
      const errParams = error?.message || "Unknown error";
      await ctx.editMessageText(`❌ Failed to withdraw fees: ${errParams}`);
    }
  });

  bot.action("cancel_withdraw", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized");
    await ctx.answerCbQuery("Cancelled");
    await ctx.deleteMessage();
  });
}

module.exports = {
  adminStats,
  adminGroupPool,
  adminPoolAdd,
  adminPoolList,
  adminPoolDelete,
  adminPoolDeleteAll,
  adminAddressPool,
  adminInitAddresses,
  adminCleanupAddresses,
  adminWarnInactive,
  adminRemoveInactive,
  adminTradeStats,
  adminRecentTrades,
  adminExportTrades,
  adminGroupReset,
  adminResetForce,
  adminResetAllGroups,
  adminResetForce,
  adminResetAllGroups,
  adminWithdrawAllBsc,
  adminWithdrawAllTron,
  adminWithdrawFees,
  adminWithdrawNetworkFees,
  adminWithdrawRoom,
  adminHelp,
  setupAdminActions,
};

async function adminWithdrawAllBsc(ctx) {
  if (!isAdmin(ctx)) return;
  // Run in background to avoid timeout
  handleWithdrawAll(ctx, "BSC").catch((err) =>
    console.error("Background BSC withdraw error:", err),
  );
}

async function adminWithdrawAllTron(ctx) {
  if (!isAdmin(ctx)) return;
  // Run in background to avoid timeout
  handleWithdrawAll(ctx, "TRON").catch((err) =>
    console.error("Background TRON withdraw error:", err),
  );
}

/**
 * Validates and consolidates withdrawals for a network
 */
async function handleWithdrawAll(ctx, network) {
  try {
    const statusMsg = await ctx.reply(
      `🔍 Scanning ${network} contracts for fees...`,
    );

    const contracts = await Contract.find({
      network: network.toUpperCase(),
      status: "deployed",
    });

    if (contracts.length === 0) {
      return ctx.reply(`❌ No deployed contracts found for ${network}.`);
    }

    // BlockchainService is a singleton, no need to instantiate
    const bs = BlockchainService;

    const totalFeeTokens = {};
    const surplusSweeps = [];

    for (const contract of contracts) {
      const decimals = bs.getTokenDecimals(contract.token, network);

      // Consolidated Withdrawal: Sweep entire balance to Fee Wallet
      // Priorities: 1. Contract's Fee Wallet 2. Config Fee Wallet

      let targetWallet = null;
      try {
        const settings = await bs.getFeeSettings(contract.token, network);
        if (
          settings.feeWallet &&
          settings.feeWallet !== ethers.ZeroAddress &&
          settings.feeWallet !== "410000000000000000000000000000000000000000"
        ) {
          targetWallet = settings.feeWallet;
        }
      } catch (e) {}

      if (!targetWallet) {
        targetWallet = network.toUpperCase().includes("TRON")
          ? config.FEE_WALLET_TRC
          : config.FEE_WALLET_BSC;
      }

      if (targetWallet) {
        try {
          // Check balance first
          const contractBalance = await bs.getTokenBalance(
            contract.token,
            network,
            contract.address,
          );

          if (contractBalance > 0) {
            const result = await bs.withdrawToken(
              contract.token,
              network,
              contract.address,
              targetWallet,
            );

            if (result.success) {
              // Log as fee withdrawal for reporting
              const amt = parseFloat(result.amount || contractBalance);
              totalFeeTokens[contract.token] =
                (totalFeeTokens[contract.token] || 0) + amt;

              // Also add to surplus list for detailed TX log
              surplusSweeps.push({
                token: contract.token,
                amount: amt,
                tx: result.transactionHash,
              });
            }
          }
        } catch (e) {
          console.error(`Error sweeping ${contract.token}:`, e.message);
        }
      }

      // 3. Rate Limit Protection
      // TRON requires slower pacing due to aggressive rate limits on free nodes
      const delay = network.toUpperCase().includes("TRON") ? 5000 : 200;
      // console.log(`[Admin] Processed ${contract.address} (${contract.token}). Waiting ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    let report = `💸 <b>${network} FEE WITHDRAWAL REPORT</b>\n\n`;

    // Fees Section
    const feeTokens = Object.keys(totalFeeTokens);
    if (feeTokens.length > 0) {
      report += `💰 <b>Fees Withdrawn:</b>\n`;
      feeTokens.forEach((t) => {
        report += `• ${totalFeeTokens[t].toFixed(4)} ${t}\n`;
      });
    } else {
      report += `💰 <b>Fees Withdrawn:</b> None\n`;
    }

    report += `\n`;

    // Surplus Section
    if (surplusSweeps.length > 0) {
      report += `🧹 <b>Surplus Swept:</b>\n`;
      surplusSweeps.forEach((item) => {
        const txDisplay = item.tx
          ? ` (<a href="https://bscscan.com/tx/${item.tx}">TX</a>)`
          : "";
        // Note: Link format depends on network, generalizing:
        report += `• ${item.amount.toFixed(4)} ${item.token} (TX: <code>${
          item.tx
        }</code>)\n`;
      });
    } else {
      report += `🧹 <b>Surplus Swept:</b> None`;
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      report,
      { parse_mode: "HTML", disable_web_page_preview: true },
    );
  } catch (error) {
    console.error("Error in withdraw all:", error);
    ctx.reply(`❌ Error: ${error.message}`);
  }
}
