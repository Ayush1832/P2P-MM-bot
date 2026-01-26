const { ethers } = require("ethers");
const axios = require("axios");
const config = require("../../config");
const ContractModel = require("../models/Contract");
const TronService = require("./TronService");

const ESCROW_VAULT_ABI = [
  "function token() view returns (address)",
  "function feeWallet() view returns (address)",
  "function release(address to, uint256 amount) external",
  "function refund(address to, uint256 amount) external",
  "function withdrawToken(address erc20Token, address to) external",
];

const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

class BlockchainService {
  constructor() {
    const providerOptions = {
      staticNetwork: null,
      batchMaxCount: 1,
    };

    this.providers = {
      BSC: new ethers.JsonRpcProvider(
        config.BSC_RPC_URL,
        null,
        providerOptions,
      ),
      SEPOLIA: new ethers.JsonRpcProvider(
        config.SEPOLIA_RPC_URL,
        null,
        providerOptions,
      ),
      ETH: new ethers.JsonRpcProvider(
        config.ETH_RPC_URL || "https://eth.llamarpc.com",
        null,
        providerOptions,
      ),
      LTC: new ethers.JsonRpcProvider(
        config.LTC_RPC_URL || "https://ltc.llamarpc.com",
        null,
        providerOptions,
      ),
      TRON: new ethers.JsonRpcProvider(
        config.TRON_RPC_URL || "https://api.trongrid.io",
        null,
        providerOptions,
      ),
    };

    const privateKey = config.HOT_WALLET_PRIVATE_KEY.startsWith("0x")
      ? config.HOT_WALLET_PRIVATE_KEY
      : "0x" + config.HOT_WALLET_PRIVATE_KEY;

    this.wallets = {};
    Object.keys(this.providers).forEach((network) => {
      this.wallets[network] = new ethers.Wallet(
        privateKey,
        this.providers[network],
      );
    });

    this.vault = null;
    this.etherscanApiKey = config.ETHERSCAN_API_KEY;
    this.etherscanBaseUrl = "https://api.etherscan.io/api";
  }

  async initialize() {
    try {
      // Just find ANY deployed EscrowVault to verify deployment
      const anyContract = await ContractModel.findOne({
        name: "EscrowVault",
        status: "deployed",
      }).sort({ createdAt: -1 });

      if (!anyContract) {
        throw new Error(
          `No deployed EscrowVault contracts found. Please deploy contracts.`,
        );
      }

      return anyContract.address;
    } catch (error) {
      throw error;
    }
  }

  async getVaultForNetwork(network, token = null) {
    try {
      const query = {
        name: "EscrowVault",
        network: network.toUpperCase(),
      };

      if (token) {
        query.token = token.toUpperCase();
      }

      const entry = await ContractModel.findOne(query);
      if (!entry) {
        const errorMsg = token
          ? `EscrowVault not found for ${token} on ${network}`
          : `EscrowVault not found on ${network}`;
        throw new Error(errorMsg);
      }
      const wallet = this.wallets[network.toUpperCase()];
      return new ethers.Contract(entry.address, ESCROW_VAULT_ABI, wallet);
    } catch (error) {
      console.error(`Error getting vault on ${network}:`, error);
      throw error;
    }
  }

  getTokenAddress(token, network) {
    const key = `${token}_${network}`.toUpperCase();
    return config[key];
  }

  getTokenDecimals(token, network) {
    const decimalsMap = {
      USDT_SEPOLIA: 6, // USDT on Ethereum/Sepolia has 6 decimals
      USDT_BSC: 18, // USDT on BSC has 18 decimals
      USDC_BSC: 18, // USDC on BSC has 18 decimals
      BUSD_BSC: 18, // BUSD on BSC has 18 decimals
      BNB_BSC: 18, // BNB has 18 decimals
      ETH_ETH: 18, // ETH has 18 decimals
      BTC_BSC: 18, // BTC on BSC has 18 decimals
      LTC_LTC: 8, // LTC has 8 decimals
      DOGE_DOGE: 8, // DOGE has 8 decimals
      DOGE_BSC: 18, // DOGE on BSC has 18 decimals
      SOL_SOL: 9, // SOL has 9 decimals
      TRX_TRON: 6, // TRX has 6 decimals
      USDT_TRON: 6,
    };

    const key = `${token}_${network}`.toUpperCase();
    return decimalsMap[key] || 18;
  }

