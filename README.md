# VEILX — Be anyone. Say anything. Leave nothing.

![VEILX](https://img.shields.io/badge/VEILX-Anonymous%20Platform-7b6fff?style=for-the-badge)
![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js)
![Socket.io](https://img.shields.io/badge/Socket.io-4.7-black?style=for-the-badge&logo=socket.io)
![License](https://img.shields.io/badge/License-Educational%20Use-ff6b9d?style=for-the-badge)

> **A fully anonymous, privacy-first web platform for chat, community, gaming, AI assistance, and more. Built with Node.js, Express, and Socket.io. Deployed on Railway.**

---

## ⚠️ Legal Disclaimer & Educational Purpose

**READ CAREFULLY BEFORE USE**

This project — VEILX — was created **strictly for educational purposes** to demonstrate concepts in:

- Anonymous communication system design
- End-to-end encryption implementation
- Real-time WebSocket architecture
- WebRTC peer-to-peer voice communication
- Privacy-preserving web application development
- Full-stack JavaScript / Node.js development

**The creator(s) of VEILX are not responsible for any actions, content, misuse, harm, or illegal activity conducted by any user on or through this platform.**

By accessing, using, deploying, or contributing to this codebase, you agree that:

1. This software is provided **"as is"** without warranty of any kind
2. The developer(s) bear **zero liability** for how this software is used
3. Any legal claims, lawsuits, or disputes arising from use of this software are **void and without merit** against the creator(s)
4. You are **solely responsible** for your own use and any deployment of this software
5. You agree to use this platform only in compliance with the laws of your jurisdiction
6. This project is **not intended** to facilitate, encourage, or enable any illegal activity

Any attempt to sue, litigate, or hold the creator(s) legally responsible for user-generated content or user actions is **without legal basis**, as this is an open-source educational project and the developer has no control over how others deploy or use it.

---

## 🔒 What Is VEILX?

VEILX is a privacy-first, zero-knowledge anonymous platform where users can:

- Chat in encrypted rooms without creating an account
- Ask for help anonymously from the community
- Confess thoughts they could never say out loud
- Study together using anonymous Pomodoro rooms
- Play real-time multiplayer games
- Talk via peer-to-peer voice rooms
- Share files temporarily with auto-deletion
- Get AI assistance through VEX — the built-in anonymous AI

Every user gets an auto-generated emoji codename identity. No email. No phone number. No IP logs. No cookies. Just privacy.

---

## 🏗️ Architecture

```
veilx/
├── backend/
│   └── server.js          ← Single all-in-one Node.js server
├── frontend/
│   └── index.html         ← Complete single-file frontend
├── package.json
└── railway.json
```

### Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 18+ |
| Framework | Express.js |
| Real-time | Socket.io 4.7 |
| Voice | WebRTC (peer-to-peer) |
| Security | Helmet.js, express-rate-limit |
| File uploads | Multer (memory storage) |
| AI | Anthropic Claude (claude-haiku) |
| Deployment | Railway.app |
| Frontend | Vanilla HTML/CSS/JS (single file) |

---

## ✨ Features

### Phase 1 — Core Platform
- 🎭 Anonymous identity generation (emoji + codename + recovery key)
- 🚪 Encrypted chat rooms with 6-digit codes
- 🆘 Community problem board with voting
- 💻 Browser-based codespace (HTML/JS/CSS live preview)
- 🎮 Gaming zone (Tic Tac Toe, Word Duel)
- 🔒 Zero IP logging, auto-delete on exit

### Phase 2 — Security & AI
- 🔐 AES-256 client-side E2E encryption
- 🤖 AI-powered first responses on problem board
- 🔥 Trending algorithm for problems
- 📱 Mobile responsive with bottom navigation
- 🚨 Anonymous report system (3 reports = auto-hide)
- 💙 Self-harm keyword detection + crisis helplines

### Phase 3 — Extensions
- 🎙️ WebRTC peer-to-peer voice rooms (server never hears audio)
- 📦 Temporary file sharing (10MB, auto-delete 24hrs, 10 download limit)
- 🧩 Word Duel multiplayer game (real-time, socket-based)
- 🌐 Hindi/Urdu language toggle with RTL support
- 💰 Monetization layer (Free / ₹99 Plus / ₹299 Pro)

### Phase 4 — Advanced Features
- 🤖 VEX AI Chatbot (20 msg/hr limit, conversation history, smart fallbacks)
- 💭 Anonymous Confessions Board (8 emoji reactions, 7-day auto-delete)
- 📚 Study Groups (Pomodoro timer sync, shared notes, live member tracking)
- 📊 Analytics Dashboard (local-only, never sent to server)
- 🔔 Smart Notifications (in-app bell, auto-triggers on activity)

### Phase 5 — Growth Features
- 🌐 Public Room Browser (discover rooms without codes, filter by type)
- 📰 VEILX Feed (Hot / New / Community tabs, unified content stream)
- 🎭 Anonymous Polls (2-4 options, 48hr expiry, live results)
- 🏆 Anonymous Leaderboard (Helpers / Studiers / Confessors / Overall)
- 🔗 Share Cards (Canvas-generated PNG cards for stats, confessions, achievements)

---

## 🚀 How It Works

### Identity System
```
1. User visits VEILX
2. Browser generates a random recovery key (e.g. ABCD-EFGH-IJKL-MNOP)
3. Key is hashed to produce: emoji + codename + 4-digit number
4. Identity stored in localStorage only — never on server
5. Recovery key = only way to restore identity on new device
```

### Room System
```
1. User creates room → gets 6-digit code
2. Others enter code → join same room
3. Messages sent via Socket.io
4. Server signs messages with HMAC (tamper detection)
5. Room auto-deletes after 1 hour of inactivity
6. No message history stored on server
```

### Voice Rooms (WebRTC)
```
1. User clicks Join Voice
2. Browser requests microphone permission
3. Server acts as signaling relay only (never receives audio)
4. WebRTC creates direct peer-to-peer connection
5. Audio flows directly between browsers — server blind
6. STUN servers: Google STUN (stun.l.google.com)
```

### File Sharing
```
1. User selects file (max 10MB)
2. File uploaded to server memory (never written to disk)
3. Server generates 8-char code (e.g. AB12CD34)
4. Code shared in chat as download card
5. File auto-deletes after 24 hours OR 10 downloads
6. Zero metadata stored — no uploader identity
```

### AI Responses
```
1. User posts problem or chats with VEX
2. Server sends to Claude Haiku via Anthropic API
3. Response returned under 150 words
4. If no API key set → smart fallback responses used
5. No conversation stored on server
```

---

## 🛠️ Setup & Installation

### Prerequisites
- Node.js 18+
- npm

### Local Development

```bash
# Clone the repo
git clone https://github.com/veilxdevs/veilx.git
cd veilx

# Install dependencies
npm install

# Set environment variables
export ANTHROPIC_API_KEY=your_key_here   # optional — fallback works without it
export PORT=3000

# Start server
node backend/server.js
```

Open `http://localhost:3000` in your browser.

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Server port (default: 3000) |
| `ANTHROPIC_API_KEY` | No | Enables real AI responses (fallback if missing) |
| `SERVER_SECRET` | No | HMAC signing key (auto-generated if missing) |
| `RAZORPAY_KEY_ID` | No | For Razorpay payment integration |
| `RAZORPAY_KEY_SECRET` | No | For Razorpay payment integration |

### Railway Deployment

```bash
# railway.json is pre-configured
git push origin main

# Set environment variables in Railway dashboard:
# ANTHROPIC_API_KEY = your_key
# NODE_ENV = production
```

---

## 📡 API Reference

### Health
```
GET  /api/health              → { status: 'ok' }
```

### Rooms
```
POST /api/rooms/create        → { code }
GET  /api/rooms/:code         → { exists, type, members }
```

### Problems / Community
```
POST /api/ai-response         → { response }
POST /api/problems            → { id }
GET  /api/problems/trending   → { problems[] }
POST /api/problems/:id/vote   → { votes }
POST /api/problems/:id/reply  → { replies }
```

### Reports
```
POST /api/report              → { success, autoHidden }
GET  /api/report/count/:id    → { count }
```

### Confessions
```
POST /api/confessions         → { success, id }
GET  /api/confessions         → { confessions[] }
POST /api/confessions/:id/react → { reactions }
```

### Files
```
POST /api/files/upload        → { fileId, name, size }
GET  /api/files/:fileId       → binary file download
GET  /api/files/:fileId/info  → { name, size, downloads, expiresIn }
```

### Voice
```
POST /api/voice/join          → { success, peerCount }
GET  /api/voice/:code/peers   → { peers }
```

### Study Groups
```
POST /api/study/create        → { code, subject }
GET  /api/study/:code         → { code, subject, members, notes, timer, sessions }
POST /api/study/:code/notes   → { success }
POST /api/study/:code/timer   → { timer, sessions }
```

### AI Chatbot
```
POST /api/chatbot             → { response, remaining }
```

### Premium
```
GET  /api/plans               → { plans[] }
GET  /api/premium/status      → { plan, active }
POST /api/premium/activate    → { token, plan }
```

### Public Rooms
```
POST /api/public-rooms/create → { code, name }
GET  /api/public-rooms        → { rooms[] }
POST /api/public-rooms/:code/ping → { success }
```

### Feed
```
GET  /api/feed?tab=hot|new|community → { items[] }
```

### Polls
```
POST /api/polls/create        → { id }
GET  /api/polls               → { polls[] }
POST /api/polls/:id/vote      → { options[], totalVotes }
```

### Leaderboard
```
POST /api/leaderboard/update  → { success, score }
GET  /api/leaderboard         → { entries[] }
```

---

## 🔌 Socket.io Events

### Client → Server
```
join_room       { code, codename, emoji }
send_message    { text }
get_room_token  { code }
voice_join      { code }
voice_offer     { targetId, offer }
voice_answer    { targetId, answer }
voice_ice       { targetId, candidate }
voice_leave     { code }
wordduel_create { codename }
wordduel_join   { gameCode, codename }
wordduel_start  { gameCode }
wordduel_answer { gameCode, word }
study_join      { code, codename }
study_leave     { code }
```

### Server → Client
```
joined              { code, type, memberCount }
message             { sender, avatar, text, time, sig }
user_joined         { count }
user_left           { count }
room_token          { token }
room_expired        { message }
content_hidden      { contentId }
voice_peer_joined   { peerId }
voice_existing_peers { peers }
voice_offer         { fromId, offer }
voice_answer        { fromId, answer }
voice_ice           { fromId, candidate }
voice_peer_left     { peerId }
wordduel_created    { gameCode }
wordduel_update     { players, status, message }
wordduel_started    { currentWord, currentPlayer, round, maxRounds }
wordduel_correct    { word, players, currentPlayer, round }
wordduel_timeout    { player, currentPlayer, currentWord }
wordduel_ended      { winner, players }
wordduel_error      { message }
study_joined        { code, subject, notes, timer, sessions, members }
study_timer_update  { timer, sessions }
study_notes_updated { notes }
study_member_update { members }
study_error         { message }
```

---

## 🔐 Security Model

| Feature | Implementation |
|---|---|
| No account required | Identity is client-side only |
| No IP logging | IPs hashed before rate limiting, never stored |
| No cookies | localStorage only, never transmitted |
| Message signing | HMAC-SHA256 with server secret |
| Rate limiting | 100 req/15min per IP (hashed), 30 msg/min per socket |
| Content Security | Helmet.js headers |
| File safety | Blocked: .exe .bat .sh .cmd .msi .dll .com |
| Auto-deletion | Rooms: 1hr · Files: 24hr · Confessions: 7d · Study: 4hr |
| Voice privacy | WebRTC P2P — server never touches audio |
| Input sanitization | All inputs sanitized, max lengths enforced |

---

## 🌐 Browser Support

| Browser | Support |
|---|---|
| Chrome 90+ | ✅ Full |
| Firefox 88+ | ✅ Full |
| Safari 14+ | ✅ Full |
| Edge 90+ | ✅ Full |
| Mobile Chrome | ✅ Full |
| Mobile Safari | ✅ Full (voice may require permission prompt) |

---

## 📦 Dependencies

```json
{
  "express": "^4.18.2",
  "socket.io": "^4.7.2",
  "helmet": "^7.1.0",
  "express-rate-limit": "^7.1.5",
  "cors": "^2.8.5",
  "multer": "^1.4.5-lts.1",
  "uuid": "^9.0.0"
}
```

---

## 🤝 Contributing

Pull requests are welcome. For major changes, open an issue first to discuss what you'd like to change.

Please ensure:
- No breaking changes to existing API routes
- Socket events remain backward compatible
- No personally identifiable data is stored anywhere
- All new features maintain zero-knowledge principles

---

## 📄 License

This project is released for **educational and personal use only**.

You are free to:
- Study the code
- Modify it for personal projects
- Use it to learn about anonymous communication systems

You may **not**:
- Use this for any illegal activity
- Deploy this commercially without the creator's permission
- Remove the educational disclaimer from any deployment
- Hold the creator liable for any use of this software

---

## 👤 Creator

Built by **Syed** — CA Foundation student, developer, and privacy advocate from Bangalore, India.

> *"Privacy is not about having something to hide. It's about having something to protect."*

---

## ⭐ Star This Repo

If VEILX helped you learn something about anonymous systems, privacy engineering, or full-stack development — give it a star. It means a lot.

---

*VEILX — Built for education. Built for privacy. Built for good.*