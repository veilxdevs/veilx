const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
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
  contentSecurityPolicy: false,
  hidePoweredBy: true,
  frameguard: { action: 'deny' },
  referrerPolicy: { policy: 'no-referrer' }
}));

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
// ════════════════════════════════════════════
// VEILX Phase 5 Step 4 — Anonymous Leaderboard
// All scores anonymous — codenames only
// ════════════════════════════════════════════

const leaderboardStore = new Map();
// Structure: sessionKey -> {
//   codename, emoji,
//   helpScore,     // upvotes received on problems
//   studySessions, // pomodoro sessions
//   reactionScore, // reactions received on confessions
//   pollVotes,     // polls created + voted
//   streak,        // days active
//   lastSeen, createdAt
// }

// ── Submit score update ──────────────────────
app.post('/api/leaderboard/update', (req, res) => {
  const { sessionKey, codename, emoji, category, delta } = req.body;

  if (!sessionKey || typeof sessionKey !== 'string') {
    return res.status(400).json({ error: 'Session key required' });
  }

  const key = sessionKey.substring(0, 32);
  const categories = ['helpScore','studySessions','reactionScore','pollVotes','streak'];

  if (!categories.includes(category)) {
    return res.status(400).json({ error: 'Invalid category' });
  }

  if (!leaderboardStore.has(key)) {
    leaderboardStore.set(key, {
      codename: sanitize(codename || 'Anonymous', 30),
      emoji: (emoji || '👤').substring(0, 4),
      helpScore: 0,
      studySessions: 0,
      reactionScore: 0,
      pollVotes: 0,
      streak: 0,
      lastSeen: Date.now(),
      createdAt: Date.now()
    });
  }

  const entry = leaderboardStore.get(key);
  entry.codename = sanitize(codename || entry.codename, 30);
  entry.emoji = (emoji || entry.emoji).substring(0, 4);
  entry[category] = Math.max(0, (entry[category] || 0) + (Number(delta) || 1));
  entry.lastSeen = Date.now();

  res.json({ success: true, score: entry[category] });
});

// ── Get leaderboard ──────────────────────────
app.get('/api/leaderboard', (req, res) => {
  const { category } = req.query;
  const now = Date.now();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;

  const entries = [];

  for (const [key, entry] of leaderboardStore.entries()) {
    // Remove entries not seen in 30 days
    if (now - entry.lastSeen > thirtyDays) {
      leaderboardStore.delete(key);
      continue;
    }

    // Calculate total score
    const totalScore = entry.helpScore * 3 +
                       entry.studySessions * 2 +
                       entry.reactionScore * 2 +
                       entry.pollVotes +
                       entry.streak * 5;

    entries.push({
      codename: entry.codename,
      emoji: entry.emoji,
      helpScore: entry.helpScore,
      studySessions: entry.studySessions,
      reactionScore: entry.reactionScore,
      pollVotes: entry.pollVotes,
      streak: entry.streak,
      totalScore
    });
  }

  // Sort by requested category or total
  if (category === 'helpers') {
    entries.sort((a, b) => b.helpScore - a.helpScore);
  } else if (category === 'studiers') {
    entries.sort((a, b) => b.studySessions - a.studySessions);
  } else if (category === 'confessors') {
    entries.sort((a, b) => b.reactionScore - a.reactionScore);
  } else {
    entries.sort((a, b) => b.totalScore - a.totalScore);
  }

  res.json({ entries: entries.slice(0, 20) });
});

// ── Cleanup inactive entries ─────────────────
setInterval(() => {
  const now = Date.now();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  for (const [key, entry] of leaderboardStore.entries()) {
    if (now - entry.lastSeen > thirtyDays) leaderboardStore.delete(key);
  }
}, 24 * 60 * 60 * 1000);
// ════════════════════════════════════════════
// VEILX Phase 5 Step 3 — Anonymous Polls
// Polls expire after 48 hours
// One vote per session per poll
// ════════════════════════════════════════════

const pollStore = new Map();
// Structure: id -> {
//   id, question, options: [{text, votes}],
//   createdAt, expiresAt, totalVotes
// }

// ── Create a poll ────────────────────────────
app.post('/api/polls/create', (req, res) => {
  const { question, options } = req.body;

  if (!question || typeof question !== 'string' || question.trim().length < 5) {
    return res.status(400).json({ error: 'Question too short' });
  }
  if (!Array.isArray(options) || options.length < 2 || options.length > 4) {
    return res.status(400).json({ error: 'Need 2–4 options' });
  }

  const id = Date.now().toString();
  const cleanOptions = options
    .map(o => ({ text: sanitize(String(o).trim(), 80), votes: 0 }))
    .filter(o => o.text.length > 0);

  if (cleanOptions.length < 2) {
    return res.status(400).json({ error: 'Need at least 2 valid options' });
  }

  pollStore.set(id, {
    id,
    question: sanitize(question.trim(), 200),
    options: cleanOptions,
    createdAt: Date.now(),
    expiresAt: Date.now() + (48 * 60 * 60 * 1000), // 48 hours
    totalVotes: 0
  });

  res.json({ success: true, id });
});

// ── Get all active polls ─────────────────────
app.get('/api/polls', (req, res) => {
  const now = Date.now();
  const list = [];

  for (const [id, poll] of pollStore.entries()) {
    if (now > poll.expiresAt) {
      pollStore.delete(id);
      continue;
    }
    list.push({ ...poll });
  }

  list.sort((a, b) => b.createdAt - a.createdAt);
  res.json({ polls: list.slice(0, 20) });
});

