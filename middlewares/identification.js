// middlewares/identification.js

const jwt = require('jsonwebtoken');

exports.identifier = (req, res, next) => {
  let token;
  
  // Extract token more carefully
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.split(" ")[1];
  } else if (req.cookies?.token) {
    token = req.cookies.token;
  }

  if (!token) {
    return res.status(401).json({ message: "Token missing" });
  }

  // Debug: Log raw token
  console.log("Received token:", token);

  try {
    const decoded = jwt.verify(token, process.env.TOKEN_SECRET);
    req.user = { id: decoded.userId };
    next();
  } catch (error) {
    console.error("Token verification failed:", error.message);
    return res.status(401).json({ message: "Invalid token" });
  }
};


