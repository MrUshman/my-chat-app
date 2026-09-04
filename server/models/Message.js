'use strict';

const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    // Who sent it
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // Who receives it (always the other user in a 2-person chat)
    receiverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // Message type
    type: {
      type: String,
      enum: ['text', 'image', 'audio', 'video'],
      required: true,
      default: 'text',
    },
    // Text content (for type='text')
    text: {
      type: String,
      default: null,
      maxlength: 5000,
    },
    // URL to access the media (served via /api/media/:id)
    mediaUrl: {
      type: String,
      default: null,
    },
    // Internal storage key (file path for local, public_id for Cloudinary)
    mediaStorageKey: {
      type: String,
      default: null,
    },
    // MIME type of the media
    mimeType: {
      type: String,
      default: null,
    },
    // File size in bytes
    fileSize: {
      type: Number,
      default: null,
    },
    // Audio duration in seconds
    duration: {
      type: Number,
      default: null,
    },
    // When the media file should be auto-deleted (null = never)
    expiresAt: {
      type: Date,
      default: null,
      index: true,
    },
    // Whether the media file has been deleted (expired)
    mediaDeleted: {
      type: Boolean,
      default: false,
    },
    // When the message was delivered (receiver was online when sent, or connected after)
    deliveredAt: {
      type: Date,
      default: null,
    },
    // When the receiver actually read/saw the message
    readAt: {
      type: Date,
      default: null,
    },
    // Message reactions (WhatsApp / Instagram style)
    reactions: [
      {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        emoji: { type: String, required: true },
        createdAt: { type: Date, default: Date.now },
      },
    ],
    // WhatsApp style message deletion
    deletedForSender: {
      type: Boolean,
      default: false,
    },
    deletedForReceiver: {
      type: Boolean,
      default: false,
    },
    deletedForEveryone: {
      type: Boolean,
      default: false,
    },
    // Quoted Reply (WhatsApp style)
    replyTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Message',
      default: null,
    },
  },
  {
    timestamps: true, // adds createdAt and updatedAt
  }
);

// Compound indexes for ultra-fast conversation & pagination queries
messageSchema.index({ createdAt: -1 });
messageSchema.index({ senderId: 1, createdAt: -1 });
messageSchema.index({ receiverId: 1, createdAt: -1 });
messageSchema.index({ senderId: 1, receiverId: 1, createdAt: -1 });

const Message = mongoose.model('Message', messageSchema);

module.exports = Message;
