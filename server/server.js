'use strict';

require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');

const { connectDatabase } = require('./config/database');
const { requireAuthSocket } = require('./middleware/auth');
const { initChatSocket } = require('./sockets/chatSocket');
const { startCleanupService } = require('./services/cleanupService');

const authRoutes = require('./routes/auth');
const messageRoutes = require('./routes/messages');
const mediaRoutes = require('./routes/media');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 5000;
const CLIENT_URL = process.env.CLIENT_URL || `http://localhost:${PORT}`;
const isProduction = process.env.NODE_ENV === 'production';

// ─── Security Middleware ───────────────────────────────────────────────────────

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.socket.io"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:", "https://res.cloudinary.com"],
      mediaSrc: ["'self'", "data:", "blob:", "https://res.cloudinary.com"],
      connectSrc: ["'self'", "wss:", "ws:", "http:", "https:"],
      upgradeInsecureRequests: isProduction ? [] : null,
    },
  },
  hsts: isProduction,
}));

// CORS — allow client origin with credentials
const corsOrigin = isProduction ? CLIENT_URL : (origin, callback) => callback(null, true);

app.use(cors({
  origin: corsOrigin,
  credentials: true, // allow cookies
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ─── General Middleware ───────────────────────────────────────────────────────

app.use(compression()); // Gzip/Brotli payload compression for fast responses
app.use(morgan(isProduction ? 'combined' : 'dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());

// Disable browser caching during dev testing to ensure mobile phones get fresh code
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// Serve the client/ folder as static files
const clientDir = path.join(__dirname, '../client');
app.use(express.static(clientDir, {
  etag: false,
  lastModified: false,
}));

// ─── API Routes ───────────────────────────────────────────────────────────────

app.use('/api/auth', authRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/media', mediaRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Serve login page for unknown routes (SPA-style fallback)
app.get('*', (req, res) => {
  // Only serve HTML for non-API routes
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Route not found.' });
  }
  res.sendFile(path.join(clientDir, 'login.html'));
});

// ─── Socket.IO Setup ──────────────────────────────────────────────────────────

const io = new Server(server, {
  cors: {
    origin: corsOrigin,
    credentials: true,
    methods: ['GET', 'POST'],
  },
  // Reconnection settings
  pingTimeout: 30000,
  pingInterval: 25000,
});

// Apply auth middleware to all socket connections
io.use(requireAuthSocket);

// Initialize chat event handlers
initChatSocket(io);

// ─── Error Handling ───────────────────────────────────────────────────────────

// 404 handler (should be caught by * above, but just in case)
app.use((req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// Global error handler — never expose stack traces in production
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  const message = isProduction ? 'Internal server error.' : err.message;
  res.status(err.status || 500).json({ error: message });
});

// ─── Start Server ─────────────────────────────────────────────────────────────

async function start() {
  try {
    // Connect to MongoDB first
    await connectDatabase();

    // Start the HTTP + Socket.IO server
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`\n🚀 Server running on http://localhost:${PORT}`);
      console.log(`📱 Local Wi-Fi Access: http://10.71.106.152:${PORT}`);
      console.log(`   Environment: ${process.env.NODE_ENV || 'development'}\n`);
    });

    // Start media cleanup cron job
    startCleanupService();
  } catch (err) {
    console.error('Fatal: Failed to start server:', err.message);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('\nSIGINT received. Shutting down...');
  server.close(() => process.exit(0));
});

start();
