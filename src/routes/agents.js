const express = require('express');
const router  = express.Router();
const prisma  = require('../utils/prisma');
const logger  = require('../utils/logger');

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

ENDING THE CALL — detect and honour all farewells immediately:
If the client says anything that clearly ends the conversation ("bye", "goodbye", "thanks bye", "take care", "cheers", "I've got to go", "not interested bye", "lovely day", etc.):
- Do NOT restart the script or ask another question.
- Respond with ONE warm closing line only, e.g. "Lovely speaking with you — take care, bye for now!" or "Not a problem — you have a great day, bye!"
- Set hangUpNow=true in your JSON response.
If they say "take me off your list" or "don't call again" — set doNotCall=true AND hangUpNow=true.

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
  ['alice', {
    id: 'alice', name: 'Alice', accent: 'British Female', gender: 'Female',
    status: 'active', voiceId: process.env.ELEVENLABS_VOICE_ALICE || 'ZEt85AU1ui8Rr8FxNslW',
    companyName: 'VoiceIQ', script: DEFAULT_PROTECTION_SCRIPT, faqContext: null,
    settings: { creativity: 75, patience: 70, stability: 60, voiceSpeed: 80, conversationStyle: 'formal' },
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

// ─── Persist agent settings to PostgreSQL ────────────────────────────────
async function persistAgent(agent) {
  try {
    const s = agent.settings || {};
    await prisma.agent.upsert({
      where: { id: agent.id },
      update: {
        name:             agent.name,
        accent:           agent.accent  || null,
        gender:           agent.gender  || null,
        status:           agent.status  || 'active',
        voiceId:          agent.voiceId || null,
        companyName:      agent.companyName || null,
        script:           agent.script  || null,
        faqContext:       agent.faqContext || null,
        creativity:       s.creativity  ?? 75,
        patience:         s.patience    ?? 70,
        stability:        s.stability   ?? 60,
        voiceSpeed:       s.voiceSpeed  ?? 80,
        conversationStyle: s.conversationStyle || 'formal',
      },
      create: {
        id:               agent.id,
        name:             agent.name,
        accent:           agent.accent  || null,
        gender:           agent.gender  || null,
        status:           agent.status  || 'active',
        voiceId:          agent.voiceId || null,
        companyName:      agent.companyName || null,
        script:           agent.script  || null,
        faqContext:       agent.faqContext || null,
        creativity:       s.creativity  ?? 75,
        patience:         s.patience    ?? 70,
        stability:        s.stability   ?? 60,
        voiceSpeed:       s.voiceSpeed  ?? 80,
        conversationStyle: s.conversationStyle || 'formal',
      },
    });
  } catch (err) {
    logger.warn('Failed to persist agent to DB', { id: agent.id, error: err.message });
  }
}

// ─── Seed in-memory agents from DB on startup ─────────────────────────────
// 1. Upsert all hardcoded defaults to DB (so they persist from day one).
// 2. Restore any DB-saved settings on top of the defaults.
// 3. Load any custom agents created via POST that aren't in the hardcoded Map.
async function seedAgentsFromDB() {
  try {
    // Write defaults to DB if they don't exist yet
    for (const agent of agents.values()) {
      await persistAgent(agent);
    }

    const rows = await prisma.agent.findMany();
    rows.forEach(row => {
      const existing = agents.get(row.id);
      const base = existing || {
        stats: { callsToday: 0, bookings: 0, answerRate: 0, avgScore: 0, _scores: [], _answered: 0 },
        createdAt: row.createdAt?.toISOString() || new Date().toISOString(),
      };
      agents.set(row.id, {
        ...base,
        id:          row.id,
        name:        row.name,
        accent:      row.accent      || base.accent      || 'Neutral UK Business',
        gender:      row.gender      || base.gender      || 'Female',
        status:      row.status      || base.status      || 'active',
        voiceId:     row.voiceId     || base.voiceId     || null,
        companyName: row.companyName || base.companyName || 'VoiceIQ',
        script:      row.script      || base.script      || DEFAULT_PROTECTION_SCRIPT,
        faqContext:  row.faqContext  || base.faqContext  || null,
        settings: {
          creativity:        row.creativity        ?? 75,
          patience:          row.patience          ?? 70,
          stability:         row.stability         ?? 60,
          voiceSpeed:        row.voiceSpeed        ?? 80,
          conversationStyle: row.conversationStyle || 'formal',
        },
      });
    });
    logger.info('Agents seeded from DB', { count: rows.length });
  } catch (err) {
    logger.warn('Could not seed agents from DB — using defaults', { error: err.message });
  }
}

seedAgentsFromDB();

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

// ─── List all agents — enrich with live DB stats ──────────────────────────
router.get('/', async (req, res) => {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // Single query: all calls grouped by agentId for today
    const todayCalls = await prisma.call.groupBy({
      by: ['agentId'],
      where: { loggedAt: { gte: todayStart } },
      _count: { id: true },
    });

    const bookedToday = await prisma.call.groupBy({
      by: ['agentId'],
      where: {
        loggedAt:  { gte: todayStart },
        OR: [
          { bookingId: { not: null } },
          { outcome: 'meeting_booked' },
        ],
      },
      _count: { id: true },
    });

    const answeredToday = await prisma.call.groupBy({
      by: ['agentId'],
      where: {
        loggedAt: { gte: todayStart },
        outcome:  { notIn: ['no_answer', 'no-answer'] },
        status:   { not: 'no-answer' },
      },
      _count: { id: true },
    });

    // Build lookup maps
    const callsMap    = Object.fromEntries(todayCalls.map(r   => [r.agentId, r._count.id]));
    const bookedMap   = Object.fromEntries(bookedToday.map(r  => [r.agentId, r._count.id]));
    const answeredMap = Object.fromEntries(answeredToday.map(r => [r.agentId, r._count.id]));

    const result = Array.from(agents.values()).map(a => {
      const calls    = callsMap[a.id]    || 0;
      const booked   = bookedMap[a.id]   || 0;
      const answered = answeredMap[a.id] || 0;
      const { _scores, _answered, ...pub } = a.stats;
      return {
        ...a,
        stats: {
          ...pub,
          callsToday:  calls,
          bookings:    booked,
          answerRate:  calls ? parseFloat((answered / calls).toFixed(2)) : 0,
        },
      };
    });

    res.json({ agents: result });
  } catch (err) {
    logger.warn('Failed to fetch agent stats from DB', { error: err.message });
    res.json({ agents: Array.from(agents.values()).map(publicAgent) });
  }
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
  persistAgent(agent);
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
  persistAgent(agent);
  res.json(agent);
});

// ─── Delete agent ─────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  if (!agents.has(id)) return res.status(404).json({ error: 'Agent not found' });
  if (agents.size <= 1) return res.status(400).json({ error: 'Cannot delete the last agent' });
  agents.delete(id);
  try { await prisma.agent.delete({ where: { id } }); } catch (_) { /* already gone */ }
  res.json({ deleted: true, id });
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