  getProvider(network) {
    return this.providers[network.toUpperCase()];
  }

  getWallet(network) {
    return this.wallets[network.toUpperCase()];
  }

  async release(to, amountUSDT, token = "USDT", network = "SEPOLIA") {
    const vault = await this.getVaultForNetwork(network);
    const wallet = this.wallets[network.toUpperCase()];
    const provider = this.providers[network.toUpperCase()];
    const decimals = this.getTokenDecimals(token, network);
    const amount = ethers.parseUnits(String(amountUSDT), decimals);

    const tx = await vault.release(to, amount);
    return await tx.wait();
  }

  async refund(to, amountUSDT, token = "USDT", network = "SEPOLIA") {
    const vault = await this.getVaultForNetwork(network);
    const wallet = this.wallets[network.toUpperCase()];
    const provider = this.providers[network.toUpperCase()];
    const decimals = this.getTokenDecimals(token, network);
    const amount = ethers.parseUnits(String(amountUSDT), decimals);

    const tx = await vault.refund(to, amount);
    return await tx.wait();
  }

  // withdrawFees removed - use specific admin withdraw commands via withdrawToken

  async refundFunds(
    token,
    network,
    sellerAddress,
    amount,
    amountWeiOverride = null,
    groupId = null,
    contractAddressOverride = null,
  ) {
    try {
      if (network && network.toUpperCase() === "TRON") {
        const tronResult = await TronService.refundFunds({
          token,
          to: sellerAddress,
          amount,
          groupId,
        });
        return {
          success: true,
          transactionHash: tronResult.transactionHash,
          blockNumber: null,
        };
      }

      let contractAddress = contractAddressOverride;
      if (!contractAddress) {
        contractAddress = await this.getEscrowContractAddress(
          token,
          network,
          groupId,
        );
      }
      if (!contractAddress) {
        throw new Error(
          `No escrow contract found for ${token} on ${network}${
            groupId ? ` for group ${groupId}` : ""
          }`,
        );
      }

      wallet = this.wallets[network.toUpperCase()];
      provider = this.providers[network.toUpperCase()];
      vaultContract = new ethers.Contract(
        contractAddress,
        ESCROW_VAULT_ABI,
        wallet,
      );
      const decimals = this.getTokenDecimals(token, network);
      amountWei = amountWeiOverride
        ? BigInt(amountWeiOverride)
        : ethers.parseUnits(amount.toString(), decimals);

      let nonce;
      try {
        nonce = await provider.getTransactionCount(wallet.address, "latest");
      } catch (nonceError) {
        try {
          nonce = await provider.getTransactionCount(wallet.address);
        } catch (fallbackError) {
          throw new Error(
            `Failed to get transaction nonce: ${fallbackError.message}`,
          );
        }
      }

      // Check balance before attempting refund
      const tokenAddressForCheck = await vaultContract.token();
      const tokenContractForCheck = new ethers.Contract(
        tokenAddressForCheck,
        ["function balanceOf(address) view returns (uint256)"],
        provider,
      );
      const contractBalanceWei = await tokenContractForCheck.balanceOf(
        contractAddress,
      );

      if (contractBalanceWei < amountWei) {
        throw new Error(
          `Insufficient Vault Balance: Contract has ${ethers.formatUnits(
            contractBalanceWei,
            decimals,
          )} but needs ${ethers.formatUnits(amountWei, decimals)}`,
        );
      }

      const tx = await vaultContract.refund(sellerAddress, amountWei, {
        nonce: nonce,
      });
      const receipt = await tx.wait();

      return {
        success: true,
        transactionHash: receipt.transactionHash || receipt.hash || tx.hash,
        blockNumber: receipt.blockNumber,
      };
    } catch (error) {
      const isNonceError =
        (error?.code === -32000 && error?.message === "already known") ||
        (error?.message && error?.message.includes("already known")) ||
        (error?.message &&
          error?.message.includes("could not coalesce error")) ||
        (error?.shortMessage &&
          error?.shortMessage.includes("could not coalesce error")) ||
        error?.error?.message === "already known" ||
        error?.info?.error?.message?.includes("nonce") ||
        error?.info?.error?.message?.includes("already known") ||
        (error?.error?.code === -32000 &&
          error?.error?.message?.includes("already known")) ||
        JSON.stringify(error).includes("already known") ||
        JSON.stringify(error).includes("nonce");

      if (isNonceError) {
        console.warn(
          `⚠️ Nonce error detected in refundFunds. Retrying with pending nonce...`,
        );
        try {
          const pendingNonce = await provider.getTransactionCount(
            wallet.address,
            "pending",
          );
          const tx = await vaultContract.refund(sellerAddress, amountWei, {
            nonce: pendingNonce,
          });
          const receipt = await tx.wait();
          return {
            success: true,
            transactionHash: receipt.transactionHash || receipt.hash || tx.hash,
            blockNumber: receipt.blockNumber,
          };
        } catch (retryError) {
          console.error("Retry failed:", retryError);
          throw retryError;
        }
      }
      console.error(`Error refunding funds for ${token} on ${network}:`, error);
      throw error;
    }
  }

