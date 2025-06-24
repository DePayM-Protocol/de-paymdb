//controller/rewardController.js

const User = require('../models/user'); // Make sure this is imported at the top

exports.rewards = async (req, res) => {
  const { wallet, ref } = req.body;
  
  let user = await User.findOne({ wallet });
  if (user) return res.json({ message: 'Already registered' });

  user = new User({ wallet });

  if (ref && ref !== wallet) {
    const referrer = await User.findOne({ wallet: ref });

    if (referrer && !referrer.referrals.includes(wallet)) {
      referrer.referrals.push(wallet);
      referrer.ratePerHour = 0.012 + referrer.referrals.length * 0.003;
      await referrer.save();

      user.referredBy = ref;
    }
  }

  user.lastClaimTime = new Date(); // Important: initialize lastClaimTime
  user.totalClaimed = 0;           // Important: initialize totalClaimed
  user.functionRewards = {};       // Important: initialize functionRewards

  await user.save();
  res.json({ message: 'Registered', user });
};

exports.claim = async (req, res) => {
  const { wallet } = req.params;

  const user = await User.findOne({ wallet });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const now = new Date();
  const hoursPassed = (now - new Date(user.lastClaimTime)) / (1000 * 60 * 60);
  const amountToClaim = hoursPassed * user.ratePerHour;

  user.totalClaimed += amountToClaim;
  user.lastClaimTime = now;
  await user.save();

  res.json({ claimed: amountToClaim, totalClaimed: user.totalClaimed });
};

exports.wallet = async (req, res) => {
  const { wallet } = req.params;

  const user = await User.findOne({ wallet });
  if (!user) {
    return res.json({ totalClaimed: 0, ratePerHour: 0.012 });
  }

  const now = new Date();
  const hours = (now - new Date(user.lastClaimTime)) / (1000 * 60 * 60);
  const inStorage = hours * user.ratePerHour;

  res.json({
    wallet,
    ratePerHour: user.ratePerHour,
    inStorage,
    totalClaimed: user.totalClaimed
  });
};

exports.walletInteraction = async (req, res) => {
  const { wallet, functionName, success } = req.body;

  if (!wallet || !['pay', 'deposit', 'withdraw'].includes(functionName))
    return res.status(400).json({ error: 'Invalid data' });

  const user = await User.findOne({ wallet });
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!success) return res.status(400).json({ message: 'Interaction failed' });

  const now = new Date();
  const last = user.functionRewards?.[functionName];
  const hours = last ? (now - new Date(last)) / (1000 * 60 * 60) : 25; // default to 25h so first interaction succeeds

  if (hours >= 24) {
    user.totalClaimed += 0.1;
    user.functionRewards[functionName] = now;
    await user.save();

    return res.json({ reward: 0.1, totalClaimed: user.totalClaimed });
  }

  res.json({ message: 'Already claimed in last 24hrs' });
};

