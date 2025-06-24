// scripts/fixWallets.js
const mongoose = require('mongoose');
const User = require('../models/user');

async function migrateWallets() {
  await mongoose.connect(process.env.MONGO_URI);
  
  const users = await User.find({
    $or: [
      { 'wallets.0': { $exists: false } },
      { 'wallets.address': { $exists: false } }
    ]
  });

  for (const user of users) {
    if (user.wallets.length > 0 && typeof user.wallets[0] === 'string') {
      user.wallets = user.wallets.map(address => ({
        address: address.toLowerCase(),
        addedAt: new Date()
      }));
      await user.save();
      console.log(`Migrated user ${user._id}`);
    }
  }
  
  process.exit();
}

migrateWallets();