const jwt    = require('jsonwebtoken');
const logger = require('../utils/logger');

// Simple API key auth for frontend → backend requests
const apiKeyAuth = (req, res, next) => {
  const key = req.headers['x-api-key'] || req.query.api_key;

  if (!key || key !== process.env.API_KEY) {
    logger.warn('Unauthorised API request', { ip: req.ip, path: req.path });
    return res.status(401).json({ error: 'Unauthorised — invalid or missing API key' });
  }

  next();
};

// Decode JWT from Bearer token and attach req.user (does not block on failure)
const parseToken = (req) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  try {
    const JWT_SECRET = process.env.JWT_SECRET || 'voiceiq-dev-secret-change-in-production';
    return jwt.verify(auth.split(' ')[1], JWT_SECRET);
  } catch {
    return null;
  }
};

// Only allow users with role === 'admin'
const requireAdmin = (req, res, next) => {
  const user = parseToken(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  if (user.role !== 'admin') {
    logger.warn('Admin-only endpoint rejected', { email: user.email, path: req.path });
    return res.status(403).json({ error: 'Admin access required' });
  }
  req.user = user;
  next();
};

module.exports = { apiKeyAuth, requireAdmin };
