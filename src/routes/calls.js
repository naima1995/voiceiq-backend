const express = require('express');
const router = express.Router();
const gemini = require('../services/gemini');
const { updateAgentStats } = require('./agents');

// In-memory call log — swap for PostgreSQL in production
const callLog = [];

// ─── Log a call (internal — called by teams route) ────────────────────────
function logCall(callData) {
  callLog.unshift({ ...callData, loggedAt: new Date().toISOString() });
  if (callLog.length > 1000) callLog.splice(1000); // Keep last 1000

  // Update the agent's live stats
  if (callData.agentId) {
    updateAgentStats(callData.agentId, {
      outcome: callData.summary?.outcome || callData.outcome,
      score:   callData.summary?.avgCallScore || callData.score,
    });
  }
}

// ─── Get call log ─────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const { page = 1, limit = 50, direction, agentId, outcome } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let filtered = callLog;
  if (direction) filtered = filtered.filter(c => c.direction === direction);
  if (agentId)   filtered = filtered.filter(c => c.agentId === agentId);
  if (outcome)   filtered = filtered.filter(c => c.summary?.outcome === outcome);

  res.json({
    calls: filtered.slice(offset, offset + parseInt(limit)),
    total: filtered.length,
    page: parseInt(page),
  });
});

// ─── Get single call ──────────────────────────────────────────────────────
router.get('/:callId', (req, res) => {
  const call = callLog.find(c => c.callId === req.params.callId);
  if (!call) return res.status(404).json({ error: 'Call not found' });
  res.json(call);
});

// ─── Get active calls ─────────────────────────────────────────────────────
router.get('/active/all', (req, res) => {
  const active = gemini.getActiveSessions();
  res.json({ calls: active, count: active.length });
});

// ─── Get analytics summary ────────────────────────────────────────────────
router.get('/analytics/summary', (req, res) => {
  const today = new Date().toDateString();
  const todayCalls = callLog.filter(c => new Date(c.loggedAt).toDateString() === today);

  const booked   = todayCalls.filter(c => c.summary?.outcome === 'meeting_booked').length;
  const answered = todayCalls.filter(c => c.summary?.outcome !== 'no_answer').length;
  const scores   = todayCalls.filter(c => c.summary?.avgCallScore).map(c => c.summary.avgCallScore);
  const avgScore = scores.length ? (scores.reduce((a,b) => a+b, 0) / scores.length).toFixed(1) : 0;

  res.json({
    today: {
      total:       todayCalls.length,
      answered,
      answerRate:  todayCalls.length ? Math.round((answered / todayCalls.length) * 100) : 0,
      booked,
      bookingRate: answered ? Math.round((booked / answered) * 100) : 0,
      avgScore:    parseFloat(avgScore),
    },
    allTime: {
      total: callLog.length,
    }
  });
});

module.exports = router;
module.exports.logCall = logCall;
