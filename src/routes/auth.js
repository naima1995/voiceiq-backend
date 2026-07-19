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

// ─── POST /api/auth/google — verify Google access token via tokeninfo ────
router.post('/google', async (req, res) => {
  const { accessToken } = req.body;
  if (!accessToken) return res.status(400).json({ error: 'Google access token required' });

  try {
    // Verify token and get user info via Google's userinfo endpoint
    const response = await fetch(
      `https://www.googleapis.com/oauth2/v3/userinfo`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!response.ok) throw new Error('Failed to verify Google token');

    const info    = await response.json();
    const email   = info.email;
    const name    = info.name    || email.split('@')[0];
    const picture = info.picture || null;

    if (!info.email_verified) {
      return res.status(401).json({ error: 'Google account email is not verified' });
    }

    // Resolve role from env vars:
    //   ALLOWED_EMAILS  (or ADMIN_EMAIL)  → role 'admin'
    //   MEMBER_EMAILS                     → role 'member'
    const toList = (raw) => (raw || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    const adminEmails  = toList(process.env.ALLOWED_EMAILS || process.env.ADMIN_EMAIL);
    const memberEmails = toList(process.env.MEMBER_EMAILS);
    const allAllowed   = [...adminEmails, ...memberEmails];

    if (allAllowed.length > 0 && !allAllowed.includes(email.toLowerCase())) {
      logger.warn('Google login rejected — not in allowed list', { email });
      return res.status(403).json({
        error: `Access denied. ${email} is not authorised to access VoiceIQ.`,
      });
    }

    const role = adminEmails.includes(email.toLowerCase()) ? 'admin' : 'member';

    const token = jwt.sign(
      { email, name, picture, role, provider: 'google' },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );

    logger.info('Google login successful', { email, role, ip: req.ip });
    res.json({ token, user: { email, name, picture, role } });

  } catch (err) {
    logger.warn('Google token verification failed', { error: err.message });
    res.status(401).json({ error: 'Google sign-in failed. Please try again.' });
  }
});

// ─── POST /api/auth/logout — client just clears token, but log it ────────
router.post('/logout', (req, res) => {
  logger.info('User logged out', { ip: req.ip });
  res.json({ success: true });
});

module.exports = router;
module.exports.JWT_SECRET = JWT_SECRET;
