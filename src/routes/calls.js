const express = require('express');
const router  = express.Router();
const gemini  = require('../services/gemini');
const prisma  = require('../utils/prisma');
const { updateAgentStats } = require('./agents');
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
  const now       = new Date();
  const todayStart     = new Date(now); todayStart.setHours(0,0,0,0);
  const yesterdayStart = new Date(todayStart); yesterdayStart.setDate(yesterdayStart.getDate() - 1);

  try {
    const [todayCalls, yesterdayCalls, allTimeTotal] = await Promise.all([
      prisma.call.findMany({ where: { loggedAt: { gte: todayStart } } }),
      prisma.call.findMany({ where: { loggedAt: { gte: yesterdayStart, lt: todayStart } } }),
      prisma.call.count(),
    ]);

    function summarise(calls) {
      const booked   = calls.filter(c => c.outcome === 'meeting_booked').length;
      const answered = calls.filter(c => c.outcome !== 'no_answer').length;
      const summaries = calls.map(c => c.summary ? JSON.parse(c.summary) : null).filter(Boolean);
      const scores   = summaries.filter(s => s?.avgCallScore).map(s => s.avgCallScore);
      const avgScore = scores.length ? (scores.reduce((a,b) => a+b, 0) / scores.length).toFixed(1) : 0;
      return {
        total:       calls.length,
        answered,
        answerRate:  calls.length ? Math.round((answered / calls.length) * 100) : 0,
        booked,
        bookingRate: answered ? Math.round((booked / answered) * 100) : 0,
        avgScore:    parseFloat(avgScore),
      };
    }

    res.json({
      today:     summarise(todayCalls),
      yesterday: summarise(yesterdayCalls),
      allTime:   { total: allTimeTotal },
    });
  } catch (err) {
    logger.error('Failed to fetch analytics', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// ─── GET /api/calls/:callId ───────────────────────────────────────────────────
router.get('/:callId', async (req, res) => {
  try {
    const call = await prisma.call.findUnique({ where: { callId: req.params.callId } });
    if (!call) return res.status(404).json({ error: 'Call not found' });
    res.json({ ...call, summary: call.summary ? JSON.parse(call.summary) : null });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch call' });
  }
});

module.exports = router;
module.exports.logCall = logCall;
