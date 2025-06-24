const express = require('express');
const router = express.Router();
const txController = require('../controllers/txController');

// Get transaction history
router.get('/', txController.getTransactions);

// Frontend notification endpoint
router.post('/notify', txController.notifyTransaction);

module.exports = router;