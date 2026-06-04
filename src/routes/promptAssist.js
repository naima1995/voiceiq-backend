const express = require('express');
const router  = express.Router();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger  = require('../utils/logger');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const ASSISTANT_SYSTEM_PROMPT = `
You are an expert AI prompt engineer and sales script specialist for UK outbound calling campaigns.
Your job is to help users build high-converting, OFCOM/GDPR-compliant AI call scripts for their VoiceIQ platform.

You have deep expertise in:
- UK outbound sales scripts and conversation flows
- Objection handling for common scenarios (not interested, voicemail, call back, price concerns, busy, gatekeeper)
- FCA-regulated financial services calling compliance
- Natural-sounding British English phrasing for AI voice agents
- Gemini AI prompt engineering for voice calling bots

When asked to write or improve prompts:
- Keep language natural, conversational British English
- Use short sentences suitable for voice (not email)
- Include [Pause 1s] or [Wait] markers where appropriate
- Reference {{variables}} like {{first_name}}, {{agent_name}}, {{company_name}} where useful
- Be specific and actionable — avoid vague filler text
- Always consider the caller's emotional state and respond with empathy

When suggesting objection handling:
- Acknowledge the objection before countering
- Never be pushy or aggressive
- Offer a graceful exit if the prospect is firm
- Suggest a follow-up approach where appropriate

Format your responses clearly. If providing a script/prompt, wrap it in a code block using triple backticks.
Keep responses concise and practical — the user wants to copy-paste and use immediately.
`;

// ─── In-memory conversation history per session ───────────────────────────
const sessions = new Map();

const MAX_HISTORY = 20; // keep last 20 turns per session

// ─── POST /api/prompt/assist ──────────────────────────────────────────────
router.post('/assist', async (req, res) => {
  const { message, sessionId, context } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });

  const sid = sessionId || 'default';

  // Build or retrieve history
  if (!sessions.has(sid)) sessions.set(sid, []);
  const history = sessions.get(sid);

  try {
    const model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      systemInstruction: ASSISTANT_SYSTEM_PROMPT,
    });

    // Include current script context if provided
    const contextNote = context
      ? `\n\n[Current script context the user is working on:\n${context}\n]`
      : '';

    const chat = model.startChat({
      history: history.slice(-MAX_HISTORY),
    });

    const result = await chat.sendMessage(message + contextNote);
    const reply  = result.response.text();

    // Update history
    history.push({ role: 'user',  parts: [{ text: message }] });
    history.push({ role: 'model', parts: [{ text: reply  }] });
    if (history.length > MAX_HISTORY * 2) history.splice(0, 2);

    logger.info('Prompt assistant response', { sid, messageLength: message.length });
    res.json({ reply, sessionId: sid });

  } catch (err) {
    logger.error('Prompt assistant error', { error: err.message });
    res.status(500).json({ error: 'AI assistant failed — please try again' });
  }
});

// ─── DELETE /api/prompt/assist/:sessionId — clear history ─────────────────
router.delete('/assist/:sessionId', (req, res) => {
  sessions.delete(req.params.sessionId);
  res.json({ cleared: true });
});

module.exports = router;
