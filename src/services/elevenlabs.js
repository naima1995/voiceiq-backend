const axios = require('axios');
const logger = require('../utils/logger');

const BASE_URL = 'https://api.elevenlabs.io/v1';

// Voice ID map — set in .env, these are defaults
const VOICE_IDS = {
  sophia:    process.env.ELEVENLABS_VOICE_SOPHIA    || '21m00Tcm4TlvDq8ikWAM',
  james:     process.env.ELEVENLABS_VOICE_JAMES     || 'AZnzlk1XvdvUeBnXmlld',
  charlotte: process.env.ELEVENLABS_VOICE_CHARLOTTE || 'EXAVITQu4vr4xnSDxMaL',
};

const headers = () => ({
  'xi-api-key': process.env.ELEVENLABS_API_KEY,
  'Content-Type': 'application/json',
});

// ─── Voice Settings per agent personality ────────────────────────────────
const VOICE_SETTINGS = {
  sophia: {
    stability: 0.55,         // Slight variation for warmth
    similarity_boost: 0.85,
    style: 0.2,              // Natural, not over-stylised
    use_speaker_boost: true,
  },
  james: {
    stability: 0.65,         // More measured / professional
    similarity_boost: 0.80,
    style: 0.1,
    use_speaker_boost: true,
  },
  charlotte: {
    stability: 0.45,         // More expressive / friendly
    similarity_boost: 0.88,
    style: 0.35,
    use_speaker_boost: true,
  },
};

// ─── Text to Speech — returns audio Buffer ────────────────────────────────
async function textToSpeech({ text, agentName = 'sophia', outputFormat = 'mp3_44100_128' }) {
  const voiceId = VOICE_IDS[agentName.toLowerCase()];
  if (!voiceId) throw new Error(`Unknown agent voice: ${agentName}`);

  const settings = VOICE_SETTINGS[agentName.toLowerCase()] || VOICE_SETTINGS.sophia;

  logger.debug('ElevenLabs TTS request', { agentName, voiceId, chars: text.length });

  const response = await axios.post(
    `${BASE_URL}/text-to-speech/${voiceId}`,
    {
      text,
      model_id: 'eleven_turbo_v2',     // Low latency — ideal for calls
      voice_settings: settings,
      output_format: outputFormat,
    },
    {
      headers: headers(),
      responseType: 'arraybuffer',
      timeout: 10000,
    }
  );

  logger.debug('ElevenLabs TTS complete', { bytes: response.data.byteLength });
  return Buffer.from(response.data);
}

// ─── Streaming TTS — pipes audio stream (for real-time use) ──────────────
async function streamTextToSpeech({ text, agentName = 'sophia', res }) {
  const voiceId = VOICE_IDS[agentName.toLowerCase()];
  if (!voiceId) throw new Error(`Unknown agent voice: ${agentName}`);

  const settings = VOICE_SETTINGS[agentName.toLowerCase()] || VOICE_SETTINGS.sophia;

  const response = await axios.post(
    `${BASE_URL}/text-to-speech/${voiceId}/stream`,
    {
      text,
      model_id: 'eleven_turbo_v2',
      voice_settings: settings,
    },
    {
      headers: headers(),
      responseType: 'stream',
      timeout: 15000,
    }
  );

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Transfer-Encoding', 'chunked');
  response.data.pipe(res);
}

// ─── List Available Voices ────────────────────────────────────────────────
async function listVoices() {
  const response = await axios.get(`${BASE_URL}/voices`, {
    headers: headers(),
  });
  return response.data.voices.map(v => ({
    id: v.voice_id,
    name: v.name,
    labels: v.labels,
    previewUrl: v.preview_url,
  }));
}

// ─── Get voice IDs configured ─────────────────────────────────────────────
function getVoiceMap() {
  return {
    sophia:    { id: VOICE_IDS.sophia,    name: 'Sophia',    accent: 'Southern British', gender: 'Female' },
    james:     { id: VOICE_IDS.james,     name: 'James',     accent: 'Neutral UK Business', gender: 'Male' },
    charlotte: { id: VOICE_IDS.charlotte, name: 'Charlotte', accent: 'Friendly Conversational', gender: 'Female' },
  };
}

// ─── Add Natural Pauses via SSML-like markers ────────────────────────────
// ElevenLabs respects <break> tags in turbo model
function addNaturalPauses(text) {
  return text
    .replace(/\.\s+/g, '. <break time="400ms"/> ')
    .replace(/\?\s+/g, '? <break time="300ms"/> ')
    .replace(/,\s+/g, ', <break time="150ms"/> ')
    .replace(/—/g, '<break time="250ms"/>');
}

module.exports = {
  textToSpeech,
  streamTextToSpeech,
  listVoices,
  getVoiceMap,
  addNaturalPauses,
  VOICE_IDS,
};
