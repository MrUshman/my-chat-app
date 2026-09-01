'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      minlength: 2,
      maxlength: 30,
    },
    passwordHash: {
      type: String,
      required: true,
      select: false, // never returned in queries unless explicitly requested
    },
    displayName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 50,
    },
    profileImage: {
      type: String,
      default: null,
    },
    lastSeen: {
      type: Date,
      default: null,
    },
    currentTheme: {
      type: String,
      default: 'purple',
    },
    currentMotion: {
      type: String,
      default: 'floating-hearts',
    },
  },
  {
    timestamps: true,
  }
);

// Hash password before any direct save (used in seed script only)
userSchema.methods.setPassword = async function (plainPassword) {
  const salt = await bcrypt.genSalt(12);
  this.passwordHash = await bcrypt.hash(plainPassword, salt);
};

// Compare a candidate password against stored hash
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.passwordHash);
};

// Never expose passwordHash in JSON responses
userSchema.methods.toSafeObject = function () {
  return {
    _id: this._id,
    username: this.username,
    displayName: this.displayName,
    profileImage: this.profileImage,
    lastSeen: this.lastSeen,
    createdAt: this.createdAt,
  };
};

const User = mongoose.model('User', userSchema);

module.exports = User;