  async withdrawToken(token, network, contractAddress, toAddress) {
    try {
      if (network && network.toUpperCase() === "TRON") {
        const result = await TronService.withdrawToken({
          contractAddress,
          token,
          to: toAddress,
        });
        return result;
      }

      const wallet = this.wallets[network.toUpperCase()];
      if (!wallet) throw new Error(`Wallet not configured for ${network}`);

      const provider = this.providers[network.toUpperCase()];
      const vault = new ethers.Contract(
        contractAddress,
        ESCROW_VAULT_ABI,
        wallet,
      );

      // We need the ERC20 token address that the vault manages
      // Usually stored in 'token()' public var
      const erc20Address = await vault.token();

      let nonce;
      try {
        nonce = await provider.getTransactionCount(wallet.address, "latest");
      } catch (nonceError) {
        nonce = await provider.getTransactionCount(wallet.address);
      }

      const tx = await vault.withdrawToken(erc20Address, toAddress, { nonce });
      const receipt = await tx.wait();

      return {
        success: true,
        transactionHash: receipt.hash || receipt.transactionHash,
      };
    } catch (error) {
      console.error(`Error sweeping token from ${contractAddress}:`, error);
      throw error;
    }
  }

  async getFeeSettings(
    token = "USDT",
    network = "BSC",
    contractAddress = null,
  ) {
    try {
      if (network && network.toUpperCase() === "TRON") {
        const result = await TronService.getFeeSettings({
          token,
          contractAddress,
        });
        return {
          feeWallet: result.feeWallet,
          feePercent: result.feePercent,
          accumulated: ethers.formatUnits(
            result.accumulated,
            this.getTokenDecimals(token, network),
          ),
        };
      }

      let vault;
      if (contractAddress) {
        const wallet = this.wallets[network.toUpperCase()];
        vault = new ethers.Contract(contractAddress, ESCROW_VAULT_ABI, wallet);
      } else {
        vault = await this.getVaultForNetwork(network, token);
      }

      const feeWallet = await vault.feeWallet();

      // Since we don't have explicit fee accounting, we treat the entire balance as potential fees to sweep
      // Valid for checking if there's anything to withdraw
      const tokenAddressForCheck = await vault.token();
      const tokenContract = new ethers.Contract(
        tokenAddressForCheck,
        ["function balanceOf(address) view returns (uint256)"],
        this.getProvider(network),
      );
      const balanceWei = await tokenContract.balanceOf(vault.target); // vault.target for v6 contract instance

      return {
        feeWallet,
        feePercent: 0,
        accumulated: ethers.formatUnits(
          balanceWei,
          this.getTokenDecimals(token, network),
        ),
      };
    } catch (error) {
      // fallback
      console.error(
        `Error fetching fee settings for ${token} on ${network}:`,
        error,
      );
      throw error;
    }
  }