// ── Vote on a poll ───────────────────────────
app.post('/api/polls/:id/vote', (req, res) => {
  const poll = pollStore.get(req.params.id);
  if (!poll) return res.status(404).json({ error: 'Poll not found or expired' });

  if (Date.now() > poll.expiresAt) {
    pollStore.delete(req.params.id);
    return res.status(410).json({ error: 'Poll has expired' });
  }

  const { optionIndex } = req.body;
  if (typeof optionIndex !== 'number' || optionIndex < 0 || optionIndex >= poll.options.length) {
    return res.status(400).json({ error: 'Invalid option' });
  }

  poll.options[optionIndex].votes++;
  poll.totalVotes++;

  res.json({ success: true, options: poll.options, totalVotes: poll.totalVotes });
});

// ── Auto cleanup expired polls ───────────────
setInterval(() => {
  const now = Date.now();
  for (const [id, poll] of pollStore.entries()) {
    if (now > poll.expiresAt) pollStore.delete(id);
  }
}, 60 * 60 * 1000);
// ════════════════════════════════════════════
// VEILX Phase 5 Step 2 — VEILX Feed
// ════════════════════════════════════════════

app.get('/api/feed', (req, res) => {
  const { tab } = req.query;
  const now = Date.now();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  const items = [];

  // Pull problems
  for (const [id, p] of problemStore.entries()) {
    if (now - p.createdAt > sevenDays) continue;
    const ageMinutes = (now - p.createdAt) / 60000;
    items.push({
      id: 'prob_' + id, type: 'problem',
      title: p.text.substring(0, 80) + (p.text.length > 80 ? '...' : ''),
      body: p.text, category: p.cat,
      votes: p.votes || 0, replies: p.replies || 0,
      createdAt: p.createdAt,
      score: calculateTrendScore(p.votes || 0, p.replies || 0, ageMinutes)
    });
  }

  // Pull confessions
  for (const [id, c] of confessionsStore.entries()) {
    if (now - c.createdAt > sevenDays) continue;
    const total = Object.values(c.reactions || {}).reduce((a, b) => a + b, 0);
    const ageMinutes = (now - c.createdAt) / 60000;
    items.push({
      id: 'conf_' + id, confId: id, type: 'confession',
      title: '"' + c.text.substring(0, 60) + (c.text.length > 60 ? '..."' : '"'),
      body: c.text, category: c.category,
      reactions: c.reactions, totalReactions: total,
      createdAt: c.createdAt,
      score: calculateTrendScore(total, 0, ageMinutes)
    });
  }

  // Pull active public rooms
  for (const [code, room] of publicRooms.entries()) {
    if (now - room.lastActivity > 2 * 60 * 60 * 1000) continue;
    const mainRoom = rooms.get(code);
    const memberCount = mainRoom ? mainRoom.members.size : 0;
    items.push({
      id: 'room_' + code, code, type: 'room',
      title: room.name,
      body: room.description || 'Join the conversation',
      category: room.type, members: memberCount,
      createdAt: room.createdAt, lastActivity: room.lastActivity,
      score: memberCount * 10 + (now - room.lastActivity < 300000 ? 50 : 0)
    });
  }

  if (tab === 'new') {
    items.sort((a, b) => b.createdAt - a.createdAt);
  } else if (tab === 'community') {
    const community = items.filter(i => i.type !== 'room');
    community.sort((a, b) => (b.votes || b.totalReactions || 0) - (a.votes || a.totalReactions || 0));
    return res.json({ items: community.slice(0, 30) });
  } else {
    items.sort((a, b) => b.score - a.score);
  }

  res.json({ items: items.slice(0, 30) });
});
// ════════════════════════════════════════════
// VEILX Phase 5 Step 1 — Public Room Browser
// ════════════════════════════════════════════

const publicRooms = new Map();
// Structure: code -> {
//   code, name, type, description,
//   members: number, maxMembers: 20,
//   createdAt, lastActivity, tags: []
// }

// ── Create a public room ─────────────────────
app.post('/api/public-rooms/create', (req, res) => {
  const { name, type, description, tags } = req.body;

  if (!name || typeof name !== 'string' || name.trim().length < 3) {
    return res.status(400).json({ error: 'Room name must be at least 3 characters' });
  }

  const code = crypto.randomBytes(3).toString('hex').toUpperCase();

  const cleanTags = Array.isArray(tags)
    ? tags.slice(0, 5).map(t => sanitize(String(t), 20))
    : [];

  publicRooms.set(code, {
    code,
    name: sanitize(name.trim(), 50),
    type: sanitize(type || 'General', 30),
    description: sanitize(description || '', 120),
    members: 0,
    maxMembers: 20,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    tags: cleanTags,
    active: true
  });

  // Also register in main rooms map
  rooms.set(code, createRoomRecord(code, type || 'General'));

  res.json({ success: true, code, name: publicRooms.get(code).name });
});

