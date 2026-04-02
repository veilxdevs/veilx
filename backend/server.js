// ════════════════════════════════════════════
// VEILX BACKEND — Phase 1
// Secure anonymous platform server
// Run: npm install && node server.js
// ════════════════════════════════════════════

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

    // Validate message
    if (!text || typeof text !== 'string') return;
    const clean = text.trim().substring(0, 2000); // Max 2000 chars
    if (!clean) return;

    const room = rooms.get(currentRoom);
    if (!room) return;

    room.lastActivity = Date.now();
    room.msgCount++;

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