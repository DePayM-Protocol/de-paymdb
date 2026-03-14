// controllers/stakingController.js
require("dotenv").config();
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const { ethers } = require("ethers");
const User = require("../models/user");
const auth = require("../middlewares/auth"); // auth middleware must set req.user.id

// CONFIG (environment overrides)
const RPC_URL = process.env.RPC_URL || "https://rpc.testnet.arc.network";
const STAKING_ABI_PATH =
  process.env.STAKING_ABI_PATH ||
  "../contracts/staking/artifacts/contracts/DePayMStaking.sol/DePayMStaking.json";
// default decimals (USDC uses 6)
const TOKEN_DECIMALS = Number(process.env.TOKEN_DECIMALS ?? 6);
// default cooldown (24 hours)
const SESSION_COOLDOWN_MS = Number(
  process.env.SESSION_COOLDOWN_MS ?? 24 * 60 * 60 * 1000,
);

/** Utility: safe lowercasing for addresses/strings */
const toLower = (s) => (s ? String(s).toLowerCase() : s);

/** Load ABI: prefer artifact, otherwise minimal ABI matching DePayMStaking */
function loadStakingAbi() {
  if (STAKING_ABI_PATH) {
    try {
      const art = require(STAKING_ABI_PATH);
      return art?.abi ?? art;
    } catch (e) {
      console.warn("loadStakingAbi: failed to require artifact:", e.message);
    }
  }
  // minimal ABI matching your contract
  return [
    "function pendingRewards(address user) view returns (uint256)",
    "function userStake(address user) view returns (uint256)",
  ];
}

/** Create ethers.Contract (provider-only, read calls) */
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

/** Read pending rewards from staking contract (returns BigInt) */
async function readOnChainPending(stakingContract, userAddress) {
  if (!stakingContract) throw new Error("stakingContract missing");
  if (!userAddress) throw new Error("userAddress missing");

  if (typeof stakingContract.pendingRewards !== "function") {
    throw new Error("staking contract does not expose pendingRewards(address)");
  }

  try {
    const raw = await stakingContract.pendingRewards(userAddress);
    return BigInt(raw.toString());
  } catch (e) {
    console.error("readOnChainPending: call failed:", e);
    throw new Error("failed to call pendingRewards on contract");
  }
}

/** Convert raw BigInt to decimal number (JS Number) using decimals */
function rawToDecimal(rawBigInt, decimals = TOKEN_DECIMALS, precision = 6) {
  try {
    const asNum = Number(ethers.formatUnits(rawBigInt.toString(), decimals));
    return Number(Number(asNum).toFixed(precision));
  } catch (e) {
    console.error("rawToDecimal error:", e);
    return 0;
  }
}

/**
 * POST /api/staking/claim-offchain
 * Body: { stakingAddress, tokenDecimals?, rpcUrl?, wallet? }
 * - `wallet` optional: if provided it must be the user's primary linked wallet (enforced)
 * Auth: requires auth middleware to set req.user.id
 */
router.post("/claim-offchain", auth, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "auth required" });
    }

    const {
      stakingAddress,
      tokenDecimals,
      rpcUrl,
      wallet: requestedWalletRaw,
    } = req.body || {};
    if (!stakingAddress) {
      return res
        .status(400)
        .json({ success: false, error: "stakingAddress required" });
    }

    // init contract (read-only provider)
    const stakingAbi = loadStakingAbi();
    const stakingContract = getContractInstance(
      stakingAddress,
      stakingAbi,
      rpcUrl,
    );
    if (!stakingContract) {
      return res
        .status(500)
        .json({
          success: false,
          error: "failed to initialize staking contract",
        });
    }

    // start transaction
    await session.startTransaction();

    // load user inside session
    const user = await User.findById(userId).session(session);
    if (!user) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ success: false, error: "user not found" });
    }

    // --- Enforce primary-wallet-only policy (server-side) ---
    // Determine canonical primary wallet for this user:
    // 1) user.primaryWallet (if present)
    // 2) user.wallets[0].address (if present)
    // 3) user.address top-level
    const primaryWallet =
      toLower(user.primaryWallet) ||
      (Array.isArray(user.wallets) &&
        user.wallets[0] &&
        toLower(
          typeof user.wallets[0] === "string"
            ? user.wallets[0]
            : user.wallets[0].address,
        )) ||
      toLower(user.address);

    // requested wallet (if client provided)
    const requestedWallet = requestedWalletRaw
      ? toLower(requestedWalletRaw)
      : null;

    // If a requestedWallet was provided, ensure user actually owns it (in user.wallets or user.address)
    if (requestedWallet) {
      const ownsRequested =
        Array.isArray(user.wallets) &&
        user.wallets.some((w) => {
          const addr = toLower(typeof w === "string" ? w : w.address);
          return addr && addr === requestedWallet;
        });
      const isTopAddress =
        user.address && toLower(user.address) === requestedWallet;

      if (!ownsRequested && !isTopAddress) {
        await session.abortTransaction();
        session.endSession();
        return res.status(403).json({
          success: false,
          error: "wallet_not_owned",
          message: "The supplied wallet is not linked to your account.",
        });
      }

      // enforce that requestedWallet must equal primaryWallet
      if (!primaryWallet || requestedWallet !== primaryWallet) {
        await session.abortTransaction();
        session.endSession();
        return res.status(403).json({
          success: false,
          error: "use_primary_wallet",
          message: `Please use your primary linked wallet (${
            primaryWallet || "not set"
          }) to claim rewards.`,
        });
      }
    }

    // If no requested wallet, use primaryWallet; if still none -> error
    let walletAddr = null;
    if (requestedWallet) walletAddr = requestedWallet;
    else {
      if (!primaryWallet) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          success: false,
          error: "no_wallet",
          message:
            "No linked wallet found. Please link a wallet to your account.",
        });
      }
      walletAddr = primaryWallet;
    }

    // --- Cooldown check (per-user) ---
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

    // --- Read on-chain pending rewards (raw units) ---
    let onChainPendingRaw;
    try {
      onChainPendingRaw = await readOnChainPending(stakingContract, walletAddr);
    } catch (e) {
      await session.abortTransaction();
      console.error("readOnChainPending failed:", e);
      session.endSession();
      return res.status(500).json({
        success: false,
        error: "failed_reading_onchain_pending",
        detail: e.message || String(e),
      });
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
    const netRaw =
      onChainPendingRaw > claimedSnapshot
        ? onChainPendingRaw - claimedSnapshot
        : 0n;

    if (netRaw === 0n) {
      // Update lastClaim + cooldown so UI knows user attempted a claim (and triggers cooldown)
      user.miningSession = user.miningSession || {};
      user.miningSession.lastClaim = new Date();
      user.cooldownEnd = new Date(Date.now() + SESSION_COOLDOWN_MS);

      await user.save({ session });
      await session.commitTransaction();
      session.endSession();
      return res.json({
        success: true,
        earned: 0,
        message: "No rewards to claim",
      });
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

    // credit off-chain balance + bookkeeping
    user.balance = Number((Number(user.balance || 0) + rounded).toFixed(6));
    user.totalClaimed = Number(
      (Number(user.totalClaimed || 0) + rounded).toFixed(6),
    );
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
      wallet: walletAddr,
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
    return res
      .status(500)
      .json({
        success: false,
        error: "server_error",
        detail: err.message || String(err),
      });
  }
});

module.exports = router;
