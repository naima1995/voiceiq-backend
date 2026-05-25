const express = require('express');
const router = express.Router();

// In-memory store — swap for PostgreSQL in production
const agents = new Map([
  ['sophia', {
    id: 'sophia', name: 'Sophia', accent: 'Southern British', gender: 'Female',
    status: 'active', voiceId: process.env.ELEVENLABS_VOICE_SOPHIA,
    companyName: 'VoiceIQ', script: null, faqContext: null,
    stats: { callsToday: 0, bookings: 0, answerRate: 0, avgScore: 0, _scores: [], _answered: 0 },
    createdAt: new Date().toISOString(),
  }],
  ['james', {
    id: 'james', name: 'James', accent: 'Neutral UK Business', gender: 'Male',
    status: 'active', voiceId: process.env.ELEVENLABS_VOICE_JAMES,
    companyName: 'VoiceIQ', script: null, faqContext: null,
    stats: { callsToday: 0, bookings: 0, answerRate: 0, avgScore: 0, _scores: [], _answered: 0 },
    createdAt: new Date().toISOString(),
  }],
  ['charlotte', {
    id: 'charlotte', name: 'Charlotte', accent: 'Friendly Conversational', gender: 'Female',
    status: 'active', voiceId: process.env.ELEVENLABS_VOICE_CHARLOTTE,
    companyName: 'VoiceIQ', script: null, faqContext: null,
    stats: { callsToday: 0, bookings: 0, answerRate: 0, avgScore: 0, _scores: [], _answered: 0 },
    createdAt: new Date().toISOString(),
  }],
]);

// ─── Update agent stats when a call completes ─────────────────────────────
function updateAgentStats(agentId, { outcome, score }) {
  const agent = agents.get(agentId);
  if (!agent) return;
  const s = agent.stats;

  s.callsToday += 1;
  if (outcome !== 'no_answer') {
    s._answered += 1;
    s.answerRate = parseFloat((s._answered / s.callsToday).toFixed(2));
  }
  if (outcome === 'meeting_booked') s.bookings += 1;
  if (score) {
    s._scores.push(score);
    s.avgScore = parseFloat((s._scores.reduce((a, b) => a + b, 0) / s._scores.length).toFixed(1));
  }
  agents.set(agentId, agent);
}

// Strip internal tracking fields before sending to client
function publicAgent(a) {
  const { _scores, _answered, ...pub } = a.stats;
  return { ...a, stats: pub };
}

// ─── List all agents ──────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.json({ agents: Array.from(agents.values()).map(publicAgent) });
});

// ─── Get single agent ─────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const agent = agents.get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json(publicAgent(agent));
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
module.exports.updateAgentStats = updateAgentStats;
