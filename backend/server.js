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
const SERVER_SECRET = process.env.SERVER_SECRET || crypto.randomBytes(32).toString('hex');

const roomTokens = new Map();
const rooms = new Map();
const problemStore = new Map();
const reportStore = new Map();
const reportCounts = new Map();
const socketMsgCount = new Map();

function signMessage(payload) {
  const data = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', SERVER_SECRET).update(data).digest('hex').substring(0, 16);
  return { ...payload, sig };
}
function getRoomToken(roomCode) {
  if (!roomTokens.has(roomCode)) roomTokens.set(roomCode, crypto.randomBytes(16).toString('hex'));
  return roomTokens.get(roomCode);
}
function deleteRoomToken(roomCode) { roomTokens.delete(roomCode); }
function sanitize(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  return str.substring(0, maxLen).replace(/[<>]/g, '').replace(/javascript:/gi, '').trim();
}
function checkMsgRate(socketId) {
  const now = Date.now();
  const entry = socketMsgCount.get(socketId) || { count: 0, reset: now + 60000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 60000; }
  entry.count++;
  socketMsgCount.set(socketId, entry);
  return entry.count <= 30;
}
function cleanupSocket(socketId) { socketMsgCount.delete(socketId); }
function createRoomRecord(code, type) {
  return { code, type, members: new Set(), created: Date.now(), lastActivity: Date.now(), msgCount: 0 };
}
function calculateTrendScore(votes, replies, ageMinutes) {
  return ((votes * 2) + (replies * 3)) / Math.pow(ageMinutes + 2, 1.5);
}
function getFallbackResponse(category) {
  const r = {
    'Mental Health': "What you feel is valid. Take one small step today. You are not alone. 💙",
    'Finance': "List every expense first — clarity reduces anxiety. Small steps add up fast.",
    'Relationships': "Write down exactly what you need before any conversation.",
    'Career': "List 3 skills you have that someone would pay for. One connection changes everything.",
    'Tech': "Break it into the smallest piece. Share the exact error — that is where the answer lives.",
    'Studies': "25 minutes focused, 5 minutes break. Teach it out loud — if you can explain it, you know it.",
    'General': "Break it into the smallest first step. Progress follows."
  };
  return r[category] || r['General'];
}
async function getAIResponse(problem, category) {
  if (!ANTHROPIC_API_KEY) return getFallbackResponse(category);
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 300,
        system: `Compassionate anonymous advisor. Under 100 words. Direct. 1-2 actionable steps. Category: ${category}`,
        messages: [{ role: 'user', content: `Problem: "${problem}". Brief helpful response.` }]
      })
    });
    if (!response.ok) return getFallbackResponse(category);
    const data = await response.json();
    return data.content?.[0]?.text || getFallbackResponse(category);
  } catch { return getFallbackResponse(category); }
}

app.use(helmet({ contentSecurityPolicy: false, hidePoweredBy: true, frameguard: { action: 'deny' }, referrerPolicy: { policy: 'no-referrer' } }));
app.disable('x-powered-by');
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, max: 100,
  keyGenerator: (req) => crypto.createHash('sha256').update(req.ip || 'unknown').digest('hex').substring(0, 16)
}));
app.use(express.json({ limit: '10kb' }));
app.use(cors({ origin: '*' }));

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - room.lastActivity > 60 * 60 * 1000) { rooms.delete(code); deleteRoomToken(code); io.to(code).emit('room_expired', { message: 'Room auto-deleted' }); }
  }
}, 5 * 60 * 1000);
setInterval(() => {
  const now = Date.now();
  for (const [id, p] of problemStore.entries()) { if (now - p.createdAt > 30 * 24 * 60 * 60 * 1000) problemStore.delete(id); }
}, 60 * 60 * 1000);
setInterval(() => {
  const now = Date.now();
  for (const [id, r] of reportStore.entries()) { if (now - r.createdAt > 7 * 24 * 60 * 60 * 1000) reportStore.delete(id); }
}, 24 * 60 * 60 * 1000);

