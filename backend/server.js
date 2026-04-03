// ════════════════════════════════════════════
// VEILX BACKEND — Phase 1
// Secure anonymous platform server
// Run: npm install && node server.js
// ════════════════════════════════════════════
const { getAIResponse, calculateTrendScore } = require('./ai');const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const crypto = require('crypto');
const { signMessage, getRoomToken, deleteRoomToken, sanitize, checkMsgRate, cleanupSocket } = require('./encryption');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;

// ── Security Middleware ──────────────────────

// Helmet: sets secure HTTP headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      imgSrc: ["'self'", 'data:'],
    }
  },
  // Remove server fingerprint
  hidePoweredBy: true,
  // Force HTTPS (enable in production)
  hsts: process.env.NODE_ENV === 'production' ? {
    maxAge: 31536000,
    includeSubDomains: true
  } : false,
  // Block iframe embedding
  frameguard: { action: 'deny' },
  // No referrer leak
  referrerPolicy: { policy: 'no-referrer' }
}));

// Remove X-Powered-By header
app.disable('x-powered-by');

// Rate limiting — 100 requests per 15 minutes per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests. Slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  // Don't store IP addresses — use hashed fingerprint
  keyGenerator: (req) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    return crypto.createHash('sha256').update(ip).digest('hex').substring(0, 16);
  }
});

app.use('/api/', limiter);
app.use(express.json({ limit: '10kb' })); // Limit payload size
app.use(cors({ origin: '*' }));

// ── Zero-Knowledge Room Store ────────────────
// Rooms are stored in memory only — never on disk
// They auto-delete after 1 hour of inactivity

const rooms = new Map();
// Structure: roomCode -> { type, members: Set, created, lastActivity, msgCount }

function createRoomRecord(code, type) {
  return {
    code,
    type,
    members: new Set(),
    created: Date.now(),
    lastActivity: Date.now(),
    msgCount: 0
  };
}

// Auto-delete rooms after 1 hour of inactivity
setInterval(() => {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  for (const [code, room] of rooms.entries()) {
    if (now - room.lastActivity > oneHour) {
      rooms.delete(code);
      io.to(code).emit('room_expired', { message: 'Room auto-deleted after 1hr inactivity' });
    }
  }
}, 5 * 60 * 1000); // Check every 5 minutes

// ── API Routes ───────────────────────────────

// Health check (no sensitive data exposed)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});
// ════════════════════════════════════════════
// VEILX Phase 2 Step 5 — Report System
// Add this block after the /api/health route
// ════════════════════════════════════════════

// In-memory report store — never logged to disk
const reportStore = new Map();
// Structure: reportId -> { type, contentId, reason, createdAt }

// Auto-actions: content reported 3+ times gets auto-hidden
const reportCounts = new Map();
// Structure: contentId -> count

// ── POST a report ────────────────────────────
app.post('/api/report', (req, res) => {
  const { type, contentId, reason } = req.body;

  // Validate inputs
  if (!type || !contentId || !reason) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const allowedTypes = ['message', 'problem', 'room'];
  if (!allowedTypes.includes(type)) {
    return res.status(400).json({ error: 'Invalid report type' });
  }

  const allowedReasons = [
    'harassment',
    'spam',
    'illegal',
    'hate_speech',
    'self_harm',
    'misinformation',
    'other'
  ];
  if (!allowedReasons.includes(reason)) {
    return res.status(400).json({ error: 'Invalid reason' });
  }

  const reportId = Date.now().toString();

  // Store report — NO identity, NO IP
  reportStore.set(reportId, {
    type,
    contentId: contentId.substring(0, 100),
    reason,
    createdAt: Date.now()
  });

  // Track report count for this content
  const count = (reportCounts.get(contentId) || 0) + 1;
  reportCounts.set(contentId, count);

  // Auto-action: 3+ reports = content flagged
  let autoHidden = false;
  if (count >= 3) {
    autoHidden = true;
    // Broadcast to room if it's a message report
    if (type === 'message') {
      io.emit('content_hidden', { contentId });
    }
  }

  res.json({
    success: true,
    message: 'Report received. Thank you for keeping VEILX safe.',
    autoHidden
  });
});

