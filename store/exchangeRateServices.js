// backend/store/exchangeRateServices.js
const axios = require('axios');
const ExchangeRate = require('../models/exchangeRate');

const API_KEY   = process.env.EXCHANGE_RATE_API_KEY;
const CACHE_TTL = 1000 * 60 * 60 * 3; // 3 hours in ms
//const base = USD;${base}

async function fetchRatesFromAPI(base) {
  const url  = `https://v6.exchangerate-api.com/v6/${API_KEY}/latest/USD`;
  const resp = await axios.get(url);
  return resp.data.conversion_rates;
}

async function getCachedRates(base) {
  base = base.toUpperCase();
  const now = Date.now();

  // Look in MongoDB
  let doc = await ExchangeRate.findOne({ baseCurrency: base });

  // If found and still fresh, return it
  if (doc && (now - doc.lastUpdated.getTime()) < CACHE_TTL) {
    // Mongoose Map → plain object
    return Object.fromEntries(doc.rates);
  }

  // Otherwise, fetch new from upstream
  const freshRates = await fetchRatesFromAPI(base);

  // Upsert into Mongo
  await ExchangeRate.findOneAndUpdate(
    { baseCurrency: base },
    {
      rates:       freshRates,
      lastUpdated: new Date(now)
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return freshRates;
}

module.exports = {
  getCachedRates,
  fetchRatesFromAPI,  // you can omit this if you don't need to export it
};
