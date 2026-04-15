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
// HELPERS
// ════════════════════════════════════════════

const SERVER_SECRET = process.env.SERVER_SECRET || crypto.randomBytes(32).toString('hex');

function signMessage(payload) {
  const data = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', SERVER_SECRET).update(data).digest('hex').substring(0, 16);
  return { ...payload, sig };
}

const roomTokens = new Map();
function getRoomToken(roomCode) {
  if (!roomTokens.has(roomCode)) roomTokens.set(roomCode, crypto.randomBytes(16).toString('hex'));
  return roomTokens.get(roomCode);
}
function deleteRoomToken(roomCode) { roomTokens.delete(roomCode); }

function sanitize(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  return str.substring(0, maxLen).replace(/[<>]/g, '').replace(/javascript:/gi, '').replace(/on\w+=/gi, '').trim();
}

const socketMsgCount = new Map();
function checkMsgRate(socketId) {
  const now = Date.now();
  const entry = socketMsgCount.get(socketId) || { count: 0, reset: now + 60000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 60000; }
  entry.count++;
  socketMsgCount.set(socketId, entry);
  return entry.count <= 30;
}
function cleanupSocket(socketId) { socketMsgCount.delete(socketId); }

// ════════════════════════════════════════════
// AI HELPERS
// ════════════════════════════════════════════

async function getAIResponse(problem, category) {
  if (!ANTHROPIC_API_KEY) return getFallbackResponse(category);
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 300,
        system: `You are a compassionate anonymous advisor on VEILX. Rules: under 100 words, direct, give 1-2 actionable steps, never ask personal details, end with encouragement. Category: ${category}`,
        messages: [{ role: 'user', content: `Anonymous problem: "${problem}". Give brief helpful response.` }]
      })
    });
    if (!response.ok) return getFallbackResponse(category);
    const data = await response.json();
    return data.content?.[0]?.text || getFallbackResponse(category);
  } catch (err) { return getFallbackResponse(category); }
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
  return ((votes * 2) + (replies * 3)) / Math.pow(ageMinutes + 2, 1.5);
}

function getSmartFallback(message) {
  const msg = message.toLowerCase();
  if (msg.includes('hello') || msg.includes('hi') || msg.includes('hey'))
    return "Hey! I'm VEX, your anonymous AI assistant. What can I help you with today? You're completely safe here.";
  if (msg.includes('code') || msg.includes('programming'))
    return "Happy to help with code! Share what you're working on and I'll help debug, explain, or build it.";
  if (msg.includes('sad') || msg.includes('depressed') || msg.includes('anxious') || msg.includes('stress'))
    return "I hear you. Whatever you're going through, you're not alone. Take a breath. Would you like to talk about it?";
  if (msg.includes('thank'))
    return "Glad I could help! Remember, you can always come back and ask me anything. Stay safe out there. 🔒";
  return "That's an interesting one. Could you share a bit more detail? I'm here and not going anywhere. 🤖";
}

// ════════════════════════════════════════════
// SECURITY MIDDLEWARE
// ════════════════════════════════════════════

app.use(helmet({ contentSecurityPolicy: false, hidePoweredBy: true, frameguard: { action: 'deny' }, referrerPolicy: { policy: 'no-referrer' } }));
app.disable('x-powered-by');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 100,
  message: { error: 'Too many requests. Slow down.' },
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => crypto.createHash('sha256').update(req.ip || 'unknown').digest('hex').substring(0, 16)
});

app.use('/api/', limiter);
app.use(express.json({ limit: '10kb' }));
app.use(cors({ origin: '*' }));

// ════════════════════════════════════════════
// DATA STORES
// ════════════════════════════════════════════

const rooms = new Map();
const problemStore = new Map();
const reportStore = new Map();
const reportCounts = new Map();
const confessionsStore = new Map();
const fileStore = new Map();
const voiceRooms = new Map();
const studyRooms = new Map();
const premiumSessions = new Map();
const wordGames = new Map();
const publicRooms = new Map();
const pollStore = new Map();
const leaderboardStore = new Map();
const chatbotRateLimit = new Map();

function createRoomRecord(code, type) {
  return { code, type, members: new Set(), created: Date.now(), lastActivity: Date.now(), msgCount: 0 };
}

const CONFESSION_REACTIONS = ['❤️','😂','😢','😮','🔥','💙','👏','🤝'];
const PLANS = {
  free: { name: 'Free', price: 0, roomLifetime: 60, maxFileSize: 10, fileExpiry: 24, maxDownloads: 10, voiceRooms: true, badge: null },
  plus: { name: 'VEILX Plus', price: 99, roomLifetime: 7*24*60, maxFileSize: 50, fileExpiry: 7*24, maxDownloads: 100, voiceRooms: true, badge: '⚡' },
  pro:  { name: 'VEILX Pro',  price: 299, roomLifetime: 30*24*60, maxFileSize: 100, fileExpiry: 30*24, maxDownloads: 1000, voiceRooms: true, badge: '👑' }
};

const WORD_LIST = [
  'apple','brave','cloud','dance','earth','flame','grace','heart','ivory','jewel',
  'knife','lemon','magic','night','ocean','peace','queen','river','stone','tiger',
  'unity','voice','water','xenon','yacht','zebra','angel','blood','crane','drift',
  'eagle','frost','ghost','honey','image','judge','karma','light','maple','noble',
  'ozone','paint','quest','radar','solar','tower','ultra','vapor','wheat','young',
  'zenith','amber','blaze','coral','depth','elite','fairy','grove','haste','inner',
  'joker','knack','lunar','mirth','nerve','orbit','prism','quota','realm','spark',
  'thorn','umbra','vivid','windy','yearn','arctic','beach','crest','delta','ember',
  'flint','gloom','haven','inlet','jazzy','lodge','mango','nexus','oasis','plaza',
  'quirk','ridge','swift','trend','under','vault'
];

// ════════════════════════════════════════════
// CLEANUP INTERVALS
// ════════════════════════════════════════════

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - room.lastActivity > 60*60*1000) { rooms.delete(code); deleteRoomToken(code); io.to(code).emit('room_expired', { message: 'Room auto-deleted after 1hr' }); }
  }
}, 5*60*1000);

