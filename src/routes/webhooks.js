const express = require('express');
const router = express.Router();
const gemini = require('../services/gemini');
const elevenlabs = require('../services/elevenlabs');
const calendar = require('../services/calendar');
const { emit } = require('../services/websocket');
const { logCall } = require('./calls');
const { getKnowledgeForAgent } = require('./knowledge');
const { buildTaskContext, getAgent } = require('./agents');
const logger = require('../utils/logger');
const audioCache = require('../utils/audioCache');

// ─── Helper: wrap content in TwiML root element ───────────────────────────
function twiml(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}

// ─── Twilio: call answered — generate greeting, start AI session ──────────
router.post('/twilio/answer', async (req, res) => {
  const {
    agentId = 'rachel', callId,
    leadName = '', leadCompany = '',
    leadFname = '', leadLname = '', leadDob = '', leadPhone = '',
    leadAddr1 = '', leadAddr2 = '', leadAddr3 = '',
    leadTown = '', leadCountry = '', leadPost = '',
    leadProvider = '',
  } = req.query;
  const { CallSid, From, To } = req.body;
  const voiceiqCallId = callId || CallSid;
  const base = process.env.CALLBACK_BASE_URL;

  try {
    // Load agent config, knowledge base, and task instructions
    const agentConfig = getAgent(agentId) || {};
    const faqContext  = getKnowledgeForAgent(agentId);
    const taskContext = buildTaskContext(agentId);

    gemini.startSession({
      callId: voiceiqCallId,
      agentConfig: {
        name:        agentConfig.name       || agentId,
        accent:      agentConfig.accent     || 'Southern British',
        companyName: agentConfig.companyName || process.env.COMPANY_NAME || 'VoiceIQ',
        script:      agentConfig.script     || '',
        settings:    agentConfig.settings   || null,
        faqContext,
        taskContext,
      },
      leadData: {
        name:        leadName,
        company:     leadCompany,
        fname:       leadFname,
        lname:       leadLname,
        dob:         leadDob,
        phoneNumber: leadPhone || From,
        address:     leadAddr1,
        address2:    leadAddr2,
        address3:    leadAddr3,
        town:        leadTown,
        country:     leadCountry,
        postcode:    leadPost,
        provider:    leadProvider,
        callStarted: new Date().toISOString(),
      },
    });

    // Build a context-rich first-turn trigger so Gemini knows who it's calling
    const greeting = leadFname || leadLname || leadName || null;
    const contextLines = [
      greeting   ? `Client name: ${[leadFname, leadLname].filter(Boolean).join(' ') || leadName}` : null,
      leadDob    ? `Client age/DOB: ${leadDob}` : null,
      leadProvider ? `Client's current insurance provider: ${leadProvider}` : null,
      leadPost   ? `Client postcode: ${leadPost}` : null,
    ].filter(Boolean);

    const firstTurnMessage = contextLines.length
      ? `[CALL_CONNECTED]\nLead context:\n${contextLines.join('\n')}\n\nStart with your greeting now.`
      : `[CALL_CONNECTED — start with your greeting now]`;

    const aiResponse  = await gemini.processTurn({ callId: voiceiqCallId, userSpeech: firstTurnMessage });
    const audioBuffer = await elevenlabs.textToSpeech({
      text: elevenlabs.addNaturalPauses(aiResponse.speech),
      agentName: agentId,
      agentSettings: agentConfig.settings || null,
    });
    const audioUrl  = `${base}/api/voice/audio/${audioCache.store(audioBuffer)}`;
    const speechUrl = `${base}/api/webhooks/twilio/speech?agentId=${encodeURIComponent(agentId)}&amp;callId=${encodeURIComponent(voiceiqCallId)}`;
    const answerUrl = `${base}/api/webhooks/twilio/answer?agentId=${encodeURIComponent(agentId)}&amp;callId=${encodeURIComponent(voiceiqCallId)}`;

    emit.callStarted({ callId: voiceiqCallId, twilioCallSid: CallSid, fromNumber: From, toNumber: To, agentId });
    logger.info('Twilio call answered', { voiceiqCallId, speech: aiResponse.speech });

    res.type('text/xml').send(twiml(`
      <Gather input="speech" action="${speechUrl}" method="POST" speechTimeout="auto" language="en-GB" timeout="15">
        <Play>${audioUrl}</Play>
      </Gather>
      <Redirect method="POST">${speechUrl}</Redirect>
    `));
  } catch (err) {
    logger.error('Twilio answer webhook error', { error: err.message });
    const fallbackSpeechUrl = `${process.env.CALLBACK_BASE_URL}/api/webhooks/twilio/speech?agentId=${encodeURIComponent(agentId)}&amp;callId=${encodeURIComponent(callId || '')}`;
    res.type('text/xml').send(twiml(`
      <Gather input="speech" action="${fallbackSpeechUrl}" method="POST" speechTimeout="auto" language="en-GB" timeout="15">
        <Say language="en-GB">One moment please.</Say>
      </Gather>
      <Redirect method="POST">${fallbackSpeechUrl}</Redirect>
    `));
  }
});

