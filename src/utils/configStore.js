/**
 * Simple in-memory config store for runtime settings.
 * Initialised from environment variables on startup.
 * Changes persist for the lifetime of the process — on redeploy,
 * the env var value is used again as the starting point.
 */

const store = {
  googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN || null,
  googleEmail:        process.env.GOOGLE_CALENDAR_EMAIL || null,
  googleCalendarId:   process.env.GOOGLE_CALENDAR_ID   || 'primary',
};

function get(key) {
  return store[key] ?? null;
}

function set(key, value) {
  store[key] = value;
}

function getCalendarConfig() {
  return {
    connected:    !!store.googleRefreshToken,
    email:        store.googleEmail,
    calendarId:   store.googleCalendarId,
  };
}

function setCalendarCredentials({ refreshToken, email, calendarId }) {
  if (refreshToken) store.googleRefreshToken = refreshToken;
  if (email)        store.googleEmail        = email;
  if (calendarId)   store.googleCalendarId   = calendarId;
}

function clearCalendarCredentials() {
  store.googleRefreshToken = null;
  store.googleEmail        = null;
}

module.exports = { get, set, getCalendarConfig, setCalendarCredentials, clearCalendarCredentials };
