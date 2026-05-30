const express = require('express');
const router = express.Router();
const axios = require('axios');
const elevenlabs = require('../services/elevenlabs');
const gemini = require('../services/gemini');
const logger = require('../utils/logger');
const audioCache = require('../utils/audioCache');

// ─── Serve cached audio (used by Twilio <Play>) ───────────────────────────
router.get('/audio/:id', (req, res) => {
  const entry = audioCache.get(req.params.id);
  if (!entry) {
    logger.warn('Audio fetch: not found', { id: req.params.id, ip: req.ip });
    return res.status(404).json({ error: 'Audio not found or expired' });
  }
  logger.info('Audio fetch: serving', { id: req.params.id, bytes: entry.buffer.length, ip: req.ip });
  res.setHeader('Content-Type', entry.contentType);
  res.setHeader('Content-Length', entry.buffer.length);
  res.send(entry.buffer);
});

// ─── Gemini model diagnostics — lists available models for this API key ──
router.get('/diagnose-gemini', async (req, res) => {
  const keySet = !!process.env.GEMINI_API_KEY;
  if (!keySet) return res.json({ keySet: false, models: [] });

  try {
    const response = await axios.get(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}&pageSize=50`
    );
    const models = (response.data.models || [])
      .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
      .map(m => m.name.replace('models/', ''));

    res.json({
      keySet,
      currentModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash-preview-05-20',
      availableModels: models,
    });
  } catch (err) {
    res.json({
      keySet,
      error: err.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 300)}` : err.message,
    });
  }
});

// ─── ElevenLabs key diagnostics ──────────────────────────────────────────
router.get('/diagnose', async (req, res) => {
  const keySet  = !!process.env.ELEVENLABS_API_KEY;
  const keySnip = keySet
    ? `${process.env.ELEVENLABS_API_KEY.slice(0, 6)}...${process.env.ELEVENLABS_API_KEY.slice(-4)}`
    : null;

  let apiOk = false;
  let apiError = null;
  let voices = [];

  if (keySet) {
    try {
      voices = await elevenlabs.listVoices();
      apiOk = true;
    } catch (err) {
      apiError = err.response
        ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 200)}`
        : err.message;
    }
  }

  res.json({
    keySet,
    keySnippet: keySnip,
    apiReachable: apiOk,
    voiceCount: voices.length,
    error: apiError,
    configuredVoices: elevenlabs.getVoiceMap(),
  });
});

// ─── List available voices ────────────────────────────────────────────────
router.get('/voices', async (req, res) => {
  const configured = elevenlabs.getVoiceMap();
  res.json({ voices: configured });
});

// ─── List all ElevenLabs voices on account ────────────────────────────────
router.get('/voices/all', async (req, res) => {
  const voices = await elevenlabs.listVoices();
  res.json({ voices, count: voices.length });
});

// ─── Text to Speech — returns audio file ─────────────────────────────────
router.post('/tts', async (req, res) => {
  const { text, agentName, stream } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });

  if (stream) {
    await elevenlabs.streamTextToSpeech({ text, agentName, res });
    return;
  }

  const audio = await elevenlabs.textToSpeech({ text, agentName });
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Length', audio.length);
  res.send(audio);
});

// ─── Analyse sentiment ────────────────────────────────────────────────────
router.post('/sentiment', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });
  const result = await gemini.analyseSentiment(text);
  res.json(result);
});

// ─── Generate objection response ──────────────────────────────────────────
router.post('/objection', async (req, res) => {
  const { objection, agentName, companyName, script } = req.body;
  if (!objection) return res.status(400).json({ error: 'objection is required' });
  const result = await gemini.generateObjectionResponse({ objection, agentName, companyName, script });
  res.json(result);
});

// ─── Generate opening greeting for an agent/lead combo ────────────────────
router.post('/greeting', async (req, res) => {
  const { agentName, leadName, leadCompany, companyName, script } = req.body;

  const session = { callId: `preview-${Date.now()}` };
  gemini.startSession({
    callId: session.callId,
    agentConfig: { name: agentName || 'Sophia', companyName, script },
    leadData: { name: leadName, company: leadCompany },
  });

  const response = await gemini.processTurn({ callId: session.callId, userSpeech: null });
  gemini.endSession(session.callId);

  const audio = await elevenlabs.textToSpeech({
    text: elevenlabs.addNaturalPauses(response.speech),
    agentName: agentName?.toLowerCase() || 'james',
  });

  res.json({
    speech: response.speech,
    audio:  audio.toString('base64'),
  });
});

module.exports = router;
