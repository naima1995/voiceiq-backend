const express = require('express');
const router = express.Router();
const teams = require('../services/teams');
const logger = require('../utils/logger');

// ─── Connection status — verifies Azure credentials & fetches numbers ─────
router.get('/status', async (req, res) => {
  try {
    const numbers = await teams.listTeamsNumbers();
    res.json({
      connected: true,
      tenant: process.env.AZURE_TENANT_ID,
      numbersFound: numbers.length,
      numbers,
    });
  } catch (err) {
    const detail = err.message || err.code || err.statusCode || JSON.stringify(err) || 'unknown error';
    logger.warn('Teams status check failed', { error: detail, stack: err.stack });
    res.status(200).json({ connected: false, error: detail, code: err.code, status: err.statusCode });
  }
});

// ─── Diagnostic: verify Object IDs and resource accounts ─────────────────
// GET /api/teams/app-info
// Returns the service principal Object ID (what AZURE_BOT_OBJECT_ID should be)
// and any Teams resource accounts found in the tenant.
router.get('/app-info', async (req, res) => {
  try {
    const info = await teams.getAppInfo();
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get Microsoft OAuth sign-in URL (delegated permissions) ─────────────
router.get('/oauth/url', async (req, res) => {
  try {
    const url = await teams.getOAuthUrl(req.query.state || 'voiceiq');
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── List Teams phone numbers ─────────────────────────────────────────────
router.get('/numbers', async (req, res) => {
  const numbers = await teams.listTeamsNumbers();
  res.json({ numbers });
});

// ─── Make outbound call ───────────────────────────────────────────────────
router.post('/call', async (req, res) => {
  const { toNumber, fromNumber, agentId, leadData } = req.body;
  if (!toNumber) return res.status(400).json({ error: 'toNumber is required' });

  try {
    const result = await teams.makeOutboundCall({
      toNumber, fromNumber, agentId, leadData,
      callbackUrl: process.env.CALLBACK_BASE_URL,
    });
    logger.info('Outbound call initiated', result);
    res.json(result);
  } catch (err) {
    // Surface the full Graph API error so we can debug payload issues
    const detail = err.body || err.message || JSON.stringify(err);
    logger.error('Teams call initiation failed', { error: detail });
    res.status(500).json({ error: detail });
  }
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

// ─── OAuth callback — redirects back to the dashboard ────────────────────
router.get('/oauth/callback', async (req, res) => {
  const { code, error, error_description } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || 'https://voiceiq.co.uk';

  if (error) {
    logger.warn('Teams OAuth error', { error, error_description });
    return res.redirect(`${frontendUrl}?teams_error=${encodeURIComponent(error_description || error)}`);
  }

  try {
    const result = await teams.handleOAuthCallback(code);
    logger.info('Teams OAuth success', { account: result.account?.username });
    res.redirect(`${frontendUrl}?teams_connected=1&account=${encodeURIComponent(result.account?.username || '')}`);
  } catch (err) {
    logger.error('Teams OAuth callback error', { error: err.message });
    res.redirect(`${frontendUrl}?teams_error=${encodeURIComponent(err.message)}`);
  }
});

module.exports = router;
