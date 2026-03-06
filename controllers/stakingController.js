// controllers/stakingcontroller.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const { ethers } = require("ethers");
const User = require("../models/user"); // adjust path to your User model
// const auth = require('../middleware/auth'); // <-- use your real auth middleware

// CONFIG: set in env
// RPC URL for the chain where staking contract lives
// e.g. process.env.RPC_URL = "https://rpc.ankr.com/bsc" or your provider
const RPC_URL = "https://rpc.testnet.arc.network" || process.env.RPC_URL;

// Optionally set STAKING_ABI_PATH to an artifact file; otherwise minimal view ABI used.
const STAKING_ABI_PATH =  "../contracts/staking/artifacts/contracts/DePayMStaking.sol/DePayMStaking.json" || process.env.STAKING_ABI_PATH ;
// DPAYM decimals (how you want to represent off-chain unit)
const DPAYM_DECIMALS = Number(process.env.DPAYM_DECIMALS ?? 6);
// Claim cooldown ms (optional)
const SESSION_COOLDOWN_MS = Number(process.env.SESSION_COOLDOWN_MS ?? 24 * 60 * 60 * 1000);

/** Helper: load staking ABI (if provided), otherwise fallback minimal view ABI */
function loadStakingAbi() {
  if (STAKING_ABI_PATH) {
    try {
      // require the ABI file (export must be JSON or object with .abi)
      const art = require(STAKING_ABI_PATH);
      return art?.abi ?? art;
    } catch (e) {
      console.warn("Failed to load STAKING_ABI_PATH:", e.message);
    }
  }
  // minimal read ABI
  return [
    "function pendingRewards(address user, address token) view returns (uint256)",
    "function pendingReward(address user) view returns (uint256)",
    "function earned(address user) view returns (uint256)",
    "function rewardOf(address user) view returns (uint256)",
    "function userInfo(address user) view returns (uint256 amount, uint256 rewardDebt)",
  ];
}

/** Helper: create ethers.Contract (provider only) */
function getContractInstance(address, abi, rpcUrl) {
  if (!address || !abi) return null;
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl || RPC_URL);
    return new ethers.Contract(address, abi, provider);
  } catch (e) {
    console.error("getContractInstance error", e);
    return null;
  }
}

/** Try common on-chain read functions to get user's pending reward; return BigInt */
async function readOnChainPending(stakingContract, userAddress, tokenAddress = null) {
  if (!stakingContract) throw new Error("stakingContract missing");

  const tries = [
    async () => {
      if (typeof stakingContract.pendingRewards === "function") {
        // some single-arg variants exist; try both if tokenAddress present
        try {
          if (tokenAddress) return await stakingContract.pendingRewards(userAddress, tokenAddress);
          return await stakingContract.pendingRewards(userAddress);
        } catch (e) {
          // ignore
        }
      }
      return null;
    },
    async () => {
      if (typeof stakingContract.pendingReward === "function") {
        return await stakingContract.pendingReward(userAddress);
      }
      return null;
    },
    async () => {
      if (typeof stakingContract.earned === "function") {
        return await stakingContract.earned(userAddress);
      }
      return null;
    },
    async () => {
      if (typeof stakingContract.rewardOf === "function") {
        return await stakingContract.rewardOf(userAddress);
      }
      return null;
    },
    async () => {
      if (typeof stakingContract.userInfo === "function") {
        try {
          const info = await stakingContract.userInfo(userAddress);
          if (!info) return null;
          // info might be array-like or object; try common fields
          if (info.pending) return info.pending;
          if (info.rewards) return info.rewards;
          if (info.reward) return info.reward;
          if (info.amount && info.rewardDebt !== undefined) {
            // we cannot compute a precise pending without rewardPerToken; skip
            return null;
          }
        } catch (e) {
          // ignore
        }
      }
      return null;
    },
  ];

  for (const fn of tries) {
    try {
      const v = await fn();
      if (v !== null && v !== undefined) return BigInt(v.toString());
    } catch (e) {
      // continue
    }
  }

  throw new Error("No pending reward view available on contract");
}

/** Convert raw BigInt to decimal number (JS Number) using decimals and round to 6 */
function rawToDecimal(rawBigInt, decimals = DPAYM_DECIMALS, precision = 6) {
  try {
    const formatted = Number(ethers.formatUnits(rawBigInt.toString(), decimals));
    return Number(Number(formatted).toFixed(precision));
  } catch (e) {
    console.error("rawToDecimal error", e);
    return 0;
  }
}

/**
 * POST /claim-offchain
 * Body: { stakingAddress, tokenAddress? , rpcUrl? , tokenDecimals? }
 * Auth required: req.user.id must be set by your auth middleware
 */
