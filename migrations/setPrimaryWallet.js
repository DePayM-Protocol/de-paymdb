const mongoose = require('mongoose');
const User = require('../models/User'); // adjust path if needed

async function migratePrimaryWallet() {
  await mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });

  const result = await User.updateMany(
    { primaryWallet: { $exists: false }, "wallets.0": { $exists: true } },
    [{ $set: { primaryWallet: "$wallets.0.address" } }]
  );

  console.log("Migration complete:", result);
  await mongoose.disconnect();
}

migratePrimaryWallet().catch(err => {
  console.error(err);
  process.exit(1);
});