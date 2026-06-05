const express = require('express');
const router = express.Router();
const gemini = require('../services/gemini');
const elevenlabs = require('../services/elevenlabs');
const calendar = require('../services/calendar');
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

    // ── Book calendar meeting if AI confirmed booking ─────────────────────
    if (aiResponse.bookMeeting && aiResponse.meetingDetails) {
      const md = aiResponse.meetingDetails;
      try {
        // Resolve a concrete start time — if the AI gave a vague string like
        // "Tuesday afternoon" we schedule 24 hrs from now as a safe fallback;
        // a proper NLP date-resolver can be added later.
        let startTime = md.startTime || md.preferredTime;
        if (!startTime || isNaN(Date.parse(startTime))) {
          // Default: next working day at 14:00 London time
          const fallback = new Date();
          fallback.setDate(fallback.getDate() + 1);
          fallback.setHours(14, 0, 0, 0);
          startTime = fallback.toISOString();
          logger.warn('bookMeeting: vague preferredTime — using fallback slot', { voiceiqCallId, preferredTime: md.preferredTime });
        }

        const session  = gemini.getSession(voiceiqCallId);
        const agentName = session?.agentConfig?.name || agentId;

        const booking = await calendar.bookMeeting({
          title:         `Meeting with ${md.name || 'Prospect'}`,
          startTime,
          attendeeEmail: md.email,
          attendeeName:  md.name,
          agentName,
          purpose:       md.purpose || 'Discovery call',
          notes:         md.notes   || '',
          addGoogleMeetLink: true,
        });

        // Attach booking details to the session so the summary picks them up
        if (session) {
          session.bookingResult = booking;
        }

        emit.meetingBooked({
          callId: voiceiqCallId,
          eventId:   booking.eventId,
          meetLink:  booking.meetLink,
          htmlLink:  booking.htmlLink,
          attendee:  md.email,
          name:      md.name,
          start:     booking.start,
          agentName,
        });

        logger.info('Calendar booking created during call', {
          voiceiqCallId,
          eventId:  booking.eventId,
          attendee: md.email,
          start:    booking.start,
        });

      } catch (bookErr) {
        // Don't fail the call — log and continue
        logger.error('Calendar booking failed during call', { voiceiqCallId, error: bookErr.message });
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
          eventId:  bookingResult.eventId,
          meetLink: bookingResult.meetLink,
          htmlLink: bookingResult.htmlLink,
          start:    bookingResult.start,
          attendee: bookingResult.attendee,
        },
      }),
    });

    emit.callEnded({ callId: CallSid, duration, status: CallStatus, channel: 'twilio' });
    if (summary) emit.callSummary({ callId: CallSid, summary });
  }
});


module.exports = router;
