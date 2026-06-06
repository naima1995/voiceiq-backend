/**
 * Simple in-memory config store for runtime settings.
 * Initialised from environment variables on startup.
 * Changes persist for the lifetime of the process — on redeploy,
 * the env var value is used again as the starting point.
 */

const store = {
  // Token loaded from env var on startup — used silently for API calls
  googleRefreshToken:    process.env.GOOGLE_REFRESH_TOKEN || null,
  // Email is only set when user explicitly connects via the UI OAuth flow
  // (never auto-populated from env so it can't be confused with the login account)
  googleEmail:           null,
  googleConnectedViaUI:  false,
  googleCalendarId:      process.env.GOOGLE_CALENDAR_ID || 'primary',
};

function get(key) {
  return store[key] ?? null;
}

function set(key, value) {
  store[key] = value;
}

function getCalendarConfig() {
  return {
    // Only report as "connected" if the user explicitly linked via UI
    connected:  store.googleConnectedViaUI,
    email:      store.googleEmail,
    calendarId: store.googleCalendarId,
  };
}

function setCalendarCredentials({ refreshToken, email, calendarId }) {
  if (refreshToken) store.googleRefreshToken   = refreshToken;
  if (email)        store.googleEmail          = email;
  if (calendarId)   store.googleCalendarId     = calendarId;
  store.googleConnectedViaUI = true;
}

function clearCalendarCredentials() {
  store.googleRefreshToken   = null;
  store.googleEmail          = null;
  store.googleConnectedViaUI = false;
}

module.exports = { get, set, getCalendarConfig, setCalendarCredentials, clearCalendarCredentials };
