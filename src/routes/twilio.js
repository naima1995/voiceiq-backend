const express = require('express');
const router  = express.Router();
const twilioService = require('../services/twilio');
const logger  = require('../utils/logger');

// ─── Connection status ────────────────────────────────────────────────────
router.get('/status', async (req, res) => {
  const status = await twilioService.getStatus();
  res.json(status);
});

// ─── List assigned numbers ────────────────────────────────────────────────
router.get('/numbers', async (req, res) => {
  const numbers = await twilioService.listNumbers();
  res.json({ numbers });
});

// ─── Make outbound call ───────────────────────────────────────────────────
router.post('/call', async (req, res) => {
  const { toNumber, fromNumber, agentId, leadData } = req.body;
  if (!toNumber) return res.status(400).json({ error: 'toNumber is required' });

  const result = await twilioService.makeOutboundCall({ toNumber, fromNumber, agentId, leadData });
  logger.info('Outbound call initiated via Twilio', result);
  res.json(result);
});

// ─── End a live call ──────────────────────────────────────────────────────
router.delete('/call/:twilioCallSid', async (req, res) => {
  const result = await twilioService.endCall(req.params.twilioCallSid);
  res.json(result);
});

module.exports = router;
