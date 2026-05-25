const twilio = require('twilio');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

let client = null;

function getClient() {
  if (!client) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken  = process.env.TWILIO_AUTH_TOKEN;
    if (!accountSid || !authToken) {
      throw new Error('Twilio credentials not configured — set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN');
    }
    client = twilio(accountSid, authToken);
  }
  return client;
}

// ─── Make outbound call ───────────────────────────────────────────────────
async function makeOutboundCall({ toNumber, fromNumber, agentId = 'sophia', leadData = {} }) {
  const c    = getClient();
  const callId = uuidv4();
  const from = fromNumber || process.env.TWILIO_PHONE_NUMBER;

  if (!from) throw new Error('No from number — set TWILIO_PHONE_NUMBER in Railway Variables');

  const base = process.env.CALLBACK_BASE_URL;
  const params = new URLSearchParams({
    agentId,
    callId,
    leadName:    leadData.name    || '',
    leadCompany: leadData.company || '',
  });

  const call = await c.calls.create({
    to:   toNumber,
    from,
    url:            `${base}/api/webhooks/twilio/answer?${params}`,
    statusCallback: `${base}/api/webhooks/twilio/status`,
    statusCallbackMethod: 'POST',
    statusCallbackEvent:  ['initiated', 'ringing', 'answered', 'completed', 'failed', 'no-answer', 'busy'],
  });

  logger.info('Twilio outbound call created', { callId, twilioSid: call.sid, toNumber, agentId });

  return {
    callId,
    twilioCallSid: call.sid,
    status:        call.status,
    toNumber,
    fromNumber:    from,
    agentId,
    initiatedAt:   new Date().toISOString(),
  };
}

// ─── End a call ───────────────────────────────────────────────────────────
async function endCall(twilioCallSid) {
  const c = getClient();
  await c.calls(twilioCallSid).update({ status: 'completed' });
  logger.info('Twilio call ended', { twilioCallSid });
  return { ended: true, twilioCallSid };
}

// ─── List numbers on account ──────────────────────────────────────────────
async function listNumbers() {
  const c = getClient();
  const numbers = await c.incomingPhoneNumbers.list({ limit: 20 });
  return numbers.map(n => ({
    sid:          n.sid,
    phoneNumber:  n.phoneNumber,
    friendlyName: n.friendlyName,
    capabilities: n.capabilities,
  }));
}

// ─── Connection status ────────────────────────────────────────────────────
async function getStatus() {
  try {
    const numbers = await listNumbers();
    return {
      connected:     true,
      accountSid:    process.env.TWILIO_ACCOUNT_SID,
      defaultNumber: process.env.TWILIO_PHONE_NUMBER || numbers[0]?.phoneNumber,
      numbers,
      numbersFound:  numbers.length,
    };
  } catch (err) {
    logger.warn('Twilio status check failed', { error: err.message });
    return { connected: false, error: err.message };
  }
}

module.exports = { makeOutboundCall, endCall, listNumbers, getStatus };
