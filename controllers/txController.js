const { ethers, ContractUnknownEventPayload } = require("ethers");
const Transaction = require("../models/transactions");
const User = require("../models/user");
const MiningController = require("./miningController");
const networkConfig = require("../config/networks");
const { getNetworkConfig } = networkConfig;

// Main indexing function
async function indexNewTransactions() {
  try {
    const results = [];

    for (const [networkName, config] of Object.entries(
      networkConfig.networks
    )) {
      try {
        const provider = new ethers.JsonRpcProvider(config.rpcUrl);
        const contract = new ethers.Contract(
          config.contractAddress,
          DEPAYM_ABI,
          provider
        );

        // Get latest processed block for this network
        const lastBlock = await Transaction.findOne({
          network: networkName,
        }).sort({ blockNumber: -1 });
        const fromBlock = lastBlock ? lastBlock.blockNumber + 1 : 0;
        const toBlock = await provider.getBlockNumber();

        if (fromBlock > toBlock) continue;

        const events = await contract.queryFilter("*", fromBlock, toBlock);

        for (const event of events) {
          await processEvent(
            event,
            provider,
            networkName,
            config.contractAddress
          );
        }

        results.push({
          network: networkName,
          blocksProcessed: toBlock - fromBlock + 1,
          transactionsAdded: events.length,
        });
      } catch (error) {
        console.error(`Indexing error on ${networkName}:`, error);
        results.push({
          network: networkName,
          error: error.message,
        });
      }
    }

    return { success: true, results };
  } catch (error) {
    console.error("Global indexing error:", error);
    return { success: false, error: error.message };
  }
}

// Process individual event
async function processEvent(event, provider, networkName, contractAddress) {
  const txHash = event.transactionHash;

  // Skip if already exists
  if (
    await Transaction.exists({ transaction_hash: txHash, network: networkName })
  )
    return;

  const receipt = await provider.getTransactionReceipt(txHash);
  const block = await provider.getBlock(receipt.blockNumber);

  // Get token config
    // Get token config - normalize addresses and find symbol/decimals/official token address
  const tokenAddressRaw = String(event.args.token || "");
  const tokenAddressLower = tokenAddressRaw.toLowerCase();
  const networkTokens = networkConfig.networks[networkName].tokens || {};

  let tokenSymbol = "UNKNOWN";
  let tokenConfig;
  let tokenAddressCanonical = tokenAddressRaw;

  for (const [sym, cfg] of Object.entries(networkTokens)) {
    if ((String(cfg.address || "")).toLowerCase() === tokenAddressLower) {
      tokenSymbol = sym;
      tokenConfig = cfg;
      tokenAddressCanonical = cfg.address; // preserve configured canonical address casing
      break;
    }
  }

  const baseTx = {
    transaction_hash: txHash,
    blockNumber: receipt.blockNumber,
    contractAddress,
    status: receipt.status === 1 ? "confirmed" : "failed",
    timestamp: new Date(block.timestamp * 1000),
    network: networkName,
    token: tokenAddressCanonical, // store canonical address
    token_decimals: (tokenConfig && tokenConfig.decimals) || 6,
    token_symbol: tokenSymbol,
  };


  // Event-specific processing
  switch (event.eventName) {
    case "PaymentExecuted":
      await new Transaction({
        ...baseTx,
        function_name: "Pay",
        sender: event.args.user,
        receiver: event.args.receiver,
        amount: event.args.receiverAmount.toString(),
        fee: event.args.tierFee.toString(),
      }).save();
      break;

    case "WithdrawalExecuted":
      await new Transaction({
        ...baseTx,
        function_name: "Withdrawal",
        sender: event.args.user,
        receiver: event.args.receiver,
        amount: event.args.receiverAmount.toString(),
        fee: (
          BigInt(event.args.tierFee) + BigInt(event.args.withdrawFee)
        ).toString(),
      }).save();
      break;

    case "DepositExecuted":
      await new Transaction({
        ...baseTx,
        function_name: "Deposit",
        sender: event.args.onRamp,
        receiver: event.args.user,
        amount: (
          BigInt(event.args.amount) -
          BigInt(event.args.tierFee) -
          BigInt(event.args.onRampFee)
        ).toString(),
        fee: (
          BigInt(event.args.tierFee) + BigInt(event.args.onRampFee)
        ).toString(),
      }).save();
      break;
  }
}