setInterval(() => {
  const now = Date.now();
  for (const [id, p] of problemStore.entries()) { if (now - p.createdAt > 30*24*60*60*1000) problemStore.delete(id); }
}, 60*60*1000);

setInterval(() => {
  const now = Date.now();
  for (const [id, r] of reportStore.entries()) { if (now - r.createdAt > 7*24*60*60*1000) reportStore.delete(id); }
}, 24*60*60*1000);

setInterval(() => {
  const now = Date.now();
  for (const [id, c] of confessionsStore.entries()) { if (now - c.createdAt > 7*24*60*60*1000) confessionsStore.delete(id); }
}, 24*60*60*1000);

setInterval(() => {
  const now = Date.now();
  for (const [id, f] of fileStore.entries()) { if (now - f.createdAt > 24*60*60*1000) fileStore.delete(id); }
}, 60*60*1000);

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of voiceRooms.entries()) { if (now - room.created > 2*60*60*1000) voiceRooms.delete(code); }
}, 30*60*1000);

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of studyRooms.entries()) { if (now - room.createdAt > 4*60*60*1000) studyRooms.delete(code); }
}, 60*60*1000);

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of publicRooms.entries()) { if (now - room.lastActivity > 2*60*60*1000) publicRooms.delete(code); }
}, 30*60*1000);

setInterval(() => {
  const now = Date.now();
  for (const [id, poll] of pollStore.entries()) { if (now > poll.expiresAt) pollStore.delete(id); }
}, 60*60*1000);

setInterval(() => {
  const now = Date.now();
  for (const [token, s] of premiumSessions.entries()) { if (s.expiresAt < now) premiumSessions.delete(token); }
}, 24*60*60*1000);

setInterval(() => {
  const now = Date.now();
  for (const [key, limit] of chatbotRateLimit.entries()) { if (now > limit.reset) chatbotRateLimit.delete(key); }
}, 60*60*1000);

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of leaderboardStore.entries()) { if (now - entry.lastSeen > 30*24*60*60*1000) leaderboardStore.delete(key); }
}, 24*60*60*1000);

// ════════════════════════════════════════════
// MULTER FOR FILE UPLOADS
// ════════════════════════════════════════════

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10*1024*1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const blocked = ['application/x-executable','application/x-msdownload','application/x-sh','application/x-bat'];
    const blockedExt = ['.exe','.bat','.sh','.cmd','.msi','.dll','.com'];
    const ext = '.' + file.originalname.split('.').pop().toLowerCase();
    if (blocked.includes(file.mimetype) || blockedExt.includes(ext)) return cb(new Error('File type not allowed'));
    cb(null, true);
  }
});

// ════════════════════════════════════════════
// API ROUTES
// ════════════════════════════════════════════

app.get('/api/health', (req, res) => res.status(200).json({ status: 'ok' }));
app.get('/health', (req, res) => res.status(200).send('OK'));

// ════════════════════════════════════════════
// VEILX Phase 6 — Admin Panel Routes
// // ════════════════════════════════════════════

const adminSessions = new Map();
const siteStats = {
  totalVisits: 0,
  activeUsers: new Set(),
  peakUsers: 0,
  startTime: Date.now()
};

// Feature flags — admin can toggle these
const featureFlags = {
  premium: true,
  polls: true,
  confessions: true,
  leaderboard: true,
  browseRooms: true,
  feed: true,
  studyGroups: true,
  gamingZone: true,
  chatbot: true,
  fileSharing: true
};

// Coupon store
const couponStore = new Map();
// Structure: code -> { discount, type, plan, expiresAt, uses, maxUses, createdAt }

// Announcements
let siteAnnouncement = null;
let maintenanceMode = false;

// ── Track visits via middleware ───────────────
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/') && !req.path.startsWith('/admin')) {
    siteStats.totalVisits++;
  }
  next();
});

// ── Admin auth middleware ─────────────────────
function requireAdmin(req, res, next) {
  // Check secret key in query
  const secretKey = req.query.key || req.headers['x-admin-key'];
  if (secretKey && secretKey === (process.env.ADMIN_SECRET_KEY || 'veilx_admin_secret_2025')) {
    return next();
  }
  // Check session token
  const sessionToken = req.headers['x-admin-session'] || req.cookies?.adminSession;
  if (sessionToken && adminSessions.has(sessionToken)) {
    const session = adminSessions.get(sessionToken);
    if (session.expiresAt > Date.now()) return next();
    adminSessions.delete(sessionToken);
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

// ── Admin Login ───────────────────────────────
app.post('/api/admin/login', (req, res) => {
  const { username, password, secretKey } = req.body;
  const validUser = process.env.ADMIN_USERNAME || 'veilxadmin';
  const validPass = process.env.ADMIN_PASSWORD || 'veilx@admin2026';
  const validKey  = process.env.ADMIN_SECRET_KEY || 'veilx_admin_secret_2026';

  const keyOk = secretKey === validKey;
  const credOk = username === validUser && password === validPass;

  if (!keyOk || !credOk) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, { createdAt: Date.now(), expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
  res.json({ success: true, token, expiresIn: '24 hours' });
});

// ── Admin Logout ──────────────────────────────
app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const token = req.headers['x-admin-session'];
  if (token) adminSessions.delete(token);
  res.json({ success: true });
});

// ── Dashboard Stats ───────────────────────────
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const activeRooms = rooms.size;
  const totalMembers = [...rooms.values()].reduce((a, r) => a + r.members.size, 0);
  const uptime = Math.floor((Date.now() - siteStats.startTime) / 1000);

  res.json({
    live: {
      activeRooms,
      totalOnlineUsers: totalMembers,
      peakUsers: siteStats.peakUsers,
      totalVisits: siteStats.totalVisits,
      uptime: uptime
    },
    content: {
      totalProblems: problemStore.size,
      totalConfessions: confessionsStore.size,
      totalPolls: pollStore.size,
      totalPublicRooms: publicRooms.size,
      activeStudyRooms: studyRooms.size,
      sharedFiles: fileStore.size
    },
    premium: {
      activeSessions: premiumSessions.size,
      totalCoupons: couponStore.size,
      activeCoupons: [...couponStore.values()].filter(c => c.expiresAt > Date.now()).length
    },
    leaderboard: {
      totalEntries: leaderboardStore.size
    },
    featureFlags,
    maintenanceMode,
    announcement: siteAnnouncement
  });
});

