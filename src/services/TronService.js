const TronWeb = require("tronweb");
const ContractModel = require("../models/Contract");
const config = require("../../config");

const ESCROW_VAULT_ABI = [
  {
    inputs: [
      { internalType: "address", name: "to", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "release",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "to", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "refund",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "erc20Token", type: "address" },
      { internalType: "address", name: "to", type: "address" },
    ],
    name: "withdrawToken",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "withdrawFees",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "accumulatedFees",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "token",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "feeWallet",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "feePercent",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
];

class TronService {
  constructor() {
    this.tronWeb = null;
    this.initialized = false;
    this.providers = [
      (config.TRON_RPC_URL || "https://api.trongrid.io").replace(
        /\/jsonrpc$/,
        "/"
      ),
      "https://tron-rpc.publicnode.com",
    ];
    this.currentProviderIndex = 0;
  }

  async init() {
    if (this.initialized) return;

    const rawKey = config.TRC_PRIVATE_KEY || config.HOT_WALLET_PRIVATE_KEY;
    const privateKey = rawKey.startsWith("0x") ? rawKey.slice(2) : rawKey;

    this.tronWeb = new TronWeb({
      fullHost: this.providers[this.currentProviderIndex],
      privateKey,
    });

    this.initialized = true;
  }

  async _rotateProvider() {
    this.currentProviderIndex =
      (this.currentProviderIndex + 1) % this.providers.length;
    const newProvider = this.providers[this.currentProviderIndex];
    console.log(`🔄 Switching Tron Provider to: ${newProvider}`);

    const rawKey = config.TRC_PRIVATE_KEY || config.HOT_WALLET_PRIVATE_KEY;
    const privateKey = rawKey.startsWith("0x") ? rawKey.slice(2) : rawKey;

    this.tronWeb = new TronWeb({
      fullHost: newProvider,
      privateKey,
    });
  }

  toSun(amount) {
    return this.tronWeb.toBigNumber(Math.round(Number(amount) * 1e6));
  }

  async getVaultContract(token = "USDT", groupId = null) {
    await this.init();

    // We don't rely on global config anymore. default to 0 if we must search without group context.
    // If groupId is provided, we should ideally finding the contract by groupId regardless of fee.
    const desiredFeePercent = 0;
    const query = {
      name: "EscrowVault",
      token: token.toUpperCase(),
      network: "TRON",
      feePercent: desiredFeePercent,
      status: "deployed",
    };

    if (groupId) {
      query.groupId = groupId;
      // vital: ignore feePercent if we are looking up by specific group ID,
      // as the group's contract might have a non-zero fee.
      delete query.feePercent;
    }

    const contractEntry = await ContractModel.findOne(query);
    if (!contractEntry) {
      throw new Error(
        `EscrowVault not found for ${token} on TRON with ${desiredFeePercent}% fee${
          groupId ? ` (group ${groupId})` : ""
        }`
      );
    }

    const contract = await this.tronWeb.contract(
      ESCROW_VAULT_ABI,
      contractEntry.address
    );
    return { contract, address: contractEntry.address };
  }

  async releaseFunds({
    token = "USDT",
    to,
    amount,
    groupId = null,
    contractAddress = null,
  }) {
    try {
      let contract, address;
      if (contractAddress) {
        contract = await this.tronWeb.contract().at(contractAddress);
        address = contractAddress;
      } else {
        const vault = await this.getVaultContract(token, groupId);
        contract = vault.contract;
        address = vault.address;
      }

      // Resolve token address for balance check
      let tokenForCheck = token;
      if (token.toUpperCase() !== "USDT" && !token.startsWith("T")) {
        try {
          const onChainToken = await contract.token().call();
          if (onChainToken) {
            tokenForCheck = this.tronWeb.address.fromHex(onChainToken);
          }
        } catch (e) {
          console.warn(
            "Could not resolve token address from vault:",
            e.message
          );
        }
      }

      // Pre-check balance
      const currentBalance = await this.getTokenBalance(tokenForCheck, address);
      if (currentBalance < amount) {
        throw new Error(
          `Insufficient Vault Balance: Contract has ${currentBalance} but needs ${amount}`
        );
      }

      const amountSun = this.toSun(amount);

      const tx = await contract.release(to, amountSun).send({
        feeLimit: 100_000_000, // 100 TRX sun
        callValue: 0,
      });

      return {
        success: true,
        transactionHash: tx,
        contractAddress: address,
      };
    } catch (error) {
      console.error("TRON releaseFunds error:", error);
      throw error;
    }
  }

  async refundFunds({
    token = "USDT",
    to,
    amount,
    groupId = null,
    contractAddress = null,
  }) {
    try {
      let contract, address;
      if (contractAddress) {
        contract = await this.tronWeb.contract().at(contractAddress);
        address = contractAddress;
      } else {
        const vault = await this.getVaultContract(token, groupId);
        contract = vault.contract;
        address = vault.address;
      }

      // Resolve token address for balance check
      let tokenForCheck = token;
      if (token.toUpperCase() !== "USDT" && !token.startsWith("T")) {
        try {
          const onChainToken = await contract.token().call();
          if (onChainToken) {
            tokenForCheck = this.tronWeb.address.fromHex(onChainToken);
          }
        } catch (e) {
          console.warn(
            "Could not resolve token address from vault:",
            e.message
          );
        }
      }

      // Pre-check balance
      const currentBalance = await this.getTokenBalance(tokenForCheck, address);
      if (currentBalance < amount) {
        throw new Error(
          `Insufficient Vault Balance: Contract has ${currentBalance} but needs ${amount}`
        );
      }

      const amountSun = this.toSun(amount);

      const tx = await contract.refund(to, amountSun).send({
        feeLimit: 100_000_000, // 100 TRX sun
        callValue: 0,
      });

      return {
        success: true,
        transactionHash: tx,
        contractAddress: address,
      };
    } catch (error) {
      console.error("TRON refundFunds error:", error);
      throw error;
    }
  }

  async withdrawToken({ contractAddress, token = "USDT", to }) {
    await this.init();
    try {
      console.log(`[TRON] withdrawToken called:`);
      console.log(`  Contract: ${contractAddress}`);
      console.log(`  Token: ${token}`);
      console.log(`  To: ${to}`);

      // If token is USDT, resolve address from config
      const tokenAddress =
        token.toUpperCase() === "USDT" ? config.USDT_TRON : token;

      console.log(`  Token Address: ${tokenAddress}`);

      const contract = await this.tronWeb.contract(
        ESCROW_VAULT_ABI,
        contractAddress
      );

      console.log(`[TRON] Calling withdrawToken on vault contract...`);

      const tx = await contract.withdrawToken(tokenAddress, to).send({
        feeLimit: 100_000_000,
        callValue: 0,
      });

      console.log(`[TRON] Transaction sent: ${tx}`);
      console.log(`[TRON] View: https://tronscan.org/#/transaction/${tx}`);

      return {
        success: true,
        transactionHash: tx,
        contractAddress: contractAddress,
      };
    } catch (error) {
      console.error("[TRON] withdrawToken error:", error);
      console.error("[TRON] Error message:", error.message);
      if (error.error) {
        console.error("[TRON] Error details:", error.error);
      }
      throw error;
    }
  }

  async getFeeSettings({ token = "USDT", contractAddress = null }) {
    await this.init();
    try {
      let contract;
      if (contractAddress) {
        contract = await this.tronWeb.contract().at(contractAddress);
      } else {
        const vault = await this.getVaultContract(token);
        contract = vault.contract;
      }

      // TRON calls
      const feeWallet = await contract.feeWallet().call();
      const feePercent = await contract.feePercent().call();
      const accumulated = await contract.accumulatedFees().call();
      return {
        feeWallet: this.tronWeb.address.fromHex(feeWallet),
        feePercent: Number(feePercent),
        accumulated: accumulated.toString(),
      };
    } catch (error) {
      console.error("TRON getFeeSettings error:", error);
      throw error;
    }
  }

  _wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async _retryWithBackoff(fn, retries = 5, delay = 5000) {
    try {
      return await fn();
    } catch (err) {
      const msg = err.message || "";
      if (
        retries > 0 &&
        (msg.includes("429") ||
          msg.includes("Too Many Requests") ||
          msg.includes("request rate exceeded"))
      ) {
        await this._rotateProvider();
        await this._wait(1000); // Short wait after switch
        return this._retryWithBackoff(fn, retries - 1, delay); // Maintain original delay if we recurse again
      }
      throw err;
    }
  }

  async withdrawFees({ token = "USDT", contractAddress = null }) {
    await this.init();
    return this._retryWithBackoff(async () => {
      let contract;
      if (contractAddress) {
        contract = await this.tronWeb.contract().at(contractAddress);
      } else {
        const vault = await this.getVaultContract(token);
        contract = vault.contract;
      }

      // Pre-check: Don't waste energy if no fees
      const accumulated = await contract.accumulatedFees().call();
      if (accumulated.toString() === "0") {
        throw new Error(
          `Validation Error: no-balance - Accumulated fees are 0. Withdrawal would fail.`
        );
      }

      const tx = await contract.withdrawFees().send({
        feeLimit: 100_000_000,
        callValue: 0,
      });

      return {
        success: true,
        transactionHash: tx,
        contractAddress: contractAddress,
        amount: accumulated.toString(),
      };
    });
  }

  /**
   * Fetch TRC20 Transfer events to a given address (best-effort via TronGrid)
   * @param {string} token
   * @param {string} toAddress
   * @param {number} fromBlock
   * @returns {Promise<Array<{from:string,to:string,valueDecimal:number,blockNumber:number}>>}
   */
  async getTokenTransfers(token = "USDT", toAddress, fromBlock = 0) {
    await this.init();
    const tokenAddress =
      token.toUpperCase() === "USDT" ? config.USDT_TRON : null;
    if (!tokenAddress || !toAddress) return [];

    try {
      const events = await this.tronWeb.getEventResult(tokenAddress, {
        eventName: "Transfer",
        size: 200,
        page: 1,
        onlyConfirmed: true,
        filters: { to: toAddress },
      });

      return (events || [])
        .filter(
          (ev) => ev && ev.result && (!fromBlock || ev.block_number > fromBlock)
        )
        .map((ev) => {
          const from = ev.result.from;
          const to = ev.result.to;
          const value = ev.result.value || "0";
          const valueDecimal = Number(value) / 1e6; // USDT TRON has 6 decimals
          return {
            from,
            to,
            valueDecimal,
            blockNumber: ev.block_number,
            hash: ev.transaction_id,
          };
        });
    } catch (error) {
      console.error("TRON getTokenTransfers error:", error);
      return [];
    }
  }

  async getLatestBlockNumber() {
    await this.init();
    try {
      const block = await this.tronWeb.trx.getCurrentBlock();
      return block?.block_header?.raw_data?.number || 0;
    } catch (error) {
      console.error("TRON getLatestBlockNumber error:", error);
      return 0;
    }
  }

  async getTokenBalance(token, address) {
    await this.init();
    try {
      console.log(`[TRON] getTokenBalance called:`);
      console.log(`  Token: ${token}`);
      console.log(`  Address: ${address}`);

      const tokenAddress =
        token.toUpperCase() === "USDT" ? config.USDT_TRON : token;

      console.log(`  Token Contract: ${tokenAddress}`);

      if (!tokenAddress) {
        console.log(`[TRON] No token address found, returning 0`);
        return 0;
      }

      const contract = await this.tronWeb.contract().at(tokenAddress);
      const balance = await contract.balanceOf(address).call();
      const balanceDecimal = Number(balance.toString()) / 1e6;

      console.log(`[TRON] Balance: ${balanceDecimal} ${token}`);

      return balanceDecimal;
    } catch (error) {
      console.error("[TRON] getTokenBalance error:", error.message);
      return 0;
    }
  }
}

module.exports = new TronService();
