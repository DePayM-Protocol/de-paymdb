const express = require('express');
const router = express.Router();
const exchangeRateService = require('../controllers/exchangeRateController');

router.get('/rates', async (req, res) => {
  try {
    const rates = await exchangeRateService.getExchangeRates();
    res.json({
      success: true,
      rates
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch exchange rates'
    });
  }
});

module.exports = router;