// ── Feature Flags ─────────────────────────────
app.post('/api/admin/features', requireAdmin, (req, res) => {
  const { feature, enabled } = req.body;
  if (!(feature in featureFlags)) return res.status(400).json({ error: 'Unknown feature' });
  featureFlags[feature] = !!enabled;
  // Broadcast to all connected clients
  io.emit('feature_flags_updated', featureFlags);
  res.json({ success: true, feature, enabled: featureFlags[feature] });
});

app.get('/api/admin/features', requireAdmin, (req, res) => {
  res.json({ featureFlags });
});

// ── Public feature flags (frontend reads this) ─
app.get('/api/features', (req, res) => {
  res.json({ featureFlags, maintenanceMode, announcement: siteAnnouncement });
});

// ── Maintenance Mode ──────────────────────────
app.post('/api/admin/maintenance', requireAdmin, (req, res) => {
  const { enabled, message } = req.body;
  maintenanceMode = !!enabled;
  if (enabled) {
    io.emit('maintenance_mode', { enabled: true, message: message || 'VEILX is under maintenance. Back soon!' });
  } else {
    io.emit('maintenance_mode', { enabled: false });
  }
  res.json({ success: true, maintenanceMode });
});

// ── Announcements ─────────────────────────────
app.post('/api/admin/announcement', requireAdmin, (req, res) => {
  const { text, type, duration } = req.body;
  if (!text) { siteAnnouncement = null; io.emit('announcement_cleared'); return res.json({ success: true, cleared: true }); }
  siteAnnouncement = { text: sanitize(text, 200), type: type || 'info', createdAt: Date.now(), duration: duration || 0 };
  io.emit('announcement', siteAnnouncement);
  res.json({ success: true, announcement: siteAnnouncement });
});

// ── Coupon Management ─────────────────────────
app.post('/api/admin/coupons/create', requireAdmin, (req, res) => {
  const { code, discount, plan, maxUses, expiryDays, type } = req.body;
  if (!code || !discount) return res.status(400).json({ error: 'Code and discount required' });
  const cleanCode = sanitize(code.toUpperCase().replace(/\s/g, ''), 20);
  if (couponStore.has(cleanCode)) return res.status(400).json({ error: 'Coupon code already exists' });
  couponStore.set(cleanCode, {
    code: cleanCode,
    discount: Math.min(100, Math.max(1, Number(discount))),
    plan: plan || 'both',
    type: type || 'percent', // percent | flat
    maxUses: maxUses || 100,
    uses: 0,
    expiresAt: Date.now() + ((expiryDays || 30) * 24 * 60 * 60 * 1000),
    createdAt: Date.now()
  });
  res.json({ success: true, coupon: couponStore.get(cleanCode) });
});

app.get('/api/admin/coupons', requireAdmin, (req, res) => {
  const coupons = [...couponStore.values()].map(c => ({
    ...c,
    active: c.expiresAt > Date.now() && c.uses < c.maxUses
  }));
  res.json({ coupons });
});

app.delete('/api/admin/coupons/:code', requireAdmin, (req, res) => {
  couponStore.delete(req.params.code.toUpperCase());
  res.json({ success: true });
});

// ── Public coupon validation (used at checkout) ─
app.post('/api/coupons/validate', (req, res) => {
  const { code, plan } = req.body;
  const coupon = couponStore.get((code || '').toUpperCase().trim());
  if (!coupon) return res.status(404).json({ error: 'Invalid coupon code' });
  if (coupon.expiresAt < Date.now()) return res.status(410).json({ error: 'Coupon expired' });
  if (coupon.uses >= coupon.maxUses) return res.status(410).json({ error: 'Coupon fully used' });
  if (coupon.plan !== 'both' && coupon.plan !== plan) return res.status(400).json({ error: 'Coupon not valid for this plan' });
  res.json({ valid: true, discount: coupon.discount, type: coupon.type, code: coupon.code });
});

// ── Apply coupon on activation ────────────────
app.post('/api/premium/activate', (req, res) => {
  const { plan, paymentId, couponCode } = req.body;
  const prices = { plus: 49, pro: 149 };
  if (!prices[plan]) return res.status(400).json({ error: 'Invalid plan' });
  if (!paymentId) return res.status(400).json({ error: 'Payment ID required' });

  let finalPrice = prices[plan];
  let discountApplied = 0;

  if (couponCode) {
    const coupon = couponStore.get(couponCode.toUpperCase().trim());
    if (coupon && coupon.expiresAt > Date.now() && coupon.uses < coupon.maxUses) {
      if (coupon.type === 'percent') discountApplied = Math.floor(finalPrice * coupon.discount / 100);
      else discountApplied = coupon.discount;
      finalPrice = Math.max(0, finalPrice - discountApplied);
      coupon.uses++;
    }
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + (30 * 24 * 60 * 60 * 1000);
  premiumSessions.set(token, { plan, paymentId: paymentId.substring(0, 50), expiresAt, createdAt: Date.now(), finalPrice, discountApplied });
  res.json({ success: true, token, plan, expiresAt, finalPrice, discountApplied, message: 'Premium activated!' });
});

// ── Content Moderation ────────────────────────
app.delete('/api/admin/content/confessions', requireAdmin, (req, res) => {
  confessionsStore.clear();
  res.json({ success: true, message: 'All confessions cleared' });
});

app.delete('/api/admin/content/problems', requireAdmin, (req, res) => {
  problemStore.clear();
  res.json({ success: true, message: 'All problems cleared' });
});

app.delete('/api/admin/content/polls', requireAdmin, (req, res) => {
  pollStore.clear();
  res.json({ success: true, message: 'All polls cleared' });
});

app.delete('/api/admin/content/rooms', requireAdmin, (req, res) => {
  publicRooms.clear();
  res.json({ success: true, message: 'All public rooms cleared' });
});

// ── Cleanup admin sessions ────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of adminSessions.entries()) {
    if (session.expiresAt < now) adminSessions.delete(token);
  }
}, 60 * 60 * 1000);

