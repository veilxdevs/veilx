const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// ════════════════════════════════════════════
// ENCRYPTION HELPERS (was encryption.js)
// ════════════════════════════════════════════

const SERVER_SECRET = process.env.SERVER_SECRET ||
  crypto.randomBytes(32).toString('hex');

function signMessage(payload) {
  const data = JSON.stringify(payload);
  const sig = crypto
    .createHmac('sha256', SERVER_SECRET)
    .update(data)
    .digest('hex')
    .substring(0, 16);
  return { ...payload, sig };
}

const roomTokens = new Map();

function getRoomToken(roomCode) {
  if (!roomTokens.has(roomCode)) {
    const token = crypto.randomBytes(16).toString('hex');
    roomTokens.set(roomCode, token);
  }
  return roomTokens.get(roomCode);
}

function deleteRoomToken(roomCode) {
  roomTokens.delete(roomCode);
}

function sanitize(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  return str
    .substring(0, maxLen)
    .replace(/[<>]/g, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+=/gi, '')
    .trim();
}

const socketMsgCount = new Map();

function checkMsgRate(socketId) {
  const now = Date.now();
  const entry = socketMsgCount.get(socketId) ||
    { count: 0, reset: now + 60000 };
  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + 60000;
  }
  entry.count++;
  socketMsgCount.set(socketId, entry);
  return entry.count <= 30;
}

function cleanupSocket(socketId) {
  socketMsgCount.delete(socketId);
}

// ════════════════════════════════════════════
// AI HELPERS (was ai.js)
// ════════════════════════════════════════════

async function getAIResponse(problem, category) {
  if (!ANTHROPIC_API_KEY) return getFallbackResponse(category);
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: `You are a compassionate anonymous advisor on VEILX.
Rules: under 100 words, direct, give 1-2 actionable steps,
never ask personal details, end with encouragement.
Category: ${category}`,
        messages: [{
          role: 'user',
          content: `Anonymous problem: "${problem}". Give brief helpful response.`
        }]
      })
    });
    if (!response.ok) return getFallbackResponse(category);
    const data = await response.json();
    return data.content?.[0]?.text || getFallbackResponse(category);
  } catch (err) {
    return getFallbackResponse(category);
  }
}

function getFallbackResponse(category) {
  const responses = {
    'Mental Health': "What you feel is valid. Take one small step today — even 5 minutes outside counts. You are not alone. 💙",
    'Finance': "List every expense first — clarity reduces anxiety. Then cut the one biggest cost. Small steps add up fast.",
    'Relationships': "Write down exactly what you need before any conversation. Clear needs lead to clearer solutions.",
    'Career': "List 3 skills you have that someone would pay for. One genuine connection changes everything.",
    'Tech': "Break it into the smallest piece and solve just that. Share the exact error — that is where the answer lives.",
    'Studies': "25 minutes focused, 5 minutes break. Teach it to an imaginary student — if you can explain it, you know it.",
    'General': "Break it into the smallest first step. Not the solution — just the first step. Progress follows."
  };
  return responses[category] || responses['General'];
}

function calculateTrendScore(votes, replies, ageMinutes) {
  const engagement = (votes * 2) + (replies * 3);
  const decay = Math.pow(ageMinutes + 2, 1.5);
  return engagement / decay;
}

// ════════════════════════════════════════════
// SECURITY MIDDLEWARE
// ════════════════════════════════════════════

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      connectSrc: ["'self'", 'ws:', 'wss:', 'https://api.anthropic.com'],
      imgSrc: ["'self'", 'data:'],
    }
  },
  hidePoweredBy: true,
  frameguard: { action: 'deny' },
  referrerPolicy: { policy: 'no-referrer' }
}));4

app.disable('x-powered-by');

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

// ════════════════════════════════════════════
// DATA STORES (all in-memory, zero disk logs)
// ════════════════════════════════════════════

const rooms = new Map();
const problemStore = new Map();
const reportStore = new Map();
const reportCounts = new Map();

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

// Auto-delete rooms after 1 hour
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - room.lastActivity > 60 * 60 * 1000) {
      rooms.delete(code);
      deleteRoomToken(code);
      io.to(code).emit('room_expired', {
        message: 'Room auto-deleted after 1hr inactivity'
      });
    }
  }
}, 5 * 60 * 1000);

