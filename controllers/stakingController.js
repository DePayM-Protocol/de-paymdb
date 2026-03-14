// controllers/stakingController.js
/**
 * Staking controller (claim off-chain)
 *
 * - Reads pending rewards from an on-chain staking contract (DePayMStaking)
 * - Converts raw on-chain units to decimal using tokenDecimals (default: USDC 6)
 * - Credits an off-chain balance on the user document and records an audit entry
 *
 * Notes:
 * - This implementation expects the staking contract to expose `pendingRewards(address) view returns (uint256)`
 *   (matching your DePayMStaking.sol).
 * - Auth middleware must set `req.user.id` (this router uses `auth`).
 */

require("dotenv").config();
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const { ethers } = require("ethers");
const User = require("../models/user");
const auth = require("../middlewares/auth"); // your auth middleware that populates req.user

// CONFIG (prefer environment variables)
const RPC_URL = process.env.RPC_URL || "https://rpc.testnet.arc.network";
const STAKING_ABI_PATH = process.env.STAKING_ABI_PATH || "../contracts/staking/artifacts/contracts/DePayMStaking.sol/DePayMStaking.json";
// Default decimals for the on-chain reward token (USDC uses 6)
const TOKEN_DECIMALS = Number(process.env.TOKEN_DECIMALS ?? 6);
// optional claim cooldown (ms) — default 24 hours
const SESSION_COOLDOWN_MS = Number(process.env.SESSION_COOLDOWN_MS ?? 1 * 60 * 1000);

/** Load ABI: prefer provided artifact, otherwise minimal ABI for our contract */
function loadStakingAbi() {
  if (STAKING_ABI_PATH) {
    try {
      const art = require(STAKING_ABI_PATH);
      return art?.abi ?? art;
    } catch (e) {
      console.warn("loadStakingAbi: failed to require artifact:", e.message);
    }
  }
  // minimal ABI matching DePayMStaking.sol
  return [
    "function pendingRewards(address user) view returns (uint256)",
    "function userStake(address user) view returns (uint256)"
  ];
}

/** Create ethers contract connected to a provider (read-only) */
function getContractInstance(address, abi, rpcUrl) {
  if (!address || !abi) return null;
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl || RPC_URL);
    return new ethers.Contract(address, abi, provider);
  } catch (e) {
    console.error("getContractInstance error:", e);
    return null;
  }
}

/** Read pending rewards from the staking contract.
 *  Returns BigInt raw value (not decimals-converted).
 *  Throws when read fails or view not available.
 */
async function readOnChainPending(stakingContract, userAddress) {
  if (!stakingContract) throw new Error("stakingContract missing");
  if (!userAddress) throw new Error("userAddress missing");

  // Our contract exposes pendingRewards(address)
  if (typeof stakingContract.pendingRewards !== "function") {
    throw new Error("staking contract does not expose pendingRewards(address)");
  }

  try {
    const raw = await stakingContract.pendingRewards(userAddress);
    // ensure BigInt
    return BigInt(raw.toString());
  } catch (e) {
    console.error("readOnChainPending: call failed:", e);
    throw new Error("failed to call pendingRewards on contract");
  }
}

/** Convert raw BigInt (on-chain) to JS Number with decimals + rounding */
function rawToDecimal(rawBigInt, decimals = TOKEN_DECIMALS, precision = 6) {
  try {
    // ethers.formatUnits accepts string or BigInt
    const asNum = Number(ethers.formatUnits(rawBigInt.toString(), decimals));
    return Number(Number(asNum).toFixed(precision));
  } catch (e) {
    console.error("rawToDecimal error:", e);
    return 0;
  }
}

/**
 * POST /api/staking/claim-offchain
 * Body: { stakingAddress, tokenDecimals? , rpcUrl? }
 * Requires auth middleware (req.user.id)
 */