// ── Rooms ────────────────────────────────────
app.post('/api/rooms/create', (req, res) => {
  const { type } = req.body;
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();
  if (rooms.has(code)) return res.status(409).json({ error: 'Code collision, retry' });
  rooms.set(code, createRoomRecord(code, type || 'General'));
  res.json({ code });
});

app.get('/api/rooms/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ exists: true, type: room.type, members: room.members.size });
});

// ── AI Response ───────────────────────────────
app.post('/api/ai-response', async (req, res) => {
  const { problem, category } = req.body;
  if (!problem || typeof problem !== 'string') return res.status(400).json({ error: 'Problem text required' });
  try {
    const response = await getAIResponse(problem.substring(0, 500).replace(/[<>]/g, ''), (category || 'General').substring(0, 30));
    res.json({ response });
  } catch (err) { res.status(500).json({ error: 'Could not generate response' }); }
});

// ── Problems ──────────────────────────────────
app.post('/api/problems', async (req, res) => {
  const { text, category } = req.body;
  if (!text || typeof text !== 'string' || text.trim().length < 10) return res.status(400).json({ error: 'Problem too short' });
  const id = Date.now().toString();
  problemStore.set(id, { id, text: text.substring(0, 500).replace(/[<>]/g, '').trim(), cat: (category || 'General').substring(0, 30), votes: 0, replies: 0, createdAt: Date.now(), score: 0 });
  res.json({ id });
});

app.get('/api/problems/trending', (req, res) => {
  const now = Date.now();
  const trending = [];
  for (const [id, p] of problemStore.entries()) {
    if (now - p.createdAt > 30*24*60*60*1000) { problemStore.delete(id); continue; }
    const ageMinutes = (now - p.createdAt) / 60000;
    trending.push({ ...p, score: calculateTrendScore(p.votes, p.replies, ageMinutes) });
  }
  trending.sort((a, b) => b.score - a.score);
  res.json({ problems: trending.slice(0, 20) });
});

app.post('/api/problems/:id/vote', (req, res) => {
  const p = problemStore.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  p.votes = Math.max(0, p.votes + 1);
  res.json({ votes: p.votes });
});

app.post('/api/problems/:id/reply', (req, res) => {
  const p = problemStore.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  p.replies += 1;
  res.json({ replies: p.replies });
});

// ── Reports ───────────────────────────────────
app.post('/api/report', (req, res) => {
  const { type, contentId, reason } = req.body;
  if (!type || !contentId || !reason) return res.status(400).json({ error: 'Missing fields' });
  const allowedTypes = ['message','problem','room'];
  const allowedReasons = ['harassment','spam','illegal','hate_speech','self_harm','misinformation','other'];
  if (!allowedTypes.includes(type) || !allowedReasons.includes(reason)) return res.status(400).json({ error: 'Invalid fields' });
  const reportId = Date.now().toString();
  reportStore.set(reportId, { type, contentId: contentId.substring(0, 100), reason, createdAt: Date.now() });
  const count = (reportCounts.get(contentId) || 0) + 1;
  reportCounts.set(contentId, count);
  let autoHidden = false;
  if (count >= 3) { autoHidden = true; if (type === 'message') io.emit('content_hidden', { contentId }); }
  res.json({ success: true, message: 'Report received. Thank you for keeping VEILX safe.', autoHidden });
});

app.get('/api/report/count/:contentId', (req, res) => {
  res.json({ count: reportCounts.get(req.params.contentId) || 0 });
});

// ── Confessions ───────────────────────────────
app.post('/api/confessions', (req, res) => {
  const { text, category } = req.body;
  if (!text || typeof text !== 'string' || text.trim().length < 5) return res.status(400).json({ error: 'Confession too short' });
  if (text.length > 300) return res.status(400).json({ error: 'Max 300 characters' });
  const id = Date.now().toString();
  const reactions = {};
  CONFESSION_REACTIONS.forEach(emoji => { reactions[emoji] = 0; });
  confessionsStore.set(id, { id, text: text.substring(0, 300).replace(/[<>]/g, '').trim(), category: (category || 'General').substring(0, 30), reactions, createdAt: Date.now(), views: 0 });
  res.json({ success: true, id });
});

app.get('/api/confessions', (req, res) => {
  const sort = req.query.sort || 'latest';
  const now = Date.now();
  const list = [];
  for (const [id, c] of confessionsStore.entries()) {
    if (now - c.createdAt > 7*24*60*60*1000) { confessionsStore.delete(id); continue; }
    list.push({ ...c, totalReactions: Object.values(c.reactions).reduce((a, b) => a + b, 0) });
  }
  if (sort === 'trending') list.sort((a, b) => b.totalReactions - a.totalReactions);
  else list.sort((a, b) => b.createdAt - a.createdAt);
  res.json({ confessions: list.slice(0, 30) });
});

app.post('/api/confessions/:id/react', (req, res) => {
  const c = confessionsStore.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const { emoji } = req.body;
  if (!CONFESSION_REACTIONS.includes(emoji)) return res.status(400).json({ error: 'Invalid reaction' });
  c.reactions[emoji] = (c.reactions[emoji] || 0) + 1;
  res.json({ reactions: c.reactions });
});

// ── Files ─────────────────────────────────────
app.post('/api/files/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const fileId = uuidv4().substring(0, 8).toUpperCase();
  fileStore.set(fileId, { name: req.file.originalname.substring(0, 100), type: req.file.mimetype, size: req.file.size, data: req.file.buffer, createdAt: Date.now(), downloads: 0, maxDownloads: 10 });
  res.json({ success: true, fileId, name: req.file.originalname, size: req.file.size, expiresIn: '24 hours', maxDownloads: 10 });
});

app.get('/api/files/:fileId', (req, res) => {
  const file = fileStore.get(req.params.fileId.toUpperCase());
  if (!file) return res.status(404).json({ error: 'File not found or expired' });
  if (file.downloads >= file.maxDownloads) { fileStore.delete(req.params.fileId.toUpperCase()); return res.status(410).json({ error: 'Download limit reached' }); }
  file.downloads++;
  res.setHeader('Content-Disposition', 'attachment; filename="' + file.name + '"');
  res.setHeader('Content-Type', file.type);
  res.setHeader('Content-Length', file.size);
  res.send(file.data);
});

