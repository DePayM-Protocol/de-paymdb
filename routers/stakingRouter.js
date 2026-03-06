const express = require("express");
const router = express.Router();

const {
  handleClaimOffchain,
  getPendingRewards
} = require("../controllers/stakingController");

const authMiddleware = require("../middleware/auth");


router.get("/rewards", authMiddleware, getPendingRewards);

router.post("/claim", authMiddleware, handleClaimOffchain);

module.exports = router;