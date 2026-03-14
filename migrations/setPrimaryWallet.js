require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/user');

async function migratePrimaryWallet() {
  try {
    await mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    const result = await User.updateMany(
      { primaryWallet: { $exists: false }, "wallets.0": { $exists: true } },
      [{ $set: { primaryWallet: "$wallets.0.address" } }]
    );
    console.log('Users updated:', result.modifiedCount);
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

migratePrimaryWallet();