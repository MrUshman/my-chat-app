'use strict';

const jwt = require('jsonwebtoken');
const User = require('../models/User');

/**
 * Middleware that verifies the JWT from cookie OR Authorization header.
 * Attaches the user object to req.user if valid.
 */
async function requireAuth(req, res, next) {
  try {
    let token = req.cookies?.chatToken;

    if (!token && req.headers.authorization) {
      const parts = req.headers.authorization.split(' ');
      if (parts.length === 2 && parts[0] === 'Bearer') {
        token = parts[1];
      }
    }

    if (!token && req.query?.token) {
      token = req.query.token;
    }

    if (!token) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'Session expired. Please login again.' });
    }

    const user = await User.findById(payload.userId).select('username displayName profileImage').lean();
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    req.user = user;
    next();
  } catch (err) {
    console.error('Auth middleware error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Socket.IO middleware that verifies the JWT from cookie OR auth token.
 * Used in chatSocket.js to authenticate socket connections.
 */
async function requireAuthSocket(socket, next) {
  try {
    // Parse cookies from handshake headers
    const cookieHeader = socket.handshake.headers.cookie || '';
    const cookies = parseCookies(cookieHeader);
    let token = cookies['chatToken'] || socket.handshake.auth?.token || socket.handshake.query?.token;

    if (!token) {
      console.warn('⚠️ Socket auth failed: No chatToken found in cookie, auth, or query');
      return next(new Error('Not authenticated'));
    }

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      console.warn('⚠️ Socket auth failed: Invalid/expired JWT token:', err.message);
      return next(new Error('Session expired'));
    }

    const user = await User.findById(payload.userId);
    if (!user) {
      console.warn('⚠️ Socket auth failed: User not found in DB:', payload.userId);
      return next(new Error('User not found'));
    }

    socket.user = user;
    next();
  } catch (err) {
    console.error('Socket auth error:', err.message);
    next(new Error('Authentication error'));
  }
}

/**
 * Robust cookie string parser
 */
function parseCookies(cookieString) {
  const cookies = {};
  if (!cookieString || typeof cookieString !== 'string') return cookies;
  const pairs = cookieString.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx > 0) {
      const key = pair.substring(0, idx).trim();
      const val = pair.substring(idx + 1).trim();
      try {
        cookies[key] = decodeURIComponent(val);
      } catch {
        cookies[key] = val;
      }
    }
  }
  return cookies;
}

module.exports = { requireAuth, requireAuthSocket };
