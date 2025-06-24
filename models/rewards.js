const rewardSchema = new mongoose.Schema({
  wallet: { type: String, unique: true },
  totalClaimed: { type: Number, default: 0 },
  lastClaimTime: { type: Date, default: Date.now },
  ratePerHour: { type: Number, default: 0.012 },
  referredBy: { type: String },
  referrals: { type: [String], default: [] },
  functionRewards: {
    pay: Date,
    deposit: Date,
    withdraw: Date,
  }
});
