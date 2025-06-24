const rateLimit = require('express-rate-limit');

export const apiLimiter = rateLimit({
  windowMs: 2 * 60 * 1000, // 2 minutes
  max: 5, // Limiting each IP to 3 requests every 2 minutes
  message: "Too Many Requests, Please Retry in 2 Minutes.",
  standardHeaders: true,
  legacyHeaders: false,
});