app.get('/api/files/:fileId/info', (req, res) => {
  const file = fileStore.get(req.params.fileId.toUpperCase());
  if (!file) return res.status(404).json({ error: 'File not found or expired' });
  res.json({ name: file.name, type: file.type, size: file.size, downloads: file.downloads, maxDownloads: file.maxDownloads, expiresIn: Math.max(0, Math.floor((file.createdAt + 24*60*60*1000 - Date.now()) / 60000)) + ' minutes' });
});

// ── Voice ─────────────────────────────────────
app.post('/api/voice/join', (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Room code required' });
  const roomCode = code.toUpperCase().substring(0, 6);
  if (!voiceRooms.has(roomCode)) voiceRooms.set(roomCode, { peers: new Set(), created: Date.now() });
  const room = voiceRooms.get(roomCode);
  if (room.peers.size >= 10) return res.status(400).json({ error: 'Voice room is full' });
  res.json({ success: true, peerCount: room.peers.size });
});

app.get('/api/voice/:code/peers', (req, res) => {
  const room = voiceRooms.get(req.params.code.toUpperCase());
  res.json({ peers: room ? room.peers.size : 0 });
});

// ── Study Rooms ───────────────────────────────
app.post('/api/study/create', (req, res) => {
  const { subject } = req.body;
  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  studyRooms.set(code, { code, subject: sanitize(subject || 'General Study', 50), members: new Set(), notes: '', timer: { mode: 'focus', timeLeft: 25*60, running: false }, sessions: 0, createdAt: Date.now() });
  res.json({ code, subject: studyRooms.get(code).subject });
});

app.get('/api/study/:code', (req, res) => {
  const room = studyRooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Study room not found' });
  res.json({ code: room.code, subject: room.subject, members: room.members.size, notes: room.notes, timer: room.timer, sessions: room.sessions });
});

app.post('/api/study/:code/notes', (req, res) => {
  const room = studyRooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Not found' });
  const { notes } = req.body;
  if (typeof notes !== 'string') return res.status(400).json({ error: 'Invalid notes' });
  room.notes = notes.substring(0, 5000);
  io.to('study_' + room.code).emit('study_notes_updated', { notes: room.notes });
  res.json({ success: true });
});

app.post('/api/study/:code/timer', (req, res) => {
  const room = studyRooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Not found' });
  const { action } = req.body;
  if (action === 'start') room.timer.running = true;
  else if (action === 'pause') room.timer.running = false;
  else if (action === 'reset') { room.timer.running = false; room.timer.timeLeft = room.timer.mode === 'focus' ? 25*60 : 5*60; }
  else if (action === 'switch') {
    room.timer.running = false;
    if (room.timer.mode === 'focus') { room.timer.mode = 'break'; room.timer.timeLeft = 5*60; room.sessions++; }
    else { room.timer.mode = 'focus'; room.timer.timeLeft = 25*60; }
  }
  io.to('study_' + room.code).emit('study_timer_update', { timer: room.timer, sessions: room.sessions });
  res.json({ timer: room.timer, sessions: room.sessions });
});

// ── Premium ───────────────────────────────────
app.get('/api/plans', (req, res) => {
  res.json({ plans: Object.entries(PLANS).map(([key, plan]) => ({ id: key, ...plan })) });
});

app.get('/api/premium/status', (req, res) => {
  const token = req.headers['x-veilx-token'];
  if (!token) return res.json({ plan: 'free', active: false });
  const session = premiumSessions.get(token);
  if (!session || session.expiresAt < Date.now()) { premiumSessions.delete(token); return res.json({ plan: 'free', active: false }); }
  res.json({ plan: session.plan, active: true, expiresAt: session.expiresAt, features: PLANS[session.plan] });
});

app.post('/api/premium/activate', (req, res) => {
  const { plan, paymentId } = req.body;
  if (!PLANS[plan] || plan === 'free') return res.status(400).json({ error: 'Invalid plan' });
  if (!paymentId) return res.status(400).json({ error: 'Payment ID required' });
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + (30*24*60*60*1000);
  premiumSessions.set(token, { plan, paymentId: paymentId.substring(0, 50), expiresAt, createdAt: Date.now() });
  res.json({ success: true, token, plan, expiresAt, message: 'Premium activated!' });
});

// ── Chatbot ───────────────────────────────────
app.post('/api/chatbot', async (req, res) => {
  const { message, history, sessionId } = req.body;
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'Message required' });
  const sessionKey = sessionId ? sessionId.substring(0, 32) : crypto.createHash('sha256').update(req.ip || 'unknown').digest('hex').substring(0, 16);
  const now = Date.now();
  const limit = chatbotRateLimit.get(sessionKey) || { count: 0, reset: now + 3600000 };
  if (now > limit.reset) { limit.count = 0; limit.reset = now + 3600000; }
  if (limit.count >= 20) return res.status(429).json({ error: 'Chatbot limit reached. Try again in an hour.', resetIn: Math.ceil((limit.reset - now) / 60000) + ' minutes' });
  limit.count++;
  chatbotRateLimit.set(sessionKey, limit);
  const cleanHistory = Array.isArray(history) ? history.slice(-10).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).substring(0, 500) })) : [];
  const cleanMessage = message.substring(0, 500).replace(/[<>]/g, '');
  if (!process.env.ANTHROPIC_API_KEY) return res.json({ response: getSmartFallback(cleanMessage), remaining: 20 - limit.count });
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 500, system: `You are VEX — VEILX's anonymous AI assistant. Be helpful, direct, concise (under 150 words). Never ask for personal info. Be warm but not robotic.`, messages: [...cleanHistory, { role: 'user', content: cleanMessage }] })
    });
    if (!response.ok) return res.json({ response: getSmartFallback(cleanMessage), remaining: 20 - limit.count });
    const data = await response.json();
    res.json({ response: data.content?.[0]?.text || getSmartFallback(cleanMessage), remaining: 20 - limit.count });
  } catch (err) { res.json({ response: getSmartFallback(cleanMessage), remaining: 20 - limit.count }); }
});

