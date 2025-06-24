const ethers = require("ethers");

const { JsonRpcProvider, Contract, Wallet } = require("ethers");
const { isAddress } = require("ethers");
//const DePayMArtifact = require("../DePayM1-SmartContract-Deployment/artifacts/contracts/DePayM.sol/DePayM.json");



// ====================== CONFIGURATION ======================
const config = {
  chainId: 84532, // Base Sepolia
  contractName: "DePayM",
  contractVersion: "1",
  maxPriceAge: 86400, // 24h in seconds
  maxDailyAmount: ethers.parseUnits("10000", 6), // 10,000 USDC (6 decimals)
  gasLimits: {
    pay: 300000n,           // Increased from 600,000n
    deposit: 250000n,        // Increased from 400,000n
    withdraw: 250000n,       // Increased from 450,000n
    signatureOperations: 350000n, // Increased from 700,000n
  },
  feeStructure: {
    withdrawBps: 50n, // 0.5%
    onRampBps: 70n, // 0.7%
    tiers: [
      { minAmount: 0, fixedFee: ethers.parseUnits("0.10", 6) },
      { minAmount: ethers.parseUnits("5", 6), fixedFee: ethers.parseUnits("0.18", 6) },
      { minAmount: ethers.parseUnits("15", 6), fixedFee: ethers.parseUnits("0.265", 6) },
      { minAmount: ethers.parseUnits("50", 6), fixedFee: ethers.parseUnits("0.371", 6) },
      { minAmount: ethers.parseUnits("100", 6), fixedFee: ethers.parseUnits("0.71", 6) },
      { minAmount: ethers.parseUnits("500", 6), fixedFee: ethers.parseUnits("2.99", 6) },
      { minAmount: ethers.parseUnits("1000", 6), fixedFee: ethers.parseUnits("5.5", 6) },
      { minAmount: ethers.parseUnits("2500", 6), fixedFee: ethers.parseUnits("8.7", 6) },
      { minAmount: ethers.parseUnits("5000", 6), fixedFee: ethers.parseUnits("15.2", 6) },
    ],
  },
};

// controllers/relayerController.js (add to top)
console.log("Relayer Controller Routes:");
console.log("  POST /api/relayer/pay");
console.log("  POST /api/relayer/deposit");
console.log("  POST /api/relayer/withdraw");

// ====================== INITIALIZATION ======================

// Updated RPC configuration with fallbacks
const BASE_RPC_URLS = [
  process.env.BASE_RPC_URL, // Custom URL from env
  "https://sepolia.base.org", // Official endpoint
  "https://base-sepolia-rpc.publicnode.com", // Public node
  "https://base-sepolia.blockpi.network/v1/rpc/public", // BlockPi
  "https://base-sepolia.drpc.org" // dRPC
].filter(Boolean); // Remove empty strings

async function createProvider() {
  let lastError;
  
  for (const url of BASE_RPC_URLS) {
    try {
      const provider = new JsonRpcProvider(url, {
        name: "Base Sepolia",
        chainId: 84532,
        ensAddress: undefined,
        staticNetwork: true // Bypass network detection
      });
      
      // Test connection with timeout
      await Promise.race([
        provider.getBlockNumber(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Timeout')), 5000)
        )
      ]);
      
      console.log(`Connected to RPC: ${url}`);
      return provider;
    } catch (error) {
      lastError = error;
      console.warn(`Failed to connect to ${url}:`, error.message);
    }
  }
  
  throw new Error(`All RPC endpoints failed. Last error: ${lastError?.message}`);
}

async function verifyNetwork() {
  try {
    const network = await provider.getNetwork();
    if (network.chainId !== 84532n) {
      throw new Error(`Connected to wrong network. Expected 84532, got ${network.chainId}`);
    }
    console.log("Connected to Base Sepolia (Chain ID: 84532)");
  } catch (error) {
    console.error("Network verification failed:", error);
    process.exit(1); // Exit if wrong network
  }
}

async function verifyContract() {
  try {
    const code = await provider.getCode(process.env.DEPAYM_CONTRACT_ADDRESS);
    if (code === '0x') {
      throw new Error("Contract not deployed at the specified address");
    }
    console.log("Contract verified at:", process.env.DEPAYM_CONTRACT_ADDRESS);
  } catch (error) {
    console.error("Contract verification failed:", error);
    process.exit(1);
  }
}

// Initialize provider
let provider, wallet, contract;
let isInitialized = false;
let initializationPromise;

async function initialize() {
  if (isInitialized) return;
  
  if (!initializationPromise) {
    initializationPromise = (async () => {
      try {
        provider = await createProvider();
        wallet = new Wallet(process.env.RELAYER_PRIVATE_KEY, provider);
        
        const abi = require("../DePayM1-SmartContract-Deployment/artifacts/contracts/DePayM.sol/DePayM.json").abi;
        contract = new Contract(process.env.DEPAYM_CONTRACT_ADDRESS, abi, wallet);
        
        // Verify contract exists
        const code = await provider.getCode(process.env.DEPAYM_CONTRACT_ADDRESS);
        if (code === '0x') {
          throw new Error("Contract not deployed at specified address");
        }
        
        isInitialized = true;
        console.log("✅ Initialization complete");
      } catch (error) {
        console.error("Initialization failed:", error);
        throw error;
      }
    })();
  }
  
  return initializationPromise;
}
  /*module.exports = {
    provider,
    wallet,
    contract,
    // ... your existing exports
  };*/