module.exports = {
  getTransactions: async (req, res) => {
    try {
      const address = req.query.address?.toLowerCase();

      if (!ethers.isAddress(address)) {
        return res.status(400).json({ error: "Invalid wallet address" });
      }

      const transactions = await Transaction.find({
        $or: [{ sender: address }, { receiver: address }],
      })
        .sort({ timestamp: -1 })
        .limit(100);

      // Enhance transactions with direction and display type
      /* const enhancedTx = transactions.map(tx => {
        const isSender = tx.sender === address;
        const isReceiver = tx.receiver === address;
        
        return {
          ...tx._doc,
          direction: isSender ? 'out' : 'in',
          displayType: isSender ? 
            (tx.function_name === 'Pay' ? 'payment' : 'withdrawal') :
            (tx.function_name === 'Pay' ? 'payment' : 'deposit'),
          amount: ethers.formatUnits(tx.amount, tx.token_decimals || 6),
          fee: tx.fee ? ethers.formatUnits(tx.fee, tx.token_decimals || 6) : '0'
        };
      });*/


      const enhancedTx = transactions.map((tx) => {
        const isSender = (tx.sender || "").toLowerCase() === address;
        const func = (tx.function_name || "").toLowerCase();

        console.log("DEBUG tx:", {
  txId: tx.transaction_hash,
  token_symbol: tx.token_symbol,
  token_decimals_stored: tx.token_decimals,
  raw_amount: tx.amount?.toString?.() ?? tx.amount,
});


        let displayType, direction;
        if (func === "pay") {
          displayType = "payment";
          direction = isSender ? "out" : "in";
        } else if (func === "deposit") {
          displayType = "deposit";
          direction = isSender ? "out" : "in";
        } else if (func === "withdraw" || func === "withdrawal") {
          displayType = "withdrawal";
          direction = isSender ? "out" : "in";
        } else {
          displayType = func || "unknown";
          direction = isSender ? "out" : "in";
        }

        const decimals = Number(tx.token_decimals || 6);

        // helper: safeFormatUnits accepts many input shapes and returns a string
        const safeFormatUnits = (value, decimals) => {
          try {
            if (value === null || value === undefined || value === "")
              return "0";
            // if it's already a BigInt or numeric string of integer base-units, format directly
            if (typeof value === "bigint") {
              return ethers.formatUnits(value, decimals);
            }
            if (typeof value === "string") {
              // if string looks like an integer (no dot, only digits), feed directly
              if (/^-?\d+$/.test(value)) {
                return ethers.formatUnits(value, decimals);
              }
              // if string looks decimal (has dot), try parseUnits to get integer base units then format
              if (/^-?\d+\.\d+$/.test(value)) {
                try {
                  const parsed = ethers.parseUnits(value, decimals); // returns BigInt
                  return ethers.formatUnits(parsed, decimals);
                } catch (e) {
                  // parseUnits may fail for malformed strings; fall through
                  console.warn(
                    "safeFormatUnits.parseUnits failed:",
                    e?.message ?? e
                  );
                }
              }
              // fallback: try formatUnits with the string anyway (may throw)
              return ethers.formatUnits(value, decimals);
            }
            if (typeof value === "number") {
              // numbers are dangerous due to float precision; convert to string then parseUnits
              const s = String(value);
              if (s.indexOf(".") >= 0) {
                const parsed = ethers.parseUnits(s, decimals);
                return ethers.formatUnits(parsed, decimals);
              } else {
                return ethers.formatUnits(s, decimals);
              }
            }
            // fallback: toString and try
            return ethers.formatUnits(String(value), decimals);
          } catch (err) {
            console.error(
              "safeFormatUnits - could not format value:",
              value,
              "decimals:",
              decimals,
              "error:",
              err?.message ?? err
            );
            // Last-resort fallback: return the raw string form
            try {
              return String(value);
            } catch (e) {
              return "0";
            }
          }
        };

        let amountHuman = safeFormatUnits(tx.amount, decimals);
        let feeHuman = tx.fee ? safeFormatUnits(tx.fee, decimals) : "0";

        return {
          ...tx._doc,
          direction,
          displayType,
          amount: amountHuman,
          fee: feeHuman,
        };
      });

      res.json(enhancedTx);
    } catch (error) {
      console.error("Error fetching transactions:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  notifyTransaction: async (req, res) => {
    try {
      const {
        txHash,
        sender,
        recipient,
        amount,
        currency,
        network,
        function_name,
        token_decimals,
        token_symbol,
        fee,
        timestamp,
        contractAddress,
      } = req.body;

      const isDeposit = function_name.toLowerCase() === "deposit";
      const direction = isDeposit
        ? "in"
        : sender === recipient
        ? "out"
        : req.body.direction || "in";

      const displayType = isDeposit
        ? "deposit"
        : function_name.toLowerCase() === "withdrawal"
        ? "withdrawal"
        : "payment";

      // Validate network
      // Resolve network (accepts display name, alias like "base_sepolia", or numeric chainId)
      const rawNetworkInput =
        network || req.body.network_display_name || req.body.chainId;
      const resolved = getNetworkConfig(rawNetworkInput);

      if (!resolved) {
        return res.status(400).json({ error: "Unsupported network" });
      }

      const { displayName: canonicalNetworkName, config: netCfg } = resolved;

      // Validate token exists on this resolved network
   /*   const tokenKey = (currency || "").toUpperCase();
      if (!netCfg.tokens || !netCfg.tokens[tokenKey]) {
        return res.status(400).json({ error: "Unsupported token" });
      }*/

            // Determine decimals from payload or network config
      const tokenKey = (currency || "").toUpperCase();
      const decimalsFromCfg = netCfg.tokens?.[tokenKey]?.decimals ?? 6;
      const decimals = Number(token_decimals ?? decimalsFromCfg);

      // Normalize amount -> base unit string
      let amountBase;
      if (amount === undefined || amount === null) {
        amountBase = "0";
      } else if (typeof amount === "string") {
        if (/^-?\d+$/.test(amount)) {
          // already an integer in base-units
          amountBase = amount;
        } else if (/^-?\d+\.\d+$/.test(amount)) {
          // decimal representation (e.g. "1.23"), parse to base units
          amountBase = ethers.parseUnits(amount, decimals).toString();
        } else {
          // fallback: try numeric conversion
          const n = Number(amount);
          if (!Number.isNaN(n)) amountBase = ethers.parseUnits(String(n), decimals).toString();
          else amountBase = String(amount);
        }
      } else if (typeof amount === "number") {
        // numeric, convert safely
        amountBase = ethers.parseUnits(String(amount), decimals).toString();
      } else {
        // fallback: toString
        amountBase = String(amount);
      }

      // Determine token_symbol reliably: prefer provided token_symbol but fallback to tokenKey
      const resolvedTokenSymbol = (token_symbol && String(token_symbol).toUpperCase()) || tokenKey;


      // Build the transaction record and persist both forms: network_key (raw input) and canonical display name
            const newTx = new Transaction({
        transaction_hash: txHash,
        sender: sender.toLowerCase(),
        receiver: recipient.toLowerCase(),
        token: tokenKey,
        token_address: netCfg.tokens[tokenKey].address,
        amount: amountBase, // scaled integer string
        blockNumber: "pending",
        timestamp: timestamp ? new Date(timestamp) : new Date(),
        network_key: String(rawNetworkInput),
        network: canonicalNetworkName,
        chainId: netCfg.chainId,
        status: "confirmed",
        function_name: function_name,
        direction: direction,
        displayType: displayType,
        token_decimals: decimals,
        token_symbol: resolvedTokenSymbol,
        fee: (() => {
          // ensure fee stored as base-unit string (similar normalization)
          try {
            if (!fee) return "0";
            if (typeof fee === "string" && /^-?\d+$/.test(fee)) return fee;
            // if decimals known, try parseUnits if fee has decimals or is number
            if (typeof fee === "string" && fee.includes(".")) return ethers.parseUnits(fee, decimals).toString();
            if (typeof fee === "number") return ethers.parseUnits(String(fee), decimals).toString();
            return String(fee);
          } catch (e) { return String(fee); }
        })(),
        contractAddress: contractAddress || netCfg.contractAddress,
        raw_payload: req.body,
      });

      console.log("DEBUG notify payload:", {
  txHash, currency, token_symbol, token_decimals, decimals, amount, amountBase
});



      await newTx.save();

      // Determine boost address - use const instead of let
      const boostAddress =
        function_name.toLowerCase() === "deposit"
          ? recipient.toLowerCase()
          : sender.toLowerCase();

      console.log(
        `Processing ${function_name} transaction from ${sender} to ${recipient}`
      );
      console.log(`Boost address: ${boostAddress}`);

      const user = await User.findOne({
        "wallets.address": boostAddress,
      });

      if (user && user.miningSession?.isActive) {
        // Normalize function name and update booster
        let normalizedFunction = function_name
          .toLowerCase()
          .replace(/[^a-z]/g, "");

        // Handle "withdrawal" → "withdraw"
        if (normalizedFunction === "withdrawal") {
          normalizedFunction = "withdraw";
        }

        await MiningController.updateBooster(user, normalizedFunction);
        console.log(`Booster updated for user: ${user._id}`);
      }

      res.json({ success: true, transaction: newTx });
    } catch (error) {
      console.error("Notification error:", error);
      res.status(500).json({ error: error.message });
    }
  },
  indexNewTransactions,
};
