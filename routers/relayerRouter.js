const express = require('express');
const router = express.Router();
const relayerController = require('../controllers/relayerController');

// Log all requests
router.use((req, res, next) => {
  console.log(`Relayer request: ${req.method} ${req.path}`);
  next();
});

// Setup routes
router.post('/pay', relayerController.payWithSignature);
router.post('/deposit', relayerController.depositWithSignature);
router.post('/withdraw', relayerController.withdrawWithSignature);
router.get('/health', relayerController.relayerhealth);

// Error handling middleware
router.use((err, req, res, next) => {
  console.error('Relayer error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = router;