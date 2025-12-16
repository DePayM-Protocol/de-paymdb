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
  /* --------------------------
     START / STOP / VALIDATE
     -------------------------- */

  static async startMining(req, res) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res
          .status(401)
          .json({ success: false, error: "Authentication required" });
      }

      const user = await User.findById(userId);
      if (!user)
        return res
          .status(404)
          .json({ success: false, error: "User not found" });

      // ensure wallets are not cross-linked
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

      // schedule validateSession externally if you have a job scheduler; also run immediate validateSession
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
   * Stop mining and claim rewards.
   * Uses calculateEarnings(user, stopTs) BEFORE clearing boosters/session state.
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

      if (!user)
        return res
          .status(404)
          .json({ success: false, error: "User not found" });
      if (!user?.miningSession?.isActive)
        return res
          .status(400)
          .json({ success: false, error: "No active mining session to stop" });

      const stopTs = Date.now();
      const earnings = MiningController.calculateEarnings(user, stopTs);

      // Update user
      user.balance = parseFloat((user.balance + earnings).toFixed(6));
      user.miningSession.isActive = false;
      user.miningSession.lastClaim = new Date(stopTs);
      user.cooldownEnd = new Date(stopTs + SESSION_COOLDOWN);

      const activeRefs = MiningController.countActiveReferrals(user.referrals);

      // Reset boosters (Design A: boosters don't extend; clearing after stop)
      user.booster = {
        functions: {}, // normalized shape
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
          referrals: user.referrals?.length || 0,
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
   * validateSession: finalize if session exceeded MAX_SESSION_DURATION
   */
  static async validateSession(user) {
    try {
      if (!user || !user.miningSession?.isActive) return;

      const sessionStart = user.miningSession.startTime
        ? new Date(user.miningSession.startTime).getTime()
        : null;
      if (!sessionStart) return;

      if (Date.now() - sessionStart > MAX_SESSION_DURATION) {
        // finalize up to max duration
        const endTs = sessionStart + MAX_SESSION_DURATION;
        const earnings = MiningController.calculateEarnings(user, endTs);
        user.balance = parseFloat((user.balance + earnings).toFixed(6));
        user.miningSession.isActive = false;
        user.cooldownEnd = new Date(Date.now() + SESSION_COOLDOWN);

        // clear boosters
        user.booster = { functions: {} };
        user.markModified("booster");
        await user.save();
      }
    } catch (err) {
      console.error("validateSession error:", err);
    }
  }

  /* --------------------------
     BOOSTER: Flexible representation & update
     - Supports legacy boolean functions and new per-function windows.
     - Design A: set function window only when first activated; do not extend on repeat.
     -------------------------- */

  /**
   * updateBooster(user, rawFunctionName)
   * - user: mongoose document (must be fetched and attached)
   * - rawFunctionName: 'pay' | 'deposit' | 'withdraw'
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

      // Normalize booster shape
      const booster = user.booster
        ? user.booster.toObject
          ? user.booster.toObject()
          : { ...user.booster }
        : { functions: {} };
      if (!booster.functions || typeof booster.functions !== "object") {
        booster.functions = {};
      }

      // If legacy booleans present (pay: true), convert to function-window entries if we see them
      for (const k of Object.keys(booster.functions || {})) {
        const val = booster.functions[k];
        if (val === true) {
          // convert to window starting now (legacy) — but keep it short: treat as just-activated now
          booster.functions[k] = {
            startTime: now,
            expiration: new Date(now.getTime() + BOOST_DURATION),
          };
        } else if (val && typeof val === "object") {
          // already in window form — keep
        } else if (val === false) {
          // ignore
          delete booster.functions[k];
        }
      }

      // If function not present or expired, set its window (Design A: do NOT extend if already active)
      const existing = booster.functions[functionName];
      let needToSet = false;
      if (!existing) needToSet = true;
      else {
        // if object shape, check expiration
        const exp = existing.expiration
          ? existing.expiration instanceof Date
            ? existing.expiration.getTime()
            : new Date(existing.expiration).getTime()
          : 0;
        if (exp && Date.now() > exp) needToSet = true;
      }

      if (needToSet) {
        booster.functions[functionName] = {
          startTime: now,
          expiration: new Date(now.getTime() + BOOST_DURATION),
        };
        console.log(
          `Booster function ${functionName} activated for user ${user._id} till ${booster.functions[functionName].expiration}`
        );
      } else {
        console.log(
          `Booster function ${functionName} already active for user ${user._id}; not extending (Design A)`
        );
      }

      // Update rate field optionally (not necessary but handy)
      const activeFnCount = Object.keys(booster.functions || {}).filter(
        (fn) => {
          const obj = booster.functions[fn];
          if (!obj) return false;
          const exp = obj.expiration
            ? obj.expiration instanceof Date
              ? obj.expiration.getTime()
              : new Date(obj.expiration).getTime()
            : 0;
          return exp > Date.now();
        }
      ).length;
      booster.rate = activeFnCount * BOOST_PER_FUNCTION;

      user.booster = booster;
      user.markModified("booster");
      await user.save();
    } catch (err) {
      console.error("updateBooster error:", err);
    }
  }

  /* --------------------------
     GET STATUS — make accumulated and rate consistent
     - accumulated is computed by calculateEarnings(user, now)
     - rate is instantaneous rate (base + active boosters + active referrals)
     -------------------------- */

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

      // Build boosterData & current boosterRate by counting currently active function-windows
      let boosterRate = 0;
      let boosterTimeLeft = 0;
      let boosterData = { functions: [], detailed: {} };

      if (user.booster && user.booster.functions) {
        for (const fn of Object.keys(user.booster.functions || {})) {
          const entry = user.booster.functions[fn];
          if (!entry) continue;

          // entry may be boolean legacy or object; normalize
          let startMs = null;
          let endMs = null;
          if (entry === true) {
            // legacy: assume active now until now + BOOST_DURATION
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
            // timeLeft for the *soonest* expiring booster (helpful)
            const timeLeft = Math.min(
              endMs - nowTs,
              boosterTimeLeft || Number.MAX_SAFE_INTEGER
            );
            boosterTimeLeft = Math.max(boosterTimeLeft, timeLeft); // keep largest left (or set)
          }
        }
      }

      // instantaneous hourly rate (base + referral + current boosters)
      const rate = parseFloat(
        (BASE_HOURLY_RATE + REFERRAL_BONUS * activeRefs + boosterRate).toFixed(
          6
        )
      );

      // accumulated: compute exact earnings from session start to now using overlap-aware function
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

  /* --------------------------
     EARNINGS CALC (overlap-aware)
     - baseTotal: base rate × sessionHours
     - boosterTotal: sum over each function's overlap (per-function window)
     - referralTotal: per-referral overlap
     -------------------------- */

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

          // support legacy boolean true/false stored in DB
          let bStart = null;
          let bEnd = null;
          if (entry === true) {
            // treat as just-activated at sessionStart or now? choose sessionStart fallback
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

  /* --------------------------
     Utility helpers
     -------------------------- */

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
