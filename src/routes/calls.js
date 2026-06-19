const express = require('express');
const router  = express.Router();
const gemini  = require('../services/gemini');
const prisma  = require('../utils/prisma');
const { updateAgentStats } = require('./agents');
const { getTranscript } = require('../utils/transcript');
const logger  = require('../utils/logger');

// ─── Log a call (internal — called by webhook handlers) ──────────────────────
async function logCall(callData) {
  try {
    await prisma.call.create({
      data: {
        callId:     callData.callId     || null,
        direction:  callData.direction  || 'outbound',
        channel:    callData.channel    || 'twilio',
        agentId:    callData.agentId    || null,
        campaignId: callData.campaignId || null,
        toNumber:   callData.toNumber   || null,
        fromNumber: callData.fromNumber || null,
        duration:   callData.duration   ? parseInt(callData.duration) : null,
        status:     callData.status     || null,
        outcome:    callData.summary?.outcome || callData.outcome || null,
        summary:    callData.summary    ? JSON.stringify(callData.summary) : null,
        bookingId:  callData.booking?.taskId   || callData.booking?.eventId || null,
        bookingLink: callData.booking?.htmlLink || null,
        bookingDue: callData.booking?.due ? new Date(callData.booking.due) : null,
      },
    });

    if (callData.agentId) {
      updateAgentStats(callData.agentId, {
        outcome: callData.summary?.outcome || callData.outcome,
        score:   callData.summary?.avgCallScore || callData.score,
      });
    }
  } catch (err) {
    logger.error('Failed to log call to DB', { error: err.message, callId: callData.callId });
  }
}

// ─── GET /api/calls ───────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { page = 1, limit = 50, direction, agentId, outcome } = req.query;

  const where = {};
  if (direction) where.direction = direction;
  if (agentId)   where.agentId   = agentId;
  if (outcome)   where.outcome   = outcome;

  try {
    const [calls, total] = await Promise.all([
      prisma.call.findMany({
        where,
        orderBy: { loggedAt: 'desc' },
        skip:  (parseInt(page) - 1) * parseInt(limit),
        take:  parseInt(limit),
      }),
      prisma.call.count({ where }),
    ]);

    // Parse summary JSON back to object for frontend compatibility
    const parsed = calls.map(c => ({
      ...c,
      summary: c.summary ? JSON.parse(c.summary) : null,
    }));

    res.json({ calls: parsed, total, page: parseInt(page) });
  } catch (err) {
    logger.error('Failed to fetch calls', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch calls' });
  }
});

// ─── GET /api/calls/active/all ────────────────────────────────────────────────
router.get('/active/all', (req, res) => {
  const active = gemini.getActiveSessions();
  res.json({ calls: active, count: active.length });
});

// ─── GET /api/calls/analytics/summary ────────────────────────────────────────
router.get('/analytics/summary', async (req, res) => {
  const now            = new Date();
  // Boundary times in UTC — Railway runs UTC, UK is UTC+0/+1
  const todayStart     = new Date(now); todayStart.setHours(0,0,0,0);
  const yesterdayStart = new Date(todayStart); yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const weekStart      = new Date(todayStart); weekStart.setDate(weekStart.getDate() - 6); // last 7 days

  try {
    const [todayCalls, yesterdayCalls, weekCalls, allTimeTotal] = await Promise.all([
      prisma.call.findMany({ where: { loggedAt: { gte: todayStart } } }),
      prisma.call.findMany({ where: { loggedAt: { gte: yesterdayStart, lt: todayStart } } }),
      prisma.call.findMany({ where: { loggedAt: { gte: weekStart } }, orderBy: { loggedAt: 'asc' } }),
      prisma.call.count(),
    ]);

    function isBooked(c) {
      return c.bookingId || c.outcome === 'meeting_booked';
    }

    function summarise(calls) {
      const booked   = calls.filter(isBooked).length;
      const answered = calls.filter(c => c.outcome !== 'no_answer' && c.outcome !== 'no-answer' && c.status !== 'no-answer').length;
      const summaries = calls.map(c => c.summary ? JSON.parse(c.summary) : null).filter(Boolean);
      const scores    = summaries.filter(s => s?.avgCallScore).map(s => s.avgCallScore);
      const avgScore  = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : 0;
      return {
        total:       calls.length,
        answered,
        answerRate:  calls.length ? Math.round((answered / calls.length) * 100) : 0,
        booked,
        bookingRate: answered ? Math.round((booked / answered) * 100) : 0,
        avgScore:    parseFloat(avgScore),
      };
    }

    // Build daily buckets for the last 7 days (Mon–Sun labels)
    const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const dailyMap = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date(todayStart); d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      dailyMap[key] = { label: DAYS[d.getDay()], calls: 0, booked: 0 };
    }
    weekCalls.forEach(c => {
      const key = c.loggedAt.toISOString().slice(0, 10);
      if (dailyMap[key]) {
        dailyMap[key].calls++;
        if (isBooked(c)) dailyMap[key].booked++;
      }
    });
    const weekly = Object.values(dailyMap);

    res.json({
      today:     summarise(todayCalls),
      yesterday: summarise(yesterdayCalls),
      weekly,
      allTime:   { total: allTimeTotal },
    });
  } catch (err) {
    logger.error('Failed to fetch analytics', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// ─── GET /api/calls/:callId/transcript ───────────────────────────────────────
router.get('/:callId/transcript', async (req, res) => {
  try {
    const ref      = req.params.callId;
    // Resolve the internal callId (Twilio SID or UUID both accepted)
    const call     = await prisma.call.findFirst({ where: { OR: [{ callId: ref }, { id: ref }] } });
    const resolvedId = call?.callId || ref;
    const messages = await getTranscript(resolvedId);
    res.json({ callId: resolvedId, messages, count: messages.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch transcript' });
  }
});

// ─── GET /api/calls/:callId ───────────────────────────────────────────────────
// Accepts either the Twilio callId (CA...) or the internal UUID id
router.get('/:callId', async (req, res) => {
  try {
    const ref  = req.params.callId;
    const call = await prisma.call.findFirst({
      where: { OR: [{ callId: ref }, { id: ref }] },
    });
    if (!call) return res.status(404).json({ error: 'Call not found' });
    res.json({ ...call, summary: call.summary ? JSON.parse(call.summary) : null });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch call' });
  }
});

module.exports = router;
module.exports.logCall = logCall;