router.post("/claim-offchain", /* auth, */ async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: "auth required" });

    const { stakingAddress, tokenAddress, rpcUrl, tokenDecimals } = req.body || {};
    if (!stakingAddress) return res.status(400).json({ success: false, error: "stakingAddress required" });

    // load ABI and contract
    const stakingAbi = loadStakingAbi();
    const stakingContract = getContractInstance(stakingAddress, stakingAbi, rpcUrl);
    if (!stakingContract) return res.status(500).json({ success: false, error: "failed to init staking contract" });

    // start db session
    await session.startTransaction();

    // load user with session
    const user = await User.findById(userId).session(session);
    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, error: "user not found" });
    }

    if (user.cooldownEnd) {
      const now = Date.now();
      const cooldownEndTs =
        user.cooldownEnd instanceof Date
          ? user.cooldownEnd.getTime()
          : new Date(user.cooldownEnd).getTime();
      if (now < cooldownEndTs) {
        const msLeft = cooldownEndTs - now;
        await session.abortTransaction();
        session.endSession();
        return res.status(429).json({
          success: false,
          error: "claim_in_cooldown",
          message: "Claim is in cooldown. Try again later.",
          cooldownRemainingMs: msLeft,
        });
      }
    }

    // Get on-chain pending (raw units)
    // Choose which wallet address to query on-chain: prefer first linked wallet or a stored address on user
    const walletAddr = (user.wallets && user.wallets[0] && user.wallets[0].address) || user.address;
    if (!walletAddr) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, error: "user has no linked wallet to query" });
    }

    let onChainPendingRaw;
    try {
      onChainPendingRaw = await readOnChainPending(stakingContract, walletAddr, tokenAddress || null);
    } catch (e) {
      await session.abortTransaction();
      console.error("readOnChainPending failed:", e);
      return res.status(500).json({ success: false, error: "failed reading on-chain pending", detail: e.message });
    }

    // claimed snapshot for this staking contract (store key by stakingAddress)
    const key = String(stakingAddress).toLowerCase();
    const claimedSnapshotRawStr = (user.claimedOffsets && typeof user.claimedOffsets.get === "function")
      ? (user.claimedOffsets.get(key) || "0")
      : ((user.claimedOffsets && user.claimedOffsets[key]) || "0");
    const claimedSnapshot = BigInt(claimedSnapshotRawStr || "0");

    // compute net to credit
    const netRaw = onChainPendingRaw > claimedSnapshot ? onChainPendingRaw - claimedSnapshot : 0n;
    if (netRaw === 0n) {
      // update lastClaim time / cooldown optionally
      user.miningSession = user.miningSession || {};
      user.miningSession.lastClaim = new Date();
      user.cooldownEnd = new Date(Date.now() + SESSION_COOLDOWN_MS);
      await user.save({ session });
      await session.commitTransaction();
      session.endSession();
      return res.json({ success: true, earned: 0, message: "No rewards to claim" });
    }

    // Convert raw -> decimal DPAYM amount (use tokenDecimals param if token reward token has different decimals)
    const decimals = Number(tokenDecimals ?? DPAYM_DECIMALS);

    const earnedDecimal = rawToDecimal(netRaw, decimals, 6); // e.g. 12.345678
    const rounded = Number(earnedDecimal.toFixed(6));

    // Persist snapshot and credit off-chain balance and audit
    if (!user.claimedOffsets) user.claimedOffsets = {};
    if (typeof user.claimedOffsets.set === "function") {
      user.claimedOffsets.set(key, onChainPendingRaw.toString());
    } else {
      user.claimedOffsets = user.claimedOffsets || {};
      user.claimedOffsets[key] = onChainPendingRaw.toString();
    }

    // credit off-chain DPAYM (balance field) — adjust to your field (you may store in user.balance or user.stakingRewards)
    user.balance = Number((Number(user.balance || 0) + rounded).toFixed(6));
    user.totalClaimed = Number((Number(user.totalClaimed || 0) + rounded).toFixed(6));
    user.miningSession = user.miningSession || {};
    user.miningSession.lastClaim = new Date();
    user.cooldownEnd = new Date(Date.now() + SESSION_COOLDOWN_MS);

    // push audit record (claims array)
    user.claims = user.claims || [];
    user.claims.push({
      amount: rounded,
      token: tokenAddress || null,
      stakingContract: key,
      snapshot: onChainPendingRaw.toString(),
      createdAt: new Date(),
    });

    user.cooldownEnd = new Date(Date.now() + SESSION_COOLDOWN_MS);

    await user.save({ session });
    await session.commitTransaction();
    session.endSession();

    return res.json({ success: true, earned: rounded, balance: user.balance });
  } catch (err) {
    console.error("claim-offchain error:", err);
    try { await session.abortTransaction(); session.endSession(); } catch (e) {}
    return res.status(500).json({ success: false, error: "server error", detail: err.message || String(err) });
  }
});

module.exports = router;