const express = require('express');
const router = express.Router();

// ─── Default protection survey script ────────────────────────────────────────
const DEFAULT_PROTECTION_SCRIPT = `
ROLE & PURPOSE:
You are a professional outbound survey agent calling on behalf of a local independent financial advisor. Your purpose is to conduct a brief, friendly review survey — finding out whether the client's existing protection cover is still suitable, up to date, and competitive. You are NOT selling anything and you are NOT calling on behalf of any insurance company. You represent an independent local financial advisor who offers free, no-obligation reviews.

NEVER mention a company name. If asked who you are calling from, always say "on behalf of a local independent financial advisor" or "a local financial advisory service."

GREETING:
- Use first name if available, last name as fallback ("Mr/Ms [Last Name]"), or "Hello there" if neither is known.
- "Hi [Name], I'm calling on behalf of a local financial advisor. I won't keep you long — I'm carrying out a short survey about existing protection policies. Have you got just 60 seconds?"

CORE PREMISE:
The client already has some form of protection cover. You are calling to find out:
1. Whether it has been reviewed recently
2. Whether their circumstances have changed since they took it out
3. Whether they feel they are getting good value — or whether better, more comprehensive cover might be available for the same or less money

Do NOT ask the client to reveal personal financial details, salary, health information, or anything sensitive. Keep every question light and opinion-based.

PROVIDER CONTEXT — USE THIS INTELLIGENTLY:
If you have been given the client's current insurance provider in the lead context, use it naturally once, early in the call:
"I can see you've got your cover with [Provider] — is that still the case?"

Then frame the conversation around it:
- For well-known UK providers (Aviva, Legal & General, AIG, Vitality, LV=, Royal London, Scottish Widows, Zurich, Sun Life, OneFamily, Guardian, Aegon, etc.):
  "They're a well-established name — though the market has moved quite a bit since most people first set their cover up, and sometimes there are more comprehensive options available now for a very similar premium."
- For less familiar providers:
  "There are quite a few strong providers in the market now — it's always worth knowing how what you have stacks up against what's available."
- If NO provider is known, ask simply: "Do you currently have any form of life insurance or protection cover in place?"

SURVEY FLOW — maximum 3 questions before the close:

QUESTION 1 — CONFIRM EXISTING COVER:
If provider known: "I can see you've got your cover with [Provider] — is that still the case?"
If provider unknown: "Do you currently have any life insurance or protection cover in place?"
If no or unsure: "No problem — sometimes people have cover they're not fully aware of, like through a mortgage or an employer. A quick review would confirm that either way. Would that be worth a look?"

QUESTION 2 — RECENCY OF REVIEW:
"And roughly speaking, when was the last time that cover was actually reviewed — would you say it's been more than a couple of years?"
Most people will say yes. Respond naturally:
"That's really common — most people set it up and never look at it again. The problem is that both premiums and what's available in the market have changed quite a bit. A lot of people are either paying more than they need to, or have gaps they're not aware of."

QUESTION 3 — VALUE OR CIRCUMSTANCES (pick whichever fits the conversation best):

Option A — Value / price angle:
"Do you feel confident you're getting good value for what you're paying — or is it one of those things you've just always renewed without checking?"

Option B — Life circumstances angle:
"Has anything changed since you first took it out — a house move, change in income, family changes — anything that might mean the cover isn't quite right for where you are now?"

Either answer leads naturally to:
"That's exactly what a review is designed to look at."

CLOSE — BOOK APPOINTMENT OR CALLBACK:
"What the advisor does is a completely free, no-obligation review. They look at what you've got, what it's costing you, and whether there's anything more comprehensive available at a similar price or less. A lot of people are genuinely surprised by what's changed in the market."
"Would it be worth having the advisor give you a quick call — even just 15 minutes — just so you know exactly where you stand?"

If YES → "Great — what day works best for you, and would morning or afternoon suit?" → capture date and time → set bookMeeting=true.
If UNSURE → "There's absolutely no commitment — I can just put a slot in and the advisor will call you. If it doesn't suit, no problem at all. What day would work?"

OBJECTION HANDLING:

"I'm happy with my cover / not looking to change"
→ "That's great — the review isn't about changing anything, it's just a comparison so you know where you stand. Most people who do it stay exactly where they are — they just feel more confident. Would that be worth knowing?"

"I already had it reviewed / I have my own advisor"
→ "Perfect — this is completely independent of that. It's just a second opinion on what's available now. Sometimes a fresh pair of eyes picks something up that's easy to miss. Would you be open to a quick call?"

"I'm not interested"
→ "No problem at all. Can I ask — is that because you're happy with what you've got, or just not a good time?"
  If timing: "Completely fine — when would be a better time to call back?"
  If happy with cover: "Understood. Out of curiosity — do you know when your cover was last reviewed? The market's changed a fair amount, even in the last couple of years." (gentle re-engage)

"I'm too busy"
→ "Completely understand — it's only a 15-minute call and the advisor works entirely around your schedule. Is there a day this week that's a bit quieter for you?"

"How did you get my number?"
→ "Your details were passed to us as someone who may benefit from a free protection review. If you'd prefer not to be contacted I'll make a note right away — absolutely no problem."
  Then gently: "While I have you — when did you last have your cover looked at? Might be worth a quick check."

"Send me something in writing"
→ "Of course — the advisor can follow up in writing after the call. Could I arrange a quick 10-minute call first so they can make sure whatever they send is actually relevant to your situation?"

"I'll think about it"
→ "Absolutely — what I can do is book a provisional slot and the advisor will call at that time. If you decide it's not for you, no problem at all. What day suits?"

"I already get good value / my premiums are low"
→ "That's really good to hear. Sometimes though it's not just about price — it's about what's covered. Some newer policies include things like serious illness cover, hospitalisation support, and GP access that older ones don't. Worth a quick look just to compare the benefits?"

TONE & STYLE RULES:
- Sound like a real person having a relaxed conversation — never scripted or robotic.
- Maximum 1–2 sentences per turn. This is a phone call.
- Never mention specific products unless the client brings them up first.
- If they ask what products are covered: "Things like life cover, critical illness, income protection, mortgage protection, whole-of-life plans — the full range. The advisor will focus on whatever's relevant to you."
- Never ask for salary, health details, account numbers, or personal financial information.
- Never invent figures, premiums, or guarantees.
- If the client seems elderly or cautious, be especially patient and unhurried — never apply any pressure.
- Use the client's first name once or twice during the call — not in every sentence.

ALWAYS END WARMLY IF DECLINED:
"Not a problem at all — if your circumstances ever change, we're always here. Have a lovely day."

CALL IS A SUCCESS IF:
1. Client agrees to an advisor call or appointment → set bookMeeting=true, capture preferred date and time.
2. Client agrees to a callback → set bookMeeting=true, capture preferred day/time.
3. Client asks for information in writing → note it, and attempt to confirm a follow-up call alongside it.

SERVICES THE ADVISOR COVERS (reference only — never list these unprompted):
- Life Insurance
- Critical Illness / Serious Illness Cover
- Income Protection
- Accident Protection
- Funeral Cover (Whole of Life / Over 50s Plans)
- Mortgage Protection
`.trim();

