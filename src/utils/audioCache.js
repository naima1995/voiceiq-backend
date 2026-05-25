// ─── Short-lived in-memory audio buffer store ─────────────────────────────
// Twilio's <Play> verb needs a public URL. We generate audio with ElevenLabs,
// store it here, and serve it at GET /api/voice/audio/:id (TTL: 5 minutes).

const { v4: uuidv4 } = require('uuid');

const cache = new Map();
const TTL_MS = 5 * 60 * 1000; // 5 minutes

function store(buffer, contentType = 'audio/mpeg') {
  const id = uuidv4();
  cache.set(id, { buffer, contentType });
  setTimeout(() => cache.delete(id), TTL_MS);
  return id;
}

function get(id) {
  return cache.get(id) || null;
}

module.exports = { store, get };