// ── Get all public rooms ─────────────────────
app.get('/api/public-rooms', (req, res) => {
  const { type, sort } = req.query;
  const now = Date.now();
  const twoHours = 2 * 60 * 60 * 1000;

  const list = [];

  for (const [code, room] of publicRooms.entries()) {
    // Remove stale rooms (no activity in 2 hours)
    if (now - room.lastActivity > twoHours) {
      publicRooms.delete(code);
      continue;
    }

    // Sync member count from main rooms map
    const mainRoom = rooms.get(code);
    if (mainRoom) room.members = mainRoom.members.size;

    // Filter by type if specified
    if (type && type !== 'All' && room.type !== type) continue;

    list.push({ ...room, members: room.members });
  }

  // Sort
  if (sort === 'active') {
    list.sort((a, b) => b.lastActivity - a.lastActivity);
  } else if (sort === 'popular') {
    list.sort((a, b) => b.members - a.members);
  } else {
    // Default: newest first
    list.sort((a, b) => b.createdAt - a.createdAt);
  }

  res.json({ rooms: list });
});

// ── Update room activity (called when message sent) ──
app.post('/api/public-rooms/:code/ping', (req, res) => {
  const room = publicRooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Not found' });
  room.lastActivity = Date.now();
  res.json({ success: true });
});

// ── Delete a public room ─────────────────────
app.delete('/api/public-rooms/:code', (req, res) => {
  publicRooms.delete(req.params.code.toUpperCase());
  res.json({ success: true });
});

// ── Auto-cleanup stale public rooms ──────────
setInterval(() => {
  const now = Date.now();
  const twoHours = 2 * 60 * 60 * 1000;
  for (const [code, room] of publicRooms.entries()) {
    if (now - room.lastActivity > twoHours) {
      publicRooms.delete(code);
    }
  }
}, 30 * 60 * 1000);
// ════════════════════════════════════════════
// VEILX Phase 4 Step 3 — Study Groups
// Pomodoro timer + shared notes per room
// ════════════════════════════════════════════

const studyRooms = new Map();
// Structure: code -> {
//   code, subject, members: Set,
//   notes: string, timer: {mode, timeLeft, running},
//   sessions: number, createdAt
// }

// ── Create study room ────────────────────────
app.post('/api/study/create', (req, res) => {
  const { subject } = req.body;
  const code = Math.random().toString(36).substring(2, 8).toUpperCase();

  studyRooms.set(code, {
    code,
    subject: sanitize(subject || 'General Study', 50),
    members: new Set(),
    notes: '',
    timer: { mode: 'focus', timeLeft: 25 * 60, running: false },
    sessions: 0,
    createdAt: Date.now()
  });

  res.json({ code, subject: studyRooms.get(code).subject });
});

// ── Get study room info ──────────────────────
app.get('/api/study/:code', (req, res) => {
  const room = studyRooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Study room not found' });

  res.json({
    code: room.code,
    subject: room.subject,
    members: room.members.size,
    notes: room.notes,
    timer: room.timer,
    sessions: room.sessions
  });
});

// ── Update shared notes ──────────────────────
app.post('/api/study/:code/notes', (req, res) => {
  const room = studyRooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Not found' });

  const { notes } = req.body;
  if (typeof notes !== 'string') return res.status(400).json({ error: 'Invalid notes' });

  room.notes = notes.substring(0, 5000);
  io.to('study_' + room.code).emit('study_notes_updated', { notes: room.notes });
  res.json({ success: true });
});

// ── Timer control ────────────────────────────
app.post('/api/study/:code/timer', (req, res) => {
  const room = studyRooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Not found' });

  const { action } = req.body;

  if (action === 'start') {
    room.timer.running = true;
  } else if (action === 'pause') {
    room.timer.running = false;
  } else if (action === 'reset') {
    room.timer.running = false;
    room.timer.timeLeft = room.timer.mode === 'focus' ? 25 * 60 : 5 * 60;
  } else if (action === 'switch') {
    room.timer.running = false;
    if (room.timer.mode === 'focus') {
      room.timer.mode = 'break';
      room.timer.timeLeft = 5 * 60;
      room.sessions++;
    } else {
      room.timer.mode = 'focus';
      room.timer.timeLeft = 25 * 60;
    }
  }

  io.to('study_' + room.code).emit('study_timer_update', { timer: room.timer, sessions: room.sessions });
  res.json({ timer: room.timer, sessions: room.sessions });
});

io.on('connection', (socket) => {
  let currentRoom = null;
  let userCodename = null;
  let userEmoji = null;

  // study_join
  socket.on('study_join', ({ code, codename }) => {
    const room = studyRooms.get((code || '').toUpperCase());
    if (!room) { socket.emit('study_error', { message: 'Study room not found' }); return; }
    socket.join('study_' + room.code);
    room.members.add(socket.id);
    io.to('study_' + room.code).emit('study_member_update', { members: room.members.size });
    socket.emit('study_joined', {
      code: room.code, subject: room.subject,
      notes: room.notes, timer: room.timer,
      sessions: room.sessions, members: room.members.size
    });
  });

  // study_leave
  socket.on('study_leave', ({ code }) => {
    const room = studyRooms.get((code || '').toUpperCase());
    if (room) {
      room.members.delete(socket.id);
      socket.leave('study_' + room.code);
      io.to('study_' + room.code).emit('study_member_update', { members: room.members.size });
    }
  });

  socket.on('join_room', ({ code, codename, emoji }) => {
    // ... existing join_room code ...
  });

  // ... rest of handlers ...

  socket.on('get_room_token', ({ code }) => {
    const token = getRoomToken(code.toUpperCase());
    socket.emit('room_token', { token });
  });

  // ... voice handlers ...

  socket.on('disconnect', () => {
    // ... disconnect code ...
  });

}); // ← one closing }); for io.on
// Auto-cleanup study rooms after 4 hours
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of studyRooms.entries()) {
    if (now - room.createdAt > 4 * 60 * 60 * 1000) {
      studyRooms.delete(code);
    }
  }
}, 60 * 60 * 1000);
// ════════════════════════════════════════════
// VEILX Phase 4 Step 2 — Confessions Board
// Anonymous confessions with emoji reactions
// Auto-delete after 7 days
// ════════════════════════════════════════════

