'use strict';

const mongoose = require('mongoose');

// MongoDB connection with retry logic
async function connectDatabase() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;

  if (!uri) {
    throw new Error('MONGODB_URI (or MONGO_URI) is not defined in environment variables');
  }

  const options = {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  };

  let retries = 5;
  while (retries > 0) {
    try {
      await mongoose.connect(uri, options);
      console.log('✅ MongoDB connected successfully');
      return;
    } catch (err) {
      retries -= 1;
      console.error(`❌ MongoDB connection failed. Retries left: ${retries}`);
      console.error(err.message);
      if (retries === 0) {
        throw err;
      }
      // Wait 3 seconds before retrying
      await new Promise(res => setTimeout(res, 3000));
    }
  }
}

// Handle connection events
mongoose.connection.on('disconnected', () => {
  console.warn('⚠️  MongoDB disconnected');
});

mongoose.connection.on('reconnected', () => {
  console.log('✅ MongoDB reconnected');
});

module.exports = { connectDatabase };
