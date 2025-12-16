// controllers/MiningController.js
const User = require("../models/user");

// Mining Constants
const BASE_HOURLY_RATE = 0.021;
const REFERRAL_BONUS = 0.0025;
const SESSION_COOLDOWN = 4 * 60 * 60 * 1000; // 4 hours in ms
const MAX_SESSION_DURATION = 4 * 60 * 60 * 1000; // 4 hours in ms
const BOOST_PER_FUNCTION = 0.2; // DPAYM per hour per function
const BOOST_DURATION = 4 * 60 * 60 * 1000; // 4 hours in ms

class MiningController {
  /**
   * Start a new mining session
   */
  static async startMining(req, res) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res
          .status(401)
          .json({ success: false, error: "Authentication required" });
      }

      const user = await User.findById(userId);
      if (!user) {
        return res
          .status(404)
          .json({ success: false, error: "User not found" });
      }

      // Check if any wallet is linked to a different user
      if (user.wallets && Array.isArray(user.wallets)) {
        for (const wallet of user.wallets) {
          const existing = await User.findOne({
            "wallets.address": wallet.address.toLowerCase(),
            _id: { $ne: user._id },
          });

          if (existing) {
            return res.status(403).json({
              success: false,
              error: `Wallet ${wallet.address} is already linked to another account`,
            });
          }
        }
      }

      if (user.miningSession?.isActive) {
        return res
          .status(400)
          .json({ success: false, error: "Mining session already active" });
      }

      user.miningSession = {
        startTime: new Date(),
        isActive: true,
        lastClaim: new Date(),
      };

      // Reset cooldown when starting
      user.cooldownEnd = null;

      await user.save();
      await MiningController.validateSession(user);

      return res.json({
        success: true,
        message: "Mining started successfully",
        data: {
          startTime: user.miningSession.startTime,
          cooldown: null,
        },
      });
    } catch (err) {
      console.error("startMining error:", err);
      return res
        .status(500)
        .json({ success: false, error: "Failed to start mining session" });
    }
  }

  /**
   * Update booster when user performs an action (pay/deposit/withdraw).
   * Design A: set booster.startTime on first activation; do NOT extend expiration on subsequent activations.
   * If booster already expired, treat the activation as a new booster (set new startTime and expiration).
   */
  static async updateBooster(user, rawFunctionName) {
    if (!user || !user.miningSession?.isActive) return;

    const validFunctions = ["pay", "deposit", "withdraw"];
    if (!rawFunctionName) {
      console.log("updateBooster called without function name");
      return;
    }

    const functionName = rawFunctionName.toLowerCase().replace(/[^a-z]/g, "");
    if (!validFunctions.includes(functionName)) {
      console.log(`Invalid function for boost: ${rawFunctionName}`);
      return;
    }

    try {
      const now = new Date();

      // Coerce booster to plain object if it is a mongoose map/document
      const booster = user.booster
        ? user.booster.toObject
          ? user.booster.toObject()
          : { ...user.booster }
        : {
            functions: {},
            startTime: null,
            expiration: null,
            rate: 0,
          };

      if (!booster.functions || typeof booster.functions !== "object") {
        booster.functions = {};
      }

      // If booster has expiration and it's in the past, reset it (allow reactivation as new booster)
      const expMs = booster.expiration
        ? booster.expiration instanceof Date
          ? booster.expiration.getTime()
          : new Date(booster.expiration).getTime()
        : 0;
      if (expMs && now.getTime() > expMs) {
        console.log("updateBooster: existing booster expired, resetting.");
        booster.functions = {};
        booster.startTime = null;
        booster.expiration = null;
        booster.rate = 0;
      }

      // Add the function if not already present
      if (!booster.functions[functionName]) {
        booster.functions[functionName] = true;
        console.log(`Added ${functionName} boost for user: ${user._id}`);
      } else {
        console.log(
          `Booster function ${functionName} already present for user: ${user._id}`
        );
      }

      // Compute valid function keys (exclude internals)
      const validKeys = Object.keys(booster.functions || {}).filter(
        (k) => !k.startsWith("$") && !k.startsWith("_")
      );

      // If this is the first valid function activation (startTime not set), set startTime and expiration
      if (validKeys.length > 0 && !booster.startTime) {
        booster.startTime = now;
        booster.expiration = new Date(now.getTime() + BOOST_DURATION);
        console.log(
          `Booster startTime set to ${booster.startTime} expiration ${booster.expiration}`
        );
      }

      // Update rate
      booster.rate = validKeys.length * BOOST_PER_FUNCTION;

      // Persist changes back onto user and save
      user.booster = booster;
      user.markModified("booster");
      await user.save();
    } catch (err) {
      console.error("updateBooster error:", err);
      // do not throw - booster update is best-effort
    }
  }

  /**
   * Stop mining and claim rewards.
   * This uses calculateEarnings(user, asOf) to compute earnings based on overlap windows.
   */
  static async stopMining(req, res) {
    try {
      let user;

      if (req.user?.id) {
        user = await User.findById(req.user.id)
          .populate("referrals", "miningSession lastClaim cooldownEnd")
          .exec();
      } else if (req.body.walletAddress) {
        user = await User.findOne({
          "wallets.address": req.body.walletAddress.toLowerCase(),
        })
          .populate("referrals", "miningSession lastClaim cooldownEnd")
          .exec();
      }

      if (!user) {
        return res
          .status(404)
          .json({ success: false, error: "User not found" });
      }

      if (!user?.miningSession?.isActive) {
        return res
          .status(400)
          .json({ success: false, error: "No active mining session to stop" });
      }

      // Calculate earnings using exact stop timestamp BEFORE we clear booster/session state
      const stopTs = Date.now();
      const earnings = MiningController.calculateEarnings(user, stopTs);

      // Update user balances and session fields
      user.balance = parseFloat((user.balance + earnings).toFixed(6));
      user.miningSession.isActive = false;
      user.miningSession.lastClaim = new Date(stopTs);
      user.cooldownEnd = new Date(stopTs + SESSION_COOLDOWN);

      // Save activeReferrals count before we clear anything (for response)
      const activeRefs = MiningController.countActiveReferrals(user.referrals);

      // Clear booster (reset)
      user.booster = {
        functions: {},
        startTime: null,
        expiration: null,
        rate: 0,
      };
      user.markModified("booster");

      await user.save();

      return res.json({
        success: true,
        message: "Mining stopped successfully",
        data: {
          earned: earnings.toFixed(6),
          balance: user.balance.toFixed(6),
          cooldown: SESSION_COOLDOWN,
          referrals: user.referrals.length,
          activeReferrals: activeRefs,
        },
      });
    } catch (err) {
      console.error("stopMining error:", err);
      return res
        .status(500)
        .json({ success: false, error: "Failed to stop mining session" });
    }
  }

  /**
   * Validate session — called after start to ensure we don't overrun MAX_SESSION_DURATION.
   * If session has exceeded MAX_SESSION_DURATION, finalize earnings and put into cooldown.
   */
  static async validateSession(user) {
    try {
      if (!user || !user.miningSession?.isActive) return;

      const sessionStart = user.miningSession.startTime
        ? new Date(user.miningSession.startTime).getTime()
        : null;
      if (!sessionStart) return;

      if (Date.now() - sessionStart > MAX_SESSION_DURATION) {
        // finalize earnings up to the max duration
        const endTs = sessionStart + MAX_SESSION_DURATION;
        const earnings = MiningController.calculateEarnings(user, endTs);
        user.balance = parseFloat((user.balance + earnings).toFixed(6));
        user.miningSession.isActive = false;
        user.cooldownEnd = new Date(Date.now() + SESSION_COOLDOWN);
        // clear booster
        user.booster = {
          functions: {},
          startTime: null,
          expiration: null,
          rate: 0,
        };
        user.markModified("booster");
        await user.save();
      }
    } catch (err) {
      console.error("validateSession error:", err);
    }
  }

  /**
   * Get current mining status
   */
  static async getMiningStatus(req, res) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res
          .status(401)
          .json({ success: false, error: "Authentication required" });
      }

      const user = await User.findById(userId)
        .populate("referrals", "miningSession lastClaim cooldownEnd")
        .exec();
      if (!user) {
        return res
          .status(404)
          .json({ success: false, error: "User not found" });
      }

      if (!user.miningSession) {
        user.miningSession = {
          startTime: null,
          lastClaim: null,
          isActive: false,
        };
        await user.save();
      }

      const nowTs = Date.now();

      const cooldown = user.cooldownEnd
        ? Math.max(0, new Date(user.cooldownEnd).getTime() - nowTs)
        : 0;
      const activeRefs = MiningController.countActiveReferrals(user.referrals);

      // -----------------------
      // Booster calculation using startTime + expiration (Design A)
      // -----------------------
      let boosterRate = 0;
      let boosterTimeLeft = 0;
      let boosterData = {
        functions: [],
        startTime: null,
        expiration: null,
        rate: 0,
      };

      if (user.booster && user.booster.startTime && user.booster.expiration) {
        const bStart =
          user.booster.startTime instanceof Date
            ? user.booster.startTime.getTime()
            : new Date(user.booster.startTime).getTime();
        const bEnd =
          user.booster.expiration instanceof Date
            ? user.booster.expiration.getTime()
            : new Date(user.booster.expiration).getTime();

        if (nowTs < bEnd && nowTs >= bStart) {
          const validKeys = Object.keys(user.booster.functions || {}).filter(
            (k) => !k.startsWith("$") && !k.startsWith("_")
          );
          boosterRate = validKeys.length * BOOST_PER_FUNCTION;
          boosterTimeLeft = bEnd - nowTs;
          boosterData = {
            functions: validKeys,
            startTime: new Date(bStart),
            expiration: new Date(bEnd),
            rate: boosterRate,
          };
        } else if (nowTs < bStart) {
          // Booster scheduled for future (rare), show functions and times but rate 0 until start
          const validKeys = Object.keys(user.booster.functions || {}).filter(
            (k) => !k.startsWith("$") && !k.startsWith("_")
          );
          boosterRate = 0;
          boosterTimeLeft = bEnd - nowTs;
          boosterData = {
            functions: validKeys,
            startTime: new Date(bStart),
            expiration: new Date(bEnd),
            rate: 0,
          };
        } else {
          // expired
          boosterData = {
            functions: [],
            startTime: null,
            expiration: null,
            rate: 0,
          };
        }
      }

      // Final hourly rate includes boosters and referral bonuses
      const rate = parseFloat(
        (
          BASE_HOURLY_RATE +
          REFERRAL_BONUS * activeRefs +
          (boosterRate || 0)
        ).toFixed(6)
      );

      // Compute accumulated and progress (using final rate)
      let accumulated = 0;
      let progress = 0;

      if (user.miningSession.isActive && user.miningSession.startTime) {
        const startMs = new Date(user.miningSession.startTime).getTime();
        const elapsedMs = nowTs - startMs;
        const cappedMs = Math.min(elapsedMs, MAX_SESSION_DURATION);
        const hours = cappedMs / 3600000;
        accumulated = parseFloat((rate * hours).toFixed(6));
        progress = Math.min(cappedMs / MAX_SESSION_DURATION, 1);
      }

      return res.json({
        success: true,
        message: "Mining status retrieved",
        data: {
          isActive: user.miningSession.isActive,
          balance: parseFloat(user.balance.toFixed(6)),
          accumulated,
          progress,
          cooldown,
          referrals: user.referrals.length,
          activeReferrals: activeRefs,

          rate, // final boosted rate
          boosterRate,
          boosterTimeLeft: boosterTimeLeft > 0 ? boosterTimeLeft : 0,
          booster: boosterData,
        },
      });
    } catch (err) {
      console.error("getMiningStatus error:", err);
      return res
        .status(500)
        .json({ success: false, error: "Failed to get mining status" });
    }
  }

  /**
   * Calculate earnings for a user session using precise overlap windows.
   * - user: mongoose user document (should include referrals, booster)
   * - asOf: timestamp (ms) at which to stop calculation (e.g. stop time). defaults to Date.now()
   *
   * Returns numeric DPAYM amount (rounded to 6 decimals).
   */
  static calculateEarnings(user, asOf = Date.now()) {
    try {
      if (!user.miningSession || !user.miningSession.startTime) return 0;

      const sessionStart = new Date(user.miningSession.startTime).getTime();
      const sessionEnd = Math.min(asOf, sessionStart + MAX_SESSION_DURATION);
      if (sessionEnd <= sessionStart) return 0;

      const sessionMs = sessionEnd - sessionStart;
      const sessionHours = sessionMs / 3600000;

      // ---------- Base earnings ----------
      const baseTotal = BASE_HOURLY_RATE * sessionHours;

      // ---------- Booster contribution (exact overlap) ----------
      let boosterTotal = 0;
      if (user.booster && user.booster.startTime && user.booster.expiration) {
        const bStart =
          user.booster.startTime instanceof Date
            ? user.booster.startTime.getTime()
            : new Date(user.booster.startTime).getTime();
        const bEnd =
          user.booster.expiration instanceof Date
            ? user.booster.expiration.getTime()
            : new Date(user.booster.expiration).getTime();

        const overlapStart = Math.max(sessionStart, bStart);
        const overlapEnd = Math.min(sessionEnd, bEnd);

        if (overlapEnd > overlapStart) {
          const overlapHours = (overlapEnd - overlapStart) / 3600000;
          const validKeys = Object.keys(user.booster.functions || {}).filter(
            (k) => !k.startsWith("$") && !k.startsWith("_")
          );
          const boostPerHour = validKeys.length * BOOST_PER_FUNCTION;
          boosterTotal = boostPerHour * overlapHours;
        }
      }

      // ---------- Referral contribution (sum per-referral overlap) ----------
      let referralTotal = 0;
      const refs = user.referrals || [];
      for (const r of refs) {
        try {
          if (!r.miningSession || !r.miningSession.startTime) continue;

          const rStart = new Date(r.miningSession.startTime).getTime();
          let rEnd;
          if (r.miningSession.isActive) {
            rEnd = Math.min(asOf, rStart + MAX_SESSION_DURATION);
          } else if (r.miningSession.lastClaim) {
            rEnd = Math.min(
              new Date(r.miningSession.lastClaim).getTime(),
              rStart + MAX_SESSION_DURATION
            );
          } else {
            rEnd = Math.min(rStart + MAX_SESSION_DURATION, asOf);
          }

          const overlapStart = Math.max(sessionStart, rStart);
          const overlapEnd = Math.min(sessionEnd, rEnd);
          if (overlapEnd > overlapStart) {
            const overlapHours = (overlapEnd - overlapStart) / 3600000;
            referralTotal += REFERRAL_BONUS * overlapHours;
          }
        } catch (e) {
          console.error("Referral overlap calc error", e);
          continue;
        }
      }

      const total = baseTotal + boosterTotal + referralTotal;
      return parseFloat(total.toFixed(6));
    } catch (err) {
      console.error("calculateEarnings error:", err);
      return 0;
    }
  }

  /**
   * Count active referrals (used for rate calculation) - safe checks for timestamps & expirations.
   */
  static countActiveReferrals(refs = []) {
    const now = Date.now();
    try {
      return (refs || []).filter((r) => {
        if (!r || !r.miningSession) return false;
        if (!r.miningSession.isActive) return false;

        const start = r.miningSession.startTime
          ? new Date(r.miningSession.startTime).getTime()
          : null;
        if (!start) return false;
        if (now - start > MAX_SESSION_DURATION) return false;

        if (r.cooldownEnd && now < new Date(r.cooldownEnd).getTime())
          return false;

        return true;
      }).length;
    } catch (e) {
      console.error("countActiveReferrals error", e);
      return 0;
    }
  }

  static isInCooldown(user) {
    return (
      user.cooldownEnd && Date.now() < new Date(user.cooldownEnd).getTime()
    );
  }

  static formatCooldown(end) {
    if (!end) return "0h 0m";
    const ms = new Date(end).getTime() - Date.now();
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return `${h}h ${m}m`;
  }
}

module.exports = MiningController;
module.exports.updateBooster = MiningController.updateBooster;