// ── Public Rooms ──────────────────────────────
app.post('/api/public-rooms/create', (req, res) => {
  const { name, type, description, tags } = req.body;
  if (!name || typeof name !== 'string' || name.trim().length < 3) return res.status(400).json({ error: 'Room name must be at least 3 characters' });
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();
  const cleanTags = Array.isArray(tags) ? tags.slice(0, 5).map(t => sanitize(String(t), 20)) : [];
  publicRooms.set(code, { code, name: sanitize(name.trim(), 50), type: sanitize(type || 'General', 30), description: sanitize(description || '', 120), members: 0, maxMembers: 20, createdAt: Date.now(), lastActivity: Date.now(), tags: cleanTags, active: true });
  rooms.set(code, createRoomRecord(code, type || 'General'));
  res.json({ success: true, code, name: publicRooms.get(code).name });
});

app.get('/api/public-rooms', (req, res) => {
  const { type, sort } = req.query;
  const now = Date.now();
  const list = [];
  for (const [code, room] of publicRooms.entries()) {
    if (now - room.lastActivity > 2*60*60*1000) { publicRooms.delete(code); continue; }
    const mainRoom = rooms.get(code);
    if (mainRoom) room.members = mainRoom.members.size;
    if (type && type !== 'All' && room.type !== type) continue;
    list.push({ ...room, members: room.members });
  }
  if (sort === 'active') list.sort((a, b) => b.lastActivity - a.lastActivity);
  else if (sort === 'popular') list.sort((a, b) => b.members - a.members);
  else list.sort((a, b) => b.createdAt - a.createdAt);
  res.json({ rooms: list });
});

app.post('/api/public-rooms/:code/ping', (req, res) => {
  const room = publicRooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Not found' });
  room.lastActivity = Date.now();
  res.json({ success: true });
});

app.delete('/api/public-rooms/:code', (req, res) => {
  publicRooms.delete(req.params.code.toUpperCase());
  res.json({ success: true });
});

// ── Feed ──────────────────────────────────────
app.get('/api/feed', (req, res) => {
  const { tab } = req.query;
  const now = Date.now();
  const sevenDays = 7*24*60*60*1000;
  const items = [];
  for (const [id, p] of problemStore.entries()) {
    if (now - p.createdAt > sevenDays) continue;
    const ageMinutes = (now - p.createdAt) / 60000;
    items.push({ id: 'prob_' + id, type: 'problem', title: p.text.substring(0, 80), body: p.text, category: p.cat, votes: p.votes || 0, replies: p.replies || 0, createdAt: p.createdAt, score: calculateTrendScore(p.votes || 0, p.replies || 0, ageMinutes) });
  }
  for (const [id, c] of confessionsStore.entries()) {
    if (now - c.createdAt > sevenDays) continue;
    const total = Object.values(c.reactions || {}).reduce((a, b) => a + b, 0);
    const ageMinutes = (now - c.createdAt) / 60000;
    items.push({ id: 'conf_' + id, confId: id, type: 'confession', title: '"' + c.text.substring(0, 60) + '"', body: c.text, category: c.category, reactions: c.reactions, totalReactions: total, createdAt: c.createdAt, score: calculateTrendScore(total, 0, ageMinutes) });
  }
  for (const [code, room] of publicRooms.entries()) {
    if (now - room.lastActivity > 2*60*60*1000) continue;
    const mainRoom = rooms.get(code);
    const memberCount = mainRoom ? mainRoom.members.size : 0;
    items.push({ id: 'room_' + code, code, type: 'room', title: room.name, body: room.description || 'Join the conversation', category: room.type, members: memberCount, createdAt: room.createdAt, lastActivity: room.lastActivity, score: memberCount * 10 + (now - room.lastActivity < 300000 ? 50 : 0) });
  }
  if (tab === 'new') items.sort((a, b) => b.createdAt - a.createdAt);
  else if (tab === 'community') { const c = items.filter(i => i.type !== 'room'); c.sort((a, b) => (b.votes || b.totalReactions || 0) - (a.votes || a.totalReactions || 0)); return res.json({ items: c.slice(0, 30) }); }
  else items.sort((a, b) => b.score - a.score);
  res.json({ items: items.slice(0, 30) });
});

// ── Polls ─────────────────────────────────────
app.post('/api/polls/create', (req, res) => {
  const { question, options } = req.body;
  if (!question || typeof question !== 'string' || question.trim().length < 5) return res.status(400).json({ error: 'Question too short' });
  if (!Array.isArray(options) || options.length < 2 || options.length > 4) return res.status(400).json({ error: 'Need 2–4 options' });
  const id = Date.now().toString();
  const cleanOptions = options.map(o => ({ text: sanitize(String(o).trim(), 80), votes: 0 })).filter(o => o.text.length > 0);
  if (cleanOptions.length < 2) return res.status(400).json({ error: 'Need at least 2 valid options' });
  pollStore.set(id, { id, question: sanitize(question.trim(), 200), options: cleanOptions, createdAt: Date.now(), expiresAt: Date.now() + (48*60*60*1000), totalVotes: 0 });
  res.json({ success: true, id });
});

app.get('/api/polls', (req, res) => {
  const now = Date.now();
  const list = [];
  for (const [id, poll] of pollStore.entries()) {
    if (now > poll.expiresAt) { pollStore.delete(id); continue; }
    list.push({ ...poll });
  }
  list.sort((a, b) => b.createdAt - a.createdAt);
  res.json({ polls: list.slice(0, 20) });
});

app.post('/api/polls/:id/vote', (req, res) => {
  const poll = pollStore.get(req.params.id);
  if (!poll) return res.status(404).json({ error: 'Poll not found or expired' });
  if (Date.now() > poll.expiresAt) { pollStore.delete(req.params.id); return res.status(410).json({ error: 'Poll has expired' }); }
  const { optionIndex } = req.body;
  if (typeof optionIndex !== 'number' || optionIndex < 0 || optionIndex >= poll.options.length) return res.status(400).json({ error: 'Invalid option' });
  poll.options[optionIndex].votes++;
  poll.totalVotes++;
  res.json({ success: true, options: poll.options, totalVotes: poll.totalVotes });
});