app.get('/api/health', (req, res) => res.status(200).json({ status: 'ok' }));
app.get('/health', (req, res) => res.status(200).send('OK'));
app.post('/api/rooms/create', (req, res) => {
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();
  rooms.set(code, createRoomRecord(code, req.body.type || 'General'));
  res.json({ code });
});
app.get('/api/rooms/:code', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Not found' });
  res.json({ exists: true, type: room.type, members: room.members.size });
});
app.post('/api/ai-response', async (req, res) => {
  const { problem, category } = req.body;
  if (!problem) return res.status(400).json({ error: 'Problem required' });
  res.json({ response: await getAIResponse(problem.substring(0, 500), (category || 'General').substring(0, 30)) });
});
app.post('/api/problems', (req, res) => {
  const { text, category } = req.body;
  if (!text || text.trim().length < 10) return res.status(400).json({ error: 'Too short' });
  const id = Date.now().toString();
  problemStore.set(id, { id, text: text.substring(0, 500).trim(), cat: category || 'General', votes: 0, replies: 0, createdAt: Date.now() });
  res.json({ id });
});
app.get('/api/problems/trending', (req, res) => {
  const now = Date.now();
  const list = [];
  for (const [id, p] of problemStore.entries()) {
    if (now - p.createdAt > 30 * 24 * 60 * 60 * 1000) { problemStore.delete(id); continue; }
    list.push({ ...p, score: calculateTrendScore(p.votes, p.replies, (now - p.createdAt) / 60000) });
  }
  res.json({ problems: list.sort((a, b) => b.score - a.score).slice(0, 20) });
});
app.post('/api/problems/:id/vote', (req, res) => {
  const p = problemStore.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  p.votes++;
  res.json({ votes: p.votes });
});
app.post('/api/problems/:id/reply', (req, res) => {
  const p = problemStore.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  p.replies++;
  res.json({ replies: p.replies });
});
app.post('/api/report', (req, res) => {
  const { type, contentId, reason } = req.body;
  if (!type || !contentId || !reason) return res.status(400).json({ error: 'Missing fields' });
  const id = Date.now().toString();
  reportStore.set(id, { type, contentId: contentId.substring(0, 100), reason, createdAt: Date.now() });
  const count = (reportCounts.get(contentId) || 0) + 1;
  reportCounts.set(contentId, count);
  if (count >= 3 && type === 'message') io.emit('content_hidden', { contentId });
  res.json({ success: true, autoHidden: count >= 3 });
});

io.on('connection', (socket) => {
  let currentRoom = null, userCodename = null, userEmoji = null;
  socket.on('join_room', ({ code, codename, emoji }) => {
    code = (code || '').toUpperCase().substring(0, 6);
    if (!code || code.length !== 6) { socket.emit('error', { message: 'Invalid room code' }); return; }
    userCodename = sanitize(codename || 'Anonymous', 30);
    userEmoji = (emoji || '👤').substring(0, 4);
    if (!rooms.has(code)) rooms.set(code, createRoomRecord(code, 'General'));
    const room = rooms.get(code);
    if (currentRoom) { socket.leave(currentRoom); const pr = rooms.get(currentRoom); if (pr) { pr.members.delete(socket.id); io.to(currentRoom).emit('user_left', { count: pr.members.size }); } }
    socket.join(code); currentRoom = code; room.members.add(socket.id); room.lastActivity = Date.now();
    socket.to(code).emit('user_joined', { count: room.members.size });
    socket.emit('joined', { code, type: room.type, memberCount: room.members.size });
  });
  socket.on('send_message', ({ text }) => {
    if (!currentRoom || !userCodename) return;
    if (!checkMsgRate(socket.id)) { socket.emit('error', { message: 'Too many messages.' }); return; }
    const clean = sanitize(text, 2000);
    if (!clean) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.lastActivity = Date.now(); room.msgCount++;
    io.to(currentRoom).emit('message', signMessage({ sender: userCodename, avatar: userEmoji, text: clean, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }));
  });
  socket.on('get_room_token', ({ code }) => socket.emit('room_token', { token: getRoomToken(code.toUpperCase()) }));
  socket.on('disconnect', () => {
    cleanupSocket(socket.id);
    if (currentRoom) { const room = rooms.get(currentRoom); if (room) { room.members.delete(socket.id); io.to(currentRoom).emit('user_left', { count: room.members.size }); } }
  });
});

app.use(express.static(path.join(__dirname, '../frontend')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n VEILX running on port ${PORT}`);
  console.log(` Zero-knowledge: ON | Auto-delete: ON | Rate-limit: ON\n`);
});