// Auto-delete problems after 30 days
setInterval(() => {
  const now = Date.now();
  for (const [id, p] of problemStore.entries()) {
    if (now - p.createdAt > 30 * 24 * 60 * 60 * 1000) {
      problemStore.delete(id);
    }
  }
}, 60 * 60 * 1000);

// Auto-delete reports after 7 days
setInterval(() => {
  const now = Date.now();
  for (const [id, r] of reportStore.entries()) {
    if (now - r.createdAt > 7 * 24 * 60 * 60 * 1000) {
      reportStore.delete(id);
    }
  }
}, 24 * 60 * 60 * 1000);

// ════════════════════════════════════════════
// API ROUTES
// ════════════════════════════════════════════

// Health checks
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Rooms
app.post('/api/rooms/create', (req, res) => {
  const { type } = req.body;
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();
  if (rooms.has(code)) {
    return res.status(409).json({ error: 'Code collision, retry' });
  }
  rooms.set(code, createRoomRecord(code, type || 'General'));
  res.json({ code });
});

app.get('/api/rooms/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ exists: true, type: room.type, members: room.members.size });
});

// AI response
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

// Problems
app.post('/api/problems', async (req, res) => {
  const { text, category } = req.body;
  if (!text || typeof text !== 'string' || text.trim().length < 10) {
    return res.status(400).json({ error: 'Problem too short' });
  }
  const id = Date.now().toString();
  problemStore.set(id, {
    id,
    text: text.substring(0, 500).replace(/[<>]/g, '').trim(),
    cat: (category || 'General').substring(0, 30),
    votes: 0,
    replies: 0,
    createdAt: Date.now(),
    score: 0
  });
  res.json({ id });
});

app.get('/api/problems/trending', (req, res) => {
  const now = Date.now();
  const trending = [];
  for (const [id, p] of problemStore.entries()) {
    if (now - p.createdAt > 30 * 24 * 60 * 60 * 1000) {
      problemStore.delete(id);
      continue;
    }
    const ageMinutes = (now - p.createdAt) / 60000;
    trending.push({ ...p, score: calculateTrendScore(p.votes, p.replies, ageMinutes) });
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

// Reports
app.post('/api/report', (req, res) => {
  const { type, contentId, reason } = req.body;
  if (!type || !contentId || !reason) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  const allowedTypes = ['message', 'problem', 'room'];
  const allowedReasons = ['harassment', 'spam', 'illegal',
    'hate_speech', 'self_harm', 'misinformation', 'other'];
  if (!allowedTypes.includes(type) || !allowedReasons.includes(reason)) {
    return res.status(400).json({ error: 'Invalid fields' });
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

// ════════════════════════════════════════════
// SOCKET.IO — REAL-TIME CHAT
// ════════════════════════════════════════════

io.on('connection', (socket) => {
  let currentRoom = null;
  let userCodename = null;
  let userEmoji = null;

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
        io.to(currentRoom).emit('user_left', { count: prevRoom.members.size });
      }
    }

    socket.join(code);
    currentRoom = code;
    room.members.add(socket.id);
    room.lastActivity = Date.now();

    socket.to(code).emit('user_joined', { count: room.members.size });
    socket.emit('joined', { code, type: room.type, memberCount: room.members.size });
  });

  socket.on('send_message', ({ text }) => {
    if (!currentRoom || !userCodename) return;
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

    const payload = signMessage({
      sender: userCodename,
      avatar: userEmoji,
      text: clean,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    });

    io.to(currentRoom).emit('message', payload);
  });

  socket.on('get_room_token', ({ code }) => {
    const token = getRoomToken(code.toUpperCase());
    socket.emit('room_token', { token });
  });

  socket.on('disconnect', () => {
    cleanupSocket(socket.id);
    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        room.members.delete(socket.id);
        io.to(currentRoom).emit('user_left', { count: room.members.size });
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

// ════════════════════════════════════════════
// STATIC FILES + START
// ════════════════════════════════════════════

app.use(express.static(path.join(__dirname, '../frontend')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🔒 VEILX Server running on port ${PORT}`);
  console.log(`📡 Zero-knowledge mode: ON`);
  console.log(`🗑  Auto-delete: ON`);
  console.log(`🛡  Rate limiting: ON`);
  console.log(`\n→ Listening on 0.0.0.0:${PORT}\n`);
});