// In-memory confessions store
const confessionsStore = new Map();
// Structure: id -> { text, reactions, createdAt, category }

const CONFESSION_REACTIONS = ['❤️','😂','😢','😮','🔥','💙','👏','🤝'];

// ── POST a confession ────────────────────────
app.post('/api/confessions', (req, res) => {
  const { text, category } = req.body;

  if (!text || typeof text !== 'string' || text.trim().length < 5) {
    return res.status(400).json({ error: 'Confession too short' });
  }

  if (text.length > 300) {
    return res.status(400).json({ error: 'Max 300 characters' });
  }

  const id = Date.now().toString();
  const clean = text.substring(0, 300).replace(/[<>]/g, '').trim();

  // Initialize reactions to 0
  const reactions = {};
  CONFESSION_REACTIONS.forEach(emoji => { reactions[emoji] = 0; });

  confessionsStore.set(id, {
    id,
    text: clean,
    category: (category || 'General').substring(0, 30),
    reactions,
    createdAt: Date.now(),
    views: 0
  });

  res.json({ success: true, id });
});

// ── GET confessions (latest or trending) ────
app.get('/api/confessions', (req, res) => {
  const sort = req.query.sort || 'latest';
  const now = Date.now();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;

  const list = [];

  for (const [id, c] of confessionsStore.entries()) {
    // Auto-expire after 7 days
    if (now - c.createdAt > sevenDays) {
      confessionsStore.delete(id);
      continue;
    }
    const totalReactions = Object.values(c.reactions).reduce((a, b) => a + b, 0);
    list.push({ ...c, totalReactions });
  }

  // Sort by latest or trending
  if (sort === 'trending') {
    list.sort((a, b) => b.totalReactions - a.totalReactions);
  } else {
    list.sort((a, b) => b.createdAt - a.createdAt);
  }

  res.json({ confessions: list.slice(0, 30) });
});

// ── React to a confession ────────────────────
app.post('/api/confessions/:id/react', (req, res) => {
  const confession = confessionsStore.get(req.params.id);
  if (!confession) return res.status(404).json({ error: 'Not found' });

  const { emoji } = req.body;
  if (!CONFESSION_REACTIONS.includes(emoji)) {
    return res.status(400).json({ error: 'Invalid reaction' });
  }

  confession.reactions[emoji] = (confession.reactions[emoji] || 0) + 1;
  res.json({ reactions: confession.reactions });
});

// ── Auto-cleanup every 24 hours ──────────────
setInterval(() => {
  const now = Date.now();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  for (const [id, c] of confessionsStore.entries()) {
    if (now - c.createdAt > sevenDays) {
      confessionsStore.delete(id);
    }
  }
}, 24 * 60 * 60 * 1000);
// ════════════════════════════════════════════
// VEILX Phase 4 Step 1 — AI Chatbot
// Personal anonymous AI assistant
// ════════════════════════════════════════════

// Rate limit chatbot — max 20 messages per hour per session
const chatbotRateLimit = new Map();

app.post('/api/chatbot', async (req, res) => {
  const { message, history, sessionId } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Message required' });
  }

  // Rate limiting per session
  const sessionKey = sessionId
    ? sessionId.substring(0, 32)
    : crypto.createHash('sha256')
        .update(req.ip || 'unknown')
        .digest('hex')
        .substring(0, 16);

  const now = Date.now();
  const limit = chatbotRateLimit.get(sessionKey) || { count: 0, reset: now + 3600000 };

  if (now > limit.reset) {
    limit.count = 0;
    limit.reset = now + 3600000;
  }

  if (limit.count >= 20) {
    return res.status(429).json({
      error: 'Chatbot limit reached. Try again in an hour.',
      resetIn: Math.ceil((limit.reset - now) / 60000) + ' minutes'
    });
  }

  limit.count++;
  chatbotRateLimit.set(sessionKey, limit);

  // Build conversation history
  const cleanHistory = Array.isArray(history)
    ? history.slice(-10).map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content).substring(0, 500)
      }))
    : [];

  const cleanMessage = message.substring(0, 500).replace(/[<>]/g, '');

  // If no API key use smart fallback
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.json({
      response: getSmartFallback(cleanMessage),
      remaining: 20 - limit.count
    });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: `You are VEX — VEILX's anonymous AI assistant. You are helpful, direct, and respectful of privacy.

Rules:
- Never ask for personal information
- Keep responses concise — under 150 words
- You can help with: advice, coding, writing, math, general questions
- If asked about sensitive topics, be compassionate but suggest professional help
- You don't know who the user is and that's perfect
- Occasionally remind users they are anonymous and safe here
- Be warm but not overly enthusiastic
- Speak naturally, not robotically`,
        messages: [
          ...cleanHistory,
          { role: 'user', content: cleanMessage }
        ]
      })
    });

    if (!response.ok) {
      return res.json({
        response: getSmartFallback(cleanMessage),
        remaining: 20 - limit.count
      });
    }

    const data = await response.json();
    const reply = data.content?.[0]?.text || getSmartFallback(cleanMessage);

    res.json({
      response: reply,
      remaining: 20 - limit.count
    });

  } catch (err) {
    res.json({
      response: getSmartFallback(cleanMessage),
      remaining: 20 - limit.count
    });
  }
});