router.post("/claim-offchain", auth, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "auth required" });
    }

    const { stakingAddress, tokenDecimals, rpcUrl } = req.body || {};
    if (!stakingAddress) {
      return res.status(400).json({ success: false, error: "stakingAddress required" });
    }

    // init contract
    const stakingAbi = loadStakingAbi();
    const stakingContract = getContractInstance(stakingAddress, stakingAbi, rpcUrl);
    if (!stakingContract) {
      return res.status(500).json({ success: false, error: "failed to initialize staking contract" });
    }

    // start a DB transaction/session
    await session.startTransaction();

    // load user inside the session
    const user = await User.findById(userId).session(session);
    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, error: "user not found" });
    }

    // cooldown check
    if (user.cooldownEnd) {
      const now = Date.now();
      const cooldownEndTs =
        user.cooldownEnd instanceof Date ? user.cooldownEnd.getTime() : new Date(user.cooldownEnd).getTime();
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

    // pick wallet to query on-chain (prefer first linked wallet)
    const walletAddr =
      (user.wallets && Array.isArray(user.wallets) && user.wallets[0] && user.wallets[0].address) ||
      user.address;

    if (!walletAddr) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, error: "user has no linked wallet to query" });
    }

    // read on-chain pending rewards (raw)
    let onChainPendingRaw;
    try {
      onChainPendingRaw = await readOnChainPending(stakingContract, walletAddr);
    } catch (e) {
      await session.abortTransaction();
      console.error("readOnChainPending failed:", e);
      session.endSession();
      return res.status(500).json({ success: false, error: "failed reading on-chain pending", detail: e.message });
    }

    // claimed snapshot for this staking contract (keyed by lowercased staking address)
    const key = String(stakingAddress).toLowerCase();

    // support both Map-like and plain object storage for claimedOffsets
    let claimedSnapshotRawStr = "0";
    if (user.claimedOffsets) {
      if (typeof user.claimedOffsets.get === "function") {
        claimedSnapshotRawStr = user.claimedOffsets.get(key) || "0";
      } else {
        claimedSnapshotRawStr = user.claimedOffsets[key] || "0";
      }
    }

    const claimedSnapshot = BigInt(claimedSnapshotRawStr || "0");

    // compute net difference
    const netRaw = onChainPendingRaw > claimedSnapshot ? onChainPendingRaw - claimedSnapshot : 0n;

    if (netRaw === 0n) {
      // update lastClaim + cooldown so UI knows user attempted claim
      user.miningSession = user.miningSession || {};
      user.miningSession.lastClaim = new Date();
      user.cooldownEnd = new Date(Date.now() + SESSION_COOLDOWN_MS);
      await user.save({ session });
      await session.commitTransaction();
      session.endSession();
      return res.json({ success: true, earned: 0, message: "No rewards to claim" });
    }

    // convert to decimal amount using tokenDecimals if supplied, otherwise TOKEN_DECIMALS
    const decimalsToUse = Number(tokenDecimals ?? TOKEN_DECIMALS);
    const earnedDecimal = rawToDecimal(netRaw, decimalsToUse, 6); // e.g. 12.345678
    const rounded = Number(earnedDecimal.toFixed(6));

    // persist claimed snapshot (store onChainPendingRaw as new snapshot)
    if (!user.claimedOffsets) user.claimedOffsets = {};
    if (typeof user.claimedOffsets.set === "function") {
      user.claimedOffsets.set(key, onChainPendingRaw.toString());
    } else {
      user.claimedOffsets = user.claimedOffsets || {};
      user.claimedOffsets[key] = onChainPendingRaw.toString();
    }

    // credit off-chain balance + bookkeeping (adjust field names as needed)
    user.balance = Number((Number(user.balance || 0) + rounded).toFixed(6));
    user.totalClaimed = Number((Number(user.totalClaimed || 0) + rounded).toFixed(6));
    user.miningSession = user.miningSession || {};
    user.miningSession.lastClaim = new Date();
    user.cooldownEnd = new Date(Date.now() + SESSION_COOLDOWN_MS);

    // push audit record
    user.claims = user.claims || [];
    user.claims.push({
      amount: rounded,
      tokenDecimals: decimalsToUse,
      stakingContract: key,
      snapshot: onChainPendingRaw.toString(),
      createdAt: new Date(),
    });

    await user.save({ session });
    await session.commitTransaction();
    session.endSession();

    return res.json({ success: true, earned: rounded, balance: user.balance });
  } catch (err) {
    console.error("claim-offchain error:", err);
    try {
      await session.abortTransaction();
      session.endSession();
    } catch (e) {
      // ignore
    }
    return res.status(500).json({ success: false, error: "server error", detail: err.message || String(err) });
  }
});

module.exports = router;