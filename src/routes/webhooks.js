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
router.post('/teams/call-events', async (req, res) => {
  res.status(200).send(); // Microsoft requires immediate 200

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
    try {
      await handleTeamsCallEvent(event);
    } catch (err) {
      logger.error('Teams call event handler error', { error: err.message });
    }
  }
});

// ─── Parse voiceiq context from clientContext field ───────────────────────
// Supports both compact {v, a} and legacy {voiceiqCallId, agentId} shapes
function parseCtx(clientContext) {
  try {
    const c = JSON.parse(clientContext || '{}');
    return {
      voiceiqCallId: c.voiceiqCallId || c.v,
      agentId:       c.agentId       || c.a,
      leadData:      c.leadData      || {},
    };
  } catch { return {}; }
}

// ─── Build a public audio URL from ElevenLabs buffer ─────────────────────
async function buildAudioUrl(text, agentName) {
  const audioBuffer = await elevenlabs.textToSpeech({
    text: elevenlabs.addNaturalPauses(text),
    agentName,
  });
  return `${process.env.CALLBACK_BASE_URL}/api/voice/audio/${audioCache.store(audioBuffer)}`;
}

// ─── Main Teams event dispatcher ─────────────────────────────────────────
async function handleTeamsCallEvent(event) {
  const { resourceData } = event;
  if (!resourceData) return;

  const teamsCallId = resourceData.id;
  const { voiceiqCallId, agentId } = parseCtx(resourceData.clientContext);
  const agentName = (agentId || 'james').toLowerCase();

  // ── recognizeAsync completed — prospect has spoken ──────────────────────
  if (resourceData.recognizeResult) {
    await handleRecognizeCompleted({ teamsCallId, voiceiqCallId, agentName, recognizeResult: resourceData.recognizeResult });
    return;
  }

  const callState = resourceData.state;
  logger.info('Teams call event', { teamsCallId, callState, voiceiqCallId });

  switch (callState) {

    case 'establishing':
      emit.callStarted({ callId: voiceiqCallId, teamsCallId, state: 'ringing' });
      break;

    // ── Call connected — start AI session, play greeting, start listening ──
    case 'established': {
      emit.callStarted({ callId: voiceiqCallId, teamsCallId, state: 'connected' });

      gemini.startSession({
        callId: voiceiqCallId,
        agentConfig: {
          name: agentName,
          companyName: process.env.COMPANY_NAME || 'VoiceIQ',
        },
        leadData: parseCtx(resourceData.clientContext).leadData || {},
      });

      const aiResponse = await gemini.processTurn({ callId: voiceiqCallId, userSpeech: null });
      const audioUrl   = await buildAudioUrl(aiResponse.speech, agentName);

      emit.agentSpeaking({ callId: voiceiqCallId, teamsCallId, speech: aiResponse.speech, intent: aiResponse.intent });
      logger.info('Teams call established — playing greeting', { voiceiqCallId, speech: aiResponse.speech });

      await teams.recognizeAsync({
        teamsCallId,
        audioUrl,
        clientContext: JSON.stringify({ voiceiqCallId, agentId }),
      });
      break;
    }

    // ── Call ended ─────────────────────────────────────────────────────────
    case 'terminated': {
      const duration = resourceData.durationInSeconds || 0;
      let summary = null;

      if (voiceiqCallId) {
        try {
          summary = await gemini.generateCallSummary({ callId: voiceiqCallId, duration });
          gemini.endSession(voiceiqCallId);
        } catch (err) {
          logger.warn('Call summary failed', { error: err.message });
        }
      }

      const callRecord = {
        callId: voiceiqCallId, teamsCallId,
        direction: 'outbound', channel: 'teams',
        agentId: agentName, duration,
        endedAt: new Date().toISOString(), summary,
      };

      logCall(callRecord);
      emit.callEnded(callRecord);
      if (summary) emit.callSummary({ callId: voiceiqCallId, summary });
      logger.info('Teams call terminated', { voiceiqCallId, duration, outcome: summary?.outcome });
      break;
    }

    default:
      logger.debug('Unhandled Teams call state', { callState, teamsCallId });
  }
}

// ─── Handle recognizeAsync result — core AI conversation turn ─────────────
async function handleRecognizeCompleted({ teamsCallId, voiceiqCallId, agentName, recognizeResult }) {
  const recognitionType = recognizeResult.recognitionType;

  // Extract speech text — Microsoft returns it in different shapes
  const speechText = recognizeResult.speech?.speech
    || recognizeResult.speech?.text
    || recognizeResult.speechResult?.text
    || '';

  logger.info('Teams recognize completed', { teamsCallId, recognitionType, speechText });

  // No speech detected — reprompt gently
  if (!speechText || ['timeout', 'completedSilenceDetected', 'failed'].includes(recognitionType)) {
    logger.info('No speech detected, reprompting', { teamsCallId });
    const audioUrl = await buildAudioUrl("I'm sorry, I didn't catch that — could you say that again?", agentName);
    await teams.recognizeAsync({ teamsCallId, audioUrl, clientContext: JSON.stringify({ voiceiqCallId, agentId: agentName }) });
    return;
  }

  emit.prospectSpeaking({ callId: voiceiqCallId, speech: speechText });

  const aiResponse = await gemini.processTurn({ callId: voiceiqCallId, userSpeech: speechText });
  emit.agentSpeaking({ callId: voiceiqCallId, speech: aiResponse.speech, intent: aiResponse.intent });

  const audioUrl = await buildAudioUrl(aiResponse.speech, agentName);

  // Prospect asked to be removed from calling list
  if (aiResponse.doNotCall) {
    await teams.playAudioPrompt({ teamsCallId, audioUrl });
    setTimeout(() => teams.endCall(teamsCallId).catch(() => {}), 5000);
    return;
  }

  // Transfer to human agent
  if (aiResponse.transferred) {
    await teams.playAudioPrompt({ teamsCallId, audioUrl });
    if (process.env.TEAMS_TRANSFER_USER_ID) {
      await teams.transferCallToHuman({ teamsCallId, targetUserId: process.env.TEAMS_TRANSFER_USER_ID });
    } else {
      setTimeout(() => teams.endCall(teamsCallId).catch(() => {}), 5000);
    }
    emit.callTransferred({ callId: voiceiqCallId, teamsCallId });
    return;
  }

  // Continue conversation — play response and listen again
  await teams.recognizeAsync({
    teamsCallId,
    audioUrl,
    clientContext: JSON.stringify({ voiceiqCallId, agentId: agentName }),
  });
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
