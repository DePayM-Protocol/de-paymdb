//controllers/walletController.js

const User = require("../models/user");

let claimQueue = [];

exports.connectWallet = async (req, res) => {
  const { wallet } = req.body;
  const userId = req.user.id;

  try {
    const walletLower = wallet.toLowerCase();
    const existingWallet = await User.findOne({ wallets: walletLower });
    if (existingWallet) {
      return res.status(409).json({ success: false, message: "Wallet already linked to another account." });
    }

    const user = await User.findById(userId);
    user.wallets.push(walletLower);
    user.walletConnected = true;
    await user.save();

    res.json({ success: true, message: "Wallet connected successfully.", user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
};

exports.getWalletData = async (req, res) => {
  try {
    // Validate user exists in request
    if (!req.user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const user = await User.findById(req.user.id)
      .select('balance miningSession referrals')
      .populate('referrals', 'miningSession');

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Calculate mining data
    const miningData = {
      balance: user.balance,
      isMining: user.miningSession?.isActive || false,
      sessionStart: user.miningSession?.startTime,
      referrals: user.referrals.length
    };

    res.status(200).json(miningData);

  } catch (err) {
    console.error('Wallet data error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};


exports.disconnectWallet = async (req, res) => {
  const userId = req.user.id;
  try {
    const user = await User.findById(userId);
    user.walletConnected = false;
    user.activeMining = false;
    await user.save();

    res.json({ success: true, message: "Wallet disconnected, mining stopped." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
};