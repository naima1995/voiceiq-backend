const express = require('express');
const router = express.Router();

// In-memory store — swap for PostgreSQL in production
const agents = new Map([
  ['sophia', {
    id: 'sophia', name: 'Sophia', accent: 'Southern British', gender: 'Female',
    status: 'active', voiceId: process.env.ELEVENLABS_VOICE_SOPHIA,
    companyName: 'VoiceIQ', script: null, faqContext: null,
    stats: { callsToday: 156, bookings: 19, answerRate: 0.72, avgScore: 4.9 },
    createdAt: new Date().toISOString(),
  }],
  ['james', {
    id: 'james', name: 'James', accent: 'Neutral UK Business', gender: 'Male',
    status: 'active', voiceId: process.env.ELEVENLABS_VOICE_JAMES,
    companyName: 'VoiceIQ', script: null, faqContext: null,
    stats: { callsToday: 91, bookings: 12, answerRate: 0.65, avgScore: 4.7 },
    createdAt: new Date().toISOString(),
  }],
  ['charlotte', {
    id: 'charlotte', name: 'Charlotte', accent: 'Friendly Conversational', gender: 'Female',
    status: 'active', voiceId: process.env.ELEVENLABS_VOICE_CHARLOTTE,
    companyName: 'VoiceIQ', script: null, faqContext: null,
    stats: { callsToday: 94, bookings: 12, answerRate: 0.68, avgScore: 4.8 },
    createdAt: new Date().toISOString(),
  }],
]);

// ─── List all agents ──────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.json({ agents: Array.from(agents.values()) });
});

// ─── Get single agent ─────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const agent = agents.get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json(agent);
});

// ─── Create agent ─────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  const { name, accent, gender, companyName, script, faqContext, voiceId } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const id = name.toLowerCase().replace(/\s+/g, '_');
  if (agents.has(id)) return res.status(409).json({ error: 'Agent with this name already exists' });

  const agent = {
    id, name, accent: accent || 'Neutral UK Business', gender: gender || 'Female',
    status: 'active', voiceId: voiceId || null,
    companyName: companyName || 'VoiceIQ',
    script: script || null,
    faqContext: faqContext || null,
    stats: { callsToday: 0, bookings: 0, answerRate: 0, avgScore: 0 },
    createdAt: new Date().toISOString(),
  };

  agents.set(id, agent);
  res.status(201).json(agent);
});

// ─── Update agent ─────────────────────────────────────────────────────────
router.patch('/:id', (req, res) => {
  const agent = agents.get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const allowed = ['name', 'accent', 'gender', 'status', 'companyName', 'script', 'faqContext', 'voiceId'];
  allowed.forEach(field => {
    if (req.body[field] !== undefined) agent[field] = req.body[field];
  });

  agent.updatedAt = new Date().toISOString();
  agents.set(req.params.id, agent);
  res.json(agent);
});

// ─── Delete agent ─────────────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  if (!agents.has(req.params.id)) return res.status(404).json({ error: 'Agent not found' });
  agents.delete(req.params.id);
  res.json({ deleted: true, id: req.params.id });
});

module.exports = router;
