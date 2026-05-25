require('dotenv').config();
require('express-async-errors');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { createServer } = require('http');

const logger = require('./utils/logger');
const { errorHandler } = require('./middleware/errorHandler');
// apiKeyAuth removed — access controlled by strict CORS origin allowlist
const rateLimiter = require('./middleware/rateLimiter');

// Routes
const teamsRoutes   = require('./routes/teams');
const twilioRoutes  = require('./routes/twilio');
const calendarRoutes = require('./routes/calendar');
const voiceRoutes   = require('./routes/voice');
const agentsRoutes  = require('./routes/agents');
const callsRoutes   = require('./routes/calls');
const webhookRoutes = require('./routes/webhooks');

const app = express();
app.set('trust proxy', 1); // Required for Railway/reverse proxy
const httpServer = createServer(app);

// ─── WebSocket for live call monitoring ───────────────────────────────────
const { initWebSocket } = require('./services/websocket');
initWebSocket(httpServer);

// ─── Global Middleware ────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // Handled by frontend
}));

const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5500',  // live-server / VS Code Live Server
  'https://voiceiq.co.uk',
  'https://www.voiceiq.co.uk',
  'https://voiceiq-one.vercel.app',
  ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : []),
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, Postman, server-to-server)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    logger.warn('CORS blocked', { origin });
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
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
      gemini: !!process.env.GEMINI_API_KEY,
      twilio: !!process.env.TWILIO_ACCOUNT_SID,
      googleCalendar: !!process.env.GOOGLE_CLIENT_ID,
    }
  });
});

// ─── Public routes (no auth) ──────────────────────────────────────────────
app.get('/api/calendar/oauth/callback', async (req, res) => {
  const calendar = require('./services/calendar');
  const { code } = req.query;
  try {
    const tokens = await calendar.handleOAuthCallback(code);
    res.json({ connected: true, hasRefreshToken: !!tokens.refresh_token, refreshToken: tokens.refresh_token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Rate Limiting ────────────────────────────────────────────────────────
app.use('/api/', rateLimiter);

// ─── Webhook routes (Microsoft validates before auth) ─────────────────────
app.use('/api/webhooks', webhookRoutes);

// ─── Authenticated API Routes ─────────────────────────────────────────────
app.use('/api/teams',    teamsRoutes);
app.use('/api/twilio',   twilioRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/voice',    voiceRoutes);
app.use('/api/agents',   agentsRoutes);
app.use('/api/calls',    callsRoutes);

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
