const User = require("../models/user");

// Mining Constants
const BASE_HOURLY_RATE = 0.021;
const REFERRAL_BONUS = 0.0025;
const SESSION_COOLDOWN = 4 * 60 * 60 * 1000; // 4 hours
const MAX_SESSION_DURATION = 4 * 60 * 60 * 1000; // 4 hours
const BOOST_PER_FUNCTION = 0.2; // 0.1% boost per function type
const BOOST_DURATION = 4 * 60 * 60 * 1000; // 4 hours

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

      // 🚫 Check if any wallet is linked to a different user
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

      if (user.miningSession?.isActive) {
        return res
          .status(400)
          .json({ success: false, error: "Mining session already active" });
      }

      if (user.miningSession?.isActive) {
        return res.status(400).json({
          success: false,
          error: "Finish current session first",
        });
      }

      user.miningSession = {
        startTime: new Date(),
        isActive: true,
        lastClaim: new Date(),
      };
      user.cooldownEnd = null; // Reset cooldown
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

  static async updateBooster(user, rawFunctionName) {
    if (!user.miningSession?.isActive) return;

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

    const now = new Date();

    // Convert to plain object if mongoose document
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

    // If booster.expiration exists and is in the past -> reset it
    const expTime = booster.expiration
      ? booster.expiration instanceof Date
        ? booster.expiration.getTime()
        : new Date(booster.expiration).getTime()
      : 0;
    if (expTime && now.getTime() > expTime) {
      // expired -> reset functions and times
      booster.functions = {};
      booster.startTime = null;
      booster.expiration = null;
      booster.rate = 0;
    }

    // Add function if not present
    if (!booster.functions[functionName]) {
      booster.functions[functionName] = true;
      console.log(`Added ${functionName} boost for user: ${user._id}`);
    }

    // If this is first valid function and booster.startTime is not set, set startTime + expiration
    const validKeys = Object.keys(booster.functions || {}).filter(
      (key) => !key.startsWith("$") && !key.startsWith("_")
    );

    if (validKeys.length > 0 && !booster.startTime) {
      booster.startTime = now;
      booster.expiration = new Date(now.getTime() + BOOST_DURATION); // BOOST_DURATION constant
      console.log(
        `Booster startTime set to ${booster.startTime} expiration ${booster.expiration}`
      );
    } else if (validKeys.length === 0) {
      // no functions -> clear booster times
      booster.startTime = null;
      booster.expiration = null;
      booster.rate = 0;
    }

    booster.rate = validKeys.length * BOOST_PER_FUNCTION;

    // Update user and save
    user.booster = booster;
    user.markModified("booster");
    await user.save();
  }

  /**
   * Stop mining and claim rewards
   */
  static async stopMining(req, res) {
    try {
      let user;

      if (req.user?.id) {
        user = await User.findById(req.user.id).populate(
          "referrals",
          "miningSession lastClaim cooldownEnd"
        );
      } else if (req.body.walletAddress) {
        user = await User.findOne({
          "wallets.address": req.body.walletAddress.toLowerCase(),
        }).populate("referrals", "miningSession");
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

      const stopTs = Date.now();
      const earnings = MiningController.calculateEarnings(user, stopTs);

      // In stopMining function (backend):
      user.balance = parseFloat((user.balance + earnings).toFixed(6));
      user.miningSession.isActive = false;
      user.miningSession.lastClaim = new Date();
      user.cooldownEnd = new Date(Date.now() + SESSION_COOLDOWN);
      user.boosterCount = 0;
      user.boosterExpiration = null;
      user.booster = {
        functions: {},
        expiration: null,
      };

      if (user.booster?.expiration) {
        const now = new Date();
        if (now > user.booster.expiration) {
          user.booster = { functions: {}, expiration: null, rate: 0 };
        }
      } else {
        user.booster = { functions: {}, expiration: null, rate: 0 };
      }

      await user.save();

      return res.json({
        success: true,
        message: "Mining stopped successfully",
        data: {
          earned: earnings.toFixed(6),
          balance: user.balance.toFixed(6),
          cooldown: SESSION_COOLDOWN,
          referrals: user.referrals.length,
          activeReferrals: MiningController.countActiveReferrals(
            user.referrals
          ),
        },
      });
    } catch (err) {
      console.error("stopMining error:", err);
      return res
        .status(500)
        .json({ success: false, error: "Failed to stop mining session" });
    }
  }


  static async validateSession(user) {
    if (user.miningSession?.isActive) {
      const sessionStart = user.miningSession.startTime.getTime();
      if (Date.now() - sessionStart > MAX_SESSION_DURATION) {
        const earnings = this.calculateEarnings(user);
        user.balance += earnings;
        user.miningSession.isActive = false;
        user.cooldownEnd = new Date(Date.now() + SESSION_COOLDOWN);
        await user.save();
      }
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

      const user = await User.findById(userId).populate(
        "referrals",
        "miningSession cooldownEnd"
      );
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
        ? Math.max(0, user.cooldownEnd.getTime() - nowTs)
        : 0;

      const activeRefs = MiningController.countActiveReferrals(user.referrals);

      // --------------------------------------------------
      // ✅ BOOSTER CALCULATION (FIRST)
      // --------------------------------------------------
      // in getMiningStatus, after you have user and nowTs

      let boosterRate = 0;
      let boosterTimeLeft = 0;
      let boosterData = {
        functions: [],
        startTime: null,
        expiration: null,
        rate: 0,
      };

      if (user.booster && user.booster.startTime && user.booster.expiration) {
        const start =
          user.booster.startTime instanceof Date
            ? user.booster.startTime.getTime()
            : new Date(user.booster.startTime).getTime();
        const expiration =
          user.booster.expiration instanceof Date
            ? user.booster.expiration.getTime()
            : new Date(user.booster.expiration).getTime();

        if (nowTs < expiration && nowTs >= start) {
          // booster is currently active
          const validKeys = Object.keys(user.booster.functions || {}).filter(
            (k) => !k.startsWith("$") && !k.startsWith("_")
          );
          boosterRate = validKeys.length * BOOST_PER_FUNCTION;
          boosterTimeLeft = expiration - nowTs;
          boosterData = {
            functions: validKeys,
            startTime: new Date(start),
            expiration: new Date(expiration),
            rate: boosterRate,
          };
        } else if (nowTs < start) {
          // booster scheduled / in future (rare)
          const validKeys = Object.keys(user.booster.functions || {}).filter(
            (k) => !k.startsWith("$") && !k.startsWith("_")
          );
          boosterRate = 0;
          boosterTimeLeft = expiration - nowTs;
          boosterData = {
            functions: validKeys,
            startTime: new Date(start),
            expiration: new Date(expiration),
            rate: 0,
          };
        } else {
          // expired or not active
          boosterData = {
            functions: [],
            startTime: null,
            expiration: null,
            rate: 0,
          };
        }
      }

      // --------------------------------------------------
      // ✅ FINAL RATE (BASE + REFERRALS + BOOSTER)
      // --------------------------------------------------
      const rate = parseFloat(
        (BASE_HOURLY_RATE + REFERRAL_BONUS * activeRefs + boosterRate).toFixed(
          6
        )
      );

      // --------------------------------------------------
      // ✅ ACCUMULATED + PROGRESS (USES FINAL RATE)
      // --------------------------------------------------
      let accumulated = 0;
      let progress = 0;

      if (user.miningSession.isActive && user.miningSession.startTime) {
        const elapsedMs = nowTs - user.miningSession.startTime.getTime();
        const cappedMs = Math.min(elapsedMs, MAX_SESSION_DURATION);
        const hours = cappedMs / 3600000;

        accumulated = parseFloat((rate * hours).toFixed(6));
        progress = Math.min(cappedMs / MAX_SESSION_DURATION, 1);
      }

      // --------------------------------------------------
      // RESPONSE
      // --------------------------------------------------
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

          rate, // ✅ correct boosted rate
          boosterRate,
          boosterTimeLeft: boosterTimeLeft > 0 ? boosterTimeLeft : 0,
          booster: boosterData, // { functions[], expiration, rate }
        },
      });
    } catch (err) {
      console.error("getMiningStatus error:", err);
      return res
        .status(500)
        .json({ success: false, error: "Failed to get mining status" });
    }
  }

  static calculateEarnings(user, asOf = Date.now()) {
    if (!user.miningSession || !user.miningSession.startTime) return 0;

    const sessionStart = new Date(user.miningSession.startTime).getTime();
    const sessionEnd = Math.min(asOf, sessionStart + MAX_SESSION_DURATION);
    if (sessionEnd <= sessionStart) return 0;

    const sessionMs = sessionEnd - sessionStart;
    const sessionHours = sessionMs / 3600000;

    // ---------- Base earnings for full session hours ----------
    const baseTotal = BASE_HOURLY_RATE * sessionHours;

    // ---------- Booster contribution (overlap) ----------
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

      // overlap between session and booster window
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

    // ---------- Referral contribution (overlap per-referral) ----------
    let referralTotal = 0;
    const refs = user.referrals || [];
    for (const r of refs) {
      try {
        if (!r.miningSession || !r.miningSession.startTime) continue;

        const rStart = new Date(r.miningSession.startTime).getTime();
        // referral active window end:
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
  }

  static countActiveReferrals(refs = []) {
    const now = Date.now();
    try {
      return refs.filter((r) => {
        if (!r || !r.miningSession) return false;
        if (!r.miningSession.isActive) return false;

        // Ensure startTime exists and the session is not expired
        const start = r.miningSession.startTime
          ? new Date(r.miningSession.startTime).getTime()
          : null;
        if (!start) return false;
        if (now - start > MAX_SESSION_DURATION) return false;

        // If the referral has a cooldownEnd and it's still in cooldown, they are NOT active
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
    return user.cooldownEnd && Date.now() < user.cooldownEnd;
  }

  static formatCooldown(end) {
    if (!end) return "0h 0m";
    const ms = end - Date.now();
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return `${h}h ${m}m`;
  }
}

module.exports = MiningController;
module.exports.updateBooster = MiningController.updateBooster;