// ── GET report count for content (mod use) ───
app.get('/api/report/count/:contentId', (req, res) => {
  const count = reportCounts.get(req.params.contentId) || 0;
  res.json({ count });
});

// ── Auto-cleanup reports after 7 days ────────
setInterval(() => {
  const now = Date.now();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  for (const [id, r] of reportStore.entries()) {
    if (now - r.createdAt > sevenDays) {
      reportStore.delete(id);
    }
  }
}, 24 * 60 * 60 * 1000); // runs once per day

// ── Phase 2 Step 3: Trending Algorithm ──────
// In-memory problem store with trending scores
// Problems auto-expire after 30 days
// Server never stores identity — only content + scores

const problemStore = new Map();
// Structure: id -> { id, text, cat, votes, replies, createdAt, score }

// ── POST a new problem ───────────────────────
app.post('/api/problems', async (req, res) => {
  const { text, category } = req.body;

  if (!text || typeof text !== 'string' || text.trim().length < 10) {
    return res.status(400).json({ error: 'Problem too short' });
  }

  const clean = text.substring(0, 500).replace(/[<>]/g, '').trim();
  const cat = (category || 'General').substring(0, 30);
  const id = Date.now().toString();

  const problem = {
    id,
    text: clean,
    cat,
    votes: 0,
    replies: 0,
    createdAt: Date.now(),
    score: 0
  };

  problemStore.set(id, problem);
  res.json({ id });
});

// ── GET trending problems ────────────────────
app.get('/api/problems/trending', (req, res) => {
  const now = Date.now();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;

  const trending = [];

  for (const [id, p] of problemStore.entries()) {
    // Auto-expire after 30 days
    if (now - p.createdAt > thirtyDays) {
      problemStore.delete(id);
      continue;
    }

    const ageMinutes = (now - p.createdAt) / 60000;
    const score = calculateTrendScore(p.votes, p.replies, ageMinutes);

    trending.push({ ...p, score });
  }

  // Sort by trending score — highest first
  trending.sort((a, b) => b.score - a.score);

  // Return top 20
  res.json({ problems: trending.slice(0, 20) });
});

// ── Vote on a problem ────────────────────────
app.post('/api/problems/:id/vote', (req, res) => {
  const problem = problemStore.get(req.params.id);
  if (!problem) return res.status(404).json({ error: 'Not found' });

  problem.votes = Math.max(0, problem.votes + 1);
  res.json({ votes: problem.votes });
});

// ── Add a reply count to problem ─────────────
app.post('/api/problems/:id/reply', (req, res) => {
  const problem = problemStore.get(req.params.id);
  if (!problem) return res.status(404).json({ error: 'Not found' });

  problem.replies += 1;
  res.json({ replies: problem.replies });
});

// ── Auto-cleanup: runs every hour ────────────
setInterval(() => {
  const now = Date.now();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  let cleaned = 0;

  for (const [id, p] of problemStore.entries()) {
    if (now - p.createdAt > thirtyDays) {
      problemStore.delete(id);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`[VEILX] Auto-cleaned ${cleaned} expired problems`);
  }
}, 60 * 60 * 1000);
// ── Phase 2: AI Response Route ──────────────
// POST /api/ai-response
// Body: { problem: "...", category: "..." }
// Returns: { response: "..." }

app.post('/api/ai-response', async (req, res) => {
  const { problem, category } = req.body;

  // Validate inputs
  if (!problem || typeof problem !== 'string') {
    return res.status(400).json({ error: 'Problem text required' });
  }

  const cleanProblem = problem.substring(0, 500).replace(/[<>]/g, '');
  const cleanCategory = (category || 'General').substring(0, 30);

  try {
    const response = await getAIResponse(cleanProblem, cleanCategory);
    res.json({ response });
  } catch (err) {
    res.status(500).json({ error: 'Could not generate response' });
  }
});

