// middleware/auth.js
const jwt = require('jsonwebtoken');

// Use same secret as your login code
const JWT_SECRET = process.env.TOKEN_SECRET || "replace_with_real_secret";

module.exports = async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || req.headers.Authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, error: "auth required" });
    }
    const token = header.split(" ")[1].trim();
    if (!token) return res.status(401).json({ success: false, error: "auth required" });

    const payload = jwt.verify(token, JWT_SECRET);
    // payload should contain user id (whatever your login sets)
    req.user = {
      id: payload.id || payload.sub || payload.userId,
      // include whatever else you want to pass downstream
      email: payload.email
    };
    return next();
  } catch (err) {
    console.error("auth middleware error:", err && err.message);
    return res.status(401).json({ success: false, error: "invalid_token", detail: err.message });
  }
};