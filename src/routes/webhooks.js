const express = require('express');
const router = express.Router();
const gemini = require('../services/gemini');
const teams = require('../services/teams');
const elevenlabs = require('../services/elevenlabs');
const { emit } = require('../services/websocket');
const { logCall } = require('./calls');
const logger = require('../utils/logger');

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
        const agentName = session?.agentConfig?.name?.toLowerCase() || agentId || 'sophia';
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
        agentId:     agentId || 'sophia',
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