// ── Leaderboard ───────────────────────────────
app.post('/api/leaderboard/update', (req, res) => {
  const { sessionKey, codename, emoji, category, delta } = req.body;
  if (!sessionKey || typeof sessionKey !== 'string') return res.status(400).json({ error: 'Session key required' });
  const key = sessionKey.substring(0, 32);
  const categories = ['helpScore','studySessions','reactionScore','pollVotes','streak'];
  if (!categories.includes(category)) return res.status(400).json({ error: 'Invalid category' });
  if (!leaderboardStore.has(key)) leaderboardStore.set(key, { codename: sanitize(codename || 'Anonymous', 30), emoji: (emoji || '👤').substring(0, 4), helpScore: 0, studySessions: 0, reactionScore: 0, pollVotes: 0, streak: 0, lastSeen: Date.now(), createdAt: Date.now() });
  const entry = leaderboardStore.get(key);
  entry.codename = sanitize(codename || entry.codename, 30);
  entry.emoji = (emoji || entry.emoji).substring(0, 4);
  entry[category] = Math.max(0, (entry[category] || 0) + (Number(delta) || 1));
  entry.lastSeen = Date.now();
  res.json({ success: true, score: entry[category] });
});

app.get('/api/leaderboard', (req, res) => {
  const { category } = req.query;
  const now = Date.now();
  const entries = [];
  for (const [key, entry] of leaderboardStore.entries()) {
    if (now - entry.lastSeen > 30*24*60*60*1000) { leaderboardStore.delete(key); continue; }
    const totalScore = entry.helpScore*3 + entry.studySessions*2 + entry.reactionScore*2 + entry.pollVotes + entry.streak*5;
    entries.push({ codename: entry.codename, emoji: entry.emoji, helpScore: entry.helpScore, studySessions: entry.studySessions, reactionScore: entry.reactionScore, pollVotes: entry.pollVotes, streak: entry.streak, totalScore });
  }
  if (category === 'helpers') entries.sort((a, b) => b.helpScore - a.helpScore);
  else if (category === 'studiers') entries.sort((a, b) => b.studySessions - a.studySessions);
  else if (category === 'confessors') entries.sort((a, b) => b.reactionScore - a.reactionScore);
  else entries.sort((a, b) => b.totalScore - a.totalScore);
  res.json({ entries: entries.slice(0, 20) });
});

// ── Multer error handler ──────────────────────
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File too large. Max 10MB.' });
  if (err.message === 'File type not allowed') return res.status(400).json({ error: 'File type not allowed.' });
  next(err);
});

// ════════════════════════════════════════════
// WORD DUEL HELPERS (outside socket handler)
// ════════════════════════════════════════════

function startWordDuelTimer(code) {
  const game = wordGames.get(code);
  if (!game) return;
  if (game.timer) clearTimeout(game.timer);
  game.timer = setTimeout(() => {
    const g = wordGames.get(code);
    if (!g || g.status !== 'playing') return;
    const currentPlayer = g.players[g.currentPlayerIndex];
    g.currentPlayerIndex = (g.currentPlayerIndex + 1) % g.players.length;
    g.round++;
    if (g.round > g.maxRounds * g.players.length) { endWordDuelGame(code); return; }
    io.to('wordduel_' + code).emit('wordduel_timeout', { player: currentPlayer.codename, currentPlayer: g.players[g.currentPlayerIndex].codename, currentWord: g.currentWord, round: g.round });
    startWordDuelTimer(code);
  }, 30000);
}

function endWordDuelGame(code) {
  const game = wordGames.get(code);
  if (!game) return;
  if (game.timer) clearTimeout(game.timer);
  game.status = 'finished';
  const sorted = [...game.players].sort((a, b) => b.score - a.score);
  io.to('wordduel_' + code).emit('wordduel_ended', { winner: sorted[0].codename, players: sorted.map(p => ({ codename: p.codename, score: p.score })) });
  setTimeout(() => wordGames.delete(code), 5*60*1000);
}

// ════════════════════════════════════════════
// SOCKET.IO — ALL HANDLERS IN ONE PLACE
// ════════════════════════════════════════════

