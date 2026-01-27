const User = require("../models/User");

class UserStatsService {
  /**
   * Get user stats with global ranks
   * @param {Object} params - { telegramId, username }
   */
  async getUserStats({ telegramId, username }) {
    let user = null;

    if (telegramId) {
      user = await User.findOne({ telegramId: Number(telegramId) });
    } else if (username) {
      // Case-insensitive username search
      const users = await User.find({
        username: { $regex: new RegExp(`^${username}$`, "i") },
      })
        .sort({ lastActive: -1 })
        .limit(1);
      user = users[0];
    }

    if (!user) {
      return null;
    }

    const [buyRank, sellRank, overallRank] = await Promise.all([
      User.countDocuments({
        totalBoughtVolume: { $gt: user.totalBoughtVolume },
      }),
      User.countDocuments({
        totalSoldVolume: { $gt: user.totalSoldVolume },
      }),
      User.countDocuments({
        totalTradedVolume: { $gt: user.totalTradedVolume },
      }),
    ]);

    const userObj = user.toObject();
    userObj.globalBuyRank = buyRank + 1;
    userObj.globalSellRank = sellRank + 1;
    userObj.overallGlobalRank = overallRank + 1;

    return userObj;
  }

  /**
   * Format stats message
   * @param {Object} user - User stats object
   */
  formatStatsMessage(user) {
    if (!user) {
      return "❌ User stats not found.";
    }

    const formatCurrency = (amount) => {
      return amount.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    };

    const usernameDisplay = user.username
      ? `@${user.username}`
      : `User ${user.telegramId}`;

    const totalBought = formatCurrency(user.totalBoughtVolume);
    const totalBuyTrades = user.totalBoughtTrades;
    const buyRank = user.globalBuyRank || "N/A";

    const totalSold = formatCurrency(user.totalSoldVolume);
    const totalSellTrades = user.totalSoldTrades;
    const sellRank = user.globalSellRank || "N/A";

    const lifetimeVolume = formatCurrency(user.totalTradedVolume);
    const totalDeals = user.totalCompletedTrades;
    const totalParticipated = user.totalParticipatedTrades;

    let completionRate = 0;
    if (totalParticipated > 0) {
      completionRate = (totalDeals / totalParticipated) * 100;
    }
    const completionRateStr = `${completionRate.toFixed(1)}%`;
    const overallRank = user.overallGlobalRank || "N/A";

    let lastTradeSection = "";
    if (user.lastTradeAmount && user.lastTradeRole) {
      const isBuy = user.lastTradeRole === "buyer";
      const roleIcon = isBuy ? "🟢" : "🔻";
      const roleName = isBuy ? "Bought" : "Sold";
      const amount = formatCurrency(user.lastTradeAmount);
      const token = user.lastTradeToken || "USDT";

      const counterparty = user.lastTradeCounterparty
        ? user.lastTradeCounterparty.startsWith("@")
          ? user.lastTradeCounterparty
          : `@${user.lastTradeCounterparty}`
        : "N/A";

      let dateStr = "N/A";
      if (user.lastTradeAt) {
        const d = new Date(user.lastTradeAt);
        const day = d.getDate();
        const month = d.toLocaleString("en-US", { month: "short" });
        const time = d.toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
        });
        dateStr = `${day} ${month}, ${time}`;
      }

