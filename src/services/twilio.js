const twilio         = require('twilio');
const { v4: uuidv4 } = require('uuid');
const logger         = require('../utils/logger');
const normalisePhone    = require('../utils/normalisePhone');
const { validatePhone } = require('../utils/normalisePhone');

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
async function makeOutboundCall({ toNumber, fromNumber, agentId = 'james', leadData = {} }) {
  const c      = getClient();
  const callId = uuidv4();
  const from   = fromNumber || process.env.TWILIO_PHONE_NUMBER;

  // Normalise then validate — reject if not a UK mobile (+447...)
  toNumber = normalisePhone(toNumber);
  const validation = validatePhone(toNumber);
  if (!validation.valid) {
    throw new Error(`Invalid phone number: ${validation.reason}`);
  }
  toNumber = validation.number;

  if (!from) throw new Error('No from number — set TWILIO_PHONE_NUMBER in Railway Variables');

  const base = process.env.CALLBACK_BASE_URL;
  const params = new URLSearchParams({
    agentId,
    callId,
    leadName:    leadData.name      || '',
    leadCompany: leadData.company   || '',
    leadFname:   leadData.fname     || '',
    leadLname:   leadData.lname     || '',
    leadDob:     leadData.dob       || leadData.age || '',
    leadPhone:   toNumber,
    leadAddr1:   leadData.address   || '',
    leadAddr2:   leadData.address2  || '',
    leadAddr3:   leadData.address3  || '',
    leadTown:    leadData.town      || '',
    leadCountry: leadData.country   || '',
    leadPost:    leadData.postcode  || '',
  });

  const call = await c.calls.create({
    to:   toNumber,
    from,
    url:            `${base}/api/webhooks/twilio/answer?${params}`,
    statusCallback: `${base}/api/webhooks/twilio/status`,
    statusCallbackMethod: 'POST',
    statusCallbackEvent:  ['initiated', 'ringing', 'answered', 'completed'],
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
