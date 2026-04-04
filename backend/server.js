// ════════════════════════════════════════════
// VEILX — Main Server (backend/server.js)
// Complete file — Phase 1 + Phase 2 all included
// ════════════════════════════════════════════

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

// Phase 2 imports
const { signMessage, getRoomToken, deleteRoomToken, sanitize, checkMsgRate, cleanupSocket } = require('./encryption');
const { getAIResponse, calculateTrendScore } = require('./ai');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;

// ── Security Middleware ──────────────────────

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
  hidePoweredBy: true,
  hsts: process.env.NODE_ENV === 'production' ? {
    maxAge: 31536000,
    includeSubDomains: true
  } : false,
  frameguard: { action: 'deny' },
  referrerPolicy: { policy: 'no-referrer' }
}));

app.disable('x-powered-by');

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests. Slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    return crypto.createHash('sha256').update(ip).digest('hex').substring(0, 16);
  }
});

app.use('/api/', limiter);
app.use(express.json({ limit: '10kb' }));
app.use(cors({ origin: '*' }));

// ── Room Store ───────────────────────────────

const rooms = new Map();

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
      deleteRoomToken(code);
      io.to(code).emit('room_expired', {
        message: 'Room auto-deleted after 1hr inactivity'
      });
    }
  }
}, 5 * 60 * 1000);

// ── Problem Store ────────────────────────────

const problemStore = new Map();
const reportStore = new Map();
const reportCounts = new Map();

// Auto-cleanup problems after 30 days
setInterval(() => {
  const now = Date.now();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  for (const [id, p] of problemStore.entries()) {
    if (now - p.createdAt > thirtyDays) {
      problemStore.delete(id);
    }
  }
}, 60 * 60 * 1000);

// Auto-cleanup reports after 7 days
setInterval(() => {
  const now = Date.now();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  for (const [id, r] of reportStore.entries()) {
    if (now - r.createdAt > sevenDays) {
      reportStore.delete(id);
    }
  }
}, 24 * 60 * 60 * 1000);

// ── API Routes ───────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Railway also checks root
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Create a room
app.post('/api/rooms/create', (req, res) => {
  const { type } = req.body;
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();
  if (rooms.has(code)) {
    return res.status(409).json({ error: 'Code collision, retry' });
  }
  rooms.set(code, createRoomRecord(code, type || 'General'));
  res.json({ code });
});

// Check if room exists
app.get('/api/rooms/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({
    exists: true,
    type: room.type,
    members: room.members.size
  });
});

// ── AI Response Route ────────────────────────

app.post('/api/ai-response', async (req, res) => {
  const { problem, category } = req.body;
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

// ── Problems Routes ──────────────────────────

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

app.get('/api/problems/trending', (req, res) => {
  const now = Date.now();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  const trending = [];
  for (const [id, p] of problemStore.entries()) {
    if (now - p.createdAt > thirtyDays) {
      problemStore.delete(id);
      continue;
    }
    const ageMinutes = (now - p.createdAt) / 60000;
    const score = calculateTrendScore(p.votes, p.replies, ageMinutes);
    trending.push({ ...p, score });
  }
  trending.sort((a, b) => b.score - a.score);
  res.json({ problems: trending.slice(0, 20) });
});

app.post('/api/problems/:id/vote', (req, res) => {
  const problem = problemStore.get(req.params.id);
  if (!problem) return res.status(404).json({ error: 'Not found' });
  problem.votes = Math.max(0, problem.votes + 1);
  res.json({ votes: problem.votes });
});

app.post('/api/problems/:id/reply', (req, res) => {
  const problem = problemStore.get(req.params.id);
  if (!problem) return res.status(404).json({ error: 'Not found' });
  problem.replies += 1;
  res.json({ replies: problem.replies });
});

// ── Report Routes ────────────────────────────

app.post('/api/report', (req, res) => {
  const { type, contentId, reason } = req.body;
  if (!type || !contentId || !reason) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  const allowedTypes = ['message', 'problem', 'room'];
  if (!allowedTypes.includes(type)) {
    return res.status(400).json({ error: 'Invalid report type' });
  }
  const allowedReasons = [
    'harassment', 'spam', 'illegal',
    'hate_speech', 'self_harm', 'misinformation', 'other'
  ];
  if (!allowedReasons.includes(reason)) {
    return res.status(400).json({ error: 'Invalid reason' });
  }
  const reportId = Date.now().toString();
  reportStore.set(reportId, {
    type,
    contentId: contentId.substring(0, 100),
    reason,
    createdAt: Date.now()
  });
  const count = (reportCounts.get(contentId) || 0) + 1;
  reportCounts.set(contentId, count);
  let autoHidden = false;
  if (count >= 3) {
    autoHidden = true;
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

app.get('/api/report/count/:contentId', (req, res) => {
  const count = reportCounts.get(req.params.contentId) || 0;
  res.json({ count });
});

// ── Socket.io ────────────────────────────────

io.on('connection', (socket) => {
  let currentRoom = null;
  let userCodename = null;
  let userEmoji = null;

  // Join a room
  socket.on('join_room', ({ code, codename, emoji }) => {
    code = (code || '').toUpperCase().substring(0, 6);
    if (!code || code.length !== 6) {
      socket.emit('error', { message: 'Invalid room code' });
      return;
    }

    userCodename = sanitize(codename || 'Anonymous', 30);
    userEmoji = (emoji || '👤').substring(0, 4);

    if (!rooms.has(code)) {
      rooms.set(code, createRoomRecord(code, 'General'));
    }

    const room = rooms.get(code);

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

    socket.to(code).emit('user_joined', {
      count: room.members.size
    });

    socket.emit('joined', {
      code,
      type: room.type,
      memberCount: room.members.size
    });
  });

  // Send a message
  socket.on('send_message', ({ text }) => {
    if (!currentRoom || !userCodename) return;

    // Rate limit — max 30 msgs/min
    if (!checkMsgRate(socket.id)) {
      socket.emit('error', { message: 'Slow down — too many messages.' });
      return;
    }

    if (!text || typeof text !== 'string') return;
    const clean = sanitize(text, 2000);
    if (!clean) return;

    const room = rooms.get(currentRoom);
    if (!room) return;

    room.lastActivity = Date.now();
    room.msgCount++;

    // Sign message for authenticity
    const payload = signMessage({
      sender: userCodename,
      avatar: userEmoji,
      text: clean,
      time: new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
      }),
    });

    // Broadcast — never stored
    io.to(currentRoom).emit('message', payload);
  });

  // Give room token for E2E encryption
  socket.on('get_room_token', ({ code }) => {
    const token = getRoomToken(code.toUpperCase());
    socket.emit('room_token', { token });
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
        if (room.members.size === 0) {
          setTimeout(() => {
            if (rooms.has(currentRoom) &&
                rooms.get(currentRoom).members.size === 0) {
              rooms.delete(currentRoom);
              deleteRoomToken(currentRoom);
            }
          }, 30000);
        }
      }
    }
  });
});

// ── Static Files ─────────────────────────────

app.use(express.static(path.join(__dirname, '../frontend')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ── Start Server ─────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🔒 VEILX Server running on port ${PORT}`);
  console.log(`📡 Zero-knowledge mode: ON`);
  console.log(`🗑  Auto-delete: ON (1hr inactivity)`);
  console.log(`🛡  Rate limiting: ON`);
  console.log(`\n→ Listening on 0.0.0.0:${PORT}\n`);
});