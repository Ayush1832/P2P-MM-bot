require("dotenv").config();

module.exports = {
  // Telegram Bot Configuration
  BOT_TOKEN: process.env.BOT_TOKEN,
  ADMIN_USERNAME: process.env.ADMIN_USERNAME,
  ADMIN_USER_ID: process.env.ADMIN_USER_ID,
  ADMIN_USERNAME2: process.env.ADMIN_USERNAME2,
  ADMIN_USER_ID2: process.env.ADMIN_USER_ID2,
  ADMIN_USERNAME3: process.env.ADMIN_USERNAME3,
  ADMIN_USER_ID3: process.env.ADMIN_USER_ID3,
  ADMIN_USERNAME4: process.env.ADMIN_USERNAME4,
  ADMIN_USER_ID4: process.env.ADMIN_USER_ID4,
  ADMIN_USERNAME5: process.env.ADMIN_USERNAME5,
  ADMIN_USER_ID5: process.env.ADMIN_USER_ID5,

  // MongoDB Configuration
  MONGODB_URI: process.env.MONGODB_URI,

  // Network Configuration
  BSC_RPC_URL: process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org/",
  ETHERSCAN_API_KEY: process.env.ETHERSCAN_API_KEY,
  // Token Contract Addresses
  USDT_SEPOLIA: process.env.USDT_SEPOLIA,
  USDT_BSC: process.env.USDT_BSC,

  USDT_TRON: process.env.USDT_TRON,
  USDC_BSC: process.env.USDC_BSC,

  BUSD_BSC: process.env.BUSD_BSC,
  ETH_ETH: process.env.ETH_ETH,

  BTC_BSC: process.env.BTC_BSC,
  TRX_TRON: process.env.TRX_TRON,
  SOL_SOL: process.env.SOL_SOL,
  LTC_LTC: process.env.LTC_LTC,
  BNB_BSC: process.env.BNB_BSC,
  DOGE_DOGE: process.env.DOGE_DOGE,
  DOGE_BSC: process.env.DOGE_BSC,

  // Network RPC URLs
  SEPOLIA_RPC_URL: process.env.SEPOLIA_RPC_URL,
  ETH_RPC_URL: process.env.ETH_RPC_URL,
  TRON_RPC_URL:
    process.env.TRON_RPC_URL ||
    "https://icy-holy-snow.tron-mainnet.quiknode.pro/9236e8e0de17867c93a9db58840aed12a689f94e/jsonrpc",

  // Wallet Configuration
  HOT_WALLET_PRIVATE_KEY: process.env.HOT_WALLET_PRIVATE_KEY,
  TRC_PRIVATE_KEY: process.env.TRC_PRIVATE_KEY,

  // Escrow Configuration
  ESCROW_FEE_PERCENT: Number(process.env.ESCROW_FEE_PERCENT || 0),
  CONTRACT_USDT_RESERVE: Number(process.env.CONTRACT_USDT_RESERVE || 0.1),

  MIN_TRADE_AMOUNT: Number(process.env.MIN_TRADE_AMOUNT || 1),
  MAX_TRADE_AMOUNT: Number(process.env.MAX_TRADE_AMOUNT || 10000),

  // Fee wallets (Per-Network)
  FEE_WALLET_BSC: process.env.FEE_WALLET_BSC,
  FEE_WALLET_TRC: process.env.FEE_WALLET_TRC,

  // Security
  NODE_ENV: process.env.NODE_ENV || "development",

  // Dispute Management
  DISPUTE_CHANNEL_ID: process.env.DISPUTE_CHANNEL_ID,
  COMPLETION_FEED_CHAT_ID: process.env.COMPLETION_FEED_CHAT_ID,

  // Group Restriction
  ALLOWED_MAIN_GROUP_ID: process.env.ALLOWED_MAIN_GROUP_ID || "-1002457247089",
  ALLOWED_MAIN_GROUP_ID2: process.env.ALLOWED_MAIN_GROUP_ID2,

  // Helper function to get all allowed group IDs
  getAllowedGroupIds() {
    const groupIds = [];
    if (this.ALLOWED_MAIN_GROUP_ID)
      groupIds.push(String(this.ALLOWED_MAIN_GROUP_ID));
    if (this.ALLOWED_MAIN_GROUP_ID2)
      groupIds.push(String(this.ALLOWED_MAIN_GROUP_ID2));
    return groupIds;
  },

  // Helper function to get all admin IDs
  getAllAdminIds() {
    const adminIds = [];
    if (this.ADMIN_USER_ID) adminIds.push(this.ADMIN_USER_ID);
    if (this.ADMIN_USER_ID2) adminIds.push(this.ADMIN_USER_ID2);
    if (this.ADMIN_USER_ID3) adminIds.push(this.ADMIN_USER_ID3);
    if (this.ADMIN_USER_ID4) adminIds.push(this.ADMIN_USER_ID4);
    if (this.ADMIN_USER_ID5) adminIds.push(this.ADMIN_USER_ID5);
    return adminIds;
  },

  // Helper function to get all admin usernames
  getAllAdminUsernames() {
    const adminUsernames = [];
    if (this.ADMIN_USERNAME) adminUsernames.push(this.ADMIN_USERNAME);
    if (this.ADMIN_USERNAME2) adminUsernames.push(this.ADMIN_USERNAME2);
    if (this.ADMIN_USERNAME3) adminUsernames.push(this.ADMIN_USERNAME3);
    if (this.ADMIN_USERNAME4) adminUsernames.push(this.ADMIN_USERNAME4);
    if (this.ADMIN_USERNAME5) adminUsernames.push(this.ADMIN_USERNAME5);
    return adminUsernames;
  },
};
