module.exports = {
  NETWORK_FEES: {
    NO_BIO_TAG: {
      BSC: 0.3,
      TRON: 3.0,
    },
    HAS_BIO_TAG: {
      BSC: 0.2,
      TRON: 2.0,
    },
  },

  SERVICE_FEES: {
    NO_BIO_TAG: 0.75,
    SELLER_ONLY_TAG: 0.5,
    BOTH_TAGS: 0.25,
  },

  getNetworkFee(chain, hasBioTag) {
    const chainUpper = (chain || "").toUpperCase();
    const category = hasBioTag ? "HAS_BIO_TAG" : "NO_BIO_TAG";

    if (chainUpper === "BSC" || chainUpper === "BNB") {
      return this.NETWORK_FEES[category].BSC;
    }
    if (chainUpper === "TRON" || chainUpper === "TRX") {
      return this.NETWORK_FEES[category].TRON;
    }

    return this.NETWORK_FEES[category].BSC;
  },

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
