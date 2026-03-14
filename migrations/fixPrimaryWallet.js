require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/user');

async function fixPrimaryWallet() {
  try {
    await mongoose.connect(process.env.MONGO_URI);

    // Convert any array values to string or null
    const result = await User.updateMany(
      { primaryWallet: { $type: "array" } },
      [
        {
          $set: {
            primaryWallet: {
              $cond: {
                if: { $gt: [{ $size: "$primaryWallet" }, 0] },
                then: { $arrayElemAt: ["$primaryWallet", 0] },
                else: null
              }
            }
          }
        }
      ]
    );

    console.log("Users fixed:", result.modifiedCount);
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

fixPrimaryWallet();