// ─── Twilio: AMD (Answering Machine Detection) callback ──────────────────
// Fired async by Twilio when machineDetection result is ready.
// If it's a machine/voicemail, end the call via REST immediately.
router.post('/twilio/amd', async (req, res) => {
  res.status(200).send(); // respond immediately
  const { CallSid, AnsweredBy } = req.body;
  // AnsweredBy values: 'human' | 'machine_start' | 'machine_end_beep' |
  //                   'machine_end_silence' | 'machine_end_other' | 'fax' | 'unknown'
  const isMachine = AnsweredBy && AnsweredBy.startsWith('machine');
  const isFax     = AnsweredBy === 'fax';

  if (isMachine || isFax) {
    logger.info('AMD: machine/voicemail detected — ending call', { CallSid, AnsweredBy });
    try {
      const twilio = require('twilio');
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      await client.calls(CallSid).update({ status: 'completed' });
    } catch (err) {
      logger.warn('AMD: failed to end call', { CallSid, error: err.message });
    }
  }
});

// ─── AI screener keyword detection ───────────────────────────────────────
// Phrases used by Google Call Screen, Apple Announce Calls,
// Samsung Bixby Text Call, and generic voicemail prompts.
const AI_SCREENER_PATTERNS = [
  // Google Call Screen
  /who(?:'s| is) (?:calling|this)/i,
  /what(?:'s| is) (?:this|the call) (?:regarding|about|for)/i,
  /this call is being screened/i,
  /google.*screen/i,
  /can you tell me.*(?:calling|reason)/i,
  // Apple Announce Calls / Call Screening
  /(?:who are you|who is this|what is this regarding)/i,
  /announce.*call/i,
  // Samsung Bixby Text Call
  /bixby/i,
  /call assistant/i,
  /text call/i,
  /this call is being assisted/i,
  // Generic voicemail / answering machine beep prompts
  /please leave (?:a |your )?message/i,
  /leave (?:a |your )?message after the (?:tone|beep)/i,
  /not (?:available|here) right now/i,
  /(?:record|leave) (?:a )?(?:message|voicemail)/i,
  /speak after the (?:tone|beep)/i,
  /no one is available/i,
  /(?:voicemail|answering machine)/i,
];

function isAIScreenerOrVoicemail(speech) {
  if (!speech) return false;
  return AI_SCREENER_PATTERNS.some(pattern => pattern.test(speech));
}

// ─── Twilio: speech received — AI processes and responds ─────────────────
router.post('/twilio/speech', async (req, res) => {
  const { agentId = 'rachel', callId, silence = '0' } = req.query;
  const { SpeechResult, CallSid } = req.body;
  const voiceiqCallId = callId || CallSid;
  const base = process.env.CALLBACK_BASE_URL;
  const speechUrl = `${base}/api/webhooks/twilio/speech?agentId=${encodeURIComponent(agentId)}&amp;callId=${encodeURIComponent(voiceiqCallId)}`;
  const agentConfig = getAgent(agentId) || {};

  try {
    if (!SpeechResult) {
      const silenceCount = parseInt(silence, 10) || 0;
      if (silenceCount >= 1) {
        // Second consecutive silence — no one home, end the call cleanly
        logger.info('No speech after 2 attempts — ending call', { voiceiqCallId });
        gemini.endSession(voiceiqCallId);
        return res.type('text/xml').send(twiml(`<Hangup/>`));
      }
      // First silence — give one more chance
      const retryUrl = `${base}/api/webhooks/twilio/speech?agentId=${encodeURIComponent(agentId)}&amp;callId=${encodeURIComponent(voiceiqCallId)}&amp;silence=1`;
      return res.type('text/xml').send(twiml(`
        <Gather input="speech" action="${retryUrl}" method="POST" speechTimeout="auto" language="en-GB" timeout="15">
        </Gather>
        <Redirect method="POST">${retryUrl}</Redirect>
      `));
    }

    // ── Screener / voicemail guard — hang up silently, no message ────────
    if (isAIScreenerOrVoicemail(SpeechResult)) {
      logger.info('AI screener or voicemail detected — ending call silently', {
        voiceiqCallId, speech: SpeechResult,
      });
      gemini.endSession(voiceiqCallId);
      return res.type('text/xml').send(twiml(`<Hangup/>`));
    }

    emit.prospectSpeaking({ callId: voiceiqCallId, speech: SpeechResult });

    const aiResponse  = await gemini.processTurn({ callId: voiceiqCallId, userSpeech: SpeechResult });
    const audioBuffer = await elevenlabs.textToSpeech({
      text: elevenlabs.addNaturalPauses(aiResponse.speech),
      agentName: agentId,
      agentSettings: agentConfig.settings || null,
    });
    const audioUrl = `${base}/api/voice/audio/${audioCache.store(audioBuffer)}`;

    emit.agentSpeaking({ callId: voiceiqCallId, speech: aiResponse.speech, intent: aiResponse.intent });

    // ── Create calendar task when AI confirms booking ─────────────────────
    if (aiResponse.bookMeeting && aiResponse.meetingDetails) {
      const md      = aiResponse.meetingDetails;
      const session = gemini.getSession(voiceiqCallId);
      const lead    = session?.leadData || {};

      try {
        // Time of the original call (when agent spoke to client)
        const callTime = lead.callStarted ? new Date(lead.callStarted) : new Date();

        // Format helper — UK date DD/MM/YYYY and time HH:MM AM/PM
        const toUKDate = (d) => d.toLocaleDateString('en-GB', { timeZone: 'Europe/London' });
        const toUKTime = (d) => d.toLocaleTimeString('en-GB', {
          timeZone: 'Europe/London',
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
        }).toUpperCase();

        // Resolve callback/meeting time — prefer AI-extracted time, fall back to next day 14:00
        let callbackTime = null;
        const rawPreferred = md.startTime || md.preferredTime;
        if (rawPreferred && !isNaN(Date.parse(rawPreferred))) {
          callbackTime = new Date(rawPreferred);
        }

        // Safety net — never book same-day; push to next working day at 14:00 if needed
        const today = new Date(callTime);
        today.setHours(0, 0, 0, 0);
        if (!callbackTime || callbackTime <= today) {
          // Find next working day (skip Saturday/Sunday)
          const nextDay = new Date(callTime);
          nextDay.setDate(nextDay.getDate() + 1);
          nextDay.setHours(14, 0, 0, 0);
          if (nextDay.getDay() === 6) nextDay.setDate(nextDay.getDate() + 2); // skip Saturday
          if (nextDay.getDay() === 0) nextDay.setDate(nextDay.getDate() + 1); // skip Sunday
          callbackTime = nextDay;
          logger.warn('Same-day booking blocked — pushed to next working day', {
            voiceiqCallId, original: rawPreferred, rescheduled: callbackTime,
          });
        }

        const callDateStr     = toUKDate(callTime);
        const callTimeStr     = toUKTime(callTime);
        const callbackDateStr = toUKDate(callbackTime);
        const callbackTimeStr = toUKTime(callbackTime);

        // Build full address from lead fields
        const addressParts = [
          lead.address, lead.address2, lead.address3,
          lead.town, lead.country, lead.postcode,
        ].filter(Boolean);
        const fullAddress = addressParts.join(', ') || 'Not provided';

        const agentName = session?.agentConfig?.name || agentId;

        const task = await calendar.createTask({
          title:   `Call Reminder — ${lead.fname || md.name?.split(' ')[0] || 'Prospect'} ${lead.lname || md.name?.split(' ').slice(1).join(' ') || ''}`.trim(),
          dueTime: callbackTime.toISOString(),
          notes: [
            `Spoke to the client on ${callDateStr} at ${callTimeStr}, and the client requested a call back on ${callbackDateStr} at ${callbackTimeStr}.`,
            ``,
            `First Name:          ${lead.fname    || md.name?.split(' ')[0] || 'N/A'}`,
            `Last Name:           ${lead.lname    || md.name?.split(' ').slice(1).join(' ') || 'N/A'}`,
            `DOB:                 ${lead.dob      || 'N/A'}`,
            `Current Provider:    ${lead.provider || 'N/A'}`,
            `Address:             ${fullAddress}`,
            ``,
            `Meeting/Call Date:   ${callbackDateStr}`,
            `Meeting/Call Time:   ${callbackTimeStr}`,
            ``,
            `Mobile No:           ${lead.phoneNumber || 'N/A'}`,
            ``,
            `Booked by Agent:     ${agentName}`,
            `AI Notes:            ${md.notes || 'N/A'}`,
          ].join('\n'),
        });

        if (session) session.bookingResult = task;

        emit.meetingBooked({
          callId:    voiceiqCallId,
          taskId:    task.taskId,
          name:      `${lead.fname || ''} ${lead.lname || ''}`.trim() || md.name,
          date:      ukDate,
          time:      ukTime,
          phone:     lead.phoneNumber,
          agentName,
        });

        logger.info('Calendar task created during call', {
          voiceiqCallId,
          taskId: task.taskId,
          name:   `${lead.fname} ${lead.lname}`,
        });

      } catch (bookErr) {
        logger.error('Calendar task creation failed during call', { voiceiqCallId, error: bookErr.message });
      }
    }

    // Gemini detected a screener/voicemail mid-call — hang up silently
    if (aiResponse.hangUpNow) {
      logger.info('Gemini flagged hangUpNow — ending call silently', { voiceiqCallId });
      gemini.endSession(voiceiqCallId);
      return res.type('text/xml').send(twiml(`<Hangup/>`));
    }

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
      <Gather input="speech" action="${speechUrl}" method="POST" speechTimeout="auto" language="en-GB" timeout="15">
        <Play>${audioUrl}</Play>
      </Gather>
      <Redirect method="POST">${speechUrl}</Redirect>
    `));
  } catch (err) {
    logger.error('Twilio speech webhook error', { error: err.message });
    // On any error keep the call alive — re-gather rather than hang up
    res.type('text/xml').send(twiml(`
      <Gather input="speech" action="${speechUrl}" method="POST" speechTimeout="auto" language="en-GB" timeout="15">
        <Say language="en-GB">Sorry, one moment.</Say>
      </Gather>
      <Redirect method="POST">${speechUrl}</Redirect>
    `));
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
    let bookingResult = null;
    try {
      // Grab booking result before session is destroyed
      const session = gemini.getSession(CallSid);
      bookingResult = session?.bookingResult || null;

      summary = await gemini.generateCallSummary({ callId: CallSid, duration });
      gemini.endSession(CallSid);
    } catch (err) {
      logger.warn('Call summary failed', { error: err.message });
      gemini.endSession(CallSid);
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
      ...(bookingResult && {
        booking: {
          taskId:   bookingResult.taskId   || null,
          eventId:  bookingResult.eventId  || null,
          htmlLink: bookingResult.htmlLink || null,
          due:      bookingResult.due      || bookingResult.start || null,
        },
      }),
    });

    emit.callEnded({ callId: CallSid, duration, status: CallStatus, channel: 'twilio' });
    if (summary) emit.callSummary({ callId: CallSid, summary });
  }
});


module.exports = router;
