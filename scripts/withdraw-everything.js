const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config();
const { ethers } = require("ethers");
const config = require("../config");

const ContractModel = require(path.join("..", "src", "models", "Contract"));

// Minimal ABIs
const ESCROW_VAULT_ABI = [
  "function withdrawToken(address erc20Token, address to) external",
  "function owner() view returns (address)",
];

const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

// Configuration for tokens to check per network
function getTokensForNetwork(network) {
  const net = network.toUpperCase();
  const tokens = [];

  // Helper to add from config if exists
  const add = (key, symbol) => {
    const addr = config[key];
    if (addr && ethers.isAddress(addr)) {
      tokens.push({ address: addr, symbol });
    }
  };

  if (net === "BSC") {
    add("USDT_BSC", "USDT");
    add("USDC_BSC", "USDC");
    add("BUSD_BSC", "BUSD");
    add("BTC_BSC", "BTCB");
    add("ETH_BSC", "ETH");
    add("BNB_BSC", "WBNB"); // WBNB
  }

  return tokens;
}

async function main() {
  const { MONGODB_URI, BSC_RPC_URL, HOT_WALLET_PRIVATE_KEY } = process.env;

  if (!MONGODB_URI) throw new Error("MONGODB_URI missing");

  // Destination address (defaults to hot wallet / admin if not provided)
  let withdrawTo = process.argv[2];

  // Setup Wallet
  const privateKey = HOT_WALLET_PRIVATE_KEY.startsWith("0x")
    ? HOT_WALLET_PRIVATE_KEY
    : "0x" + HOT_WALLET_PRIVATE_KEY;

  // We'll use BSC provider for now since most tokens are on BSC
  // If we need multi-chain, we'd need multiple providers
  if (!BSC_RPC_URL) throw new Error("BSC_RPC_URL missing");
  const provider = new ethers.JsonRpcProvider(BSC_RPC_URL);
  const wallet = new ethers.Wallet(privateKey, provider);

  if (!withdrawTo) {
    withdrawTo = wallet.address;
    console.log("ℹ️  No destination address provided. Using Admin Wallet.");
  }

  if (!ethers.isAddress(withdrawTo)) {
    throw new Error(`Invalid withdrawal address: ${withdrawTo}`);
  }

  console.log("🔌 Connecting to database...");
  await mongoose.connect(MONGODB_URI);
  console.log("✅ Connected!\n");

  // 1. Fetch Contracts
  const contracts = await ContractModel.find({
    status: "deployed",
    network: "BSC", // Limiting to BSC for this script version
  });

  if (contracts.length === 0) {
    console.log("No BSC contracts found.");
    await mongoose.disconnect();
    return;
  }

  console.log(
    `📋 Scanning ${contracts.length} contracts for ANY token balance...`
  );
  console.log(`📍 Withdrawal Destination: ${withdrawTo}`);
  console.log("=".repeat(60));

  // 2. Scan Balances
  const withdrawals = [];
  const knownTokens = getTokensForNetwork("BSC");

  // Also add any tokens defined in the contracts themselves if not in known list
  const allTokenAddresses = new Set(
    knownTokens.map((t) => t.address.toLowerCase())
  );

  for (let i = 0; i < contracts.length; i++) {
    const contract = contracts[i];

    // Add contract's own token to check list if new
    const contractTokenAddr = config[`${contract.token}_BSC`]; // Try to find address
    // We can relies on knownTokens for now to be safe and cover major ones

    process.stdout.write(
      `\r🔍 [${i + 1}/${contracts.length}] Checking ${contract.address}...`
    );

    for (const token of knownTokens) {
      try {
        const tokenContract = new ethers.Contract(
          token.address,
          ERC20_ABI,
          provider
        );
        const balance = await tokenContract.balanceOf(contract.address);

        if (balance > 0n) {
          const decimals = await tokenContract.decimals().catch(() => 18);
          const format = ethers.formatUnits(balance, decimals);

          withdrawals.push({
            contractAddress: contract.address,
            contractToken: contract.token, // What the contract is SUPPOSED to allow
            tokenAddress: token.address,
            tokenSymbol: token.symbol,
            rawBalance: balance,
            formattedBalance: format,
            vaultContract: new ethers.Contract(
              contract.address,
              ESCROW_VAULT_ABI,
              wallet
            ),
          });
        }
      } catch (e) {
        // Provide quiet failure for token checks
      }
    }
  }
  console.log("\n");

  if (withdrawals.length === 0) {
    console.log("✅ No stray funds found in any contract.");
    await mongoose.disconnect();
    return;
  }

  // 3. Review
  console.log("💰 FUNDS FOUND:");
  withdrawals.forEach((w, idx) => {
    console.log(
      `${idx + 1}. Contract (${w.contractToken}): ${w.contractAddress}`
    );
    console.log(`   Found: ${w.formattedBalance} ${w.tokenSymbol}`);
    if (w.tokenSymbol !== w.contractToken && w.contractToken !== "UNKNOWN") {
      console.log(
        `   ⚠️  MISMATCH: Found ${w.tokenSymbol} in ${w.contractToken} vault!`
      );
    }
    console.log("-".repeat(40));
  });

  // 4. Confirm
  console.log(`\n⚠️  Ready to withdraw ALL above funds to ${withdrawTo}?`);
  console.log("Press Ctrl+C to cancel, or wait 5s to proceed...");
  await new Promise((r) => setTimeout(r, 5000));

  // 5. Execute
  console.log("\n🚀 Executing Withdrawals...");

  for (const w of withdrawals) {
    try {
      console.log(
        `Processing ${w.formattedBalance} ${w.tokenSymbol} from ${w.contractAddress}...`
      );

      // Pre-flight check: Owner?
      const owner = await w.vaultContract.owner();
      if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
        console.log(`❌ Failed: Wallet is not owner of this contract.`);
        continue;
      }

      const tx = await w.vaultContract.withdrawToken(
        w.tokenAddress,
        withdrawTo
      );
      console.log(`   Tx Sent: ${tx.hash}`);
      await tx.wait();
      console.log(`   ✅ Confirmed.`);
    } catch (err) {
      console.log(`   ❌ Error: ${err.message}`);
    }
  }

  console.log("\n✅ Done.");
  await mongoose.disconnect();
}

main().catch(console.error);
