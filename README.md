# 💌 Private Chat App

A private, real-time 1-to-1 chat application built for two people. Supports text, photos, and voice messages with automatic media expiry.

## Features

- ✅ Real-time text messaging (Socket.IO)
- ✅ Photo messages (preview before send, viewer, download, auto-expiry)
- ✅ Voice messages (record, preview, play, download, auto-expiry)
- ✅ Emoji picker (300+ emojis, 7 categories)
- ✅ Typing indicator
- ✅ Online/offline status + last seen
- ✅ Message delivery & read status (✓ / ✓✓)
- ✅ Message history with pagination (scroll up for older messages)
- ✅ Automatic media cleanup (expired files deleted from storage + DB)
- ✅ Secure authentication (JWT, HTTP-only cookies, bcrypt)
- ✅ Mobile responsive (Android Chrome, iPhone Safari)
- ✅ Browser notifications (when tab is in background)
- ✅ Auto-reconnect on disconnect

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | HTML5, CSS3, Vanilla JavaScript |
| Backend | Node.js, Express.js |
| Real-time | Socket.IO |
| Database | MongoDB + Mongoose |
| Auth | JWT (HTTP-only cookies) + bcrypt |
| File Storage | Local filesystem / Cloudinary (configurable) |
| Cleanup | node-cron |

## Folder Structure

```
├── client/                   # Frontend (static files)
│   ├── index.html            # Chat page
│   ├── login.html            # Login page
│   ├── css/style.css         # All styles
│   └── js/
│       ├── auth.js           # Login logic
│       ├── chat.js           # Main chat logic
│       ├── socket.js         # Socket.IO client
│       ├── emoji.js          # Emoji picker
│       ├── media.js          # Photo/voice handling
│       └── ui.js             # UI utilities
├── server/
│   ├── server.js             # Express + Socket.IO entry point
│   ├── config/database.js    # MongoDB connection
│   ├── models/
│   │   ├── User.js           # User schema
│   │   └── Message.js        # Message schema
│   ├── routes/
│   │   ├── auth.js           # Login/logout/me
│   │   ├── messages.js       # Get messages (paginated)
│   │   └── media.js          # Upload + serve media
│   ├── middleware/
│   │   ├── auth.js           # JWT middleware (HTTP + Socket)
│   │   └── upload.js         # Multer config
│   ├── sockets/chatSocket.js # Socket.IO event handlers
│   ├── services/
│   │   ├── storageService.js # Local/Cloudinary abstraction
│   │   └── cleanupService.js # Auto-delete expired media
│   └── scripts/seed.js       # Create the two user accounts
├── uploads/                  # Local media files (gitignored)
├── .env.example              # Environment variable template
└── README.md
```

---

## Installation & Local Setup

### Prerequisites

