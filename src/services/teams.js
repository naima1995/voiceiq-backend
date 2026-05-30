const { ConfidentialClientApplication } = require('@azure/msal-node');
const { Client } = require('@microsoft/microsoft-graph-client');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const logger = require('../utils/logger');

// ─── MSAL Config (lazy init) ──────────────────────────────────────────────
let msalClient = null;

function getMsalClient() {
  if (!msalClient) {
    if (!process.env.AZURE_CLIENT_SECRET || !process.env.AZURE_CLIENT_ID || !process.env.AZURE_TENANT_ID) {
      throw new Error('Azure credentials not configured. Set AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_CLIENT_SECRET.');
    }
    msalClient = new ConfidentialClientApplication({
      auth: {
        clientId: process.env.AZURE_CLIENT_ID,
        authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
        clientSecret: process.env.AZURE_CLIENT_SECRET,
      }
    });
  }
  return msalClient;
}

// Scopes needed for Teams calling via Graph API
const CALLING_SCOPES = ['https://graph.microsoft.com/.default'];

// ─── Get App Token ────────────────────────────────────────────────────────
async function getAppToken() {
  const result = await getMsalClient().acquireTokenByClientCredential({
    scopes: CALLING_SCOPES
  });
  if (!result?.accessToken) throw new Error('Failed to acquire Teams app token');
  return result.accessToken;
}

// ─── Graph Client ─────────────────────────────────────────────────────────
async function getGraphClient() {
  const token = await getAppToken();
  return Client.init({
    authProvider: (done) => done(null, token)
  });
}

// ─── List Phone Numbers on Tenant ─────────────────────────────────────────
async function listTeamsNumbers() {
  const client = await getGraphClient();
  const result = await client
    .api('/communications/onlineMeetings')
    .get();

  // Get phone numbers assigned in tenant
  const users = await client.api('/users')
    .select('displayName,mail,businessPhones,assignedLicenses')
    .get();

  const numberedUsers = users.value
    .filter(u => u.businessPhones?.length > 0)
    .map(u => ({
      name: u.displayName,
      email: u.mail,
      phoneNumbers: u.businessPhones,
    }));

  return numberedUsers;
}

// ─── Make Outbound Call ───────────────────────────────────────────────────
// Uses Graph API Communications — Calls endpoint
// Requires Calls.Initiate.All + Calls.AccessMedia.All app permissions
async function makeOutboundCall({ toNumber, fromNumber, callbackUrl, agentId, leadData }) {
  const callId = uuidv4();

  // clientContext is passed through every webhook callback so we can
  // correlate events back to our session. Max 256 chars — keep it compact.
  const clientContext = JSON.stringify({ v: callId, a: agentId });

  // Normalise phone number — Graph requires E.164 with + prefix
  const normalisedTo = toNumber.startsWith('+') ? toNumber : `+${toNumber}`;
  const normalisedFrom = (fromNumber || process.env.TEAMS_PHONE_NUMBER || '');
  const normalisedFromE164 = normalisedFrom.startsWith('+') ? normalisedFrom : `+${normalisedFrom}`;

  const callPayload = {
    '@odata.type': '#microsoft.graph.call',
    callbackUri: `${process.env.CALLBACK_BASE_URL}/api/webhooks/teams/call-events`,
    source: {
      '@odata.type': '#microsoft.graph.participantInfo',
      identity: {
        '@odata.type': '#microsoft.graph.communicationsIdentitySet',
        applicationInstance: {
          '@odata.type': '#microsoft.graph.identity',
          displayName: 'VoiceIQ',
          id: process.env.AZURE_BOT_OBJECT_ID,
        },
      },
    },
    targets: [
      {
        '@odata.type': '#microsoft.graph.invitationParticipantInfo',
        identity: {
          '@odata.type': '#microsoft.graph.communicationsIdentitySet',
          phone: {
            '@odata.type': '#microsoft.graph.identity',
            id: normalisedTo,
          },
        },
      },
    ],
    requestedModalities: ['audio'],
    mediaConfig: {
      '@odata.type': '#microsoft.graph.serviceHostedMediaConfig',
    },
    tenantId: process.env.AZURE_TENANT_ID,
    clientContext,
  };

  logger.info('Initiating Teams outbound call', { toNumber: normalisedTo, callId, agentId, payload: JSON.stringify(callPayload) });

  // Use axios directly so we capture the full Microsoft error body on failure
  const token = await getAppToken();
  let call;
  try {
    const response = await axios.post(
      'https://graph.microsoft.com/v1.0/communications/calls',
      callPayload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );
    call = response.data;
  } catch (axiosErr) {
    const msError = axiosErr.response?.data;
    logger.error('Graph API call creation failed', {
      status: axiosErr.response?.status,
      msError: JSON.stringify(msError),
      payload: JSON.stringify(callPayload),
    });
    const err = new Error(JSON.stringify(msError || axiosErr.message));
    err.body = msError;
    err.statusCode = axiosErr.response?.status;
    throw err;
  }

  return {
    callId,
    teamsCallId: call.id,
    status: call.state,
    toNumber: normalisedTo,
    fromNumber: normalisedFromE164,
    initiatedAt: new Date().toISOString(),
  };
}

