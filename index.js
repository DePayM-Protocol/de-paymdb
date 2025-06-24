require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');
const authRouter = require('./routers/authRouter');
const miningRouter = require('./routers/miningRouter');
const relayerRouter = require('./routers/relayerRouter')
const txRouter = require('./routers/txRouter');
const currencyRouter = require('./routers/exchangeRateRouter');


const app = express();

// Security Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https://*.de-paym.com"],
    }
  }
}));

// CORS Configuration
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://192.168.91.170:8081',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});
// Body Parsers
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database Connection
mongoose.connect(process.env.MONGO_URI, {
  serverSelectionTimeoutMS: 5000,
  maxPoolSize: 10
})
.then(() => console.log("🗄️  Database connected"))
.catch(err => {
  console.error('Database connection failed:', err);
  process.exit(1);
});

// Routes
app.use('/api/auth', authRouter);
app.use('/api/mining', miningRouter);
app.use('/api/relayer', relayerRouter);
app.use('/api/transactions', txRouter);

app.use('/api/currency', currencyRouter);


app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    dbState: mongoose.connection.readyState,
    timestamp: Date.now()
  });
  
});


// Error Handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// Server Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🛡️  Environment: ${process.env.NODE_ENV || 'development'}`);
});