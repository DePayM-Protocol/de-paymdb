const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { identifier } = require('../middlewares/identification');
const miningController = require('../controllers/miningController');
const interactionController = require('../controllers/interactionController');
const walletController = require('../controllers/walletController');

// Auth routes
router.post("/register", authController.register);
router.post("/login", authController.login);
router.post("/logout", authController.logout);
router.post("/add-wallet", identifier, authController.addWallet);
router.post("/check-verification", authController.checkVerification);
router.post("/send-verification-code", authController.sendVerificationCode);
router.post("/verify-verification-code", authController.verifyVerificationCode);
router.post("/change-password", authController.changePassword);
router.post("/send-fp-code", authController.sendForgotPasswordCode);
router.post("/verify-fp-code", authController.verifyForgotPasswordCode);

module.exports = router;
