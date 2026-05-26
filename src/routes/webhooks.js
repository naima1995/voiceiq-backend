const express = require('express');
const router = express.Router();
const gemini = require('../services/gemini');
const teams = require('../services/teams');
const elevenlabs = require('../services/elevenlabs');
const { emit } = require('../services/websocket');
const { logCall } = require('./calls');
const logger = require('../utils/logger');
const audioCache = require('../utils/audioCache');

// ─── Helper: wrap content in TwiML root element ───────────────────────────
function twiml(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}

// ─── Twilio: call answered — generate greeting, start AI session ──────────
router.post('/twilio/answer', async (req, res) => {
  const { agentId = 'james', callId, leadName = '', leadCompany = '' } = req.query;
  const { CallSid, From, To } = req.body;
  const voiceiqCallId = callId || CallSid;
  const base = process.env.CALLBACK_BASE_URL;

  try {
    gemini.startSession({
      callId: voiceiqCallId,
      agentConfig: { name: agentId, companyName: process.env.COMPANY_NAME || 'VoiceIQ' },
      leadData: { name: leadName, company: leadCompany, phoneNumber: From },
    });

    const aiResponse  = await gemini.processTurn({ callId: voiceiqCallId, userSpeech: null });
    const audioBuffer = await elevenlabs.textToSpeech({
      text: elevenlabs.addNaturalPauses(aiResponse.speech),
      agentName: agentId,
    });
    const audioUrl  = `${base}/api/voice/audio/${audioCache.store(audioBuffer)}`;
    const speechUrl = `${base}/api/webhooks/twilio/speech?agentId=${encodeURIComponent(agentId)}&callId=${encodeURIComponent(voiceiqCallId)}`;

    emit.callStarted({ callId: voiceiqCallId, twilioCallSid: CallSid, fromNumber: From, toNumber: To, agentId });
    logger.info('Twilio call answered', { voiceiqCallId, speech: aiResponse.speech });

    res.type('text/xml').send(twiml(`
      <Play>${audioUrl}</Play>
      <Gather input="speech" action="${speechUrl}" method="POST" speechTimeout="auto" speechModel="phone_call" language="en-GB"></Gather>
      <Redirect method="POST">${base}/api/webhooks/twilio/answer?agentId=${encodeURIComponent(agentId)}&amp;callId=${encodeURIComponent(voiceiqCallId)}</Redirect>
    `));
  } catch (err) {
    logger.error('Twilio answer webhook error', { error: err.message });
    res.type('text/xml').send(twiml(`<Say voice="Polly.Amy">Sorry, I'm having a technical issue. Please call back shortly.</Say><Hangup/>`));
  }
});

// ─── Twilio: speech received — AI processes and responds ─────────────────
router.post('/twilio/speech', async (req, res) => {
  const { agentId = 'james', callId } = req.query;
  const { SpeechResult, CallSid } = req.body;
  const voiceiqCallId = callId || CallSid;
  const base = process.env.CALLBACK_BASE_URL;
  const speechUrl = `${base}/api/webhooks/twilio/speech?agentId=${encodeURIComponent(agentId)}&callId=${encodeURIComponent(voiceiqCallId)}`;

  try {
    if (!SpeechResult) {
      return res.type('text/xml').send(twiml(`
        <Gather input="speech" action="${speechUrl}" method="POST" speechTimeout="auto" speechModel="phone_call" language="en-GB"></Gather>
      `));
    }

    emit.prospectSpeaking({ callId: voiceiqCallId, speech: SpeechResult });

    const aiResponse  = await gemini.processTurn({ callId: voiceiqCallId, userSpeech: SpeechResult });
    const audioBuffer = await elevenlabs.textToSpeech({
      text: elevenlabs.addNaturalPauses(aiResponse.speech),
      agentName: agentId,
    });
    const audioUrl = `${base}/api/voice/audio/${audioCache.store(audioBuffer)}`;

    emit.agentSpeaking({ callId: voiceiqCallId, speech: aiResponse.speech, intent: aiResponse.intent });

    if (aiResponse.doNotCall) {
      return res.type('text/xml').send(twiml(`<Play>${audioUrl}</Play><Hangup/>`));
    }

    if (aiResponse.transferred) {
      const dialVerb = process.env.TRANSFER_NUMBER
        ? `<Dial>${process.env.TRANSFER_NUMBER}</Dial>`
        : '<Hangup/>';
      return res.type('text/xml').send(twiml(`<Play>${audioUrl}</Play>${dialVerb}`));
    }

    res.type('text/xml').send(twiml(`
      <Play>${audioUrl}</Play>
      <Gather input="speech" action="${speechUrl}" method="POST" speechTimeout="auto" speechModel="phone_call" language="en-GB"></Gather>
      <Redirect method="POST">${base}/api/webhooks/twilio/answer?agentId=${encodeURIComponent(agentId)}&amp;callId=${encodeURIComponent(voiceiqCallId)}</Redirect>
    `));
  } catch (err) {
    logger.error('Twilio speech webhook error', { error: err.message });
    res.type('text/xml').send(twiml(`<Say voice="Polly.Amy">One moment please.</Say><Pause length="1"/><Hangup/>`));
  }
});