      lastTradeSection = `
⏱ LAST TRADE
${roleIcon} ${roleName} <code>${amount} ${token}</code>
👤 With: ${counterparty}
📅 <code>${dateStr}</code>`;
    }

    const quoteHeader = `📊 ${usernameDisplay} — Stats`;
    // Note: Using blockquote expandable for the requested style.
    const quoteBody = `
🟢 BUYING STATS
• Total Bought: $${totalBought}
• Total Buy Trades: ${totalBuyTrades}

🔴 SELLING STATS
• Total Sold: $${totalSold}
• Total Sell Trades: ${totalSellTrades}`;

    return `<blockquote expandable>${quoteHeader}${quoteBody}</blockquote>

📈 OVERALL PERFORMANCE
• Lifetime Volume: $${lifetimeVolume}
• Total Deals: ${totalDeals}
• Completion Rate: ${completionRateStr} (${totalDeals} / ${totalParticipated})
🏆 Overall Global Rank: #${overallRank} Trader${lastTradeSection}`;
  }

  /**
   * Get date filter for a time period
   * @param {string} period - 'week', 'month', 'year', or 'all'
   * @returns {Date|null} Start date for filter, null for 'all'
   */
  getDateFilterFromPeriod(period) {
    const now = new Date();
    switch (period) {
      case "week":
        return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      case "month":
        return new Date(now.getFullYear(), now.getMonth(), 1);
      case "year":
        return new Date(now.getFullYear(), 0, 1);
      case "all":
      default:
        return null;
    }
  }

  /**
   * Get leaderboard stats filtered by time period
   * @param {string} period - 'week', 'month', 'year', or 'all'
   */
  async getLeaderboardByPeriod(period = "all") {
    const Escrow = require("../models/Escrow");
    const startDate = this.getDateFilterFromPeriod(period);

    // Build date filter for completedAt
    const dateFilter = startDate ? { completedAt: { $gte: startDate } } : {};

    // Get top traders by volume for this period
    const topTradersAgg = await Escrow.aggregate([
      { $match: { status: "completed", ...dateFilter } },
      {
        $facet: {
          buyers: [
            {
              $group: {
                _id: "$buyerId",
                username: { $first: "$buyerUsername" },
                volume: { $sum: "$quantity" },
              },
            },
            { $sort: { volume: -1 } },
            { $limit: 5 },
          ],
          sellers: [
            {
              $group: {
                _id: "$sellerId",
                username: { $first: "$sellerUsername" },
                volume: { $sum: "$quantity" },
              },
            },
            { $sort: { volume: -1 } },
            { $limit: 5 },
          ],
          overall: [
            {
              $project: {
                participants: [
                  {
                    id: "$buyerId",
                    username: "$buyerUsername",
                    amount: "$quantity",
                  },
                  {
                    id: "$sellerId",
                    username: "$sellerUsername",
                    amount: "$quantity",
                  },
                ],
              },
            },
            { $unwind: "$participants" },
            {
              $group: {
                _id: "$participants.id",
                username: { $first: "$participants.username" },
                volume: { $sum: "$participants.amount" },
              },
            },
            { $sort: { volume: -1 } },
            { $limit: 5 },
          ],
          stats: [
            {
              $group: {
                _id: null,
                totalDeals: { $sum: 1 },
                totalVolume: { $sum: "$quantity" },
              },
            },
          ],
        },
      },
    ]);

    const result = topTradersAgg[0] || {
      buyers: [],
      sellers: [],
      overall: [],
      stats: [],
    };
    const stats = result.stats[0] || { totalDeals: 0, totalVolume: 0 };

    return {
      topBuyers: result.buyers.map((u) => ({
        telegramId: u._id,
        username: u.username,
        volume: u.volume,
      })),
      topSellers: result.sellers.map((u) => ({
        telegramId: u._id,
        username: u.username,
        volume: u.volume,
      })),
      topOverall: result.overall.map((u) => ({
        telegramId: u._id,
        username: u.username,
        volume: u.volume,
      })),
      totalDeals: stats.totalDeals,
      totalVolume: stats.totalVolume,
      period,
    };
  }

  /**
   * Format leaderboard with period filter
   */
  formatLeaderboardWithPeriod(data) {
    const formatCurrency = (val) =>
      Number(val || 0).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

    const periodLabels = {
      week: "📅 This Week",
      month: "📆 This Month",
      year: "📊 This Year",
      all: "🌍 All Time",
    };

    const periodLabel = periodLabels[data.period] || "All Time";
    const medals = ["🥇", "🥈", "🥉", "🏅", "🏅"];
    const formatUser = (u) =>
      u.username ? `@${u.username}` : `User ${u.telegramId || "?"}`;

    let msg = `<b>${periodLabel} LEADERBOARD</b>\n\n`;
    msg += `📊 <b>Total:</b> ${data.totalDeals} trades | ${formatCurrency(
      data.totalVolume,
    )} USDT\n\n`;

    msg += `<b>🏆 TOP TRADERS</b>\n`;
    if (data.topOverall.length === 0) {
      msg += `<i>No trades in this period.</i>\n`;
    } else {
      data.topOverall.forEach((u, i) => {
        msg += `${medals[i] || "🏅"} #${i + 1} ${formatUser(
          u,
        )} — ${formatCurrency(u.volume)} USDT\n`;
      });
    }

    return msg;
  }

  /**
   * Get high level stats for main leaderboard
   */
  async getHighLevelStats() {
    const Escrow = require("../models/Escrow");

    // Top 5 Traders by Volume
    const topTraders = await User.find({ totalTradedVolume: { $gt: 0 } })
      .sort({ totalTradedVolume: -1 })
      .limit(5);

    // Global Stats
    const Stats = require("../models/Stats");

    // Global Stats (Preferred from Aggregated Collection)
    const statsDoc = await Stats.findOne({ key: "global" });

    let totalDeals = 0;
    let totalVolume = 0;

    if (statsDoc) {
      totalDeals = statsDoc.totalCompletedTrades || 0;
      totalVolume = statsDoc.totalCompletedVolume || 0;
    } else {
      // Fallback to aggregation (expensive and potentially inaccurate if history is messy)
      const totalStats = await Escrow.aggregate([
        { $match: { status: "completed" } },
        {
          $group: {
            _id: null,
            totalDeals: { $sum: 1 },
            totalVolume: { $sum: "$quantity" },
          },
        },
      ]);
      const aggResult = totalStats[0] || { totalDeals: 0, totalVolume: 0 };
      totalDeals = aggResult.totalDeals;
      totalVolume = aggResult.totalVolume;
    }

    const globalStats = { totalDeals, totalVolume };

    // Common projection for deal stats
    const dealProjection = {
      duration: 1,
      quantity: 1,
      token: 1,
      buyerUsername: 1,
      sellerUsername: 1,
      buyerId: 1,
      sellerId: 1,
    };

    // Highest Deal
    const highestDeal = await Escrow.findOne({ status: "completed" })
      .sort({ quantity: -1 })
      .select("quantity token buyerUsername sellerUsername buyerId sellerId");

    // Lowest Deal
    const lowestDeal = await Escrow.findOne({ status: "completed" })
      .sort({ quantity: 1 })
      .select("quantity token buyerUsername sellerUsername buyerId sellerId");

    // Shortest Deal (Aggregation)
    const shortestDealAgg = await Escrow.aggregate([
      {
        $match: {
          status: "completed",
          tradeStartTime: { $exists: true, $ne: null },
        },
      },
      {
        $addFields: {
          duration: {
            $subtract: [
              { $ifNull: ["$completedAt", "$updatedAt"] },
              "$tradeStartTime",
            ],
          },
        },
      },
      { $match: { duration: { $gt: 0 } } },
      { $sort: { duration: 1 } },
      { $limit: 1 },
      { $project: dealProjection },
    ]);

    // Longest Deal (Aggregation)
    const longestDealAgg = await Escrow.aggregate([
      {
        $match: {
          status: "completed",
          tradeStartTime: { $exists: true, $ne: null },
        },
      },
      {
        $addFields: {
          duration: {
            $subtract: [
              { $ifNull: ["$completedAt", "$updatedAt"] },
              "$tradeStartTime",
            ],
          },
        },
      },
      { $sort: { duration: -1 } },
      { $limit: 1 },
      { $project: dealProjection },
    ]);

    return {
      topTraders,
      globalStats,
      highestDeal,
      lowestDeal,
      shortest: shortestDealAgg[0],
      longest: longestDealAgg[0],
    };
  }

  formatDuration(ms) {
    if (!ms) return "N/A";
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);
    const days = Math.floor(ms / (1000 * 60 * 60 * 24));

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 && days === 0) parts.push(`${seconds}s`); // Only show seconds if duration is short

    return parts.join(" ") || "0s";
  }

  formatMainLeaderboard({
    topTraders,
    globalStats,
    highestDeal,
    lowestDeal,
    shortest,
    longest,
  }) {
    const formatCurrency = (val) =>
      Number(val).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

    // Helper to format volume like "300K"
    const formatKVolume = (val) => {
      const v = Number(val);
      if (v >= 1000000) return (v / 1000000).toFixed(1) + "M";
      if (v >= 1000) return (v / 1000).toFixed(0) + "K";
      return v.toFixed(0);
    };

    const medals = ["🥇", "🥈", "🥉", "🏅", "🏅"];
    const formatUser = (u) =>
      u.username ? `@${u.username}` : `User ${u.telegramId}`;

    let msg = `🌍 <b>GLOBAL LEADERBOARD</b>

🏆 <b>TOP TRADERS — OVERALL VOLUME</b>

`;

    if (topTraders.length === 0) {
      msg += "<i>No trades yet.</i>\n";
    } else {
      topTraders.forEach((u, i) => {
        const icon = i < 3 ? medals[i] : "🏅";
        const name = formatUser(u);
        const userVol = this.normalizeAmount(u.totalTradedVolume);
        msg += `${icon} #${i + 1} ${name} — ${formatCurrency(userVol)} USDT\n`;
      });
    }

    msg += "\n<b>DEAL STATS</b>\n\n";

    // Global Stats
    const normalizedGlobalVolume = this.normalizeAmount(
      globalStats.totalVolume,
    );
    msg += `<b>TOTAL:</b> ${globalStats.totalDeals}\n`;
    msg += `<b>VOLUME:</b> ${formatKVolume(normalizedGlobalVolume)} Usdt\n\n`;

    // Helper for "Val ( @ & @ )" format
    const formatDealInfo = (deal, type) => {
      if (!deal) return "None";
      const bName = deal.buyerUsername
        ? `@${deal.buyerUsername}`
        : deal.buyerId
        ? `User ${deal.buyerId}`
        : "Unknown";
      const sName = deal.sellerUsername
        ? `@${deal.sellerUsername}`
        : deal.sellerId
        ? `User ${deal.sellerId}`
        : "Unknown";
      const participants = `${bName} & ${sName}`;

      let valDisplay = "";
      if (type === "time") {
        // Use shared formatDuration logic to show proper seconds/minutes
        valDisplay = this.formatDuration(deal.duration);
      } else {
        // Amount
        const normalizedAmt = this.normalizeAmount(deal.quantity);
        const amt = Number(normalizedAmt);
        valDisplay = `${Number.isInteger(amt) ? amt : amt.toFixed(2)} Usdt`;
      }

      return `${valDisplay} (${participants})`;
    };

    msg += `<b>SHORTEST:</b> ${formatDealInfo(shortest, "time")}\n`;
    msg += `<b>LONGEST:</b> ${formatDealInfo(longest, "time")}\n`;
    msg += `<b>BIGGEST:</b> ${formatDealInfo(highestDeal, "amount")}\n`;
    msg += `<b>LOWEST:</b> ${formatDealInfo(lowestDeal, "amount")}\n`;

    return msg;
  }

  /**
   * Get top buyers
   */
  async getTopBuyers(limit = 5) {
    return User.find({ totalBoughtVolume: { $gt: 0 } })
      .sort({ totalBoughtVolume: -1 })
      .limit(limit);
  }

  /**
   * Get top sellers
   */
  async getTopSellers(limit = 5) {
    return User.find({ totalSoldVolume: { $gt: 0 } })
      .sort({ totalSoldVolume: -1 })
      .limit(limit);
  }

  formatTopBuyers(users) {
    const formatCurrency = (val) =>
      Number(val).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    const medals = ["🥇", "🥈", "🥉", "🏅", "🏅"];
    const formatUser = (u) =>
      u.username ? `@${u.username}` : `User ${u.telegramId}`;

    let msg = "<b>🟢 TOP BUYERS — GLOBAL RANKING</b>\n";
    if (users.length === 0) {
      msg += "<i>No data yet.</i>";
    } else {
      users.forEach((u, i) => {
        const icon = i < 3 ? medals[i] : "🏅"; // Top 3 get specific medals, rest get generic
        const name = formatUser(u);
        const volume = this.normalizeAmount(u.totalBoughtVolume); // Normalize massive numbers
        msg += `${icon} #${i + 1} ${name} — ${formatCurrency(volume)} USDT\n`;
      });
    }
    return msg;
  }

  formatTopSellers(users) {
    const formatCurrency = (val) =>
      Number(val).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    const medals = ["🥇", "🥈", "🥉", "🏅", "🏅"];
    const formatUser = (u) =>
      u.username ? `@${u.username}` : `User ${u.telegramId}`;

    let msg = "<b>🔴 TOP SELLERS — GLOBAL RANKING</b>\n";
    if (users.length === 0) {
      msg += "<i>No data yet.</i>";
    } else {
      users.forEach((u, i) => {
        const icon = i < 3 ? medals[i] : "🏅";
        const name = formatUser(u);
        const volume = this.normalizeAmount(u.totalSoldVolume); // Normalize massive numbers
        msg += `${icon} #${i + 1} ${name} — ${formatCurrency(volume)} USDT\n`;
      });
    }
    return msg;
  }

  normalizeAmount(amount) {
    const val = Number(amount);
    // Heuristic:
    // 1. If > 1e22 (10 Sextillion), it's likely double-scaled (18+6 decimals error).
    //    User case: 9.55e24 -> should be ~9.55. Factor is 1e24.
    if (val > 1e22) {
      return val / 1e24;
    }
    // 2. If > 1e14 (100 Trillion), it's likely Wei (18 decimals).
    //    Standard normalization.
    if (val > 1e14) {
      return val / 1e18;
    }
    return val;
  }

  /**
   * Update user stats after a completed trade
   * @param {Object} escrow - The completed escrow object
   */
  async updateUserStats(escrow) {
    if (!escrow || !escrow.buyerId || !escrow.sellerId) {
      return;
    }

    const {
      buyerId,
      sellerId,
      buyerUsername,
      sellerUsername,
      quantity,
      token,
      escrowId,
    } = escrow;

    const amount = Number(quantity);
    const tradeDate = new Date();

    await User.findOneAndUpdate(
      { telegramId: Number(buyerId) },
      {
        $setOnInsert: {
          telegramId: Number(buyerId),
          username: buyerUsername || `user_${buyerId}`,
        },
        $inc: {
          totalBoughtVolume: amount,
          totalTradedVolume: amount,
          totalBoughtTrades: 1,
          totalParticipatedTrades: 1,
          totalCompletedTrades: 1,
        },
        $set: {
          lastActive: tradeDate,
          lastTradeAt: tradeDate,
          lastTradeRole: "buyer",
          lastTradeAmount: amount,
          lastTradeToken: token,
          lastTradeEscrowId: escrowId,
          lastTradeCounterparty: sellerUsername
            ? `@${sellerUsername}`
            : `User ${sellerId}`,
        },
      },
      { upsert: true },
    );

    await User.findOneAndUpdate(
      { telegramId: Number(sellerId) },
      {
        $setOnInsert: {
          telegramId: Number(sellerId),
          username: sellerUsername || `user_${sellerId}`,
        },
        $inc: {
          totalSoldVolume: amount,
          totalTradedVolume: amount,
          totalSoldTrades: 1,
          totalParticipatedTrades: 1,
          totalCompletedTrades: 1,
        },
        $set: {
          lastActive: tradeDate,
          lastTradeAt: tradeDate,
          lastTradeRole: "seller",
          lastTradeAmount: amount,
          lastTradeToken: token,
          lastTradeEscrowId: escrowId,
          lastTradeCounterparty: buyerUsername
            ? `@${buyerUsername}`
            : `User ${buyerId}`,
        },
      },
      { upsert: true },
    );
  }

  async recordTrade(escrow) {
    return this.updateUserStats(escrow);
  }

  /**
   * Record simple participation (called when role is selected)
   * @param {Object} params - { telegramId, username }
   */
  async recordParticipation({ telegramId, username }) {
    if (!telegramId) return;

    await User.findOneAndUpdate(
      { telegramId: Number(telegramId) },
      {
        $setOnInsert: {
          telegramId: Number(telegramId),
          username: username || `user_${telegramId}`,
          totalBoughtVolume: 0,
          totalSoldVolume: 0,
          totalTradedVolume: 0,
          totalBoughtTrades: 0,
          totalSoldTrades: 0,
          totalCompletedTrades: 0,
        },
        $inc: {
          totalParticipatedTrades: 1,
        },
        $set: {
          lastActive: new Date(),
        },
      },
      { upsert: true },
    );
  }
}

module.exports = new UserStatsService();
