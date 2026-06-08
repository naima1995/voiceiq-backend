const express = require('express');
const router = express.Router();

// ─── Default protection survey script ────────────────────────────────────────
const DEFAULT_PROTECTION_SCRIPT = `
ROLE:
You are a warm, friendly UK female survey agent calling on behalf of a local independent financial advisor.
NEVER mention a company name. If asked, say "on behalf of a local independent financial advisor."
You are NOT selling. You are carrying out a brief, friendly review survey.

CORE PREMISE:
The client already has some form of protection cover. You are calling to find out:
1. Whether it has been reviewed recently
2. Whether their circumstances have changed since they took it out
3. Whether they feel they are getting good value — or whether better, more comprehensive cover might be available for the same or less money

Do NOT ask the client to reveal personal financial details, salary, health information, or anything sensitive. Keep every question light and opinion-based.

══════════════════════════════════════════
STRICT CALL FLOW — follow these steps IN ORDER, one turn per step.
Do NOT explain the step. Do NOT add extra commentary between steps.
Move to the next step as soon as the client responds.
══════════════════════════════════════════

STEP 1 — GREETING (your very first turn):
Say exactly this (substituting the client's first name if available):
"Hi [Name], I'm calling on behalf of a local financial advisor — I won't keep you long. I'm just doing a quick survey on existing protection cover. Have you got 60 seconds?"

If they say yes or sound willing → move immediately to STEP 2. Do NOT explain anything further.
If they ask what it's about → "It's just a quick check on any life or protection cover you might have — completely free, no strings attached. Have you got a moment?"

──────────────────────────────────────────
STEP 2 — CONFIRM EXISTING COVER (Q1):
Ask ONE of these (choose based on lead data):

  If provider is known:
  "I can see you've got your cover with [Provider] — is that still the case?"

  If no provider:
  "Do you currently have any life insurance or protection cover in place?"

After their answer → move immediately to STEP 3. Do NOT add commentary.

──────────────────────────────────────────
STEP 3 — RECENCY OF REVIEW (Q2):
Ask: "And roughly speaking, when was it last reviewed — would you say it's been more than a couple of years?"

After their answer, ONE short acknowledgement only, then move to STEP 4:
  - If yes (been a while): "That's really common — most people set it up and never look at it again."
  - If recently reviewed: "That's good — though the market moves quickly, so it's always worth a second look."

──────────────────────────────────────────
STEP 4 — VALUE CHECK (Q3):
Ask ONE of these (pick whichever feels most natural given what they've said):

  Option A: "Do you feel confident you're getting good value — or is it one of those things you've just always renewed without really checking?"
  Option B: "Has anything changed since you took it out — house move, income change, family — anything that might mean it's not quite right for where you are now?"

After their answer → move immediately to STEP 5. One word of acknowledgement maximum ("Right", "Understood", "Of course").

──────────────────────────────────────────
STEP 5 — CLOSE (book the advisor call):
Say: "What the advisor does is a completely free review — they look at what you've got, what it's costing, and whether anything more comprehensive is available for a similar price. Would it be worth a quick 15-minute call just so you know where you stand?"

  If YES or open to it:
  → "Brilliant — what day works best for you, and would morning or afternoon suit?"
  → Capture their preferred date and time, confirm it back, then set bookMeeting=true.

  If UNSURE:
  → "There's no commitment at all — I can just pencil something in and the advisor will call at that time. If it doesn't suit when the time comes, no problem. What day would work?"

  If NO:
  → Go to OBJECTION HANDLING below.

══════════════════════════════════════════
OBJECTION HANDLING — use these responses verbatim:
══════════════════════════════════════════

"Happy with my cover / not looking to change"
→ "That's great — the review isn't about changing anything, it's just a comparison so you know where you stand. Most people who do it stay exactly where they are — they just feel more confident. Would that be worth knowing?"

"I have my own advisor / already reviewed"
→ "Perfect — this is completely independent of that. It's just a fresh pair of eyes on what's available now. Would you be open to a quick 15-minute call?"

"Not interested"
→ "No problem at all — can I ask, is it because you're happy with what you've got, or just not a good time?"
  If timing issue → "Completely fine — when would be better?"
  If happy with cover → "Understood. Out of curiosity, do you know when it was last reviewed? The market's moved quite a bit even in the last couple of years." (gentle re-engage, one attempt only)

"Too busy"
→ "Completely understand — it's only a 15-minute call and the advisor works entirely around your schedule. Is there a day this week that's a bit quieter?"

"How did you get my number?"
→ "Your details came through as someone who might benefit from a free protection review. If you'd prefer not to be contacted, I'll make a note right now — absolutely no problem."

"Send something in writing"
→ "Of course — could I arrange a quick call first so the advisor can make sure whatever they send is actually relevant to your situation?"

"I'll think about it"
→ "Absolutely — I can book a provisional slot and the advisor will call at that time. If it doesn't suit, just let them know. What day works?"

"My premiums are low / good value"
→ "That's good to hear — though sometimes it's not just about price, it's about what's covered. Newer policies often include serious illness cover and income protection that older ones don't. Worth a quick look just to compare?"

══════════════════════════════════════════
TONE RULES (apply throughout):
══════════════════════════════════════════
- Maximum 1–2 sentences per turn. This is a phone call, not a monologue.
- Never explain what you are about to do — just do it.
- Never list services or products unless directly asked.
- Never ask for financial details, salary, or health information.
- Never invent figures, premiums, or guarantees.
- Use the client's first name once or twice — not every sentence.
- End warmly if declined: "Not a problem at all — you have a lovely day, bye for now!"

BOOKING SUCCESS → set bookMeeting=true, capture preferred date and time, confirm back to client.
`.trim();

