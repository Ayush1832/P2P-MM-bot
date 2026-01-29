/**
 * BioCheckService
 * Checks user bios to determine appropriate fee tier based on @room mentions
 */
class BioCheckService {
  constructor(bot) {
    this.bot = bot;
  }

  /**
   * Check if a user has @room in their bio
   * @param {number} userId - Telegram user ID
   * @returns {Promise<boolean>} - True if bio contains @room
   */
  async checkUserBio(userId) {
    try {
      const user = await this.bot.telegram.getChat(userId);
      const bio = user.bio || "";
      const hasRoom = bio.toLowerCase().includes("@room");

      console.log(
        `Bio check for user ${userId}: ${hasRoom ? "HAS" : "NO"} @room`,
      );
      return hasRoom;
    } catch (error) {
      console.error(`Error checking bio for user ${userId}:`, error.message);
      return false;
    }
  }

  /**
   * Determine fee tier based on buyer and seller bios
   * @param {number} buyerId - Buyer's Telegram user ID
   * @param {number} sellerId - Seller's Telegram user ID
   * @returns {Promise<string>} - Tier ('both_tags', 'one_tag', 'no_tag')
   */
  async determineTier(buyerId, sellerId) {
    try {
      const buyerHasRoom = await this.checkUserBio(buyerId);
      const sellerHasRoom = await this.checkUserBio(sellerId);

      const count = (buyerHasRoom ? 1 : 0) + (sellerHasRoom ? 1 : 0);

      let tier;
      if (count === 0) {
        tier = "no_tag";
      } else if (count === 1) {
        tier = "one_tag";
      } else {
        tier = "both_tags";
      }

      console.log(
        `Tier determination: Buyer ${buyerHasRoom ? "HAS" : "NO"} @room, ` +
          `Seller ${sellerHasRoom ? "HAS" : "NO"} @room → ${tier}`,
      );

      return tier;
    } catch (error) {
      console.error("Error determining tier:", error);
      return "no_tag";
    }
  }
}

module.exports = BioCheckService;
