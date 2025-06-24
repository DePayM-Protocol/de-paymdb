//controller/rewardController.js

const User = require('../models/user');

exports.trackInteraction = async (req, res) => {
  const { action } = req.params;
  const validActions = ['pay', 'deposit', 'withdraw'];

  try {
    if (!validActions.includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }

    const user = await User.findById(req.user.id);
    const lastAction = user.interactions[action];
    
    if (lastAction && (Date.now() - lastAction < 86400000)) {
      return res.status(400).json({
        error: `24h cooldown for ${action}`
      });
    }

    // Update interaction and balance
    user.interactions[action] = Date.now();
    user.balance += 0.1;
    await user.save();

    res.json({
      balance: user.balance.toFixed(6),
      cooldowns: user.interactionCooldowns
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/*const User = require('../models/user');

exports.trackInteraction = async (req, res) => {
  const userId = req.user.id;
  try {
    const user = await User.findById(userId);
    user.interactionCount += 1;

    if (user.interactionCount >= 9 && !user.confirmedReferral && user.pendingReferrer) {
      const referrer = await User.findOne({ wallets: user.pendingReferrer });

      if (referrer) {
        referrer.referrals.push(user.wallets[0]);
        referrer.ratePerHour += 0.001; // Example: +0.001 extra per referral
        await referrer.save();

        user.confirmedReferral = true;
        user.referredBy = user.pendingReferrer;
      }
    }
    
    await user.save();
    res.json({ success: true, message: "Interaction tracked.", interactionCount: user.interactionCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
};*/
