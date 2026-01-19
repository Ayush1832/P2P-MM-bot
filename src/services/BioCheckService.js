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
        `Bio check for user ${userId}: ${hasRoom ? "HAS" : "NO"} @room`
      );
      return hasRoom;
    } catch (error) {
      console.error(`Error checking bio for user ${userId}:`, error.message);
      // Default to false if error (safer to charge higher fee)
      return false;
    }
  }

  /**
   * Determine fee percent based on buyer and seller bios
   * @param {number} buyerId - Buyer's Telegram user ID
   * @param {number} sellerId - Seller's Telegram user ID
   * @returns {Promise<number>} - Fee percent (0.25, 0.50, or 0.75)
   */
  async determineFeePercent(buyerId, sellerId) {
    try {
      const buyerHasRoom = await this.checkUserBio(buyerId);
      const sellerHasRoom = await this.checkUserBio(sellerId);

      const count = (buyerHasRoom ? 1 : 0) + (sellerHasRoom ? 1 : 0);

      let feePercent;
      if (count === 0) {
        feePercent = 0.75; // No @room in bio
      } else if (count === 1) {
        feePercent = 0.5; // 1 user has @room
      } else {
        feePercent = 0.25; // Both have @room
      }

      console.log(
        `Fee determination: Buyer ${buyerHasRoom ? "HAS" : "NO"} @room, ` +
          `Seller ${sellerHasRoom ? "HAS" : "NO"} @room → ${feePercent}% fee`
      );

      return feePercent;
    } catch (error) {
      console.error("Error determining fee percent:", error);
      // Default to highest fee if error
      return 0.75;
    }
  }
}

module.exports = BioCheckService;
