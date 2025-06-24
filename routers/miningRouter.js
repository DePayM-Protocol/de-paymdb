// routers/miningRouter.js

const express = require('express');
const router  = express.Router();
const { identifier } = require('../middlewares/identification');
const MiningController = require('../controllers/miningController');

// Route: Start a mining session
router.post('/start', identifier, MiningController.startMining);

// Route: Stop a mining session and claim rewards
router.post('/stop', identifier, MiningController.stopMining);


// Route: Get current mining status (protected!)
router.get('/status', identifier, MiningController.getMiningStatus.bind(MiningController));

module.exports = router;
