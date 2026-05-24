require('dotenv').config();
require('express-async-errors');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { createServer } = require('http');

const logger = require('./utils/logger');
const { errorHandler } = require('./middleware/errorHandler');
const { apiKeyAuth } = require('./middleware/auth');
const rateLimiter = require('./middleware/rateLimiter');

// Routes
const teamsRoutes = require('./routes/teams');
const calendarRoutes = require('./routes/calendar');
const voiceRoutes = require('./routes/voice');
const agentsRoutes = require('./routes/agents');
const callsRoutes = require('./routes/calls');
const webhookRoutes = require('./routes/webhooks');

const app = express();
const httpServer = createServer(app);

// ─── WebSocket for live call monitoring ───────────────────────────────────
const { initWebSocket } = require('./services/websocket');
initWebSocket(httpServer);

// ─── Global Middleware ────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // Handled by frontend
}));

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
}));

app.use(morgan('combined', {
  stream: { write: (msg) => logger.http(msg.trim()) }
}));

// Raw body needed for Microsoft webhook validation
app.use('/api/webhooks', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Health Check (no auth) ───────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'VoiceIQ API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    integrations: {
      teams: !!process.env.AZURE_CLIENT_ID,
      elevenlabs: !!process.env.ELEVENLABS_API_KEY,
      openai: !!process.env.OPENAI_API_KEY,
      googleCalendar: !!process.env.GOOGLE_CLIENT_ID,
    }
  });
});

// ─── Rate Limiting ────────────────────────────────────────────────────────
app.use('/api/', rateLimiter);

// ─── Webhook routes (Microsoft validates before auth) ─────────────────────
app.use('/api/webhooks', webhookRoutes);

// ─── Authenticated API Routes ─────────────────────────────────────────────
app.use('/api/teams',    apiKeyAuth, teamsRoutes);
app.use('/api/calendar', apiKeyAuth, calendarRoutes);
app.use('/api/voice',    apiKeyAuth, voiceRoutes);
app.use('/api/agents',   apiKeyAuth, agentsRoutes);
app.use('/api/calls',    apiKeyAuth, callsRoutes);

// ─── 404 ──────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found', path: req.path });
});

// ─── Global Error Handler ─────────────────────────────────────────────────
app.use(errorHandler);

// ─── Start ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  logger.info(`VoiceIQ API running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV}`);
  logger.info(`Frontend URL: ${process.env.FRONTEND_URL}`);
});

module.exports = { app, httpServer };
