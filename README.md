# VEILX — Complete Build Guide
## "Be anyone. Say anything. Leave nothing."

---

## PHASE 1 FILES (What you have now)
```
veilx/
├── frontend/
│   └── index.html        ← Complete UI (all panels, encryption, rooms, code, games)
├── backend/
│   └── server.js         ← Secure Node.js server (helmet, rate-limit, socket.io)
├── package.json          ← Dependencies
└── README.md             ← This file
```

---

## STEP 1 — Install & Run Locally

```bash
# 1. Make sure Node.js is installed
node --version   # Should be 18+

# 2. Install dependencies
cd veilx
npm install

# 3. Start the server
npm start

# 4. Open browser
# Go to: http://localhost:3000
```

---

## STEP 2 — HTTPS Setup (Free with Cloudflare)

1. Buy a domain from Namecheap (~₹500/yr)
   Example: veilx.app or goveilx.com

2. Sign up at cloudflare.com (free)

3. Add your domain to Cloudflare
   - Change nameservers at Namecheap to Cloudflare's
   - Cloudflare gives you FREE SSL/HTTPS automatically

4. In Cloudflare dashboard:
   - SSL/TLS → Full (Strict)
   - Security → High
   - Enable "Always Use HTTPS"
   - Enable "Bot Fight Mode"

---

## STEP 3 — Deploy to a Server (VPS)

### Option A — Free (Render.com)
```bash
# Push to GitHub first
git init
git add .
git commit -m "VEILX Phase 1"
git push origin main

# Then on render.com:
# New Web Service → Connect GitHub → Deploy
# It gives you a free HTTPS URL instantly
```

### Option B — DigitalOcean Droplet (~₹400/month)
```bash
# SSH into your server
ssh root@your-server-ip

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone your project
git clone your-repo-url
cd veilx
npm install

# Install PM2 (keeps server running forever)
npm install -g pm2
pm2 start backend/server.js --name veilx
pm2 startup
pm2 save
```

---

## STEP 4 — Add Real WebSocket Chat

Connect frontend to your live backend by adding this to index.html before `</body>`:

```html
<script src="https://cdn.socket.io/4.7.2/socket.io.min.js"></script>
<script>
  // Connect to your server
  const socket = io('https://yourdomain.com');

  // When user joins a room
  function openChatRoomLive(code, type) {
    socket.emit('join_room', {
      code,
      codename: identity.codename,
      emoji: identity.emoji
    });
  }

  // Receive messages from others
  socket.on('message', (msg) => {
    if (msg.sender !== identity.codename) {
      messages.push(msg);
      renderMessages();
    }
  });

  // User joined notification
  socket.on('user_joined', ({ count }) => {
    document.getElementById('online-count').textContent = count + ' online';
  });
</script>
```

---

## SECURITY CHECKLIST

Before going live, verify:

- [ ] HTTPS enabled (Cloudflare SSL)
- [ ] Server IP hidden behind Cloudflare proxy (orange cloud = ON)
- [ ] Rate limiting active (100 req/15min)
- [ ] No logs in server.js (check: no console.log of user data)
- [ ] Messages NOT stored in database
- [ ] Room auto-delete working (1hr inactivity)
- [ ] Recovery key generated client-side (never sent to server)
- [ ] Content-Security-Policy header active (check in browser DevTools → Network → Response Headers)

---

## PHASE 2 ROADMAP (Next 2 weeks)

### Week 3
- [ ] Real E2E encryption using TweetNaCl.js
- [ ] AI-powered problem responses (Claude API)
- [ ] Trending algorithm for problems board
- [ ] Mobile responsive polish

### Week 4
- [ ] Voice rooms (WebRTC audio)
- [ ] File sharing (auto-delete in 24hrs)
- [ ] More games (Word Duel, Card game)
- [ ] Language support (Hindi/Urdu)

---

## MONETIZATION (Phase 3)

| Feature | Price |
|---------|-------|
| Premium rooms (password protected) | ₹99/month |
| Longer room lifetime (7 days) | ₹49/room |
| Codespace Pro (more languages) | ₹199/month |
| Anonymous ads (DuckDuckGo model) | Revenue share |
| API access for developers | ₹999/month |

---

## COMMON ERRORS & FIXES

### "Cannot find module 'express'"
```bash
npm install   # Run this in the veilx folder
```

### "Port 3000 already in use"
```bash
# Change port in server.js:
const PORT = 4000;
# Or kill the existing process:
lsof -ti:3000 | xargs kill
```

### "CORS error in browser"
```bash
# Already handled in server.js with cors()
# If still happening, check your domain in Cloudflare
```

### "Socket not connecting"
```bash
# Make sure socket.io CDN is loaded BEFORE your socket code
# Check browser console for errors
```

---

## TECH STACK SUMMARY

| Layer | Technology | Why |
|-------|-----------|-----|
| Frontend | Vanilla HTML/CSS/JS | No framework = faster, simpler |
| Real-time | Socket.io | Best for anonymous chat |
| Backend | Node.js + Express | Fast, lightweight |
| Security | Helmet.js | 11 security headers in 1 line |
| Rate limit | express-rate-limit | Blocks bots |
| Hosting | Render / DigitalOcean | Cheap, reliable |
| CDN/SSL | Cloudflare (free) | HTTPS + DDoS protection |
| Identity | Client-side only | Zero knowledge |

---

Built with privacy by design. No logs. No tracking. No identity.# Sat Apr  4 11:18:55 UTC 2026