- Node.js 18+ ([download](https://nodejs.org))
- A MongoDB Atlas account (free tier) — [atlas.mongodb.com](https://www.mongodb.com/atlas)

---

### Step 1 — Install Dependencies

```bash
npm install
```

---

### Step 2 — Configure Environment

```bash
copy .env.example .env
```

Open `.env` and fill in the values:

```env
PORT=5000
NODE_ENV=development
MONGODB_URI=mongodb+srv://YOUR_USER:YOUR_PASS@cluster0.xxxxx.mongodb.net/chatapp
JWT_SECRET=some_long_random_string_here
JWT_EXPIRES_IN=15d
COOKIE_SECRET=another_random_string
CLIENT_URL=http://localhost:5000

# Media expiry (set to 0 for never)
PHOTO_EXPIRY_HOURS=24
VOICE_EXPIRY_HOURS=24

# Max upload size
MAX_FILE_SIZE_MB=10

# User accounts
USER1_USERNAME=usman
USER1_PASSWORD=YourStrongPassword1!
USER1_DISPLAY_NAME=Usman

USER2_USERNAME=rehnuma
USER2_PASSWORD=YourStrongPassword2!
USER2_DISPLAY_NAME=Rehnuma
```

---

### Step 3 — Create MongoDB Atlas Database

1. Go to [atlas.mongodb.com](https://cloud.mongodb.com)
2. Create a free cluster
3. Click **Connect** → **Connect your application**
4. Copy the connection string and paste into `MONGODB_URI` in `.env`
5. In Atlas → **Network Access** → Add IP: `0.0.0.0/0` (for dev)
6. Create a database user with password

---

### Step 4 — Create User Accounts

```bash
npm run seed
```

This creates the two user accounts with hashed passwords. Run once. Safe to run again (skips existing users).

---

### Step 5 — Start the Server

**Development (auto-restart on changes):**
```bash
npm run dev
```

**Production:**
```bash
npm start
```

---

### Step 6 — Open the App

Open [http://localhost:5000](http://localhost:5000) in your browser.

Login with `usman` / `rehnuma` credentials you set in `.env`.

Open in two different browser windows/tabs to test real-time messaging.

---

## Testing

### Test Real-Time Chat
1. Open `http://localhost:5000` in Browser A → Login as `usman`
2. Open `http://localhost:5000` in Browser B (incognito) → Login as `rehnuma`
3. Send a message from A → should appear in B instantly

### Test Photo
1. Click 📷 → select an image → preview → Send ❤️
2. Should appear in other browser with thumbnail
3. Click thumbnail → full viewer → Download

### Test Voice
1. Click 🎙️ → allow microphone → speak → click ✓ Done
2. Preview → Send 🎙️
3. Should appear with play button in other browser

### Test Expiry (quick test)
Set `PHOTO_EXPIRY_HOURS=0.01` (~36 seconds) in `.env`, restart server, send a photo, wait, check it disappears.

---

## Media Expiry Configuration

Edit `.env`:

```env
PHOTO_EXPIRY_HOURS=24    # 24h = 1 day
VOICE_EXPIRY_HOURS=24    # same

# Set to 0 for never expiring
PHOTO_EXPIRY_HOURS=0
VOICE_EXPIRY_HOURS=0
```

**Text messages are NEVER deleted** by the cleanup service.

Cleanup runs every 30 minutes automatically on the server.

---

## Deployment (Free Tier)

### Recommended Stack (all free)

| Service | Purpose | Free Tier |
|---------|---------|-----------|
| [Render.com](https://render.com) | Node.js backend + serves frontend | 750 hrs/month |
| [MongoDB Atlas](https://www.mongodb.com/atlas) | Database | 512 MB |
| [Cloudinary](https://cloudinary.com) | Photo/audio storage | 10 GB storage |

> ⚠️ **Render free tier** spins down after 15 minutes of inactivity. First request after sleep takes ~30 seconds. Upgrade to Starter ($7/mo) to avoid this for a personal always-on app.

---

### Deploy to Render

#### Step 1 — Setup Cloudinary (for production file storage)

1. Create free account at [cloudinary.com](https://cloudinary.com)
2. Copy your Cloud Name, API Key, API Secret
3. Add to production env vars

#### Step 2 — Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USER/private-chat.git
git push -u origin main
```

#### Step 3 — Create Render Web Service

1. Go to [render.com](https://render.com) → New → Web Service
2. Connect your GitHub repo
3. Settings:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Environment**: `Node`

#### Step 4 — Set Environment Variables in Render

Add all env vars from `.env.example` with production values:

```
NODE_ENV=production
PORT=10000
MONGODB_URI=mongodb+srv://...
JWT_SECRET=<long random string>
COOKIE_SECRET=<long random string>
CLIENT_URL=https://YOUR-APP.onrender.com
PHOTO_EXPIRY_HOURS=24
VOICE_EXPIRY_HOURS=24
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
USER1_USERNAME=usman
USER1_PASSWORD=your_strong_password
USER1_DISPLAY_NAME=Usman
USER2_USERNAME=rehnuma
USER2_PASSWORD=your_strong_password
USER2_DISPLAY_NAME=Rehnuma
```

#### Step 5 — Run Seed on Render

In Render → your service → **Shell**:
```bash
npm run seed
```

#### Step 6 — Test from Two Phones

Open `https://YOUR-APP.onrender.com` on two different phones on different networks and test everything.

---

## Security Notes

- Passwords are hashed with bcrypt (cost factor 12)
- JWTs stored in HTTP-only cookies (not accessible to JavaScript)
- Rate limiting on login (5 attempts per 15 minutes)
- All media access requires authentication
- Expired media returns 410 Gone
- No stack traces exposed in production

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `MONGODB_URI is not defined` | Copy `.env.example` to `.env` and fill in values |
| `Cannot connect to MongoDB` | Check Atlas Network Access — add your IP |
| Login page reloads but no error | Check browser console for network errors |
| Photos not uploading | Check `uploads/` folder exists and is writable |
| Voice recording not working | Allow microphone permission in browser |
| Socket not connecting | Make sure `CLIENT_URL` in `.env` matches your actual URL |
| `npm run seed` fails | Check `MONGODB_URI` is correct in `.env` |
| Render: app sleeping | Expected on free tier — upgrade to Starter to avoid |
