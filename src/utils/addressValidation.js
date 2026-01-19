/**
 * Validate address format based on chain
 * @param {string} address - Address to validate
 * @param {string} chain - Chain name (BSC, ETH, TRON, etc.)
 * @returns {boolean} - True if valid
 */
function isValidAddress(address, chain = "BSC") {
  if (!address || typeof address !== "string") return false;

  const chainUpper = (chain || "").toUpperCase();

  if (chainUpper === "TRON" || chainUpper === "TRX") {
    return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address);
  }

  return /^0x[a-fA-F0-9]{40}$/.test(address) && address.length === 42;
}

/**
 * Get address validation error message
 * @param {string} chain - Chain name
 * @returns {string} - Error message
 */
function getAddressErrorMessage(chain = "BSC") {
  const chainUpper = (chain || "").toUpperCase();

  if (chainUpper === "TRON" || chainUpper === "TRX") {
    return "❌ Invalid TRON address format. Address must start with T and be 34 characters (base58 encoded).";
  }

  return "❌ Invalid address format. Address must start with 0x and be 42 characters (0x + 40 hexadecimal characters).";
}

/**
 * Get address input example message
 * @param {string} chain - Chain name
 * @returns {string} - Example message
 */
function getAddressExample(chain = "BSC") {
  const chainUpper = (chain || "").toUpperCase();

  if (chainUpper === "TRON" || chainUpper === "TRX") {
    return "💰 Step 5 - {username}, enter your TRON wallet address (starts with T, 34 characters).";
  }

  return "💰 Step 5 - {username}, enter your {chain} wallet address starts with 0x and is 42 chars (0x + 40 hex).";
}

module.exports = {
  isValidAddress,
  getAddressErrorMessage,
  getAddressExample,
};
