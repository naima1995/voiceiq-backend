const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const calendar = require('../services/calendar');
const configStore = require('../utils/configStore');
const logger = require('../utils/logger');
const { requireAdmin } = require('../middleware/auth');

// All calendar management endpoints are admin-only
router.use(requireAdmin);

// ─── OAuth ────────────────────────────────────────────────────────────────
router.get('/oauth/url', (req, res) => {
  const url = calendar.getOAuthUrl();
  res.json({ url });
});

// ─── OAuth callback — saves token to runtime config store ─────────────────
router.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const tokens = await calendar.handleOAuthCallback(code);

    // Fetch the connected Google account email
    let email = null;
    try {
      const oauth2 = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
      );
      oauth2.setCredentials(tokens);
      const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2 });
      const info = await oauth2Api.userinfo.get();
      email = info.data.email;
    } catch (e) {
      logger.warn('Could not fetch Google account email', { error: e.message });
    }

    // Save to runtime store — takes effect immediately, no redeploy needed
    configStore.setCalendarCredentials({
      refreshToken: tokens.refresh_token,
      email,
    });

    logger.info('Google Calendar connected', { email, hasRefreshToken: !!tokens.refresh_token });

    // Return a clean success page
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Google Calendar Connected</title>
          <style>
            body { font-family: sans-serif; display: flex; align-items: center; justify-content: center;
                   min-height: 100vh; margin: 0; background: #0f1117; color: #fff; }
            .box { text-align: center; padding: 2rem; }
            .icon { font-size: 3rem; }
            h2 { margin: 1rem 0 0.5rem; }
            p { color: #9ca3af; margin: 0; }
            .email { color: #6366f1; font-weight: 600; margin-top: 0.5rem; }
          </style>
        </head>
        <body>
          <div class="box">
            <div class="icon">✅</div>
            <h2>Google Calendar Connected</h2>
            <p class="email">${email || 'Account linked'}</p>
            ${tokens.refresh_token ? `
            <p style="margin-top:1.5rem;color:#9ca3af;font-size:0.85rem;">Save this refresh token in Railway as <strong>GOOGLE_REFRESH_TOKEN</strong> so it persists across deploys:</p>
            <textarea readonly onclick="this.select()" style="margin-top:0.5rem;width:100%;max-width:600px;padding:0.5rem;background:#1f2937;color:#34d399;border:1px solid #374151;border-radius:6px;font-family:monospace;font-size:0.8rem;resize:none;" rows="3">${tokens.refresh_token}</textarea>
            ` : ''}
            <p style="margin-top:1rem;">You can close this tab and return to VoiceIQ.</p>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    logger.error('OAuth callback error', { error: err.message });
    res.status(500).send(`
      <!DOCTYPE html><html><body style="font-family:sans-serif;background:#0f1117;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;">
        <div style="text-align:center"><div style="font-size:3rem">❌</div><h2>Connection Failed</h2><p style="color:#9ca3af">${err.message}</p></div>
      </body></html>
    `);
  }
});

// ─── Connection status ────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  res.json(configStore.getCalendarConfig());
});

// ─── Disconnect ───────────────────────────────────────────────────────────
router.delete('/disconnect', (req, res) => {
  configStore.clearCalendarCredentials();
  logger.info('Google Calendar disconnected');
  res.json({ disconnected: true });
});

// ─── Available slots ──────────────────────────────────────────────────────
router.get('/slots', async (req, res) => {
  const { daysAhead, slotDurationMins } = req.query;
  const slots = await calendar.getAvailableSlots({
    daysAhead: daysAhead ? parseInt(daysAhead) : 7,
    slotDurationMins: slotDurationMins ? parseInt(slotDurationMins) : 30,
  });
  res.json({ slots });
});

// ─── Book meeting ─────────────────────────────────────────────────────────
router.post('/book', async (req, res) => {
  const result = await calendar.bookMeeting(req.body);
  logger.info('Meeting booked via API', { eventId: result.eventId });
  res.json(result);
});

// ─── Create task ──────────────────────────────────────────────────────────
router.post('/task', async (req, res) => {
  const result = await calendar.createTask(req.body);
  logger.info('Task created via API', { taskId: result.taskId });
  res.json(result);
});

// ─── Reschedule meeting ───────────────────────────────────────────────────
router.patch('/reschedule', async (req, res) => {
  const result = await calendar.rescheduleMeeting(req.body);
  res.json(result);
});

// ─── Cancel meeting ───────────────────────────────────────────────────────
router.delete('/cancel/:eventId', async (req, res) => {
  const result = await calendar.cancelMeeting({ eventId: req.params.eventId, reason: req.query.reason });
  res.json(result);
});

// ─── List upcoming events ─────────────────────────────────────────────────
router.get('/events', async (req, res) => {
  const config = configStore.getCalendarConfig();
  if (!config?.connected) return res.json({ events: [], connected: false });
  try {
    const events = await calendar.listUpcomingEvents({
      maxResults: req.query.maxResults ? parseInt(req.query.maxResults) : 20,
      daysAhead:  req.query.daysAhead  ? parseInt(req.query.daysAhead)  : 14,
    });
    res.json({ events, connected: true });
  } catch (err) {
    logger.warn('Calendar events fetch failed', { error: err.message });
    res.json({ events: [], connected: false, error: err.message });
  }
});

module.exports = router;
