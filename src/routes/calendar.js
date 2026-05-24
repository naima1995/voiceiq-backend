const express = require('express');
const router = express.Router();
const calendar = require('../services/calendar');
const logger = require('../utils/logger');

// ─── OAuth ────────────────────────────────────────────────────────────────
router.get('/oauth/url', (req, res) => {
  const url = calendar.getOAuthUrl();
  res.json({ url });
});

router.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;
  const tokens = await calendar.handleOAuthCallback(code);
  res.json({ connected: true, hasRefreshToken: !!tokens.refresh_token, tokens });
});

// ─── Available slots ──────────────────────────────────────────────────────
router.get('/slots', async (req, res) => {
  const { daysAhead, slotDurationMins } = req.query;
  const slots = await calendar.getAvailableSlots({
    daysAhead: daysAhead ? parseInt(daysAhead) : 7,
    slotDurationMins: slotDurationMins ? parseInt(slotDurationMins) : 30,
  });
  res.json({ slots });
});

// ─── Book meeting ─────────────────────────────────────────────────────────
router.post('/book', async (req, res) => {
  const result = await calendar.bookMeeting(req.body);
  logger.info('Meeting booked via API', { eventId: result.eventId });
  res.json(result);
});

// ─── Reschedule meeting ───────────────────────────────────────────────────
router.patch('/reschedule', async (req, res) => {
  const result = await calendar.rescheduleMeeting(req.body);
  res.json(result);
});

// ─── Cancel meeting ───────────────────────────────────────────────────────
router.delete('/cancel/:eventId', async (req, res) => {
  const result = await calendar.cancelMeeting({ eventId: req.params.eventId, reason: req.query.reason });
  res.json(result);
});

// ─── List upcoming events ─────────────────────────────────────────────────
router.get('/events', async (req, res) => {
  const events = await calendar.listUpcomingEvents({
    maxResults: req.query.maxResults ? parseInt(req.query.maxResults) : 20,
    daysAhead: req.query.daysAhead ? parseInt(req.query.daysAhead) : 14,
  });
  res.json({ events });
});

module.exports = router;
