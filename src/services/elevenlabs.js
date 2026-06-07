const axios = require('axios');
const logger = require('../utils/logger');

const BASE_URL = 'https://api.elevenlabs.io/v1';

// Voice ID map — set in Railway Variables, no hardcoded fallbacks for custom voices
const VOICE_IDS = {
  james:   process.env.ELEVENLABS_VOICE_JAMES   || 'AZnzlk1XvdvUeBnXmlld',
  rachel:  process.env.ELEVENLABS_VOICE_RACHEL  || '21m00Tcm4TlvDq8ikWAM',
  shelley: process.env.ELEVENLABS_VOICE_SHELLEY || '',
  alexis:  process.env.ELEVENLABS_VOICE_ALEXIS  || '',
};

const headers = () => ({
  'xi-api-key': process.env.ELEVENLABS_API_KEY,
  'Content-Type': 'application/json',
});

// ─── Voice Settings per agent personality ────────────────────────────────
const VOICE_SETTINGS = {
  james: {
    stability: 0.65,         // Measured, professional
    similarity_boost: 0.80,
    style: 0.1,
    use_speaker_boost: true,
  },
  rachel: {
    stability: 0.55,         // Warm, natural British
    similarity_boost: 0.85,
    style: 0.2,
    use_speaker_boost: true,
  },
  shelley: {
    stability: 0.58,         // Warm, approachable professional
    similarity_boost: 0.83,
    style: 0.25,
    use_speaker_boost: true,
  },
  alexis: {
    stability: 0.62,         // Confident, clear
    similarity_boost: 0.82,
    style: 0.15,
    use_speaker_boost: true,
  },
};

// ─── Text to Speech — returns audio Buffer ────────────────────────────────
async function textToSpeech({ text, agentName = 'james', outputFormat = 'mp3_44100_128', agentSettings = null }) {
  const voiceId = VOICE_IDS[agentName.toLowerCase()];
  if (!voiceId) throw new Error(`No voice ID configured for agent "${agentName}" — set ELEVENLABS_VOICE_${agentName.toUpperCase()} in Railway Variables`);

  const base = VOICE_SETTINGS[agentName.toLowerCase()] || VOICE_SETTINGS.james;

  // Override stability and style from agent settings sliders (0–100 → 0.0–1.0)
  const settings = agentSettings
    ? {
        ...base,
        stability:        parseFloat(((agentSettings.stability  ?? 60) / 100).toFixed(2)),
        style:            parseFloat(((agentSettings.voiceSpeed ?? 80) / 100).toFixed(2)),
        similarity_boost: base.similarity_boost,
        use_speaker_boost: true,
      }
    : base;

  logger.debug('ElevenLabs TTS request', { agentName, voiceId, chars: text.length });

  const response = await axios.post(
    `${BASE_URL}/text-to-speech/${voiceId}?output_format=${outputFormat}`,
    {
      text,
      model_id: 'eleven_flash_v2_5',   // Lowest latency — ideal for live calls
      voice_settings: settings,
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
async function streamTextToSpeech({ text, agentName = 'james', res }) {
  const voiceId = VOICE_IDS[agentName.toLowerCase()];
  if (!voiceId) throw new Error(`No voice ID configured for agent "${agentName}" — set ELEVENLABS_VOICE_${agentName.toUpperCase()} in Railway Variables`);

  const settings = VOICE_SETTINGS[agentName.toLowerCase()] || VOICE_SETTINGS.james;

  const response = await axios.post(
    `${BASE_URL}/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128`,
    {
      text,
      model_id: 'eleven_flash_v2_5',
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
    james:   { id: VOICE_IDS.james,   name: 'James',   accent: 'Neutral UK Business',      gender: 'Male'   },
    rachel:  { id: VOICE_IDS.rachel,  name: 'Rachel',  accent: 'Southern British',          gender: 'Female' },
    shelley: { id: VOICE_IDS.shelley, name: 'Shelley', accent: 'Warm British Professional', gender: 'Female' },
    alexis:  { id: VOICE_IDS.alexis,  name: 'Alexis',  accent: 'Clear Confident British',   gender: 'Female' },
  };
}

// ─── Add Natural Pauses via SSML-like markers ────────────────────────────
// Keep pauses short — long breaks cause noticeable dead air on a phone call
function addNaturalPauses(text) {
  return text
    .replace(/\.\s+/g, '. <break time="150ms"/> ')
    .replace(/\?\s+/g, '? <break time="150ms"/> ')
    .replace(/,\s+/g, ', <break time="75ms"/> ')
    .replace(/—/g, '<break time="100ms"/>');
}

module.exports = {
  textToSpeech,
  streamTextToSpeech,
  listVoices,
  getVoiceMap,
  addNaturalPauses,
  VOICE_IDS,
};
