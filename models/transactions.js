const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  transaction_hash: { type: String, required: true, unique: true },
  contractAddress: { type: String, required: true },
  sender: { type: String, required: true },
  receiver: { type: String },
  amount: { type: Number, required: true },
  function_name: { type: String, enum: ['pay', 'withdraw', 'deposit'] },
  network: { type: String, required: true },
  token: { type: String, required: true },
  token_decimals: { type: Number, default: 6 },
  token_symbol: { type: String, default: 'USDC' },
  contractAddress: { type: String, required: true },
  direction: { type: String, enum: ['in', 'out'] },
  displayType: { type: String, enum: ['payment', 'deposit', 'withdrawal'] },
  network: { type: String, required: true },
  fee: String,
  status: { 
    type: String, 
    enum: ['pending', 'confirmed', 'failed'],
    default: 'pending'
  },
  timestamp: { type: Date, default: Date.now },
  network: { type: String, default: 'Base Sepolia' }
});



module.exports = mongoose.model('Transaction', transactionSchema);