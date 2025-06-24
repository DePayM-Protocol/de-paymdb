const mongoose = require('mongoose');

const exchangeRateSchema = new mongoose.Schema({
  baseCurrency: {
    type: String,
    required: true,
    uppercase: true,
    unique: true,
    trim: true
  },
  rates: {
    // store conversion_rates as a map of USD: 1.0, EUR: 0.85, etc.
    type: Map,
    of: Number,
    required: true
  },
  lastUpdated: {
    type: Date,
    required: true,
    default: Date.now
  }
});

module.exports = mongoose.model('ExchangeRate', exchangeRateSchema);
