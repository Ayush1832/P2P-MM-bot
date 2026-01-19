# Telegram Escrow Bot

A centralized Telegram escrow bot for USDT transactions on BSC network.

## Features

- 🤖 **Telegram Bot Interface**: Easy-to-use commands for escrow management
- 💰 **USDT on BSC**: Support for USDT transactions on Binance Smart Chain
- 🔒 **Secure Escrow**: Centralized hot wallet with deposit address generation
- 📊 **Real-time Monitoring**: Automatic deposit detection via BscScan API
- ⚖️ **Dispute Resolution**: Built-in dispute system with admin intervention
- 💸 **Fee Management**: 1% escrow fee with transparent fee breakdown (70% - 30% distribution)

## Commands

- `/start` - Start the bot and see welcome message
- `/escrow` - Create a new escrow (group only)
- `/dd` - Set deal details (quantity, rate, conditions)
- `/buyer <address>` - Set buyer wallet address
- `/token` - Select token and network (USDT/BSC only)
- `/deposit` - Generate deposit address
- `/release <amount>` - Release funds to buyer
- `/refund <amount>` - Refund to seller
- `/dispute` - Raise a dispute
- `/menu` - Show all available commands

## Setup

1. **Install Dependencies**

   ```bash
   npm install
   ```

2. **Configure Environment (.env)**
   Create a `.env` file (never commit it) with placeholders like:

   ```env
   BOT_TOKEN=YOUR_TELEGRAM_BOT_TOKEN
   ADMIN_USERNAME=YOUR_ADMIN_USERNAME
   ADMIN_USER_ID=YOUR_ADMIN_TELEGRAM_ID
   MONGODB_URI=YOUR_MONGODB_URI
   BSC_RPC_URL=https://bsc-dataseed.binance.org/
   SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/YOUR_KEY
   ETH_RPC_URL=https://eth.llamarpc.com
   LTC_RPC_URL=https://ltc.llamarpc.com
   ETHERSCAN_API_KEY=YOUR_ETHERSCAN_API_KEY
   USDT_SEPOLIA=0x55d398326f99059fF775485246999027B3197955
   USDT_BSC=0x55d398326f99059fF775485246999027B3197955
   USDC_BSC=0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d
   BUSD_BSC=0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56
   ETH_ETH=0x0000000000000000000000000000000000000000
   BTC_BSC=0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c
   LTC_LTC=0x0000000000000000000000000000000000000000
   BNB_BSC=0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c
   HOT_WALLET_PRIVATE_KEY=YOUR_PRIVATE_KEY
   ESCROW_FEE_PERCENT=1.0
   ESCROW_FEE_BPS=100
   MIN_TRADE_AMOUNT=1
   MAX_TRADE_AMOUNT=10000
   FEE_WALLET_1=YOUR_FEE_WALLET_1  # 70% of escrow fees
   FEE_WALLET_2=YOUR_FEE_WALLET_2  # 30% of escrow fees
   ```

   Warning: Do not paste real secrets into documentation or commit history.

3. **Compile and Deploy Contracts**

   ```bash
   npm run compile

   # Deploy contracts for BSC network (USDT and USDC with 0% escrow fee):
   npm run deploy
   ```

   The deployed `EscrowVault` addresses will be saved in MongoDB (`contracts` collection).

4. **Start the Bot**
   ```bash
   npm start
   ```

## Usage Flow

1. **Create Group**: Users create a Telegram group and add the bot as admin
2. **Start Escrow**: Use `/escrow` command in the group
3. **Set Details**: Use `/dd` to set deal details
4. **Assign Roles**: Use `/buyer` command with wallet addresses
5. **Select Token**: Use `/token` to confirm USDT/BSC
6. **Generate Deposit**: Use `/deposit` to get deposit address
7. **Monitor Deposit**: Bot automatically detects USDT deposits
8. **Release/Refund**: Use `/release` or `/refund` with dual confirmation

## Security Features

- ✅ Address validation for BSC addresses
- ✅ Role-based access control
- ✅ Dual confirmation for releases/refunds
- ✅ Dispute resolution system
- ✅ Transaction logging and audit trail
- ✅ Deposit address TTL (20 minutes)

## Architecture

- **Database**: MongoDB for persistent storage
- **Blockchain**: BSC integration via BscScan API
- **Wallet**: HD wallet for deposit address generation
- **Monitoring**: Automated deposit detection every 30 seconds

## Configuration

Key settings in `config.js`:

```javascript
{
  BOT_TOKEN: 'env',
  MONGODB_URI: 'env',
  BSC_RPC_URL: 'env or https://bsc-dataseed.binance.org/',
  ETHERSCAN_API_KEY: 'env',
  HOT_WALLET_PRIVATE_KEY: 'env',
  ESCROW_FEE_PERCENT: 1.0,
  MIN_TRADE_AMOUNT: 1,
  MAX_TRADE_AMOUNT: 10000
}
```

## Production Deployment

1. **Security**: Use environment variables for sensitive data
2. **Monitoring**: Set up error logging and alerts
3. **Backup**: Regular database backups
4. **Scaling**: Consider load balancing for high volume

## Support

For issues or questions, contact the admin or use the `/dispute` command in your escrow group.
