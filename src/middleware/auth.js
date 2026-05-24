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

module.exports = { apiKeyAuth };
