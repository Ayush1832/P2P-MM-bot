const { ethers } = require("ethers");
const config = require("../../config");
const Contract = require("../models/Contract");
const Escrow = require("../models/Escrow");
const GroupPool = require("../models/GroupPool");

class AddressAssignmentService {
  normalizeChainToNetwork(chain) {
    if (!chain) return "BSC";
    const upper = chain.toUpperCase();
    if (upper === "BNB" || upper === "BEP-20") return "BSC";
    if (upper === "ETHEREUM") return "ETH";
    if (upper === "MATIC" || upper === "POLYGON") return "POLYGON";
    return upper;
  }

  async assignDepositAddress(escrowId, token, network, amount, groupId = null) {
    try {
      const normalizedToken = (token || "").toUpperCase();
      let normalizedNetwork = network
        ? this.normalizeChainToNetwork(network)
        : "BSC";

      if (!groupId) {
        const escrow = await Escrow.findOne({ escrowId });
        if (escrow && escrow.groupId) {
          groupId = escrow.groupId;
          if (escrow.chain && !network) {
            normalizedNetwork = this.normalizeChainToNetwork(escrow.chain);
          }
        }
      }

      normalizedNetwork = normalizedNetwork.toUpperCase();

      let groupFeePercent = null;
      if (groupId) {
        try {
          const group = await GroupPool.findOne({ groupId });
          if (group) {
            groupFeePercent = group.feePercent;

            let assignedContract = null;
            if (group.contracts) {
              const key1 = normalizedToken;
              const key2 = `${normalizedToken}_${normalizedNetwork}`;

              if (group.contracts.get(key2)) {
                assignedContract = group.contracts.get(key2);
              } else if (group.contracts.get(key1)) {
                const c = group.contracts.get(key1);
                if (c.network === normalizedNetwork) {
                  assignedContract = c;
                }
              }
            }

            if (assignedContract && assignedContract.address) {
              return {
                address: assignedContract.address,
                contractAddress: assignedContract.address,
                sharedWithAmount: null,
              };
            }
          }
        } catch (groupError) {
          console.error(
            "Error getting group-specific contract address:",
            groupError,
          );
        }
      }

      let contract = null;

      if (!contract) {
        contract = await Contract.findOne({
          name: "EscrowVault",
          token: normalizedToken,
          network: normalizedNetwork,
          status: "deployed",
        });
      }

      if (!contract) {
        throw new Error(
          `No EscrowVault contract found for ${normalizedToken} on ${normalizedNetwork}. ` +
            `Please deploy the contract first using: npm run deploy`,
        );
      }

      return {
        address: contract.address,
        contractAddress: contract.address,
        sharedWithAmount: null,
      };
    } catch (error) {
      console.error("Error getting deposit address:", error);
      throw error;
    }
  }

  async releaseDepositAddress(escrowId) {
    return true;
  }

  async cleanupAbandonedAddresses() {
    return 0;
  }

  async getAddressPoolStats() {
    try {
      const privateKey = config.HOT_WALLET_PRIVATE_KEY.startsWith("0x")
        ? config.HOT_WALLET_PRIVATE_KEY
        : "0x" + config.HOT_WALLET_PRIVATE_KEY;
      const wallet = new ethers.Wallet(privateKey);
      const depositAddress = wallet.address;

      return {
        total: 1,
        singleAddress: depositAddress,
        byToken: {
          ALL_TOKENS: depositAddress,
        },
      };
    } catch (error) {
      console.error("Error getting address pool stats:", error);
      return { total: 0, singleAddress: null, byToken: {} };
    }
  }

  async initializeAddressPool(feePercent = null) {
    return {
      message:
        "Address pool initialization no longer needed. Single deposit address is used for all tokens.",
    };
  }
}

module.exports = new AddressAssignmentService();
