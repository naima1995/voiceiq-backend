const express = require('express');
const router = express.Router();
const gemini = require('../services/gemini');
const elevenlabs = require('../services/elevenlabs');
const calendar = require('../services/calendar');
const { emit } = require('../services/websocket');
const { logCall } = require('./calls');
const { getKnowledgeForAgent } = require('./knowledge');
const { buildTaskContext } = require('./agents');
const logger = require('../utils/logger');
const audioCache = require('../utils/audioCache');

// ─── Helper: wrap content in TwiML root element ───────────────────────────
function twiml(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}

// ─── Twilio: call answered — generate greeting, start AI session ──────────
router.post('/twilio/answer', async (req, res) => {
  const {
    agentId = 'james', callId,
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
    // Load knowledge base content and task instructions for this agent
    const faqContext  = getKnowledgeForAgent(agentId);
    const taskContext = buildTaskContext(agentId);

    gemini.startSession({
      callId: voiceiqCallId,
      agentConfig: {
        name:        agentId,
        companyName: process.env.COMPANY_NAME || 'VoiceIQ',
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
    });
    const audioUrl  = `${base}/api/voice/audio/${audioCache.store(audioBuffer)}`;
    const speechUrl = `${base}/api/webhooks/twilio/speech?agentId=${encodeURIComponent(agentId)}&amp;callId=${encodeURIComponent(voiceiqCallId)}`;
    const answerUrl = `${base}/api/webhooks/twilio/answer?agentId=${encodeURIComponent(agentId)}&amp;callId=${encodeURIComponent(voiceiqCallId)}`;

    emit.callStarted({ callId: voiceiqCallId, twilioCallSid: CallSid, fromNumber: From, toNumber: To, agentId });
    logger.info('Twilio call answered', { voiceiqCallId, speech: aiResponse.speech });

    res.type('text/xml').send(twiml(`
      <Play>${audioUrl}</Play>
      <Gather input="speech" action="${speechUrl}" method="POST" speechTimeout="auto" speechModel="phone_call" language="en-GB"></Gather>
      <Redirect method="POST">${answerUrl}</Redirect>
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
  const speechUrl = `${base}/api/webhooks/twilio/speech?agentId=${encodeURIComponent(agentId)}&amp;callId=${encodeURIComponent(voiceiqCallId)}`;

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
