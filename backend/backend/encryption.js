const crypto = require('crypto');

const SERVER_SECRET = process.env.SERVER_SECRET || crypto.randomBytes(32).toString('hex');

function signMessage(payload) {
  const data = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', SERVER_SECRET).update(data).digest('hex').substring(0, 16);
  return { ...payload, sig };
}

const roomTokens = new Map();
function getRoomToken(roomCode) {
  if (!roomTokens.has(roomCode)) {
    roomTokens.set(roomCode, crypto.randomBytes(16).toString('hex'));
  }
  return roomTokens.get(roomCode);
}
function deleteRoomToken(roomCode) { roomTokens.delete(roomCode); }

function sanitize(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  return str.substring(0, maxLen).replace(/[<>]/g, '').replace(/javascript:/gi, '').trim();
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

module.exports = { signMessage, getRoomToken, deleteRoomToken, sanitize, checkMsgRate, cleanupSocket };