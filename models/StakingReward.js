const mongoose = require("mongoose");

const stakingRewardSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  wallet: {
    type: String,
    required: true
  },
  amount: {
    type: Number,
    required: true
  },
  claimed: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model("StakingReward", stakingRewardSchema);