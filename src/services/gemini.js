const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const logger = require('../utils/logger');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ─── Safety settings — relaxed for sales context ──────────────────────────
const SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT,        threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,       threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
];

// ─── Base system instruction for all agents ───────────────────────────────
const BASE_SYSTEM_INSTRUCTION = `
You are a highly professional, natural-sounding UK AI sales agent making calls on behalf of a UK business.

VOICE & TONE RULES — follow these precisely:
- Speak in natural British English. Use contractions (I'm, you're, we've, that's).
- Use brief, realistic conversational fillers where natural: "Right", "Of course", "Absolutely", "That's a good point", "I understand".
- Keep responses SHORT — one or two sentences maximum per turn. This is a phone call, not an email.
- Never say "Certainly!", "Great choice!", or overly enthusiastic American-style phrases.
- Sound calm, confident, and genuinely interested — not robotic or salesy.
- If interrupted mid-sentence, stop and listen. Acknowledge what they said.
- Pause naturally at commas and full stops. Don't rush.

CALL BEHAVIOUR RULES:
- Always confirm you're speaking with the right person at the start.
- Never lie or make up information. If you don't know, say so naturally.
- Handle objections with empathy, not pressure.
- If the prospect says "speak to a person", "talk to someone real", or similar — immediately say you'll transfer them and set transferred=true.
- If the call is going well and the prospect is interested — move towards booking a meeting.
- When booking: confirm their name, email, and preferred time. Then confirm back.
- Never call back if they say "remove me from your list" — set doNotCall=true.

RESPONSE FORMAT — always respond with valid JSON only:
{
  "speech": "What you say out loud — natural spoken English, no markdown",
  "intent": "greeting | qualifying | pitching | objection_handling | booking | closing | transferring | ending",
  "sentiment": "positive | neutral | negative",
  "bookMeeting": false,
  "meetingDetails": null,
  "transferred": false,
  "doNotCall": false,
  "callScore": 0,
  "notes": "Brief internal note about this turn"
}

meetingDetails shape (when bookMeeting=true):
{
  "name": "prospect full name",
  "email": "their email",
  "preferredTime": "what they said e.g. 'Tuesday afternoon'",
  "purpose": "brief meeting purpose",
  "notes": "anything relevant from the conversation"
}

callScore: integer 1-10. Rate this specific turn's quality — how well the conversation is going.
`;

// ─── Build agent-specific system prompt ───────────────────────────────────
function buildSystemPrompt({ agentName, agentAccent, companyName, campaignScript, faqContext }) {
  return `${BASE_SYSTEM_INSTRUCTION}

YOUR IDENTITY:
- Your name is ${agentName}
- You have a ${agentAccent} accent and personality
- You are calling on behalf of: ${companyName}

CAMPAIGN SCRIPT & GOALS:
${campaignScript || 'Introduce the company, qualify the prospect, and book a discovery call.'}

${faqContext ? `COMPANY KNOWLEDGE BASE:\n${faqContext}` : ''}
`.trim();
}

// ─── Active conversation sessions (in-memory) ─────────────────────────────
// In production replace with Redis
const sessions = new Map();

// ─── Start a new call session ─────────────────────────────────────────────
function startSession({ callId, agentConfig, leadData }) {
  const rawName = agentConfig.name || 'James';
  const systemInstruction = buildSystemPrompt({
    agentName:      rawName.charAt(0).toUpperCase() + rawName.slice(1),
    agentAccent:    agentConfig.accent || 'Neutral UK Business',
    companyName:    agentConfig.companyName || 'VoiceIQ',
    campaignScript: agentConfig.script,
    faqContext:     agentConfig.faqContext,
  });

  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    systemInstruction,
    safetySettings: SAFETY_SETTINGS,
    generationConfig: {
      temperature:     0.75,   // Natural but not unpredictable
      topP:            0.92,
      topK:            40,
      maxOutputTokens: 300,    // Keep responses short — it's a phone call
      responseMimeType: 'application/json',
    },
  });

  const chat = model.startChat({
    history: [],
  });

  sessions.set(callId, {
    chat,
    callId,
    agentConfig,
    leadData,
    history: [],
    startedAt: new Date().toISOString(),
    turnCount: 0,
    overallSentiment: 'neutral',
    totalScore: 0,
  });

  logger.info('Gemini session started', { callId, agent: agentConfig.name });
  return sessions.get(callId);
}