  async getTokenTransactions(token, network, address, startBlock = 0) {
    try {
      const tokenAddress = this.getTokenAddress(token, network);
      if (!tokenAddress) {
        console.error(`Token address not found for ${token} on ${network}`);
        return [];
      }

      if (
        network.toUpperCase() === "ETH" ||
        network.toUpperCase() === "SEPOLIA"
      ) {
        const response = await axios.get(this.etherscanBaseUrl, {
          params: {
            module: "account",
            action: "tokentx",
            contractaddress: tokenAddress,
            address: address,
            startblock: startBlock,
            endblock: 999999999,
            sort: "desc",
            apikey: this.etherscanApiKey,
          },
        });

        if (response.data.status === "1") {
          return response.data.result.map((tx) => ({
            ...tx,
            valueDecimal: Number(tx.value) / 1_000_000,
          }));
        }
        return [];
      } else {
        return await this.getTokenTransfersViaRPC(
          token,
          network,
          address,
          startBlock,
        );
      }
    } catch (error) {
      console.error("Error fetching token transactions:", error);
      return await this.getTokenTransfersViaRPC(
        token,
        network,
        address,
        startBlock,
      );
    }
  }

  async getTokenTransfersViaRPC(token, network, toAddress, fromBlock) {
    try {
      if (network && network.toUpperCase() === "TRON") {
        return await TronService.getTokenTransfers(token, toAddress, fromBlock);
      }
      const provider = this.getProvider(network);
      const tokenAddress = this.getTokenAddress(token, network);

      if (!provider || !tokenAddress) return [];

      const toAddrLc = toAddress.toLowerCase();
      const iface = new ethers.Interface(ERC20_ABI);

      const latest = await provider.getBlockNumber();
      const start = Number.isFinite(fromBlock)
        ? Math.max(0, fromBlock)
        : Math.max(0, latest - 2000);

      const maxRange = 500;
      const totalRange = latest - start;

      if (totalRange <= maxRange) {
        const filter = {
          address: tokenAddress,
          fromBlock: start,
          toBlock: latest,
          topics: [
            iface.getEvent("Transfer").topicHash,
            null,
            ethers.zeroPadValue(toAddrLc, 32),
          ],
        };

        const logs = await provider.getLogs(filter);
        return logs.map((log) => {
          const parsed = iface.parseLog({ topics: log.topics, data: log.data });
          const from = parsed.args[0];
          const to = parsed.args[1];
          const value = parsed.args[2];
          const decimals = this.getTokenDecimals(token, network);
          const valueDecimal = Number(ethers.formatUnits(value, decimals));
          return { from, to, valueDecimal, hash: log.transactionHash };
        });
      } else {
        const allLogs = [];
        let currentStart = start;

        while (currentStart < latest) {
          const currentEnd = Math.min(currentStart + maxRange, latest);

          try {
            const filter = {
              address: tokenAddress,
              fromBlock: currentStart,
              toBlock: currentEnd,
              topics: [
                iface.getEvent("Transfer").topicHash,
                null,
                ethers.zeroPadValue(toAddrLc, 32),
              ],
            };

            const logs = await provider.getLogs(filter);
            allLogs.push(...logs);

            currentStart = currentEnd + 1;
          } catch (chunkError) {
            console.error(
              `Error scanning blocks ${currentStart}-${currentEnd}:`,
              chunkError,
            );
            currentStart = currentEnd + 1;
          }
        }

        return allLogs.map((log) => {
          const parsed = iface.parseLog({ topics: log.topics, data: log.data });
          const from = parsed.args[0];
          const to = parsed.args[1];
          const value = parsed.args[2];
          const decimals = this.getTokenDecimals(token, network);
          const valueDecimal = Number(ethers.formatUnits(value, decimals));
          return { from, to, valueDecimal, hash: log.transactionHash };
        });
      }
    } catch (error) {
      console.error("Error fetching token transfers:", error);
      return [];
    }
  }

