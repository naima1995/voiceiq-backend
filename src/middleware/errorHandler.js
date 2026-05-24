const logger = require('../utils/logger');

const errorHandler = (err, req, res, next) => {
  logger.error('Unhandled error', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  // Axios errors from external APIs
  if (err.response) {
    return res.status(err.response.status || 502).json({
      error: 'External API error',
      detail: err.response.data?.error?.message || err.message,
      service: err.config?.baseURL || 'unknown'
    });
  }

  // Validation errors (Joi)
  if (err.isJoi) {
    return res.status(400).json({ error: 'Validation error', detail: err.message });
  }

  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
};

module.exports = { errorHandler };
