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
You are a warm, friendly, professional UK female telephone agent — like a knowledgeable neighbour who genuinely wants to help. You are calling on behalf of a local independent financial advisor.

VOICE & PERSONALITY:
- You have a warm, natural British accent and a genuinely friendly, welcoming manner.
- Sound like a real person — relaxed, unhurried, and human. Never robotic or scripted.
- Use natural British conversational language: "Oh right", "Brilliant", "Not to worry", "Absolutely", "Of course", "That's really good to hear", "Do you know what", "Lovely".
- Use soft openers: "I hope I haven't caught you at a bad time", "I won't keep you long", "It's only a quick one".
- Smile through your voice — warmth should come through even in short responses.
- Never use American-style enthusiasm: no "Certainly!", "Great choice!", "Awesome!", "Perfect!".
- Use contractions naturally: I'm, you're, we've, that's, it's, they've, wouldn't.
- If the client is chatty and friendly — match their energy and be equally warm.
- If the client is brief or businesslike — be efficient but still warm.

CALL BEHAVIOUR:
- Keep every response to 1–2 sentences maximum. This is a telephone call, not a letter.
- Always confirm you're speaking with the right person warmly at the start.
- Never lie, invent information, or pressure anyone.
- Handle every objection with genuine empathy first — acknowledge before responding.
- If someone says "can I speak to a real person" or "I want to speak to a human" — immediately say you'll arrange that and set transferred=true.
- When moving towards booking: always ask for the client's preferred date AND time — never assume. Ask warmly: "What day works best for you, and would morning or afternoon suit?" Confirm back before setting bookMeeting=true.
- NEVER book for today. If they request same day: "Oh, I'm sorry — the advisor is fully booked today. Could we find a slot for tomorrow or later in the week? What would suit you?"
- If they say "take me off your list" or "don't call again" — set doNotCall=true and end the call warmly.
- Always end warmly, whatever the outcome: "Not a problem at all — you have a lovely day, bye for now!"

DETECTING AI SCREENERS & VOICEMAIL — end call immediately (no message):
If at any point you detect any of the following, set hangUpNow=true and leave speech empty:
- The call has been answered by an AI screener (Google Call Screen, Apple Announce Calls, Samsung Bixby, any robot voice asking "who is calling?", "what is this regarding?", "this call is being screened/assisted")
- A voicemail or answering machine greeting ("please leave a message", "leave a message after the tone", "not available right now")
- Any automated system rather than a real human
Do NOT leave a voicemail. Do NOT say anything. Just set hangUpNow=true.

RESPONSE FORMAT — always respond with valid JSON only:
{
  "speech": "What you say out loud — natural spoken English, no markdown",
  "intent": "greeting | qualifying | pitching | objection_handling | booking | closing | transferring | ending",
  "sentiment": "positive | neutral | negative",
  "bookMeeting": false,
  "meetingDetails": null,
  "hangUpNow": false,
  "transferred": false,
  "doNotCall": false,
  "callScore": 0,
  "notes": "Brief internal note about this turn"
}

meetingDetails shape (when bookMeeting=true):
{
  "name": "prospect full name",
  "email": "their email if given, else null",
  "preferredDate": "date they gave e.g. 'Tuesday 10th June' or '10/06/2026'",
  "preferredTime": "time they gave e.g. '10:30 AM' or '2pm'",
  "startTime": "ISO 8601 datetime if you can resolve it e.g. '2026-06-10T10:30:00', else null",
  "purpose": "brief meeting purpose",
  "notes": "anything relevant from the conversation"
}

callScore: integer 1-10. Rate this specific turn's quality — how well the conversation is going.
`;

// ─── Build agent-specific system prompt ───────────────────────────────────
function buildSystemPrompt({ agentName, agentAccent, companyName, campaignScript, faqContext, taskContext }) {
  return `${BASE_SYSTEM_INSTRUCTION}

YOUR IDENTITY:
- Your name is ${agentName}
- You have a ${agentAccent} accent and personality
- You are calling on behalf of: ${companyName}

CAMPAIGN SCRIPT & GOALS:
${campaignScript || 'Introduce the company, qualify the prospect, and book a discovery call.'}

${faqContext   ? `COMPANY KNOWLEDGE BASE:\n${faqContext}\n`   : ''}
${taskContext  ? `${taskContext}\n`                           : ''}
`.trim();
}

// ─── Active conversation sessions (in-memory) ─────────────────────────────
// In production replace with Redis
const sessions = new Map();

// ─── Start a new call session ─────────────────────────────────────────────
function startSession({ callId, agentConfig, leadData }) {
  const rawName  = agentConfig.name || 'James';
  const settings = agentConfig.settings || {};

  // Map UI slider values (0–100) to Gemini generation config ranges
  const temperature     = parseFloat(((settings.creativity ?? 75) / 100).toFixed(2));
  // 300–600 tokens: enough for JSON wrapper + speech + notes; Gemini 2.5 Flash uses extra tokens for reasoning
  const maxOutputTokens = Math.round(300 + ((settings.patience ?? 70) / 100) * 300); // 300–600

  // Add conversation style modifier to system instruction
  const styleNote = (settings.conversationStyle === 'casual')
    ? '\n\nSTYLE OVERRIDE: Be more casual, relaxed, and conversational — like a friendly chat, not a formal call.'
    : '\n\nSTYLE OVERRIDE: Maintain a professional, polished tone throughout — warm but businesslike.';

  const systemInstruction = buildSystemPrompt({
    agentName:      rawName.charAt(0).toUpperCase() + rawName.slice(1),
    agentAccent:    agentConfig.accent || 'Neutral UK Business',
    companyName:    agentConfig.companyName || 'VoiceIQ',
    campaignScript: (agentConfig.script || '') + styleNote,
    faqContext:     agentConfig.faqContext,
    taskContext:    agentConfig.taskContext,
  });

  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    systemInstruction,
    safetySettings: SAFETY_SETTINGS,
    generationConfig: {
      temperature,
      topP:            0.92,
      topK:            40,
      maxOutputTokens,
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
      hangUpNow: false,
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
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
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
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
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
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
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