// Smart fallback responses when API key not set
function getSmartFallback(message) {
  const msg = message.toLowerCase();

  if (msg.includes('hello') || msg.includes('hi') || msg.includes('hey')) {
    return "Hey! I'm VEX, your anonymous AI assistant. What can I help you with today? You're completely safe here — no identity, no tracking.";
  }
  if (msg.includes('code') || msg.includes('programming') || msg.includes('javascript') || msg.includes('python')) {
    return "Happy to help with code! Share what you're working on and I'll do my best to help debug, explain, or build it with you.";
  }
  if (msg.includes('sad') || msg.includes('depressed') || msg.includes('anxious') || msg.includes('stress')) {
    return "I hear you. Whatever you're going through, you're not alone. Take a breath. Would you like to talk about it, or would some practical coping tips help right now?";
  }
  if (msg.includes('help') || msg.includes('how')) {
    return "I'm here to help! I can assist with advice, coding questions, writing, math, or just someone to talk to. What do you need?";
  }
  if (msg.includes('who are you') || msg.includes('what are you')) {
    return "I'm VEX — VEILX's built-in AI assistant. I'm here to help you anonymously. I don't know who you are, and that's exactly how it should be. What can I do for you?";
  }
  if (msg.includes('thank')) {
    return "Glad I could help! Remember, you can always come back and ask me anything. Stay safe out there. 🔒";
  }
  if (msg.includes('advice') || msg.includes('should i')) {
    return "Good question. Let me think about this with you. Can you give me a bit more context about the situation? I want to give you genuinely useful advice, not a generic answer.";
  }

  return "That's an interesting one. I want to give you a proper answer — could you share a bit more detail? I'm here and not going anywhere. 🤖";
}

// Cleanup rate limits hourly
setInterval(() => {
  const now = Date.now();
  for (const [key, limit] of chatbotRateLimit.entries()) {
    if (now > limit.reset) chatbotRateLimit.delete(key);
  }
}, 60 * 60 * 1000);
// ════════════════════════════════════════════
// VEILX Phase 3 Step 5 — Monetization Layer
// ════════════════════════════════════════════

// ── Premium Plans ────────────────────────────
const PLANS = {
  free: {
    name: 'Free',
    price: 0,
    roomLifetime: 60,        // 1 hour in minutes
    maxFileSize: 10,         // MB
    fileExpiry: 24,          // hours
    maxDownloads: 10,
    voiceRooms: true,
    codespace: 'basic',
    badge: null
  },
  plus: {
    name: 'VEILX Plus',
    price: 99,               // ₹99/month
    roomLifetime: 7 * 24 * 60, // 7 days
    maxFileSize: 50,
    fileExpiry: 7 * 24,      // 7 days
    maxDownloads: 100,
    voiceRooms: true,
    codespace: 'pro',
    badge: '⚡'
  },
  pro: {
    name: 'VEILX Pro',
    price: 299,              // ₹299/month
    roomLifetime: 30 * 24 * 60, // 30 days
    maxFileSize: 100,
    fileExpiry: 30 * 24,     // 30 days
    maxDownloads: 1000,
    voiceRooms: true,
    codespace: 'pro',
    badge: '👑'
  }
};

// In-memory premium sessions
// In production replace with a real database
const premiumSessions = new Map();
// Structure: sessionToken -> { plan, expiresAt, createdAt }

// ── Get Plans ────────────────────────────────
app.get('/api/plans', (req, res) => {
  res.json({
    plans: Object.entries(PLANS).map(([key, plan]) => ({
      id: key,
      ...plan
    }))
  });
});

// ── Check Premium Status ─────────────────────
app.get('/api/premium/status', (req, res) => {
  const token = req.headers['x-veilx-token'];
  if (!token) return res.json({ plan: 'free', active: false });

  const session = premiumSessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    premiumSessions.delete(token);
    return res.json({ plan: 'free', active: false });
  }

  res.json({
    plan: session.plan,
    active: true,
    expiresAt: session.expiresAt,
    features: PLANS[session.plan]
  });
});

// ── Create Premium Session (after payment) ───
// In production connect to Razorpay/Stripe webhook
app.post('/api/premium/activate', (req, res) => {
  const { plan, paymentId } = req.body;

  if (!PLANS[plan] || plan === 'free') {
    return res.status(400).json({ error: 'Invalid plan' });
  }

  if (!paymentId) {
    return res.status(400).json({ error: 'Payment ID required' });
  }

  // Generate anonymous session token
  const token = crypto.randomBytes(32).toString('hex');

  // Set expiry — 30 days
  const expiresAt = Date.now() + (30 * 24 * 60 * 60 * 1000);

  premiumSessions.set(token, {
    plan,
    paymentId: paymentId.substring(0, 50),
    expiresAt,
    createdAt: Date.now()
  });

  res.json({
    success: true,
    token,
    plan,
    expiresAt,
    message: 'Premium activated! Save your token safely.'
  });
});

