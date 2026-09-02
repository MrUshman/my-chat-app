'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const { saveFile } = require('../services/storageService');

const router = express.Router();

// Rate limit: max login attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 30 : 500,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Helper to set JWT cookie
function setAuthCookie(res, userId) {
  const token = jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '15d',
  });

  const isProduction = process.env.NODE_ENV === 'production';

  res.cookie('chatToken', token, {
    path: '/',                 // Ensure cookie is sent for all routes including /socket.io/
    httpOnly: true,           // JS cannot access this cookie
    secure: isProduction,     // HTTPS only in production
    sameSite: 'lax',          // Allow cookie on same-site navigations & socket connections
    maxAge: 15 * 24 * 60 * 60 * 1000, // 15 days in ms
  });

  return token;
}

// POST /api/auth/login
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;

    // Validate presence
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    // Find user - explicitly select passwordHash (excluded by default)
    const user = await User.findOne({ username: username.toLowerCase().trim() }).select('+passwordHash');

    // Generic error - do not reveal if username exists
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const token = setAuthCookie(res, user._id);

    res.json({
      success: true,
      token,
      user: user.toSafeObject(),
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// POST /api/auth/register
router.post('/register', loginLimiter, async (req, res) => {
  try {
    const { username, password, displayName } = req.body;

    if (!username || !password || !displayName) {
      return res.status(400).json({ error: 'Display Name, Username, and Password are required.' });
    }

    const cleanUsername = username.toLowerCase().trim();
    if (cleanUsername.length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters long.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    const existingUser = await User.findOne({ username: cleanUsername });
    if (existingUser) {
      return res.status(400).json({ error: 'Username is already taken.' });
    }

    const user = new User({
      username: cleanUsername,
      displayName: displayName.trim(),
      passwordHash: 'placeholder',
    });

    await user.setPassword(password);
    await user.save();
    const token = setAuthCookie(res, user._id);

    res.json({
      success: true,
      token,
      user: user.toSafeObject(),
    });
  } catch (err) {
    console.error('Registration error:', err.message);
    res.status(500).json({ error: 'Server error during registration.' });
  }
});

// POST /api/auth/logout
router.post('/logout', requireAuth, async (req, res) => {
  try {
    // Update lastSeen before logging out
    await User.findByIdAndUpdate(req.user._id, { lastSeen: new Date() });

    res.clearCookie('chatToken', {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
    });

    res.json({ success: true, message: 'Logged out successfully.' });
  } catch (err) {
    console.error('Logout error:', err.message);
    res.status(500).json({ error: 'Logout failed.' });
  }
});

// GET /api/auth/me — check if currently logged in and fetch partner in single fast query
router.get('/me', requireAuth, async (req, res) => {
  try {
    const partner = await User.findOne({ _id: { $ne: req.user._id } })
      .select('username displayName profileImage lastSeen')
      .lean();
    res.json({
      user: req.user,
      partner: partner || null,
    });
  } catch (err) {
    res.json({ user: req.user, partner: null });
  }
});

// GET /api/auth/partner — get partner user info
// GET /api/auth/partner — get partner user info
router.get('/partner', requireAuth, async (req, res) => {
  try {
    const partner = await User.findOne({ _id: { $ne: req.user._id } })
      .select('username displayName profileImage lastSeen')
      .lean();
    if (!partner) {
      return res.status(404).json({ error: 'Partner not found' });
    }
    res.json({ partner });
  } catch (err) {
    console.error('Get partner error:', err.message);
    res.status(500).json({ error: 'Failed to fetch partner' });
  }
});

// PUT /api/auth/profile — update current user profile (displayName & profileImage avatar)
router.put('/profile', requireAuth, (req, res, next) => {
  upload.single('avatar')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Image too large. Maximum size is 10MB.' });
      }
      return res.status(400).json({ error: err.message || 'Image upload failed.' });
    }
    next();
  });
}, async (req, res) => {
  try {
    const updates = {};
    if (req.body.displayName && req.body.displayName.trim()) {
      updates.displayName = req.body.displayName.trim();
    }

    if (req.file) {
      const { url } = await saveFile(req.file);
      updates.profileImage = url;
    }

    const updatedUser = await User.findByIdAndUpdate(req.user._id, updates, { new: true });

    res.json({
      success: true,
      user: updatedUser.toSafeObject(),
    });
  } catch (err) {
    console.error('Profile update error:', err.message);
    res.status(500).json({ error: 'Failed to update profile.' });
  }
});

module.exports = router;
