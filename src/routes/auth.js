const express       = require('express');
const router        = require('express').Router();
const jwt           = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const logger        = require('../utils/logger');

const JWT_SECRET  = process.env.JWT_SECRET  || 'voiceiq-dev-secret-change-in-production';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h';

// ─── Single admin account from env vars ──────────────────────────────────
function getAdminCredentials() {
  return {
    email:    process.env.ADMIN_EMAIL    || 'admin@voiceiq.co.uk',
    password: process.env.ADMIN_PASSWORD || 'voiceiq2026',
    name:     process.env.ADMIN_NAME     || 'Admin',
  };
}

// ─── GET /api/auth/config — public, exposes only the Google client ID ────
router.get('/config', (req, res) => {
  res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || null });
});

// ─── POST /api/auth/login ────────────────────────────────────────────────
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const admin = getAdminCredentials();

  // Case-insensitive email check, exact password
  if (email.toLowerCase() !== admin.email.toLowerCase() || password !== admin.password) {
    logger.warn('Failed login attempt', { email, ip: req.ip });
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const token = jwt.sign(
    { email: admin.email, name: admin.name, role: 'admin' },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );

  logger.info('Successful login', { email, ip: req.ip });
  res.json({ token, user: { email: admin.email, name: admin.name, role: 'admin' } });
});

// ─── GET /api/auth/me — verify token + return user ───────────────────────
router.get('/me', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const payload = jwt.verify(auth.split(' ')[1], JWT_SECRET);
    res.json({ user: { email: payload.email, name: payload.name, role: payload.role } });
  } catch {
    res.status(401).json({ error: 'Token invalid or expired' });
  }
});

// ─── POST /api/auth/google — verify Google ID token ──────────────────────
router.post('/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'Google credential required' });

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'GOOGLE_CLIENT_ID not configured' });

  try {
    const client  = new OAuth2Client(clientId);
    const ticket  = await client.verifyIdToken({ idToken: credential, audience: clientId });
    const payload = ticket.getPayload();

    const email = payload.email;
    const name  = payload.name  || email.split('@')[0];
    const picture = payload.picture || null;

    // Check against allowed emails list (comma-separated env var)
    // Also allow the ADMIN_EMAIL as a fallback
    const allowedRaw  = process.env.ALLOWED_EMAILS || process.env.ADMIN_EMAIL || '';
    const allowedList = allowedRaw.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

    if (allowedList.length > 0 && !allowedList.includes(email.toLowerCase())) {
      logger.warn('Google login rejected — email not in allowed list', { email });
      return res.status(403).json({ error: `Access denied. ${email} is not authorised to use VoiceIQ.` });
    }

    const token = jwt.sign(
      { email, name, picture, role: 'admin', provider: 'google' },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );

    logger.info('Google login successful', { email, ip: req.ip });
    res.json({ token, user: { email, name, picture, role: 'admin' } });

  } catch (err) {
    logger.warn('Google token verification failed', { error: err.message });
    res.status(401).json({ error: 'Invalid Google token' });
  }
});

// ─── POST /api/auth/logout — client just clears token, but log it ────────
router.post('/logout', (req, res) => {
  logger.info('User logged out', { ip: req.ip });
  res.json({ success: true });
});

module.exports = router;
module.exports.JWT_SECRET = JWT_SECRET;
