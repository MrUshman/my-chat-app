'use strict';

/**
 * Seed Script
 * Creates the two user accounts if they don't already exist.
 * Run with: npm run seed
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const mongoose = require('mongoose');
const User = require('../models/User');

const USERS = [
  {
    username: process.env.USER1_USERNAME || 'usman',
    password: process.env.USER1_PASSWORD || 'Change_This_Password_1!',
    displayName: process.env.USER1_DISPLAY_NAME || 'Usman',
  },
  {
    username: process.env.USER2_USERNAME || 'rehnuma',
    password: process.env.USER2_PASSWORD || 'Change_This_Password_2!',
    displayName: process.env.USER2_DISPLAY_NAME || 'Rehnuma',
  },
];

async function seed() {
  try {
    console.log('🌱 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected\n');

    for (const userData of USERS) {
      const existing = await User.findOne({ username: userData.username });

      if (existing) {
        console.log(`⏭️  User "${userData.username}" already exists — skipping`);
        continue;
      }

      const user = new User({
        username: userData.username,
        displayName: userData.displayName,
        passwordHash: 'placeholder', // will be replaced below
      });

      await user.setPassword(userData.password);
      await user.save();

      console.log(`✅ Created user: ${userData.username} (${userData.displayName})`);
    }

    console.log('\n🎉 Seed complete! You can now login with:');
    USERS.forEach(u => {
      console.log(`   Username: ${u.username}  |  Password: ${u.password}`);
    });
    console.log('\n⚠️  Remember to change these passwords in your .env file!\n');

  } catch (err) {
    console.error('❌ Seed failed:', err.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

seed();