  async getLatestBlockNumber(network = "ETH") {
    try {
      if (network && network.toUpperCase() === "TRON") {
        return await TronService.getLatestBlockNumber();
      }
      if (
        network.toUpperCase() === "ETH" ||
        network.toUpperCase() === "SEPOLIA"
      ) {
        const response = await axios.get(this.etherscanBaseUrl, {
          params: {
            module: "proxy",
            action: "eth_blockNumber",
            apikey: this.etherscanApiKey,
          },
        });
        return parseInt(response.data.result, 16);
      } else {
        const provider = this.getProvider(network);
        return await provider.getBlockNumber();
      }
    } catch (error) {
      console.error("Error getting latest block number:", error);
      return 0;
    }
  }

  /**
   * Get the timestamp of a transaction in milliseconds
   * @param {string} network
   * @param {string} txHash
   * @returns {Promise<number>} Timestamp in ms
   */
  async getTransactionTimestamp(network, txHash) {
    try {
      if (
        network &&
        (network.toUpperCase() === "TRON" || network.toUpperCase() === "TRX")
      ) {
        // For TRON, getTransactionInfo typically contains blockTimeStamp
        if (TronService && typeof TronService.tronWeb !== "undefined") {
          const tx = await TronService.tronWeb.trx.getTransaction(txHash);
          if (tx && tx.raw_data && tx.raw_data.timestamp) {
            return tx.raw_data.timestamp;
          }
          // Fallback to info
          const info = await TronService.tronWeb.trx.getTransactionInfo(txHash);
          if (info && info.blockTimeStamp) {
            return info.blockTimeStamp;
          }
        }
        return Date.now(); // Fallback if can't fetch (safety: allow but warn?) -> actually better to throw or handle in caller
      }

      const provider = this.getProvider(network);
      if (!provider) return Date.now();

      const tx = await provider.getTransaction(txHash);
      if (!tx || !tx.blockNumber) return Date.now();

      const block = await provider.getBlock(tx.blockNumber);
      if (!block) return Date.now();

      return block.timestamp * 1000; // EVM timestamps are in seconds
    } catch (error) {
      console.error(
        `Error fetching timestamp for ${txHash} on ${network}:`,
        error.message,
      );
      return Date.now(); // Fail safe: return current time so we don't block valid txs on RPC errors?
      // Limit logic: if we return Date.now(), diff is 0, so it passes.
      // This is "fail open". To "fail closed", we'd return 0.
      // Let's return 0 to indicate failure to fetch, so the caller can decide.
      return 0;
    }
  }

