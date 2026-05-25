const { WebSocketServer } = require('ws');
const logger = require('../utils/logger');

let wss = null;

// Connected frontend clients
const clients = new Set();

function initWebSocket(httpServer) {
  wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  const ALLOWED_WS_ORIGINS = [
    'https://voiceiq.co.uk',
    'https://www.voiceiq.co.uk',
    'https://voiceiq-one.vercel.app',
    'http://localhost:3000',
    'http://localhost:5500',
    ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : []),
  ];

  wss.on('connection', (ws, req) => {
    const origin = req.headers.origin;
    if (origin && !ALLOWED_WS_ORIGINS.includes(origin)) {
      ws.close(4001, 'Unauthorised origin');
      return;
    }

    clients.add(ws);
    logger.info('WS client connected', { total: clients.size });

    ws.send(JSON.stringify({ type: 'connected', message: 'VoiceIQ live monitoring active' }));

    ws.on('close', () => {
      clients.delete(ws);
      logger.info('WS client disconnected', { total: clients.size });
    });

    ws.on('error', (err) => {
      logger.error('WS error', { error: err.message });
      clients.delete(ws);
    });
  });

  logger.info('WebSocket server initialised on /ws');
}

// ─── Broadcast to all connected frontend clients ──────────────────────────
function broadcast(type, data) {
  if (!wss || clients.size === 0) return;

  const message = JSON.stringify({ type, data, ts: new Date().toISOString() });

  clients.forEach(client => {
    if (client.readyState === 1) { // OPEN
      try { client.send(message); }
      catch (err) { logger.error('WS send error', { error: err.message }); }
    }
  });
}

// ─── Typed broadcast helpers ──────────────────────────────────────────────
const emit = {
  callStarted:    (data) => broadcast('call_started',     data),
  callEnded:      (data) => broadcast('call_ended',       data),
  callTransferred:(data) => broadcast('call_transferred', data),
  agentSpeaking:  (data) => broadcast('agent_speaking',   data),
  prospectSpeaking:(data)=> broadcast('prospect_speaking',data),
  meetingBooked:  (data) => broadcast('meeting_booked',   data),
  sentimentUpdate:(data) => broadcast('sentiment_update', data),
  callSummary:    (data) => broadcast('call_summary',     data),
  agentStatus:    (data) => broadcast('agent_status',     data),
};

module.exports = { initWebSocket, broadcast, emit };
