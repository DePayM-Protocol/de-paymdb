const mongoose = require('mongoose');

const relayerSchema = new mongoose.Schema({
  address: {
    type: String,
    required: true,
    unique: true,
    validate: {
      validator: v => /^0x[a-fA-F0-9]{40}$/.test(v),
      message: 'Invalid Ethereum address'
    },
    lowercase: true
  },
  name: {
    type: String,
    trim: true
  },
  isActive: {
    type: Boolean,
    default: true
  },
  feeEarned: {
    type: Number,
    default: 0
  },
  transactionsProcessed: {
    type: Number,
    default: 0
  },
  lastActive: Date,
  whitelistedTokens: [{
    type: String,
    validate: {
      validator: v => /^0x[a-fA-F0-9]{40}$/.test(v),
      message: 'Invalid token address'
    },
    lowercase: true
  }]
}, { timestamps: true });

// Index for faster queries
relayerSchema.index({ address: 1 }, { unique: true });

module.exports = mongoose.model('Relayer', relayerSchema);