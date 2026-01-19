require('@nomicfoundation/hardhat-toolbox');
require('dotenv').config();

const {
  BSC_RPC_URL,
  BSC_TESTNET_RPC_URL,
  SEPOLIA_RPC_URL,
  TRON_RPC_URL,
  HOT_WALLET_PRIVATE_KEY
} = process.env;

module.exports = {
  solidity: {
    version: '0.8.24',
    settings: { optimizer: { enabled: true, runs: 200 } }
  },
  networks: {
    bsc: {
      url: BSC_RPC_URL || 'https://bsc-dataseed.binance.org/',
      accounts: HOT_WALLET_PRIVATE_KEY ? [HOT_WALLET_PRIVATE_KEY] : []
    },
    bscTestnet: {
      url: BSC_TESTNET_RPC_URL || 'https://data-seed-prebsc-1-s1.binance.org:8545/',
      accounts: HOT_WALLET_PRIVATE_KEY ? [HOT_WALLET_PRIVATE_KEY] : []
    },
    sepolia: {
      url: SEPOLIA_RPC_URL || 'https://sepolia.infura.io/v3/YOUR_KEY',
      accounts: HOT_WALLET_PRIVATE_KEY ? [HOT_WALLET_PRIVATE_KEY] : []
    },
    ethereum: {
      url: process.env.ETH_RPC_URL || 'https://eth.llamarpc.com',
      accounts: HOT_WALLET_PRIVATE_KEY ? [HOT_WALLET_PRIVATE_KEY] : []
    },
    litecoin: {
      url: process.env.LTC_RPC_URL || 'https://ltc.llamarpc.com',
      accounts: HOT_WALLET_PRIVATE_KEY ? [HOT_WALLET_PRIVATE_KEY] : []
    },
    tron: {
      url: TRON_RPC_URL || 'https://api.trongrid.io',
      accounts: HOT_WALLET_PRIVATE_KEY ? [HOT_WALLET_PRIVATE_KEY] : []
    }
  }
};


