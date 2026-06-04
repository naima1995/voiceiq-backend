const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const logger  = require('../utils/logger');

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

// ─── POST /api/auth/logout — client just clears token, but log it ────────
router.post('/logout', (req, res) => {
  logger.info('User logged out', { ip: req.ip });
  res.json({ success: true });
});

module.exports = router;
module.exports.JWT_SECRET = JWT_SECRET;