// Create a room
app.post('/api/rooms/create', (req, res) => {
  const { type } = req.body;

  // Generate a random 6-character room code
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();

  if (rooms.has(code)) {
    return res.status(409).json({ error: 'Code collision, retry' });
  }

  rooms.set(code, createRoomRecord(code, type || 'General'));

  // Return only the code — no metadata
  res.json({ code });
});

// Check if room exists
app.get('/api/rooms/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const room = rooms.get(code);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  res.json({
    exists: true,
    type: room.type,
    members: room.members.size
    // Never expose member identities
  });
});

// ── Socket.io — Real-time Anonymous Chat ─────

io.on('connection', (socket) => {
  let currentRoom = null;
  let userCodename = null;
  let userEmoji = null;

  // Join a room
  socket.on('join_room', ({ code, codename, emoji }) => {
    code = (code || '').toUpperCase().substring(0, 6);

    // Input validation
    if (!code || code.length !== 6) {
      socket.emit('error', { message: 'Invalid room code' });
      return;
    }

    // Sanitize inputs
    userCodename = (codename || 'Anonymous').substring(0, 30).replace(/[<>]/g, '');
    userEmoji = (emoji || '👤').substring(0, 4);

    // Create room if it doesn't exist (joining creates it too)
    if (!rooms.has(code)) {
      rooms.set(code, createRoomRecord(code, 'General'));
    }

    const room = rooms.get(code);

    // Leave previous room if any
    if (currentRoom) {
      socket.leave(currentRoom);
      const prevRoom = rooms.get(currentRoom);
      if (prevRoom) {
        prevRoom.members.delete(socket.id);
        io.to(currentRoom).emit('user_left', {
          count: prevRoom.members.size
        });
      }
    }

    socket.join(code);
    currentRoom = code;
    room.members.add(socket.id);
    room.lastActivity = Date.now();

    // Notify room of new member (no identity revealed to others)
    socket.to(code).emit('user_joined', {
      count: room.members.size,
      // Just the count — not who joined
    });

    // Confirm join to sender
    socket.emit('joined', {
      code,
      type: room.type,
      memberCount: room.members.size
    });
  });

  // Send a message
  socket.on('send_message', ({ text }) => {
    if (!currentRoom || !userCodename) return;
    if (!checkMsgRate(socket.id)) {
      socket.emit('error', { message: 'Too many messages.' });
      return;
    }
    if (!text || typeof text !== 'string') return;
    const clean = sanitize(text, 2000);
    if (!clean) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.lastActivity = Date.now();
    room.msgCount++;
    const payload = signMessage({
      sender: userCodename,
      avatar: userEmoji,
      text: clean,
      time: new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }),
    });
    io.to(currentRoom).emit('message', payload);
  });

    // NOTE: Message is NOT stored anywhere — broadcast only
    // Even server RAM doesn't keep it after broadcast
    const payload = {
      sender: userCodename,
      avatar: userEmoji,
      text: clean,
      time: new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }),
      // No IP, no socket ID, no server-side ID
    };

    // Broadcast to all in room including sender
    io.to(currentRoom).emit('message', payload);
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    cleanupSocket(socket.id);
    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        room.members.delete(socket.id);
        io.to(currentRoom).emit('user_left', {
          count: room.members.size
        });

        // Auto-delete empty rooms immediately
        if (room.members.size === 0) {
          setTimeout(() => {
            if (rooms.has(currentRoom) && rooms.get(currentRoom).members.size === 0) {
              rooms.delete(currentRoom);
            }
          }, 30000); // 30 sec grace period
        }
      }
    }
    // user identity is gone — socket.id was the only link
  });

// ── Static Files ─────────────────────────────
app.use(express.static(path.join(__dirname, '../frontend')));

// Catch-all: serve index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ── Start Server ─────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🔒 VEILX Server running on port ${PORT}`);
  console.log(`📡 Zero-knowledge mode: ON`);
  console.log(`🗑  Auto-delete: ON (1hr inactivity)`);
  console.log(`🛡  Rate limiting: ON`);
  console.log(`\n→ Open http://localhost:${PORT}\n`);
});