// ── Razorpay Order Creation ──────────────────
// Uncomment and add your Razorpay key when ready
/*
const Razorpay = require('razorpay');
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

app.post('/api/payment/create-order', async (req, res) => {
  const { plan } = req.body;
  if (!PLANS[plan] || plan === 'free') {
    return res.status(400).json({ error: 'Invalid plan' });
  }

  try {
    const order = await razorpay.orders.create({
      amount: PLANS[plan].price * 100, // paise
      currency: 'INR',
      receipt: 'veilx_' + Date.now()
    });
    res.json({ orderId: order.id, amount: order.amount });
  } catch(err) {
    res.status(500).json({ error: 'Payment creation failed' });
  }
});
*/

// ── Clean expired sessions daily ─────────────
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of premiumSessions.entries()) {
    if (session.expiresAt < now) {
      premiumSessions.delete(token);
    }
  }
}, 24 * 60 * 60 * 1000);

// ════════════════════════════════════════════
// VEILX Phase 3 Step 2 — Temporary File Sharing
// Files auto-delete after 24 hours
// Max file size: 10MB
// No identity stored with files
// ════════════════════════════════════════════

// In-memory file store — no disk writes
const fileStore = new Map();
// Structure: fileId -> { name, type, size, data, createdAt, downloads }

// Multer — store files in memory only
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max
    files: 1
  },
  fileFilter: (req, file, cb) => {
    // Block dangerous file types
    const blocked = [
      'application/x-executable',
      'application/x-msdownload',
      'application/x-sh',
      'application/x-bat'
    ];
    const blockedExt = ['.exe','.bat','.sh','.cmd','.msi','.dll','.com'];
    const ext = '.' + file.originalname.split('.').pop().toLowerCase();

    if (blocked.includes(file.mimetype) || blockedExt.includes(ext)) {
      return cb(new Error('File type not allowed'));
    }
    cb(null, true);
  }
});

// ── Upload a file ────────────────────────────
app.post('/api/files/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const fileId = uuidv4().substring(0, 8).toUpperCase();

  fileStore.set(fileId, {
    name: req.file.originalname.substring(0, 100),
    type: req.file.mimetype,
    size: req.file.size,
    data: req.file.buffer,
    createdAt: Date.now(),
    downloads: 0,
    maxDownloads: 10 // Max 10 downloads per file
  });

  res.json({
    success: true,
    fileId,
    name: req.file.originalname,
    size: req.file.size,
    expiresIn: '24 hours',
    maxDownloads: 10
  });
});

// ── Download a file ──────────────────────────
app.get('/api/files/:fileId', (req, res) => {
  const fileId = req.params.fileId.toUpperCase();
  const file = fileStore.get(fileId);

  if (!file) {
    return res.status(404).json({ error: 'File not found or expired' });
  }

  // Check download limit
  if (file.downloads >= file.maxDownloads) {
    fileStore.delete(fileId);
    return res.status(410).json({ error: 'File download limit reached' });
  }

  file.downloads++;

  // Set headers for download
  res.setHeader('Content-Disposition', 'attachment; filename="' + file.name + '"');
  res.setHeader('Content-Type', file.type);
  res.setHeader('Content-Length', file.size);
  res.send(file.data);
});

// ── Get file info (no download) ──────────────
app.get('/api/files/:fileId/info', (req, res) => {
  const fileId = req.params.fileId.toUpperCase();
  const file = fileStore.get(fileId);

  if (!file) {
    return res.status(404).json({ error: 'File not found or expired' });
  }

  // Return info without the actual data
  res.json({
    name: file.name,
    type: file.type,
    size: file.size,
    downloads: file.downloads,
    maxDownloads: file.maxDownloads,
    expiresIn: Math.max(0, Math.floor((file.createdAt + 24*60*60*1000 - Date.now()) / 60000)) + ' minutes'
  });
});

// ── Auto-delete files after 24 hours ─────────
setInterval(() => {
  const now = Date.now();
  const twentyFourHours = 24 * 60 * 60 * 1000;
  let deleted = 0;

  for (const [id, file] of fileStore.entries()) {
    if (now - file.createdAt > twentyFourHours) {
      fileStore.delete(id);
      deleted++;
    }
  }

  if (deleted > 0) {
    console.log('[VEILX] Auto-deleted ' + deleted + ' expired files');
  }
}, 60 * 60 * 1000); // Check every hour

// Handle multer errors
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'File too large. Max 10MB.' });
  }
  if (err.message === 'File type not allowed') {
    return res.status(400).json({ error: 'File type not allowed.' });
  }
  next(err);
});
// ════════════════════════════════════════════
// VEILX Phase 3 Step 1 — Voice Room Signaling
// WebRTC signaling — server never hears audio
// ════════════════════════════════════════════

// Active voice rooms — in memory only
const voiceRooms = new Map();
// Structure: roomCode -> { peers: Set of socketIds, created }

// Join a voice room
app.post('/api/voice/join', (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Room code required' });

  const roomCode = code.toUpperCase().substring(0, 6);

  if (!voiceRooms.has(roomCode)) {
    voiceRooms.set(roomCode, {
      peers: new Set(),
      created: Date.now()
    });
  }

  const room = voiceRooms.get(roomCode);

  // Max 10 people per voice room
  if (room.peers.size >= 10) {
    return res.status(400).json({ error: 'Voice room is full (max 10)' });
  }

  res.json({
    success: true,
    peerCount: room.peers.size
  });
});