io.on('connection', (socket) => {
  let currentRoom = null;
  let userCodename = null;
  let userEmoji = null;

  // ── Study Room Sockets ──
  socket.on('study_join', ({ code, codename }) => {
    const room = studyRooms.get((code || '').toUpperCase());
    if (!room) { socket.emit('study_error', { message: 'Study room not found' }); return; }
    socket.join('study_' + room.code);
    room.members.add(socket.id);
    io.to('study_' + room.code).emit('study_member_update', { members: room.members.size });
    socket.emit('study_joined', { code: room.code, subject: room.subject, notes: room.notes, timer: room.timer, sessions: room.sessions, members: room.members.size });
  });

  socket.on('study_leave', ({ code }) => {
    const room = studyRooms.get((code || '').toUpperCase());
    if (room) { room.members.delete(socket.id); socket.leave('study_' + room.code); io.to('study_' + room.code).emit('study_member_update', { members: room.members.size }); }
  });

  // ── Word Duel Sockets ──
  socket.on('wordduel_create', ({ codename }) => {
    const gameCode = Math.random().toString(36).substring(2, 7).toUpperCase();
    wordGames.set(gameCode, { players: [{ id: socket.id, codename: sanitize(codename || 'Anonymous', 20), score: 0 }], currentWord: '', usedWords: new Set(), status: 'waiting', currentPlayerIndex: 0, round: 0, maxRounds: 10 });
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
    io.to('wordduel_' + code).emit('wordduel_update', { players: game.players.map(p => ({ codename: p.codename, score: p.score })), status: game.status, message: sanitize(codename || 'Anonymous', 20) + ' joined the game!' });
  });

  socket.on('wordduel_start', ({ gameCode }) => {
    const code = (gameCode || '').toUpperCase();
    const game = wordGames.get(code);
    if (!game) return;
    if (game.players.length < 2) { socket.emit('wordduel_error', { message: 'Need at least 2 players' }); return; }
    if (game.players[0].id !== socket.id) { socket.emit('wordduel_error', { message: 'Only host can start' }); return; }
    game.status = 'playing'; game.round = 1;
    const firstWord = WORD_LIST[Math.floor(Math.random() * WORD_LIST.length)];
    game.currentWord = firstWord; game.usedWords.add(firstWord);
    io.to('wordduel_' + code).emit('wordduel_started', { currentWord: firstWord, currentPlayer: game.players[0].codename, round: game.round, maxRounds: game.maxRounds, timeLimit: 30 });
    startWordDuelTimer(code);
  });

  socket.on('wordduel_answer', ({ gameCode, word }) => {
    const code = (gameCode || '').toUpperCase();
    const game = wordGames.get(code);
    if (!game || game.status !== 'playing') return;
    const currentPlayer = game.players[game.currentPlayerIndex];
    if (currentPlayer.id !== socket.id) return;
    const cleanWord = sanitize((word || '').toLowerCase().trim(), 30);
    if (!cleanWord || cleanWord.length < 2) { socket.emit('wordduel_error', { message: 'Word too short' }); return; }
    const lastLetter = game.currentWord[game.currentWord.length - 1];
    if (cleanWord[0] !== lastLetter) { socket.emit('wordduel_invalid', { message: 'Word must start with "' + lastLetter.toUpperCase() + '"' }); return; }
    if (game.usedWords.has(cleanWord)) { socket.emit('wordduel_invalid', { message: 'Word already used!' }); return; }
    currentPlayer.score += cleanWord.length;
    game.usedWords.add(cleanWord); game.currentWord = cleanWord; game.round++;
    game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.players.length;
    if (game.round > game.maxRounds * game.players.length) { endWordDuelGame(code); return; }
    const nextPlayer = game.players[game.currentPlayerIndex];
    io.to('wordduel_' + code).emit('wordduel_correct', { word: cleanWord, player: currentPlayer.codename, score: currentPlayer.score, players: game.players.map(p => ({ codename: p.codename, score: p.score })), currentWord: cleanWord, currentPlayer: nextPlayer.codename, round: game.round, maxRounds: game.maxRounds * game.players.length });
    startWordDuelTimer(code);
  });

  // ── Chat Room Sockets ──
  socket.on('join_room', ({ code, codename, emoji }) => {
    code = (code || '').toUpperCase().substring(0, 6);
    if (!code || code.length !== 6) { socket.emit('error', { message: 'Invalid room code' }); return; }
    userCodename = sanitize(codename || 'Anonymous', 30);
    userEmoji = (emoji || '👤').substring(0, 4);
    if (!rooms.has(code)) rooms.set(code, createRoomRecord(code, 'General'));
    const room = rooms.get(code);
    if (currentRoom) {
      socket.leave(currentRoom);
      const prevRoom = rooms.get(currentRoom);
      if (prevRoom) { prevRoom.members.delete(socket.id); io.to(currentRoom).emit('user_left', { count: prevRoom.members.size }); }
    }
    socket.join(code); currentRoom = code;
    room.members.add(socket.id); room.lastActivity = Date.now();
    socket.to(code).emit('user_joined', { count: room.members.size });
    socket.emit('joined', { code, type: room.type, memberCount: room.members.size });
  });

  socket.on('send_message', ({ text }) => {
    if (!currentRoom || !userCodename) return;
    if (!checkMsgRate(socket.id)) { socket.emit('error', { message: 'Slow down — too many messages.' }); return; }
    if (!text || typeof text !== 'string') return;
    const clean = sanitize(text, 2000);
    if (!clean) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.lastActivity = Date.now(); room.msgCount++;
    io.to(currentRoom).emit('message', signMessage({ sender: userCodename, avatar: userEmoji, text: clean, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }));
  });

  socket.on('get_room_token', ({ code }) => {
    const token = getRoomToken(code.toUpperCase());
    socket.emit('room_token', { token });
  });

  // ── Voice Sockets ──
  socket.on('voice_join', ({ code }) => {
    const voiceRoom = 'voice_' + code.toUpperCase();
    socket.join(voiceRoom);
    socket.to(voiceRoom).emit('voice_peer_joined', { peerId: socket.id });
    const room = io.sockets.adapter.rooms.get(voiceRoom);
    const peers = room ? [...room].filter(id => id !== socket.id) : [];
    socket.emit('voice_existing_peers', { peers });
  });

  socket.on('voice_offer', ({ targetId, offer }) => {
    io.to(targetId).emit('voice_offer', { fromId: socket.id, offer });
  });

  socket.on('voice_answer', ({ targetId, answer }) => {
    io.to(targetId).emit('voice_answer', { fromId: socket.id, answer });
  });

  socket.on('voice_ice', ({ targetId, candidate }) => {
    io.to(targetId).emit('voice_ice', { fromId: socket.id, candidate });
  });

  socket.on('voice_leave', ({ code }) => {
    const voiceRoom = 'voice_' + code.toUpperCase();
    socket.leave(voiceRoom);
    socket.to(voiceRoom).emit('voice_peer_left', { peerId: socket.id });
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    cleanupSocket(socket.id);
    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        room.members.delete(socket.id);
        io.to(currentRoom).emit('user_left', { count: room.members.size });
        if (room.members.size === 0) {
          setTimeout(() => {
            if (rooms.has(currentRoom) && rooms.get(currentRoom).members.size === 0) { rooms.delete(currentRoom); deleteRoomToken(currentRoom); }
          }, 30000);
        }
      }
    }
    // Clean up study rooms
    for (const [code, room] of studyRooms.entries()) {
      if (room.members.has(socket.id)) { room.members.delete(socket.id); io.to('study_' + code).emit('study_member_update', { members: room.members.size }); }
    }
  });
});

// ════════════════════════════════════════════
// STATIC FILES + START
// ════════════════════════════════════════════

app.use(express.static(path.join(__dirname, '../frontend')));
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, '../frontend/index.html')); });

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🔒 VEILX Server running on port ${PORT}`);
  console.log(`📡 Zero-knowledge mode: ON`);
  console.log(`🗑  Auto-delete: ON`);
  console.log(`🛡  Rate limiting: ON`);
  console.log(`\n→ Listening on 0.0.0.0:${PORT}\n`);
});