// ─── Process a conversation turn ──────────────────────────────────────────
async function processTurn({ callId, userSpeech }) {
  const session = sessions.get(callId);
  if (!session) throw new Error(`No active session for callId: ${callId}`);

  session.turnCount++;
  logger.debug('Gemini turn', { callId, turn: session.turnCount, userSpeech });

  // First turn — AI speaks first (greeting). Pass a system trigger.
  const message = userSpeech || '[CALL_CONNECTED — start with your greeting now]';

  let rawText = '';
  try {
    const result = await session.chat.sendMessage(message);
    rawText = result.response.text();

    // Strip any accidental markdown code fences
    const cleaned = rawText.replace(/```json|```/gi, '').trim();
    const parsed = JSON.parse(cleaned);

    // Update session state
    session.history.push({ role: 'user', content: message, ts: new Date().toISOString() });
    session.history.push({ role: 'agent', content: parsed.speech, intent: parsed.intent, ts: new Date().toISOString() });
    session.totalScore += parsed.callScore || 5;
    session.overallSentiment = parsed.sentiment;

    logger.debug('Gemini response', { callId, intent: parsed.intent, sentiment: parsed.sentiment, score: parsed.callScore });

    return parsed;

  } catch (err) {
    logger.error('Gemini turn error', { callId, rawText, error: err.message });

    // Graceful fallback — keep call alive
    return {
      speech: "I do apologise, could you repeat that?",
      intent: 'qualifying',
      sentiment: 'neutral',
      bookMeeting: false,
      meetingDetails: null,
      transferred: false,
      doNotCall: false,
      callScore: 3,
      notes: 'Parse error — fallback response used',
    };
  }
}

// ─── Generate call summary after call ends ────────────────────────────────
async function generateCallSummary({ callId, duration }) {
  const session = sessions.get(callId);
  if (!session) return null;

  const avgScore = session.turnCount > 0
    ? Math.round(session.totalScore / session.turnCount * 10) / 10
    : 0;

  const historyText = session.history
    .map(h => `[${h.role.toUpperCase()}]: ${h.content}`)
    .join('\n');

  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 500,
      responseMimeType: 'application/json',
    },
  });

  const prompt = `
Analyse this UK sales call transcript and return a JSON summary.

TRANSCRIPT:
${historyText}

Return this JSON:
{
  "summary": "2-3 sentence plain English summary of the call",
  "outcome": "meeting_booked | interested | follow_up_needed | not_interested | no_answer | escalated | do_not_call",
  "keyPoints": ["array", "of", "key", "points", "max 5"],
  "objections": ["objections raised by prospect"],
  "nextAction": "what should happen next",
  "leadQuality": "hot | warm | cold | unqualified",
  "recommendedFollowUpDays": 0
}
`;

  try {
    const result = await model.generateContent(prompt);
    const cleaned = result.response.text().replace(/```json|```/gi, '').trim();
    const summaryData = JSON.parse(cleaned);

    const fullSummary = {
      callId,
      agentName:       session.agentConfig.name,
      leadName:        session.leadData?.name,
      leadCompany:     session.leadData?.company,
      duration,
      turnCount:       session.turnCount,
      avgCallScore:    avgScore,
      finalSentiment:  session.overallSentiment,
      startedAt:       session.startedAt,
      endedAt:         new Date().toISOString(),
      ...summaryData,
    };

    logger.info('Call summary generated', { callId, outcome: summaryData.outcome });
    return fullSummary;

  } catch (err) {
    logger.error('Summary generation failed', { callId, error: err.message });
    return {
      callId,
      summary: 'Summary generation failed — check logs.',
      outcome: 'follow_up_needed',
      avgCallScore: avgScore,
    };
  }
}

// ─── Analyse sentiment from transcript snippet ────────────────────────────
async function analyseSentiment(text) {
  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 100,
      responseMimeType: 'application/json',
    },
  });

  const result = await model.generateContent(
    `Rate the sentiment of this prospect speech in a UK sales call. Return JSON only: {"sentiment":"positive|neutral|negative","confidence":0.0,"emotion":"interested|hesitant|annoyed|friendly|busy|confused"}\n\nText: "${text}"`
  );

  const cleaned = result.response.text().replace(/```json|```/gi, '').trim();
  return JSON.parse(cleaned);
}

// ─── Handle objection with Gemini ─────────────────────────────────────────
async function generateObjectionResponse({ objection, agentName, companyName, script }) {
  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 150,
      responseMimeType: 'application/json',
    },
  });

  const result = await model.generateContent(`
You are ${agentName}, a UK sales agent for ${companyName}.
A prospect just said: "${objection}"
Context: ${script || 'General sales call'}

Respond naturally in British English — empathetic, not pushy. Max 2 sentences.
Return JSON: {"response": "your spoken reply"}
`);

  const cleaned = result.response.text().replace(/```json|```/gi, '').trim();
  return JSON.parse(cleaned);
}

// ─── Clean up session ────────────────────────────────────────────────────
function endSession(callId) {
  const existed = sessions.has(callId);
  sessions.delete(callId);
  logger.info('Gemini session ended', { callId, existed });
  return existed;
}

// ─── Get session state ────────────────────────────────────────────────────
function getSession(callId) {
  return sessions.get(callId) || null;
}

// ─── List all active sessions ────────────────────────────────────────────
function getActiveSessions() {
  return Array.from(sessions.values()).map(s => ({
    callId:    s.callId,
    agentName: s.agentConfig?.name,
    leadName:  s.leadData?.name,
    turnCount: s.turnCount,
    startedAt: s.startedAt,
    sentiment: s.overallSentiment,
  }));
}

module.exports = {
  startSession,
  processTurn,
  generateCallSummary,
  analyseSentiment,
  generateObjectionResponse,
  endSession,
  getSession,
  getActiveSessions,
};