// Get peers in a voice room
app.get('/api/voice/:code/peers', (req, res) => {
  const code = req.params.code.toUpperCase();
  const room = voiceRooms.get(code);
  if (!room) return res.json({ peers: 0 });
  res.json({ peers: room.peers.size });
});

// Auto-cleanup empty voice rooms after 2 hours
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of voiceRooms.entries()) {
    if (now - room.created > 2 * 60 * 60 * 1000) {
      voiceRooms.delete(code);
    }
  }
}, 30 * 60 * 1000);
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
// VEILX Phase 3 Step 3 — Word Duel Game
// Add this block BEFORE get_room_token socket
// ════════════════════════════════════════════
// ── Word Duel Game Store ─────────────────────
const wordGames = new Map();
// Structure: gameCode -> {
//   players: [{id, codename, score}],
//   currentWord: '',
//   usedWords: Set,
//   status: 'waiting'|'playing'|'finished',
//   currentPlayerIndex: 0,
//   timeLimit: 30,
//   round: 0,
//   maxRounds: 10
// }

const WORD_LIST = [
  'apple','brave','cloud','dance','earth','flame','grace','heart','ivory','jewel',
  'knife','lemon','magic','night','ocean','peace','queen','river','stone','tiger',
  'unity','voice','water','xenon','yacht','zebra','angel','blood','crane','drift',
  'eagle','frost','ghost','honey','image','judge','karma','light','maple','noble',
  'ozone','paint','quest','radar','solar','tower','ultra','vapor','wheat','xenon',
  'young','zenith','amber','blaze','coral','depth','elite','fairy','grove','haste',
  'inner','joker','knack','lunar','mirth','nerve','orbit','prism','quota','realm',
  'spark','thorn','umbra','vivid','windy','xylem','yearn','zonal','arctic','beach',
  'crest','delta','ember','flint','gloom','haven','inlet','jazzy','kinky','lodge',
  'mango','nexus','oasis','plaza','quirk','ridge','swift','trend','under','vault'
];

// Word Duel socket handlers
socket.on('wordduel_create', ({ codename }) => {
  const gameCode = Math.random().toString(36).substring(2,7).toUpperCase();
  wordGames.set(gameCode, {
    players: [{ id: socket.id, codename: sanitize(codename || 'Anonymous', 20), score: 0 }],
    currentWord: '',
    usedWords: new Set(),
    status: 'waiting',
    currentPlayerIndex: 0,
    round: 0,
    maxRounds: 10
  });
  socket.join('wordduel_' + gameCode);
  socket.emit('wordduel_created', { gameCode });
});

socket.on('wordduel_join', ({ gameCode, codename }) => {
  const code = (gameCode || '').toUpperCase();
  const game = wordGames.get(code);

  if (!game) { socket.emit('wordduel_error', { message: 'Game not found' }); return; }
  if (game.players.length >= 4) { socket.emit('wordduel_error', { message: 'Game is full (max 4)' }); return; }
  if (game.status !== 'waiting') { socket.emit('wordduel_error', { message: 'Game already started' }); return; }

  game.players.push({ id: socket.id, codename: sanitize(codename || 'Anonymous', 20), score: 0 });
  socket.join('wordduel_' + code);

  io.to('wordduel_' + code).emit('wordduel_update', {
    players: game.players.map(p => ({ codename: p.codename, score: p.score })),
    status: game.status,
    message: sanitize(codename || 'Anonymous', 20) + ' joined the game!'
  });
});

socket.on('wordduel_start', ({ gameCode }) => {
  const code = (gameCode || '').toUpperCase();
  const game = wordGames.get(code);
  if (!game) return;
  if (game.players.length < 2) { socket.emit('wordduel_error', { message: 'Need at least 2 players' }); return; }
  if (game.players[0].id !== socket.id) { socket.emit('wordduel_error', { message: 'Only host can start' }); return; }

  game.status = 'playing';
  game.round = 1;

  // Pick first word randomly
  const firstWord = WORD_LIST[Math.floor(Math.random() * WORD_LIST.length)];
  game.currentWord = firstWord;
  game.usedWords.add(firstWord);

  io.to('wordduel_' + code).emit('wordduel_started', {
    currentWord: firstWord,
    currentPlayer: game.players[0].codename,
    round: game.round,
    maxRounds: game.maxRounds,
    timeLimit: 30
  });

  // Start turn timer
  startWordDuelTimer(code);
});

