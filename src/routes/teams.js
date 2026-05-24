const express = require('express');
const router = express.Router();
const teams = require('../services/teams');
const logger = require('../utils/logger');

// ─── List Teams phone numbers ─────────────────────────────────────────────
router.get('/numbers', async (req, res) => {
  const numbers = await teams.listTeamsNumbers();
  res.json({ numbers });
});

// ─── Make outbound call ───────────────────────────────────────────────────
router.post('/call', async (req, res) => {
  const { toNumber, fromNumber, agentId, leadData } = req.body;
  if (!toNumber) return res.status(400).json({ error: 'toNumber is required' });

  const result = await teams.makeOutboundCall({
    toNumber, fromNumber, agentId, leadData,
    callbackUrl: process.env.CALLBACK_BASE_URL,
  });

  logger.info('Outbound call initiated', result);
  res.json(result);
});

// ─── Transfer call to human ───────────────────────────────────────────────
router.post('/transfer', async (req, res) => {
  const { teamsCallId, targetUserId, targetEmail } = req.body;
  const result = await teams.transferCallToHuman({ teamsCallId, targetUserId, targetEmail });
  res.json(result);
});

// ─── End call ─────────────────────────────────────────────────────────────
router.delete('/call/:teamsCallId', async (req, res) => {
  const result = await teams.endCall(req.params.teamsCallId);
  res.json(result);
});

// ─── OAuth callback ───────────────────────────────────────────────────────
router.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;
  const result = await teams.handleOAuthCallback(code);
  res.json({ connected: true, account: result.account });
});

module.exports = router;