const domain = {
  name: config.contractName,
  version: config.contractVersion,
  chainId: config.chainId,
  verifyingContract: process.env.DEPAYM_CONTRACT_ADDRESS,
};

const types = {
  Pay: [
    { name: "user", type: "address" },
    { name: "token", type: "address" },
    { name: "receiver", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  Withdraw: [
    { name: "user", type: "address" },
    { name: "token", type: "address" },
    { name: "receiver", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  Deposit: [
    { name: "user", type: "address" },
    { name: "token", type: "address" },
    { name: "onRamp", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

// ====================== UTILITIES ======================
function validateAddress(addr) {
  if (!isAddress(addr)) throw new Error(`Invalid address: ${addr}`);
}

async function checkDailyLimit(user, amount) {
  const dailyVolume = await contract.dailyVolume(user);
  if (dailyVolume + amount > config.maxDailyAmount) {
    throw new Error("Daily limit exceeded");
  }
}

// Verify network connection




// ====================== CORE FUNCTIONS ======================

// ----------- PAYMENT FLOW -----------
async function ensureInitialized() {
  if (!contract) {
    await initialize();
  }
}


exports.payWithSignature = async (req, res) => {
  try {
    await ensureInitialized();

    // Validate request structure
    if (!req.body?.contractAddress) {
      throw new Error("Missing contractAddress in request");
    }
    if (!req.body?.signedTx?.message || !req.body?.signedTx?.signature) {
      throw new Error("Invalid signedTx structure");
    }

    // Normalize contract address
    const contractAddress = ethers.getAddress(req.body.contractAddress);
    const contract = new Contract(
      contractAddress,
      DePayMArtifact.abi,
      wallet.connect(provider)
    );

    // Extract and validate message
    const { message, signature } = req.body.signedTx;
    
    // Verify domain and types match frontend
    const domain = {
      name: "DePayM",
      version: "1",
      chainId: 84532,
      verifyingContract: contractAddress
    };

    const types = {
      Pay: [
        { name: "user", type: "address" },
        { name: "token", type: "address" },
        { name: "receiver", type: "address" },
        { name: "receiverAmount", type: "uint256" },
        { name: "totalAmount", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ]
    };

    // Verify signature
    const recoveredAddress = ethers.verifyTypedData(
      domain,
      types,
      message,
      signature
    );

    // Rest of your existing code...
    const { v, r, s } = ethers.Signature.from(signature);

    // Prepare transaction
    const tx = await contract.payWithSignature.populateTransaction(
      message.user,
      message.token,
      message.receiver,
      message.receiverAmount,
      message.totalAmount,
      message.nonce,
      message.deadline,
      v, r, s
    );

    // Send transaction
    const txResponse = await wallet.sendTransaction({
      ...tx,
      gasLimit: config.gasLimits.signatureOperations,
    });

    const receipt = await txResponse.wait();

     // 8. Parse events
     console.log("Parsing receipt events...");
     let feeEvent, paymentEvent;
     for (const log of receipt.logs) {
       try {
         const parsed = contract.interface.parseLog(log);
         if (parsed?.name === "FeeDetails") feeEvent = parsed;
         if (parsed?.name === "PaymentExecuted") paymentEvent = parsed;
       } catch (e) {
         // Skip unparseable logs
       }
     }
 
     if (!feeEvent || !paymentEvent) {
       console.warn("Missing expected events in receipt");
     }
 
     return res.json({
       success: true,
       txHash: receipt.hash,
       receiverAmount: feeEvent?.args?.receiverAmount?.toString() || "0",
       tierFee: feeEvent?.args?.tierFee?.toString() || "0",
       totalAmount: feeEvent?.args?.totalAmount?.toString() || "0"
     });
 

  } catch (error) {
    console.error("PayWithSignature error:", {
      message: error.message,
      stack: error.stack,
      reason: error.reason,
      data: error.data
    });
    res.status(500).json({ 
      error: error.message,
      details: error.reason || undefined
    });
  }
}; 



exports.pay = async (req, res) => {
  try {
    await ensureInitialized();
    const { user, token, receiver, amount } = req.body;
    validateAddress(user);
    validateAddress(token);
    validateAddress(receiver);

    // Pre-checks
    if (!(await contract.relayers(wallet.address))) 
      throw new Error("Relayer not authorized");
    if (!(await contract.supportedStablecoins(token))) 
      throw new Error("Unsupported token");
    await checkDailyLimit(user, amount);

    const tx = await contract.pay.populateTransaction(
      user, token, receiver, amount
    );
    
    const receipt = await wallet.sendTransaction({
      ...tx,
      gasLimit: config.gasLimits.pay,
    }).then(tx => tx.wait());

    res.json({ 
      success: true, 
      txHash: receipt.hash 
    });
  } catch (error) {
    console.error("pay error:", error);
    res.status(500).json({ error: error.message });
  }
};

// ----------- WITHDRAWAL FLOW -----------
exports.withdrawWithSignature = async (req, res) => {
  try {
    await ensureInitialized();
    const { signedTx } = req.body;
    const { message, signature } = signedTx;

    const { v, r, s } = ethers.Signature.from(signature);
    const tx = await contract.withdrawWithSignature.populateTransaction(
      message.user,
      message.token,
      message.receiver,
      message.amount,
      message.deadline,
      v, r, s
    );

    const receipt = await wallet.sendTransaction({
      ...tx,
      gasLimit: config.gasLimits.signatureOperations,
    }).then(tx => tx.wait());

    const event = receipt.logs?.find(log => 
      contract.interface.parseLog(log)?.name === "WithdrawalExecuted"
    );

    res.json({
      success: true,
      txHash: receipt.hash,
      amount: event.args.amount.toString(),
      tierFee: event.args.tierFee.toString(),
      withdrawFee: event.args.withdrawFee.toString(),
    });
  } catch (error) {
    console.error("withdrawWithSignature error:", error);
    res.status(500).json({ error: error.message });
  }
};

exports.withdraw = async (req, res) => {
  try {
    await ensureInitialized();
    const { user, token, receiver, amount } = req.body;
    validateAddress(user);
    validateAddress(token);
    validateAddress(receiver);

    if (!(await contract.relayers(wallet.address))) 
      throw new Error("Relayer not authorized");
    if (!(await contract.supportedStablecoins(token))) 
      throw new Error("Unsupported token");
    await checkDailyLimit(user, amount);

    const tx = await contract.withdraw.populateTransaction(
      user, token, receiver, amount
    );

    const receipt = await wallet.sendTransaction({
      ...tx,
      gasLimit: config.gasLimits.withdraw,
    }).then(tx => tx.wait());

    res.json({ 
      success: true, 
      txHash: receipt.hash 
    });
  } catch (error) {
    console.error("withdraw error:", error);
    res.status(500).json({ error: error.message });
  }
};

// ----------- DEPOSIT FLOW -----------
exports.depositWithSignature = async (req, res) => {
  try {
    await ensureInitialized();
    const { signedTx } = req.body;
    const { message, signature } = signedTx;

    const { v, r, s } = ethers.Signature.from(signature);
    const tx = await contract.depositWithSignature.populateTransaction(
      message.user,
      message.token,
      message.onRamp,
      message.amount,
      message.deadline,
      v, r, s
    );

    const receipt = await wallet.sendTransaction({
      ...tx,
      gasLimit: config.gasLimits.signatureOperations,
    }).then(tx => tx.wait());

    const event = receipt.logs?.find(log => 
      contract.interface.parseLog(log)?.name === "DepositExecuted"
    );

    res.json({
      success: true,
      txHash: receipt.hash,
      amount: event.args.amount.toString(),
      tierFee: event.args.tierFee.toString(),
      onRampFee: event.args.onRampFee.toString(),
    });
  } catch (error) {
    console.error("depositWithSignature error:", error);
    res.status(500).json({ error: error.message });
  }
};

exports.deposit = async (req, res) => {
  try {
    await ensureInitialized();
    const { user, token, onRamp, amount } = req.body;
    validateAddress(user);
    validateAddress(token);
    validateAddress(onRamp);

    if (!(await contract.relayers(wallet.address))) 
      throw new Error("Relayer not authorized");
    if (!(await contract.supportedStablecoins(token))) 
      throw new Error("Unsupported token");
    await checkDailyLimit(onRamp, amount);

    const tx = await contract.deposit.populateTransaction(
      user, token, onRamp, amount
    );

    const receipt = await wallet.sendTransaction({
      ...tx,
      gasLimit: config.gasLimits.signatureOperations,
    }).then(tx => tx.wait());
    
    const event = receipt.logs?.find(log => 
      contract.interface.parseLog(log)?.name === "DepositExecuted"
    );
    
    res.json({
      success: true,
      txHash: receipt.hash,
      amount: event?.args?.amount?.toString(),
      tierFee: event?.args?.tierFee?.toString(),
      onRampFee: event?.args?.onRampFee?.toString(),
    });
  } catch (error) {
    console.error("deposit error:", error);
    res.status(500).json({ error: error.message });
  }
};
exports.relayerhealth = async (req, res) => {
  try {
    await ensureInitialized();
    const block = await provider.getBlockNumber();
    res.json({ 
      status: 'ok', 
      blockNumber: block,
      contractAddress: process.env.DEPAYM_CONTRACT_ADDRESS
    });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
}; 