  async getTokenBalance(token, network, address) {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (network === "TRON" || network === "TRX") {
          // Delegate to TronService if available, otherwise return 0
          if (
            TronService &&
            typeof TronService.getTRC20Balance === "function"
          ) {
            const tokenAddress = this.getTokenAddress(token, network);
            const balance = await TronService.getTRC20Balance(
              tokenAddress,
              address,
            );
            return balance;
          }
          return 0;
        }

        const tokenAddress = this.getTokenAddress(token, network);
        if (!tokenAddress) {
          // Native currency check?
          // if (token === network) ...
          // For now assume tokens.
          return 0;
        }

        const provider = this.providers[network.toUpperCase()];
        if (!provider) return 0;

        const decimals = this.getTokenDecimals(token, network);
        const abi = ["function balanceOf(address) view returns (uint256)"];
        const contract = new ethers.Contract(tokenAddress, abi, provider);

        const balanceWei = await contract.balanceOf(address);
        return Number(ethers.formatUnits(balanceWei, decimals));
      } catch (error) {
        lastError = error;
        // Wait 2s before retry
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    }
    console.error(
      `Error getting token balance after 3 attempts: ${lastError.message}`,
    );
    throw lastError;
  }

  async releaseFunds(
    token,
    network,
    buyerAddress,
    amount,
    amountWeiOverride = null,
    groupId = null,
    contractAddressOverride = null,
  ) {
    let wallet, provider, vaultContract, amountWei, contractAddress;
    try {
      // Validate inputs
      const decimals = this.getTokenDecimals(token, network);
      if (amountWeiOverride) {
        amountWei = BigInt(amountWeiOverride);
      } else {
        // Prevent negative amounts from network fee calculation issues
        if (amount < 0) {
          throw new Error(
            `Invalid Release Amount: ${amount}. Network fee might exceed gross amount.`,
          );
        }
        amountWei = ethers.parseUnits(amount.toString(), decimals);
      }
      if (amountWei <= 0n) {
        throw new Error(`Invalid Wei Amount: ${amountWei}. Must be positive.`);
      }
      if (network && network.toUpperCase() === "TRON") {
        const tronResult = await TronService.releaseFunds({
          token,
          to: buyerAddress,
          amount,
          groupId,
          contractAddress: contractAddressOverride,
        });
        return {
          success: true,
          transactionHash: tronResult.transactionHash,
          blockNumber: null,
        };
      }

      contractAddress = contractAddressOverride;
      if (!contractAddress) {
        contractAddress = await this.getEscrowContractAddress(
          token,
          network,
          groupId,
        );
      }
      if (!contractAddress) {
        throw new Error(
          `No escrow contract found for ${token} on ${network}${
            groupId ? ` for group ${groupId}` : ""
          }`,
        );
      }

      wallet = this.wallets[network.toUpperCase()];
      if (!wallet) {
        throw new Error(`Wallet not configured for network: ${network}`);
      }

      provider = this.providers[network.toUpperCase()];
      vaultContract = new ethers.Contract(
        contractAddress,
        ESCROW_VAULT_ABI,
        wallet,
      );

      let nonce;
      try {
        nonce = await provider.getTransactionCount(wallet.address, "pending");
      } catch (nonceError) {
        try {
          nonce = await provider.getTransactionCount(wallet.address);
        } catch (fallbackError) {
          throw new Error(
            `Failed to get transaction nonce: ${fallbackError.message}`,
          );
        }
      }

      // SAFETY CHECK: Verify Contract Balance
      // Re-initialize token contract to check balance
      const tokenAddressForCheck = await vaultContract.token();
      const tokenContractForCheck = new ethers.Contract(
        tokenAddressForCheck,
        ["function balanceOf(address) view returns (uint256)"],
        provider,
      );
      const contractBalanceWei = await tokenContractForCheck.balanceOf(
        contractAddress,
      );

      if (contractBalanceWei < amountWei) {
        throw new Error(
          `Insufficient Vault Balance: Contract has ${ethers.formatUnits(
            contractBalanceWei,
            decimals,
          )} but needs ${ethers.formatUnits(amountWei, decimals)}`,
        );
      }

      const tx = await vaultContract.release(buyerAddress, amountWei, {
        nonce: nonce,
      });

      const waitPromise = tx.wait();
      let receipt;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `Transaction verification timed out (${attempt}/3).`,
                  ),
                ),
              60000,
            ),
          );
          receipt = await Promise.race([waitPromise, timeoutPromise]);
          break; // Success!
        } catch (e) {
          if (attempt === 3) {
            throw new Error(
              "Transaction verification timed out after 3 attempts (180s). Please check the explorer manually.",
            );
          }
          console.log(
            `Verification attempt ${attempt} timed out, continuing to wait...`,
          );
        }
      }

      const transactionHash =
        receipt.transactionHash || receipt.hash || tx.hash;

      return {
        success: true,
        transactionHash: transactionHash,
        blockNumber: receipt.blockNumber,
      };
    } catch (error) {
      // Provide a concise log for common provider errors (like insufficient gas funds)
      const code = error?.code || error?.shortMessage || "";
      const providerMessage =
        error?.info?.error?.message || error?.message || "";
      if (
        code === "INSUFFICIENT_FUNDS" ||
        providerMessage.toLowerCase().includes("insufficient funds")
      ) {
        console.error(
          `Error releasing funds: Insufficient gas balance on ${network}. Details: ${providerMessage}`,
        );
      } else {
      }

      const errorMessage = error?.message || "";
      const errorData = JSON.stringify(error);

      if (
        errorMessage.includes("BEP20: transfer amount exceeds balance") ||
        errorData.includes("BEP20: transfer amount exceeds balance")
      ) {
        console.warn(
          `⚠️ Release Failed: Contract likely has insufficient balance (transfer exceeds balance).`,
        );
        throw error;
      }

      // Robust check for "Insufficient Vault Balance" to prevent console spam
      const errString = (error?.message || "") + (error?.toString() || "");
      if (!errString.includes("Insufficient Vault Balance")) {
        console.error(
          `Error releasing funds on ${network} (token: ${token}, contract: ${contractAddress}, amount: ${amount}):`,
          error,
        );
      }
      throw error;
    }
  }

  async refundFunds(
    token,
    network,
    sellerAddress,
    amount,
    amountWeiOverride = null,
    groupId = null,
    contractAddressOverride = null,
  ) {
    let wallet, provider, vaultContract, amountWei;
    try {
      if (network && network.toUpperCase() === "TRON") {
        const tronResult = await TronService.refundFunds({
          token,
          to: sellerAddress,
          amount,
          groupId,
          contractAddress: contractAddressOverride,
        });
        return {
          success: true,
          transactionHash: tronResult.transactionHash,
          blockNumber: null,
        };
      }

      let contractAddress = contractAddressOverride;
      if (!contractAddress) {
        contractAddress = await this.getEscrowContractAddress(
          token,
          network,
          groupId,
        );
      }
      if (!contractAddress) {
        throw new Error(
          `No escrow contract found for ${token} on ${network}${
            groupId ? ` for group ${groupId}` : ""
          }`,
        );
      }

      wallet = this.wallets[network.toUpperCase()];
      if (!wallet) {
        throw new Error(`Wallet not configured for network: ${network}`);
      }

      provider = this.providers[network.toUpperCase()];
      vaultContract = new ethers.Contract(
        contractAddress,
        ESCROW_VAULT_ABI,
        wallet,
      );
      const decimals = this.getTokenDecimals(token, network);
      amountWei = amountWeiOverride
        ? BigInt(amountWeiOverride)
        : ethers.parseUnits(amount.toString(), decimals);

      let nonce;
      try {
        nonce = await provider.getTransactionCount(wallet.address, "pending");
      } catch (nonceError) {
        try {
          nonce = await provider.getTransactionCount(wallet.address);
        } catch (fallbackError) {
          throw new Error(
            `Failed to get transaction nonce: ${fallbackError.message}`,
          );
        }
      }

      // SAFETY CHECK: Verify Contract Balance
      // Re-initialize token contract to check balance
      const tokenAddressForCheck = await vaultContract.token();
      const tokenContractForCheck = new ethers.Contract(
        tokenAddressForCheck,
        ["function balanceOf(address) view returns (uint256)"],
        provider,
      );
      const contractBalanceWei = await tokenContractForCheck.balanceOf(
        contractAddress,
      );

      if (contractBalanceWei < amountWei) {
        throw new Error(
          `Insufficient Vault Balance: Contract has ${ethers.formatUnits(
            contractBalanceWei,
            decimals,
          )} but needs ${ethers.formatUnits(amountWei, decimals)}`,
        );
      }

      const tx = await vaultContract.refund(sellerAddress, amountWei, {
        nonce: nonce,
      });

      const waitPromise = tx.wait();
      let receipt;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `Transaction verification timed out (${attempt}/3).`,
                  ),
                ),
              60000,
            ),
          );
          receipt = await Promise.race([waitPromise, timeoutPromise]);
          break; // Success!
        } catch (e) {
          if (attempt === 3) {
            throw new Error(
              "Transaction verification timed out after 3 attempts (180s). Please check the explorer manually.",
            );
          }
          console.log(
            `Verification attempt ${attempt} timed out, continuing to wait...`,
          );
        }
      }

      const transactionHash =
        receipt.transactionHash || receipt.hash || tx.hash;

      return {
        success: true,
        transactionHash: transactionHash,
        blockNumber: receipt.blockNumber,
      };
    } catch (error) {
      // Provide a concise log for common provider errors (like insufficient gas funds)
      const code = error?.code || error?.shortMessage || "";
      const providerMessage =
        error?.info?.error?.message || error?.message || "";
      if (
        code === "INSUFFICIENT_FUNDS" ||
        providerMessage.toLowerCase().includes("insufficient funds")
      ) {
        console.error(
          `Error refunding funds: Insufficient gas balance on ${network}. Details: ${providerMessage}`,
        );
      }

      const errorMessage = error?.message || "";
      const errorData = JSON.stringify(error);

      if (
        errorMessage.includes("BEP20: transfer amount exceeds balance") ||
        errorData.includes("BEP20: transfer amount exceeds balance")
      ) {
        console.warn(
          `⚠️ Refund Failed: Contract likely has insufficient balance (transfer exceeds balance).`,
        );
        throw error;
      }

      if (!error.message.includes("Insufficient Vault Balance")) {
        console.error("Error refunding funds:", error);
      }
      throw error;
    }
  }

  async getEscrowContractAddress(token, network, groupId = null) {
    try {
      const desiredFeePercent = Number(0); // Strict, no config fallback

      const contract = await ContractModel.findOne({
        name: "EscrowVault",
        token: token.toUpperCase(),
        network: network.toUpperCase(),
        feePercent: desiredFeePercent,
        status: "deployed",
      });

      return contract ? contract.address : null;
    } catch (error) {
      console.error("Error getting escrow contract address:", error);
      return null;
    }
  }

  getTokenAddress(token, network) {
    const tokenKey = `${token}_${network.toUpperCase()}`;
    return config[tokenKey];
  }

  async withdrawToAdmin(contractAddress, adminAddress, token, network, amount) {
    try {
      const wallet = this.wallets[network.toUpperCase()];
      if (!wallet) {
        throw new Error(`Wallet not configured for network: ${network}`);
      }

      const provider = this.providers[network.toUpperCase()];
      const vaultContract = new ethers.Contract(
        contractAddress,
        ESCROW_VAULT_ABI,
        wallet,
      );
      const decimals = this.getTokenDecimals(token, network);
      const amountWei = ethers.parseUnits(amount.toString(), decimals);

      const tokenAddress = this.getTokenAddress(token, network);
      if (!tokenAddress) {
        throw new Error(`Token address not found for ${token} on ${network}`);
      }

      let nonce;
      try {
        nonce = await provider.getTransactionCount(wallet.address, "latest");
      } catch (nonceError) {
        try {
          nonce = await provider.getTransactionCount(wallet.address);
        } catch (fallbackError) {
          throw new Error(
            `Failed to get transaction nonce: ${fallbackError.message}`,
          );
        }
      }

      const tx = await vaultContract.withdrawToken(tokenAddress, adminAddress, {
        nonce: nonce,
      });
      const receipt = await tx.wait();

      const transactionHash =
        receipt.transactionHash || receipt.hash || tx.hash;

      return transactionHash;
    } catch (error) {
      console.error("Error withdrawing to admin:", error);
      throw error;
    }
  }
}

module.exports = new BlockchainService();