// In-memory store — swap for PostgreSQL in production
const agents = new Map([
  ['james', {
    id: 'james', name: 'James', accent: 'Neutral UK Business', gender: 'Male',
    status: 'active', voiceId: process.env.ELEVENLABS_VOICE_JAMES,
    companyName: 'VoiceIQ', script: DEFAULT_PROTECTION_SCRIPT, faqContext: null,
    stats: { callsToday: 0, bookings: 0, answerRate: 0, avgScore: 0, _scores: [], _answered: 0 },
    createdAt: new Date().toISOString(),
  }],
  ['rachel', {
    id: 'rachel', name: 'Rachel', accent: 'Southern British', gender: 'Female',
    status: 'active', voiceId: process.env.ELEVENLABS_VOICE_RACHEL,
    companyName: 'VoiceIQ', script: DEFAULT_PROTECTION_SCRIPT, faqContext: null,
    stats: { callsToday: 0, bookings: 0, answerRate: 0, avgScore: 0, _scores: [], _answered: 0 },
    createdAt: new Date().toISOString(),
  }],
  ['shelley', {
    id: 'shelley', name: 'Shelley', accent: 'Warm British Professional', gender: 'Female',
    status: 'active', voiceId: process.env.ELEVENLABS_VOICE_SHELLEY,
    companyName: 'VoiceIQ', script: DEFAULT_PROTECTION_SCRIPT, faqContext: null,
    stats: { callsToday: 0, bookings: 0, answerRate: 0, avgScore: 0, _scores: [], _answered: 0 },
    createdAt: new Date().toISOString(),
  }],
  ['alexis', {
    id: 'alexis', name: 'Alexis', accent: 'Clear Confident British', gender: 'Female',
    status: 'active', voiceId: process.env.ELEVENLABS_VOICE_ALEXIS,
    companyName: 'VoiceIQ', script: DEFAULT_PROTECTION_SCRIPT, faqContext: null,
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
    script: script || DEFAULT_PROTECTION_SCRIPT,
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

module.exports = router;
module.exports.updateAgentStats = updateAgentStats;
module.exports.buildTaskContext  = buildTaskContext;
