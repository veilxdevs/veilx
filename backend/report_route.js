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