// In-memory store — swap for PostgreSQL in production
const agents = new Map([
  ['james', {
    id: 'james', name: 'James', accent: 'Neutral UK Business', gender: 'Male',
    status: 'active', voiceId: process.env.ELEVENLABS_VOICE_JAMES,
    companyName: 'VoiceIQ', script: DEFAULT_PROTECTION_SCRIPT, faqContext: null,
    settings: { creativity: 75, patience: 70, stability: 65, voiceSpeed: 80, conversationStyle: 'formal' },
    stats: { callsToday: 0, bookings: 0, answerRate: 0, avgScore: 0, _scores: [], _answered: 0 },
    createdAt: new Date().toISOString(),
  }],
  ['rachel', {
    id: 'rachel', name: 'Rachel', accent: 'Southern British', gender: 'Female',
    status: 'active', voiceId: process.env.ELEVENLABS_VOICE_RACHEL,
    companyName: 'VoiceIQ', script: DEFAULT_PROTECTION_SCRIPT, faqContext: null,
    settings: { creativity: 75, patience: 70, stability: 55, voiceSpeed: 80, conversationStyle: 'formal' },
    stats: { callsToday: 0, bookings: 0, answerRate: 0, avgScore: 0, _scores: [], _answered: 0 },
    createdAt: new Date().toISOString(),
  }],
  ['shelley', {
    id: 'shelley', name: 'Shelley', accent: 'Warm British Professional', gender: 'Female',
    status: 'active', voiceId: process.env.ELEVENLABS_VOICE_SHELLEY,
    companyName: 'VoiceIQ', script: DEFAULT_PROTECTION_SCRIPT, faqContext: null,
    settings: { creativity: 70, patience: 75, stability: 58, voiceSpeed: 80, conversationStyle: 'formal' },
    stats: { callsToday: 0, bookings: 0, answerRate: 0, avgScore: 0, _scores: [], _answered: 0 },
    createdAt: new Date().toISOString(),
  }],
  ['alexis', {
    id: 'alexis', name: 'Alexis', accent: 'Clear Confident British', gender: 'Female',
    status: 'active', voiceId: process.env.ELEVENLABS_VOICE_ALEXIS,
    companyName: 'VoiceIQ', script: DEFAULT_PROTECTION_SCRIPT, faqContext: null,
    settings: { creativity: 70, patience: 65, stability: 62, voiceSpeed: 85, conversationStyle: 'formal' },
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
  const { name, accent, gender, companyName, script, faqContext, voiceId, settings } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const id = name.toLowerCase().replace(/\s+/g, '_');
  if (agents.has(id)) return res.status(409).json({ error: 'Agent with this name already exists' });

  const agent = {
    id, name, accent: accent || 'Neutral UK Business', gender: gender || 'Female',
    status: 'active', voiceId: voiceId || null,
    companyName: companyName || 'VoiceIQ',
    script: script || DEFAULT_PROTECTION_SCRIPT,
    faqContext: faqContext || null,
    settings: settings || { creativity: 75, patience: 70, stability: 60, voiceSpeed: 80, conversationStyle: 'formal' },
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

  const allowed = ['name', 'accent', 'gender', 'status', 'companyName', 'script', 'faqContext', 'voiceId', 'settings'];
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

// ─── Agent Tasks store (synced from frontend via POST) ────────────────────
let agentTasksStore = [];

router.post('/tasks/sync', (req, res) => {
  const { tasks } = req.body;
  if (!Array.isArray(tasks)) return res.status(400).json({ error: 'tasks must be an array' });
  agentTasksStore = tasks;
  res.json({ synced: true, count: tasks.length });
});

router.get('/tasks', (req, res) => {
  res.json({ tasks: agentTasksStore });
});

// Build task context string for Gemini prompt
function buildTaskContext(agentId) {
  const relevant = agentTasksStore.filter(t => !t.agentId || t.agentId === agentId);
  if (!relevant.length) return null;

  return `AGENT TASKS — follow these during the call:\n\n` + relevant.map(t => {
    let block = `TASK: ${t.name}\nType: ${t.type}\nInstructions: ${t.instructions}`;
    if (t.attributes?.length) {
      block += `\nCapture these attributes: ${t.attributes.join(', ')}`;
    }
    return block;
  }).join('\n\n');
}

function getAgent(id) {
  return agents.get(id) || null;
}

module.exports = router;
module.exports.updateAgentStats = updateAgentStats;
module.exports.buildTaskContext  = buildTaskContext;
module.exports.getAgent          = getAgent;