// ─── Twilio: call status updates ─────────────────────────────────────────
router.post('/twilio/status', async (req, res) => {
  res.status(200).send();
  const { CallSid, CallStatus, CallDuration, From, To } = req.body;
  logger.info('Twilio status update', { CallSid, CallStatus, CallDuration });

  if (['completed', 'failed', 'no-answer', 'busy', 'canceled'].includes(CallStatus)) {
    const duration = parseInt(CallDuration || 0);
    let summary = null;
    try {
      summary = await gemini.generateCallSummary({ callId: CallSid, duration });
      gemini.endSession(CallSid);
    } catch (err) {
      logger.warn('Call summary failed', { error: err.message });
    }

    logCall({
      callId:    CallSid,
      direction: 'outbound',
      channel:   'twilio',
      toNumber:  To,
      fromNumber: From,
      duration,
      endedAt:   new Date().toISOString(),
      summary,
      outcome:   summary?.outcome || CallStatus,
    });

    emit.callEnded({ callId: CallSid, duration, status: CallStatus, channel: 'twilio' });
    if (summary) emit.callSummary({ callId: CallSid, summary });
  }
});

// ─── Microsoft Teams Call Events ──────────────────────────────────────────
// Microsoft sends call state notifications to this endpoint.
// Must be publicly reachable — use ngrok in dev.
// Register as callbackUri in every Teams call payload.
router.post('/teams/call-events', async (req, res) => {
  // Microsoft requires a 200 immediately — process async
  res.status(200).send();

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    logger.error('Teams webhook: could not parse body');
    return;
  }

  const { value } = body;
  if (!Array.isArray(value)) return;

  for (const event of value) {
    await handleTeamsCallEvent(event);
  }
});

async function handleTeamsCallEvent(event) {
  const { resourceData, changeType } = event;
  if (!resourceData) return;

  const teamsCallId = resourceData.id;
  const callState   = resourceData.state;

  logger.info('Teams call event', { teamsCallId, callState, changeType });

  // Parse voiceiq context stored in clientContext
  let voiceiqCtx = {};
  try {
    if (resourceData.clientContext) {
      voiceiqCtx = JSON.parse(resourceData.clientContext);
    }
  } catch { /* no context */ }

  const { voiceiqCallId, agentId } = voiceiqCtx;

  switch (callState) {

    // ── Call is ringing / connecting ─────────────────────────────────────
    case 'establishing':
      emit.callStarted({ callId: voiceiqCallId, teamsCallId, state: 'ringing' });
      break;

    // ── Call connected — AI speaks first ─────────────────────────────────
    case 'established': {
      emit.callStarted({ callId: voiceiqCallId, teamsCallId, state: 'connected' });

      // Trigger initial AI greeting
      try {
        const aiResponse = await gemini.processTurn({
          callId: voiceiqCallId,
          userSpeech: null, // null = opening turn
        });

        const session = gemini.getSession(voiceiqCallId);
        const agentName = session?.agentConfig?.name?.toLowerCase() || agentId || 'james';
        const audioBuffer = await elevenlabs.textToSpeech({
          text: elevenlabs.addNaturalPauses(aiResponse.speech),
          agentName,
        });

        // In full production: inject audio into Teams call via Bot Framework / ACS
        // For now: log the audio is ready
        logger.info('Opening audio ready', {
          callId: voiceiqCallId,
          speech: aiResponse.speech,
          audioBytes: audioBuffer.length,
        });

        emit.agentSpeaking({
          callId:    voiceiqCallId,
          teamsCallId,
          speech:    aiResponse.speech,
          intent:    aiResponse.intent,
        });
      } catch (err) {
        logger.error('Failed to generate opening greeting', { error: err.message });
      }
      break;
    }

    // ── Call terminated ───────────────────────────────────────────────────
    case 'terminated': {
      const duration = resourceData.durationInSeconds || 0;

      let summary = null;
      if (voiceiqCallId) {
        summary = await gemini.generateCallSummary({ callId: voiceiqCallId, duration });
        gemini.endSession(voiceiqCallId);
      }

      const callRecord = {
        callId:      voiceiqCallId,
        teamsCallId,
        direction:   'outbound',
        channel:     'teams',
        agentId:     agentId || 'james',
        duration,
        endedAt:     new Date().toISOString(),
        summary,
      };

      logCall(callRecord);
      emit.callEnded({ ...callRecord });
      if (summary) emit.callSummary({ callId: voiceiqCallId, summary });

      logger.info('Call terminated and logged', {
        callId:  voiceiqCallId,
        outcome: summary?.outcome,
        duration,
      });
      break;
    }

    // ── Call updated (e.g. participant joined/left) ────────────────────────
    case 'updating':
      logger.debug('Teams call updating', { teamsCallId });
      break;

    default:
      logger.debug('Unhandled Teams call state', { callState, teamsCallId });
  }
}

// ─── Microsoft Graph Change Notifications validation ──────────────────────
// Microsoft sends a validationToken on initial subscription — must echo back
router.post('/teams/subscribe', (req, res) => {
  const { validationToken } = req.query;
  if (validationToken) {
    logger.info('Microsoft webhook validation', { validationToken });
    return res.status(200).contentType('text/plain').send(validationToken);
  }
  res.status(200).send();
});

// ─── Inbound call notification ────────────────────────────────────────────
// Fired when someone calls your Teams number
router.post('/teams/inbound', async (req, res) => {
  res.status(200).send();

  const { callId, from, to } = req.body;
  logger.info('Inbound Teams call', { callId, from, to });

  emit.callStarted({
    callId,
    fromNumber: from,
    toNumber:   to,
    direction:  'inbound',
    channel:    'teams',
  });
});

module.exports = router;
