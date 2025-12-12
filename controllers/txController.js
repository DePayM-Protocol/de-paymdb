const { ethers } = require('ethers');
const Transaction = require('../models/transactions');
const User = require('../models/user');
const MiningController = require('./miningController');
const networkConfig = require('../config/networks');
const { getNetworkConfig } = networkConfig;

// Main indexing function
async function indexNewTransactions() {
  try {
    const results = [];
    
    for (const [networkName, config] of Object.entries(networkConfig.networks)) {
      try {
        const provider = new ethers.JsonRpcProvider(config.rpcUrl);
        const contract = new ethers.Contract(config.contractAddress, DEPAYM_ABI, provider);
        
        // Get latest processed block for this network
        const lastBlock = await Transaction.findOne({ network: networkName }).sort({ blockNumber: -1 });
        const fromBlock = lastBlock ? lastBlock.blockNumber + 1 : 0;
        const toBlock = await provider.getBlockNumber();
        
        if (fromBlock > toBlock) continue;

        const events = await contract.queryFilter('*', fromBlock, toBlock);
        
        for (const event of events) {
          await processEvent(event, provider, networkName, config.contractAddress);
        }
        
        results.push({
          network: networkName,
          blocksProcessed: toBlock - fromBlock + 1,
          transactionsAdded: events.length
        });
      } catch (error) {
        console.error(`Indexing error on ${networkName}:`, error);
        results.push({
          network: networkName,
          error: error.message
        });
      }
    }
    
    return { success: true, results };
  } catch (error) {
    console.error('Global indexing error:', error);
    return { success: false, error: error.message };
  }
}

// Process individual event
async function processEvent(event, provider, networkName, contractAddress) {
  const txHash = event.transactionHash;
  
  // Skip if already exists
  if (await Transaction.exists({ transaction_hash: txHash, network: networkName })) return;

  const receipt = await provider.getTransactionReceipt(txHash);
  const block = await provider.getBlock(receipt.blockNumber);
  
  // Get token config
  const tokenAddress = event.args.token;
  const tokenConfig = Object.values(networkConfig.networks[networkName].tokens)
    .find(t => t.address.toLowerCase() === tokenAddress.toLowerCase());
  
  const baseTx = {
    transaction_hash: txHash,
    blockNumber: receipt.blockNumber,
    contractAddress,
    status: receipt.status === 1 ? 'confirmed' : 'failed',
    timestamp: new Date(block.timestamp * 1000),
    network: networkName,
    token: tokenAddress,
    token_decimals: tokenConfig?.decimals || 6,
    token_symbol: Object.keys(networkConfig.networks[networkName].tokens)
      .find(key => networkConfig.networks[networkName].tokens[key].address === tokenAddress) || 'UNKNOWN'
  };

  // Event-specific processing
  switch(event.eventName) {
    case 'PaymentExecuted':
      await new Transaction({
        ...baseTx,
        function_name: 'Pay',
        sender: event.args.user,
        receiver: event.args.receiver,
        amount: event.args.receiverAmount.toString(),
        fee: event.args.tierFee.toString()
      }).save();
      break;

    case 'WithdrawalExecuted':
      await new Transaction({
        ...baseTx,
        function_name: 'Withdrawal',
        sender: event.args.user,
        receiver: event.args.receiver,
        amount: event.args.receiverAmount.toString(),
        fee: (BigInt(event.args.tierFee) + BigInt(event.args.withdrawFee)).toString()
      }).save();
      break;

    case 'DepositExecuted':
      await new Transaction({
        ...baseTx,
        function_name: 'Deposit',
        sender: event.args.onRamp,
        receiver: event.args.user,
        amount: (BigInt(event.args.amount) - BigInt(event.args.tierFee) - BigInt(event.args.onRampFee)).toString(),
        fee: (BigInt(event.args.tierFee) + BigInt(event.args.onRampFee)).toString()
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
        const isSender = tx.sender.toLowerCase() === address;
        // const isReceiver = tx.receiver.toLowerCase() === address;
        const func = tx.function_name.toLowerCase();

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
          displayType = func;
          direction = isSender ? "out" : "in";
        }

        return {
          ...tx._doc,
          direction,
          displayType,
          amount: ethers.formatUnits(
            tx.amount?.toString() || "0",
            tx.token_decimals || 6
          ),
          fee: tx.fee
            ? ethers.formatUnits(tx.fee.toString(), tx.token_decimals || 6)
            : "0",
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
const rawNetworkInput = network || req.body.network_display_name || req.body.chainId;
const resolved = getNetworkConfig(rawNetworkInput);

if (!resolved) {
  return res.status(400).json({ error: "Unsupported network" });
}

const { displayName: canonicalNetworkName, config: netCfg } = resolved;

// Validate token exists on this resolved network
const tokenKey = (currency || "").toUpperCase();
if (!netCfg.tokens || !netCfg.tokens[tokenKey]) {
  return res.status(400).json({ error: "Unsupported token" });
}

// Build the transaction record and persist both forms: network_key (raw input) and canonical display name
const newTx = new Transaction({
  transaction_hash: txHash,
  sender: sender.toLowerCase(),
  receiver: recipient.toLowerCase(),
  token: tokenKey,
  token_address: netCfg.tokens[tokenKey].address,
  amount: amount.toString(),
  blockNumber: "pending",
  timestamp: timestamp ? new Date(timestamp) : new Date(),
  network_key: String(rawNetworkInput),                // the exact client-provided value
  network: canonicalNetworkName,                       // canonical display name you already use
  chainId: netCfg.chainId,                             // numeric chainId
  status: "confirmed",
  function_name: function_name,
  direction: direction,
  displayType: displayType,
  token_decimals: token_decimals || netCfg.tokens[tokenKey].decimals || 6,
  token_symbol: token_symbol || tokenKey,
  fee: fee?.toString() || "0",
  contractAddress: contractAddress || netCfg.contractAddress,
  raw_payload: req.body, // optional, useful for auditing
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

