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
  /* ---------------- START / STOP / VALIDATE ---------------- */

  static async startMining(req, res) {
    try {
      const userId = req.user?.id;
      if (!userId)
        return res
          .status(401)
          .json({ success: false, error: "Authentication required" });

      const user = await User.findById(userId);
      if (!user)
        return res
          .status(404)
          .json({ success: false, error: "User not found" });

      if (user.wallets && Array.isArray(user.wallets)) {
        for (const wallet of user.wallets) {
          const existing = await User.findOne({
            "wallets.address": wallet.address.toLowerCase(),
            _id: { $ne: user._id },
          });
          if (existing) {
            return res
              .status(403)
              .json({
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
      user.cooldownEnd = null;
      await user.save();

      // optional: validateSession can be scheduled by a job runner; we call once for safety
      await MiningController.validateSession(user);

      return res.json({
        success: true,
        message: "Mining started successfully",
        data: { startTime: user.miningSession.startTime, cooldown: null },
      });
    } catch (err) {
      console.error("startMining error:", err);
      return res
        .status(500)
        .json({ success: false, error: "Failed to start mining session" });
    }
  }

  static async stopMining(req, res) {
    try {
      let user;
      if (req.user?.id) {
        user = await User.findById(req.user.id)
          .populate("referrals", "miningSession lastClaim cooldownEnd")
          .exec();
      } else if (req.body?.walletAddress) {
        user = await User.findOne({
          "wallets.address": req.body.walletAddress.toLowerCase(),
        })
          .populate("referrals", "miningSession lastClaim cooldownEnd")
          .exec();
      }

      if (!user)
        return res
          .status(404)
          .json({ success: false, error: "User not found" });
      if (!user.miningSession?.isActive)
        return res
          .status(400)
          .json({ success: false, error: "No active mining session to stop" });

      const stopTs = Date.now();
      const earnings = MiningController.calculateEarnings(user, stopTs);

      user.balance = parseFloat(((user.balance || 0) + earnings).toFixed(6));
      user.miningSession.isActive = false;
      user.miningSession.lastClaim = new Date(stopTs);
      user.cooldownEnd = new Date(stopTs + SESSION_COOLDOWN);

      const activeRefs = MiningController.countActiveReferrals(
        user.referrals || []
      );

      // Clear boosters (Design A: boosters cleared once session stops)
      user.booster = { functions: {} };
      user.markModified("booster");

      await user.save();

      return res.json({
        success: true,
        message: "Mining stopped successfully",
        data: {
          earned: earnings.toFixed(6),
          balance: user.balance.toFixed(6),
          cooldown: SESSION_COOLDOWN,
          referrals: (user.referrals || []).length,
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

  static async validateSession(user) {
    try {
      if (!user || !user.miningSession?.isActive) return;
      const sessionStart = user.miningSession.startTime
        ? new Date(user.miningSession.startTime).getTime()
        : null;
      if (!sessionStart) return;

      if (Date.now() - sessionStart > MAX_SESSION_DURATION) {
        const endTs = sessionStart + MAX_SESSION_DURATION;
        const earnings = MiningController.calculateEarnings(user, endTs);
        user.balance = parseFloat(((user.balance || 0) + earnings).toFixed(6));
        user.miningSession.isActive = false;
        user.cooldownEnd = new Date(Date.now() + SESSION_COOLDOWN);
        user.booster = { functions: {} };
        user.markModified("booster");
        await user.save();
      }
    } catch (err) {
      console.error("validateSession error:", err);
    }
  }

  /* ---------------- UPDATE BOOSTER (activation only, DESIGN A) ---------------- */

  /**
   * updateBooster(user, rawFunctionName)
   * - ensures booster.functions uses per-function windows: { startTime, expiration }
   * - supports legacy booleans (true/false) by converting them
   * - sets a window only if the function wasn't active or it expired (no extension while active)
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
      const nowMs = now.getTime();

      // Normalize booster structure
      const booster = user.booster
        ? user.booster.toObject
          ? user.booster.toObject()
          : { ...user.booster }
        : { functions: {} };
      if (!booster.functions || typeof booster.functions !== "object")
        booster.functions = {};

      // Convert legacy boolean entries into windows (just-activated at now)
      for (const k of Object.keys(booster.functions || {})) {
        const val = booster.functions[k];
        if (val === true) {
          booster.functions[k] = {
            startTime: new Date(nowMs),
            expiration: new Date(nowMs + BOOST_DURATION),
          };
        } else if (val === false) {
          delete booster.functions[k];
        } // if object, keep as-is
      }

      const existing = booster.functions[functionName];
      let shouldSetWindow = false;

      if (!existing) {
        shouldSetWindow = true;
      } else if (existing && typeof existing === "object") {
        const expMs = existing.expiration
          ? existing.expiration instanceof Date
            ? existing.expiration.getTime()
            : new Date(existing.expiration).getTime()
          : 0;
        if (!expMs || Date.now() > expMs) shouldSetWindow = true;
      }

      if (shouldSetWindow) {
        booster.functions[functionName] = {
          startTime: new Date(nowMs),
          expiration: new Date(nowMs + BOOST_DURATION),
        };
        console.log(
          `Activated booster ${functionName} for user ${user._id} until ${booster.functions[functionName].expiration}`
        );
      } else {
        // active and not expired -> do not extend (Design A)
        console.log(
          `Booster ${functionName} already active for user ${user._id} (not extended).`
        );
      }

      // optional: update a convenience rate field
      const activeCount = Object.keys(booster.functions || {}).filter((fn) => {
        const e = booster.functions[fn];
        if (!e || typeof e !== "object") return false;
        const exp = e.expiration
          ? e.expiration instanceof Date
            ? e.expiration.getTime()
            : new Date(e.expiration).getTime()
          : 0;
        return exp > Date.now();
      }).length;
      booster.rate = activeCount * BOOST_PER_FUNCTION;

      user.booster = booster;
      user.markModified("booster");
      await user.save();
    } catch (err) {
      console.error("updateBooster error:", err);
    }
  }

  /* ---------------- GET STATUS ---------------- */

  static async getMiningStatus(req, res) {
    try {
      const userId = req.user?.id;
      if (!userId)
        return res
          .status(401)
          .json({ success: false, error: "Authentication required" });

      const user = await User.findById(userId)
        .populate("referrals", "miningSession lastClaim cooldownEnd")
        .exec();
      if (!user)
        return res
          .status(404)
          .json({ success: false, error: "User not found" });

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
      const activeRefs = MiningController.countActiveReferrals(
        user.referrals || []
      );

      // compute current boosterRate by checking per-function windows
      let boosterRate = 0;
      let boosterTimeLeft = 0;
      let boosterData = { functions: [], detailed: {} };

      if (user.booster && user.booster.functions) {
        for (const fn of Object.keys(user.booster.functions || {})) {
          const entry = user.booster.functions[fn];
          if (!entry) continue;

          // entry can be legacy boolean or object
          let startMs = null;
          let endMs = null;
          if (entry === true) {
            startMs = nowTs;
            endMs = nowTs + BOOST_DURATION;
          } else if (entry && typeof entry === "object") {
            startMs = entry.startTime
              ? entry.startTime instanceof Date
                ? entry.startTime.getTime()
                : new Date(entry.startTime).getTime()
              : null;
            endMs = entry.expiration
              ? entry.expiration instanceof Date
                ? entry.expiration.getTime()
                : new Date(entry.expiration).getTime()
              : null;
          }

          boosterData.detailed[fn] = {
            startTime: startMs ? new Date(startMs) : null,
            expiration: endMs ? new Date(endMs) : null,
          };

          if (startMs && endMs && nowTs >= startMs && nowTs < endMs) {
            boosterRate += BOOST_PER_FUNCTION;
            boosterData.functions.push(fn);
            // capture largest time left (useful for UI)
            boosterTimeLeft = Math.max(boosterTimeLeft, endMs - nowTs);
          }
        }
      }

      const rate = parseFloat(
        (BASE_HOURLY_RATE + REFERRAL_BONUS * activeRefs + boosterRate).toFixed(
          6
        )
      );

      let accumulated = 0;
      let progress = 0;
      if (user.miningSession.isActive && user.miningSession.startTime) {
        accumulated = MiningController.calculateEarnings(user, nowTs);
        const startMs = new Date(user.miningSession.startTime).getTime();
        const elapsedMs = Math.min(nowTs - startMs, MAX_SESSION_DURATION);
        progress = Math.min(elapsedMs / MAX_SESSION_DURATION, 1);
      }

      return res.json({
        success: true,
        message: "Mining status retrieved",
        data: {
          isActive: user.miningSession.isActive,
          balance: parseFloat((user.balance || 0).toFixed(6)),
          accumulated: parseFloat((accumulated || 0).toFixed(6)),
          progress,
          cooldown,
          referrals: (user.referrals || []).length,
          activeReferrals: activeRefs,
          rate,
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

  /* ---------------- CALCULATE EARNINGS (overlap-aware) ---------------- */

  static calculateEarnings(user, asOf = Date.now()) {
    try {
      if (!user.miningSession || !user.miningSession.startTime) return 0;

      const sessionStart = new Date(user.miningSession.startTime).getTime();
      const sessionEnd = Math.min(asOf, sessionStart + MAX_SESSION_DURATION);
      if (sessionEnd <= sessionStart) return 0;

      const sessionMs = sessionEnd - sessionStart;
      const sessionHours = sessionMs / 3600000;

      // base
      const baseTotal = BASE_HOURLY_RATE * sessionHours;

      // boosters: iterate each function window and add overlap-hours * BOOST_PER_FUNCTION
      let boosterTotal = 0;
      if (user.booster && user.booster.functions) {
        for (const fn of Object.keys(user.booster.functions || {})) {
          const entry = user.booster.functions[fn];
          if (!entry) continue;

          // support boolean legacy or object windows
          let bStart = null;
          let bEnd = null;
          if (entry === true) {
            // treat legacy true as "activated at sessionStart"
            bStart = sessionStart;
            bEnd = sessionStart + BOOST_DURATION;
          } else if (entry && typeof entry === "object") {
            bStart = entry.startTime
              ? entry.startTime instanceof Date
                ? entry.startTime.getTime()
                : new Date(entry.startTime).getTime()
              : null;
            bEnd = entry.expiration
              ? entry.expiration instanceof Date
                ? entry.expiration.getTime()
                : new Date(entry.expiration).getTime()
              : null;
          } else {
            continue;
          }

          if (!bStart || !bEnd) continue;
          const overlapStart = Math.max(sessionStart, bStart);
          const overlapEnd = Math.min(sessionEnd, bEnd);
          if (overlapEnd > overlapStart) {
            const overlapHours = (overlapEnd - overlapStart) / 3600000;
            boosterTotal += BOOST_PER_FUNCTION * overlapHours;
          }
        }
      }

      // referrals: sum per-referral overlap
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

  /* ---------------- UTIL ---------------- */

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
