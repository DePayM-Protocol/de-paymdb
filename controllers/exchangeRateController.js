const axios = require('axios');
const { EXCHANGE_RATE_API_KEY } = process.env;

const CACHE_TTL = 3 * 60 * 60 * 1000; // 3 hours in ms
let cachedRates = null;
let lastFetchTime = 0;

const fetchRates = async () => {
  try {
    const response = await axios.get(
      `https://v6.exchangerate-api.com/v6/${EXCHANGE_RATE_API_KEY}/latest/USD`
    );
    
   
    const rates = {
      ...response.data.conversion_rates,
    };
    
    cachedRates = rates;
    lastFetchTime = Date.now();
    return rates;
    
  } catch (error) {
    console.error('Exchange rate API error:', error.message);
    return cachedRates || require('./fallbackRates.json');
  }
};

module.exports = {
  getExchangeRates: async () => {
    if (!cachedRates || (Date.now() - lastFetchTime) > CACHE_TTL) {
      return await fetchRates();
    }
    return cachedRates;
  }
};