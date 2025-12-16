const mongoose = require('mongoose');


// Define wallet sub-schema
const walletSchema = new mongoose.Schema({
  address: {
    type: String,
    required: [true, 'Wallet address is required'],
    lowercase: true,
    validate: {
      validator: v => /^0x[a-fA-F0-9]{40}$/.test(v),
      message: props => `${props.value} is not a valid Ethereum address!`
    }
  },
  addedAt: {
    type: Date,
    default: Date.now
  }
}, { _id: false }); // Prevent auto _id generation for each wallet

// Define user schema
const userSchema = mongoose.Schema({
  username: {
    type: String,
    trim: true
  },
  email: {
    type: String,
    required: [true, 'Email is needed to proceed.'],
    trim: true,
    unique: true,
    minlength: [7, "Email must have at least 7 characters!"],
    lowercase: true
  },
  password: {
    type: String,
    required: [true, 'Password must be provided!'],
    trim: true,
    select: false
  },
  verified: {
    type: Boolean,
    default: false
  },
  verificationCode: {
    type: String,
    select: false
  },
  verificationCodeExpires: {
    type: Date,
    select: false
  },
  verificationCodeValidation: {
    type: String,
    select: false
  },
  forgotPasswordCode: {
    type: String,
    select: false
  },
  forgotPasswordCodeValidation: {
    type: String,
    select: false
  },
  isRelayer: {
    type: Boolean,
    default: false
  },
  relayerProfile: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Relayer'
  },
  transactions: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Transaction'
  }],
  wallets: {
    type: [walletSchema],
    default: []
  },
  boosterStart: Date,       // When current boost started
  boosterExpiration: Date,  // When boost expires
  boosterRate: {            // Current boost rate (DPAYM/hour)
    type: Number,
    default: 0
  },   
  balance: { type: Number, default: 0 },
  totalClaimed: { type: Number, default: 0 },
  lastClaimTime: { type: Date, default: Date.now },
  ratePerHour: { type: Number, default: 0.012 },
  createdAt: {
    type: Date,
    default: Date.now
  },
  booster: {
  functions: { type: Map, of: Boolean, default: {} }, // or plain Object
  startTime: { type: Date, default: null },
  expiration: { type: Date, default: null },
  rate: { type: Number, default: 0 }
},
  accumulated: { type: Number, default: 0 },
  cooldownEnd: Date,
  miningSession: {
    startTime: Date,
    storageCapacity: { type: Number, default: 100 },
    currentStorage: { type: Number, default: 0 },
    lastClaim: Date,
    isActive: { type: Boolean, default: false }
  },
  referrals: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
},
 {
  timestamps: true
});

const User = mongoose.model('User', userSchema)

// Virtuals
userSchema.virtual('claimCooldown').get(function() {
  if (!this.miningSession?.lastClaim) return 0;
  const elapsed = Date.now() - this.miningSession.lastClaim;
  return Math.max(14400000 - elapsed, 0);
});

userSchema.virtual('activeReferrals').get(async function() {
  return User.find({
    _id: { $in: this.referrals },
    'miningSession.isActive': true
  });
});

userSchema.virtual('isInCooldown').get(function() {
  return this.cooldownEnd && Date.now() < this.cooldownEnd;
});

userSchema.pre('save', function(next) {
  if (this.booster && this.booster.functions) {
    // Remove internal properties
    const cleanedFunctions = {};
    for (const [key, value] of Object.entries(this.booster.functions)) {
      if (!key.startsWith('$') && !key.startsWith('__') && !key.startsWith('_')) {
        cleanedFunctions[key] = value;
      }
    }
    this.booster.functions = cleanedFunctions;
  }
  next();
});

userSchema.set('toJSON', { virtuals: true });
userSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('User', userSchema);


  /* set: function(wallets) {
      return (wallets || [])
        .filter(w => w && w.address)
        .map(w => ({ address: w.address.toLowerCase(), addedAt: w.addedAt }));
    }*/