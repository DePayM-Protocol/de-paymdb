const User = require('../models/user');


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
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }
  
      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }
  
      // 🚫 Check if any wallet is linked to a different user
      for (const wallet of user.wallets) {
        const existing = await User.findOne({ 
          'wallets.address': wallet.address.toLowerCase(), 
          _id: { $ne: user._id } 
        });
  
        if (existing) {
          return res.status(403).json({ 
            success: false, 
            error: `Wallet ${wallet.address} is already linked to another account` 
          });
        }
      }
  
      if (user.miningSession?.isActive) {
        return res.status(400).json({ success: false, error: 'Mining session already active' });
      }
  
     
      if (user.miningSession?.isActive) {
        return res.status(400).json({ 
          success: false, 
          error: 'Finish current session first' 
        });
      }
  
      user.miningSession = {
        startTime: new Date(),
        isActive: true,
        lastClaim: new Date()
      };
      user.cooldownEnd = null; // Reset cooldown
      await user.save();
      await MiningController.validateSession(user);
      
      return res.json({
        success: true,
        message: 'Mining started successfully',
        data: {
          startTime: user.miningSession.startTime,
          cooldown: null
        }
      });

    } catch (err) {
      console.error('startMining error:', err);
      return res.status(500).json({ success: false, error: 'Failed to start mining session' });
    }
  }

  static async updateBooster(user, rawFunctionName) {
    if (!user.miningSession?.isActive) return;
  
    // Validate and normalize function name FIRST
    const validFunctions = ['pay', 'deposit', 'withdraw'];
    
    // Check if rawFunctionName exists
    if (!rawFunctionName) {
      console.log('updateBooster called without function name');
      return;
    }
    
    const functionName = rawFunctionName.toLowerCase().replace(/[^a-z]/g, '');
    
    if (!validFunctions.includes(functionName)) {
      console.log(`Invalid function for boost: ${rawFunctionName}`);
      return;
    }
  
    const now = new Date();
    
    // Convert to plain JavaScript object
    const booster = user.booster ? 
      (user.booster.toObject ? user.booster.toObject() : {...user.booster}) : 
      { functions: {}, expiration: null, rate: 0 }; // Initialize if doesn't exist
  
    // Initialize functions if needed
    if (!booster.functions || typeof booster.functions !== 'object') {
      booster.functions = {};
    }
  
    // Log current state BEFORE modification
    console.log(`Current booster functions: ${JSON.stringify(Object.keys(booster.functions))}`);
    console.log(`Adding ${functionName} to booster`);
  
    // Reset booster if expired
    if (booster.expiration && now > booster.expiration) {
      booster.functions = {};
      booster.expiration = null;
    }
  
    // Track new function type
    if (!booster.functions[functionName]) {
      booster.functions[functionName] = true;
      console.log(`Added ${functionName} boost for user: ${user._id}`);
      
      // Set expiration on first valid boost
      const validKeys = Object.keys(booster.functions).filter(
        key => !key.startsWith('$') && !key.startsWith('_')
      );
      
      if (validKeys.length === 1) {
        booster.expiration = new Date(now.getTime() + BOOST_DURATION);
        console.log(`Set expiration: ${booster.expiration}`);
      }
    }
    
    // Update rate based on valid keys
    const validKeys = Object.keys(booster.functions).filter(
      key => !key.startsWith('$') && !key.startsWith('_')
    );
    booster.rate = validKeys.length * BOOST_PER_FUNCTION;
    
    // Log AFTER modification
    console.log(`Total active boosts: ${validKeys.length}, Rate: ${booster.rate}`);
    
    // Update user document
    user.booster = booster;
    user.markModified('booster');
    await user.save();
  }

  /**
   * Stop mining and claim rewards
   */
  static async stopMining(req, res) {
    try {
      let user;
  
      if (req.user?.id) {
        user = await User.findById(req.user.id).populate('referrals', 'miningSession');
      } else if (req.body.walletAddress) {
        user = await User.findOne({ 'wallets.address': req.body.walletAddress.toLowerCase() }).populate('referrals', 'miningSession');
      }
  
      if (!user) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }
  
      if (!user?.miningSession?.isActive) {
        return res
          .status(400)
          .json({ success: false, error: "No active mining session to stop" });
      }
      const earnings = MiningController.calculateEarnings(user);
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
        message: 'Mining stopped successfully',
        data: {
          earned: earnings.toFixed(6),
          balance: user.balance.toFixed(6),
          cooldown: SESSION_COOLDOWN,
          referrals: user.referrals.length,
          activeReferrals: MiningController.countActiveReferrals(user.referrals),
        }
      });
    } catch (err) {
      console.error('stopMining error:', err);
      return res.status(500).json({ success: false, error: 'Failed to stop mining session' });
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
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const user = await User.findById(userId).populate('referrals', 'miningSession cooldownEnd');
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    if (!user.miningSession) {
      user.miningSession = { startTime: null, lastClaim: null, isActive: false };
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
    let boosterRate = 0;
    let boosterTimeLeft = 0;
    let boosterData = { functions: [], expiration: null, rate: 0 };

    if (user.booster && user.booster.expiration) {
      const expiration = user.booster.expiration instanceof Date
        ? user.booster.expiration.getTime()
        : new Date(user.booster.expiration).getTime();

      if (nowTs < expiration) {
        const validKeys = Object.keys(user.booster.functions || {}).filter(
          k => !k.startsWith('$') && !k.startsWith('_')
        );

        boosterRate = validKeys.length * BOOST_PER_FUNCTION;
        boosterTimeLeft = expiration - nowTs;

        boosterData = {
          functions: validKeys,
          expiration: new Date(expiration),
          rate: boosterRate,
        };
      }
    }

    // --------------------------------------------------
    // ✅ FINAL RATE (BASE + REFERRALS + BOOSTER)
    // --------------------------------------------------
    const rate = parseFloat((
      BASE_HOURLY_RATE +
      REFERRAL_BONUS * activeRefs +
      boosterRate
    ).toFixed(6));

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
      message: 'Mining status retrieved',
      data: {
        isActive: user.miningSession.isActive,
        balance: parseFloat(user.balance.toFixed(6)),
        accumulated,
        progress,
        cooldown,
        referrals: user.referrals.length,
        activeReferrals: activeRefs,

        rate,                     // ✅ correct boosted rate
        boosterRate,
        boosterTimeLeft: boosterTimeLeft > 0 ? boosterTimeLeft : 0,
        booster: boosterData,     // { functions[], expiration, rate }
      },
    });

  } catch (err) {
    console.error('getMiningStatus error:', err);
    return res.status(500).json({ success: false, error: 'Failed to get mining status' });
  }
}


    static calculateEarnings(user) {
  if (!user.miningSession?.isActive) return 0;
  const elapsedMs = Date.now() - user.miningSession.startTime;
  const hours = Math.min(elapsedMs, MAX_SESSION_DURATION) / 3600000;

  const activeRefs = MiningController.countActiveReferrals(user.referrals);

  let boosterRate = 0;
  if (user.booster?.expiration && new Date() < new Date(user.booster.expiration)) {
    const validKeys = Object.keys(user.booster.functions || {}).filter(
      k => !k.startsWith('$') && !k.startsWith('_')
    );
    boosterRate = validKeys.length * BOOST_PER_FUNCTION;
  }

  return parseFloat((
    (BASE_HOURLY_RATE + REFERRAL_BONUS * activeRefs + boosterRate) * hours
  ).toFixed(6));
}

  

  /*static countActiveReferrals(refs) {
    return refs.filter(r => r.miningSession?.isActive).length;
  }*/

    static countActiveReferrals(refs = []) {
  const now = Date.now();
  try {
    return refs.filter(r => {
      if (!r || !r.miningSession) return false;
      if (!r.miningSession.isActive) return false;

      // Ensure startTime exists and the session is not expired
      const start = r.miningSession.startTime ? new Date(r.miningSession.startTime).getTime() : null;
      if (!start) return false;
      if (now - start > MAX_SESSION_DURATION) return false;

      // If the referral has a cooldownEnd and it's still in cooldown, they are NOT active
      if (r.cooldownEnd && now < new Date(r.cooldownEnd).getTime()) return false;

      return true;
    }).length;
  } catch (e) {
    console.error('countActiveReferrals error', e);
    return 0;
  }
}


  static isInCooldown(user) {
    return user.cooldownEnd && Date.now() < user.cooldownEnd;
  }

  static formatCooldown(end) {
    if (!end) return '0h 0m';
    const ms = end - Date.now();
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return `${h}h ${m}m`;
  }
}

module.exports = MiningController;
module.exports.updateBooster = MiningController.updateBooster;