// ─── Transfer Call to Human ───────────────────────────────────────────────
async function transferCallToHuman({ teamsCallId, targetUserId, targetEmail }) {
  const client = await getGraphClient();

  // Redirect the call to a Teams user
  await client.api(`/communications/calls/${teamsCallId}/redirect`).post({
    targets: [
      {
        '@odata.type': '#microsoft.graph.invitationParticipantInfo',
        identity: {
          '@odata.type': '#microsoft.graph.communicationsIdentitySet',
          user: {
            '@odata.type': '#microsoft.graph.identity',
            id: targetUserId,
            displayName: targetEmail,
          }
        }
      }
    ],
    callbackUri: `${process.env.CALLBACK_BASE_URL}/api/webhooks/teams/call-events`,
  });

  logger.info('Call transferred to human', { teamsCallId, targetUserId });
  return { transferred: true, teamsCallId, to: targetEmail };
}

// ─── End / Hang Up Call ───────────────────────────────────────────────────
async function endCall(teamsCallId) {
  const client = await getGraphClient();
  await client.api(`/communications/calls/${teamsCallId}`).delete();
  logger.info('Call ended', { teamsCallId });
  return { ended: true };
}

// ─── Get Call Record (after call ends) ───────────────────────────────────
async function getCallRecord(teamsCallId) {
  const client = await getGraphClient();
  const record = await client
    .api(`/communications/callRecords/${teamsCallId}`)
    .expand('sessions($expand=segments)')
    .get();
  return record;
}

// ─── Send DTMF Tones (for IVR navigation if needed) ──────────────────────
async function sendDtmf({ teamsCallId, tones }) {
  const client = await getGraphClient();
  await client.api(`/communications/calls/${teamsCallId}/sendDtmfTones`).post({
    tones,
    clientContext: uuidv4(),
  });
}

// ─── Play Audio Prompt via Graph ──────────────────────────────────────────
async function playAudioPrompt({ teamsCallId, audioUrl }) {
  const client = await getGraphClient();
  await client.api(`/communications/calls/${teamsCallId}/playPrompt`).post({
    prompts: [
      {
        '@odata.type': '#microsoft.graph.mediaPrompt',
        mediaInfo: {
          '@odata.type': '#microsoft.graph.mediaInfo',
          uri: audioUrl,
          resourceId: uuidv4(),
        }
      }
    ],
    clientContext: uuidv4(),
  });
}

// ─── Play audio AND listen for speech response ────────────────────────────
// Plays the prompt then immediately starts recognising what the caller says.
// Result comes back as a recognizeCompleted webhook event.
async function recognizeAsync({ teamsCallId, audioUrl, clientContext }) {
  const client = await getGraphClient();

  await client.api(`/communications/calls/${teamsCallId}/recognizeAsync`).post({
    clientContext: clientContext || uuidv4(),
    prompt: {
      '@odata.type': '#microsoft.graph.mediaPrompt',
      mediaInfo: {
        '@odata.type': '#microsoft.graph.mediaInfo',
        uri: audioUrl,
        resourceId: uuidv4(),
      }
    },
    recognizeRequests: [
      {
        '@odata.type': '#microsoft.graph.speechRecognitionConfig',
        speechLanguage: 'en-GB',
      }
    ],
    bargeInAllowed: false,
    initialSilenceTimeoutInSeconds: 10,
    maxSilenceTimeoutInSeconds: 3,
    maxRecordDurationInSeconds: 60,
    playBeep: false,
    stopTones: [],
  });

  logger.info('Teams recognizeAsync initiated', { teamsCallId });
}

// ─── OAuth Flow (delegated — user-level scopes only) ─────────────────────
// Calls.Initiate.All / Calls.AccessMedia.All are app-only permissions —
// they are granted via admin consent, not via user OAuth.
function getOAuthUrl(state) {
  const authCodeUrlParams = {
    scopes: [
      'User.Read',
      'OnlineMeetings.ReadWrite',
    ],
    redirectUri: `${process.env.CALLBACK_BASE_URL}/api/teams/oauth/callback`,
    state,
  };
  return getMsalClient().getAuthCodeUrl(authCodeUrlParams);
}

async function handleOAuthCallback(code) {
  const tokenRequest = {
    code,
    scopes: CALLING_SCOPES,
    redirectUri: `${process.env.CALLBACK_BASE_URL}/api/teams/oauth/callback`,
  };
  const response = await getMsalClient().acquireTokenByCode(tokenRequest);
  return {
    accessToken: response.accessToken,
    account: response.account,
  };
}

module.exports = {
  makeOutboundCall,
  transferCallToHuman,
  endCall,
  getCallRecord,
  sendDtmf,
  playAudioPrompt,
  recognizeAsync,
  listTeamsNumbers,
  getOAuthUrl,
  handleOAuthCallback,
};
