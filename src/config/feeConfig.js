/**
 * CENTRALIZED FEE CONFIGURATION
 *
 * This file contains ALL fee-related rules for the escrow bot.
 * NEVER hardcode fees elsewhere - always reference this file.
 */

module.exports = {
  /**
   * NETWORK FEES (Flat USDT amounts deducted for blockchain gas)
   * These are deducted in JavaScript BEFORE sending to smart contract.
   * The smart contract does NOT handle network fees.
   */
  NETWORK_FEES: {
    // No user has @room bio tag
    NO_BIO_TAG: {
      BSC: 0.2, // 0.2 USDT
      TRON: 3.0, // 3.0 USDT
    },
    // ANY of the 2 users has @room bio tag (discounted rate)
    HAS_BIO_TAG: {
      BSC: 0.2, // 0.2 USDT (same as no tag)
      TRON: 2.0, // 2.0 USDT (reduced from 3.0)
    },
  },

  /**
   * SERVICE FEES (Percentage-based fees for escrow service)
   * These are deducted by the SMART CONTRACT, not JavaScript.
   * The contract's release()/refund() functions handle this automatically.
   */
  SERVICE_FEES: {
    // No user has @room bio tag
    NO_BIO_TAG: 0.75, // 0.75%

    // Only seller has @room bio tag
    SELLER_ONLY_TAG: 0.5, // 0.50%

    // Both users have @room bio tag
    BOTH_TAGS: 0.25, // 0.25%
  },

  /**
   * Get network fee for a specific chain and bio status
   * @param {string} chain - 'BSC' or 'TRON'
   * @param {boolean} hasBioTag - Whether any user has @room tag
   * @returns {number} Network fee in USDT
   */
  getNetworkFee(chain, hasBioTag) {
    const chainUpper = (chain || "").toUpperCase();
    const category = hasBioTag ? "HAS_BIO_TAG" : "NO_BIO_TAG";

    if (chainUpper === "BSC" || chainUpper === "BNB") {
      return this.NETWORK_FEES[category].BSC;
    }
    if (chainUpper === "TRON" || chainUpper === "TRX") {
      return this.NETWORK_FEES[category].TRON;
    }

    // Fallback to BSC if unknown chain
    return this.NETWORK_FEES[category].BSC;
  },

  /**
   * Get service fee percentage based on bio tag status
   * @param {boolean} sellerHasTag - Whether seller has @room tag
   * @param {boolean} buyerHasTag - Whether buyer has @room tag
   * @returns {number} Service fee percentage (e.g., 0.75 for 0.75%)
   */
  getServiceFee(sellerHasTag, buyerHasTag) {
    if (sellerHasTag && buyerHasTag) {
      return this.SERVICE_FEES.BOTH_TAGS;
    }
    if (sellerHasTag || buyerHasTag) {
      return this.SERVICE_FEES.SELLER_ONLY_TAG;
    }
    return this.SERVICE_FEES.NO_BIO_TAG;
  },
};