socket.on('wordduel_answer', ({ gameCode, word }) => {
  const code = (gameCode || '').toUpperCase();
  const game = wordGames.get(code);
  if (!game || game.status !== 'playing') return;

  const currentPlayer = game.players[game.currentPlayerIndex];
  if (currentPlayer.id !== socket.id) return;

  const cleanWord = sanitize((word || '').toLowerCase().trim(), 30);

  // Validate word
  if (!cleanWord || cleanWord.length < 2) {
    socket.emit('wordduel_error', { message: 'Word too short' });
    return;
  }

  // Must start with last letter of current word
  const lastLetter = game.currentWord[game.currentWord.length - 1];
  if (cleanWord[0] !== lastLetter) {
    socket.emit('wordduel_invalid', {
      message: 'Word must start with "' + lastLetter.toUpperCase() + '"'
    });
    return;
  }

  // Must not be used before
  if (game.usedWords.has(cleanWord)) {
    socket.emit('wordduel_invalid', { message: 'Word already used!' });
    return;
  }

  // Valid word — award points
  currentPlayer.score += cleanWord.length;
  game.usedWords.add(cleanWord);
  game.currentWord = cleanWord;
  game.round++;

  // Move to next player
  game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.players.length;

  // Check if game over
  if (game.round > game.maxRounds * game.players.length) {
    endWordDuelGame(code);
    return;
  }

  const nextPlayer = game.players[game.currentPlayerIndex];

  io.to('wordduel_' + code).emit('wordduel_correct', {
    word: cleanWord,
    player: currentPlayer.codename,
    score: currentPlayer.score,
    players: game.players.map(p => ({ codename: p.codename, score: p.score })),
    currentWord: cleanWord,
    currentPlayer: nextPlayer.codename,
    round: game.round,
    maxRounds: game.maxRounds * game.players.length
  });

  // Reset timer for next player
  startWordDuelTimer(code);
});

function startWordDuelTimer(code) {
  const game = wordGames.get(code);
  if (!game) return;

  // Clear existing timer
  if (game.timer) clearTimeout(game.timer);

  game.timer = setTimeout(() => {
    const g = wordGames.get(code);
    if (!g || g.status !== 'playing') return;

    // Current player lost their turn
    const currentPlayer = g.players[g.currentPlayerIndex];
    g.currentPlayerIndex = (g.currentPlayerIndex + 1) % g.players.length;
    g.round++;

    if (g.round > g.maxRounds * g.players.length) {
      endWordDuelGame(code);
      return;
    }

    io.to('wordduel_' + code).emit('wordduel_timeout', {
      player: currentPlayer.codename,
      currentPlayer: g.players[g.currentPlayerIndex].codename,
      currentWord: g.currentWord,
      round: g.round
    });

    startWordDuelTimer(code);
  }, 30000); // 30 second timer
}

function endWordDuelGame(code) {
  const game = wordGames.get(code);
  if (!game) return;

  if (game.timer) clearTimeout(game.timer);
  game.status = 'finished';

  // Sort players by score
  const sorted = [...game.players].sort((a, b) => b.score - a.score);

  io.to('wordduel_' + code).emit('wordduel_ended', {
    winner: sorted[0].codename,
    players: sorted.map(p => ({ codename: p.codename, score: p.score }))
  });

  // Delete game after 5 minutes
  setTimeout(() => wordGames.delete(code), 5 * 60 * 1000);
}
  socket.on('get_room_token', ({ code }) => {
    io.on('connection', (socket) => {

  // ... voice handlers ...
  // ... wordduel handlers ...

  // ── Study Room Sockets ── ← PASTE HERE (inside connection block)
  socket.on('study_join', ({ code, codename }) => {
    const room = studyRooms.get((code || '').toUpperCase());
    if (!room) { socket.emit('study_error', { message: 'Study room not found' }); return; }
    socket.join('study_' + room.code);
    room.members.add(socket.id);
    io.to('study_' + room.code).emit('study_member_update', { members: room.members.size });
    socket.emit('study_joined', {
      code: room.code, subject: room.subject,
      notes: room.notes, timer: room.timer,
      sessions: room.sessions, members: room.members.size
    });
  });

  socket.on('study_leave', ({ code }) => {
    const room = studyRooms.get((code || '').toUpperCase());
    if (room) {
      room.members.delete(socket.id);
      socket.leave('study_' + room.code);
      io.to('study_' + room.code).emit('study_member_update', { members: room.members.size });
    }
  });

  // ── This was already here ──
  socket.on('get_room_token', ({ code }) => {
    // ...
  });

}); // ← io.on closes here
    const token = getRoomToken(code.toUpperCase());
    socket.emit('room_token', { token });
  });

  // ── Phase 3: WebRTC Voice Signaling ──────────
// Server only passes signals — never touches audio

socket.on('voice_join', ({ code }) => {
  const voiceRoom = 'voice_' + code.toUpperCase();
  socket.join(voiceRoom);

  // Tell existing peers about new user
  socket.to(voiceRoom).emit('voice_peer_joined', {
    peerId: socket.id
  });

  // Tell new user about existing peers
  const room = io.sockets.adapter.rooms.get(voiceRoom);
  const peers = room ? [...room].filter(id => id !== socket.id) : [];
  socket.emit('voice_existing_peers', { peers });
});

socket.on('voice_offer', ({ targetId, offer }) => {
  io.to(targetId).emit('voice_offer', {
    fromId: socket.id,
    offer
  });
});

socket.on('voice_answer', ({ targetId, answer }) => {
  io.to(targetId).emit('voice_answer', {
    fromId: socket.id,
    answer
  });
});

socket.on('voice_ice', ({ targetId, candidate }) => {
  io.to(targetId).emit('voice_ice', {
    fromId: socket.id,
    candidate
  });
});

socket.on('voice_leave', ({ code }) => {
  const voiceRoom = 'voice_' + code.toUpperCase();
  socket.leave(voiceRoom);
  socket.to(voiceRoom).emit('voice_peer_left', {
    peerId: socket.id
  });
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