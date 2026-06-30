const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const logger  = require('../utils/logger');
const twilio  = require('../services/twilio');
const { broadcast } = require('../services/websocket');

// ─── Per-campaign dialler state ───────────────────────────────────────────
// Maps campaignId → { running: bool, timer: Timeout | null }
const diallerState = {};

// Maps twilioCallSid → lead object so the status callback can update lead status
const callSidToLead = {};

// Called by the status callback in webhooks.js when a call ends
function updateLeadOutcome(twilioCallSid, outcome) {
  const lead = callSidToLead[twilioCallSid];
  if (lead) {
    lead.status    = outcome; // 'called', 'voicemail', 'no_answer', 'busy', 'error'
    lead.calledAt  = lead.calledAt || new Date().toISOString();
    delete callSidToLead[twilioCallSid];
  }
}

// ─── In-memory campaigns store ────────────────────────────────────────────
const campaigns = [];

// ─── GET /api/campaigns ───────────────────────────────────────────────────
router.get('/', (req, res) => {
  const { status } = req.query;
  const filtered = status ? campaigns.filter(c => c.status === status) : campaigns;

  const totalLeads    = campaigns.reduce((s, c) => s + (c.leadCount || 0), 0);
  const activeCount   = campaigns.filter(c => c.status === 'active').length;
  const totalBooked   = campaigns.reduce((s, c) => s + (c.booked || 0), 0);

  res.json({
    campaigns: filtered,
    meta: { totalLeads, activeCount, totalBooked },
  });
});

// ─── POST /api/campaigns ──────────────────────────────────────────────────
router.post('/', (req, res) => {
  const { name, agentId, script, dailyLimit, startDate, timezone, schedule } = req.body;
  if (!name) return res.status(400).json({ error: 'Campaign name is required' });

  const defaultSchedule = {
    mon: { enabled: true,  from: '08:00', to: '18:00' },
    tue: { enabled: true,  from: '08:00', to: '18:00' },
    wed: { enabled: true,  from: '08:00', to: '18:00' },
    thu: { enabled: true,  from: '08:00', to: '18:00' },
    fri: { enabled: true,  from: '08:00', to: '18:00' },
    sat: { enabled: false, from: '09:00', to: '13:00' },
    sun: { enabled: false, from: '10:00', to: '14:00' },
  };

  const { scheduledAt } = req.body;
  const campaign = {
    id:          uuidv4(),
    name,
    agentId:     agentId   || 'james',
    script:      script    || '',
    dailyLimit:  parseInt(dailyLimit) || 200,
    startDate:   startDate || new Date().toISOString().split('T')[0],
    timezone:    timezone  || 'Europe/London',
    schedule:    schedule  || defaultSchedule,
    scheduledAt: scheduledAt || null,
    status:      scheduledAt ? 'scheduled' : 'draft',
    leadCount:   0,
    reached:     0,
    booked:      0,
    createdAt:   new Date().toISOString(),
  };

  campaigns.unshift(campaign);
  logger.info('Campaign created', { id: campaign.id, name });
  res.status(201).json(campaign);
});

// ─── PATCH /api/campaigns/:id — update status or attach leads ─────────────
router.patch('/:id', (req, res) => {
  const campaign = campaigns.find(c => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const allowed = ['name', 'agentId', 'status', 'leadCount', 'reached', 'booked', 'script', 'dailyLimit', 'schedule', 'timezone', 'startDate', 'scheduledAt'];
  allowed.forEach(key => {
    if (req.body[key] !== undefined) campaign[key] = req.body[key];
  });

  campaign.updatedAt = new Date().toISOString();
  logger.info('Campaign updated', { id: campaign.id, changes: req.body });
  res.json(campaign);
});

// ─── DELETE /api/campaigns/:id ────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  const idx = campaigns.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Campaign not found' });
  // Stop dialler if running
  stopDialler(req.params.id);
  campaigns.splice(idx, 1);
  res.json({ deleted: true });
});

// ─── POST /api/campaigns/:id/start — activate campaign & begin dialling ────
router.post('/:id/start', async (req, res) => {
  const campaign = campaigns.find(c => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (campaign.status === 'active') return res.json({ message: 'Already running', campaign });

  campaign.status    = 'active';
  campaign.startedAt = campaign.startedAt || new Date().toISOString();
  campaign.updatedAt = new Date().toISOString();

  logger.info('Campaign started', { id: campaign.id, name: campaign.name });
  broadcast('campaign_started', { campaignId: campaign.id, name: campaign.name });

  // Kick off dialler without blocking the HTTP response
  res.json({ message: 'Campaign started', campaign });
  runDialler(campaign);
});

// ─── POST /api/campaigns/:id/pause — pause a running campaign ──────────────
router.post('/:id/pause', (req, res) => {
  const campaign = campaigns.find(c => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  campaign.status    = 'paused';
  campaign.updatedAt = new Date().toISOString();
  stopDialler(campaign.id);

  logger.info('Campaign paused', { id: campaign.id });
  broadcast('campaign_paused', { campaignId: campaign.id });
  res.json({ message: 'Campaign paused', campaign });
});

// ─── POST /api/campaigns/:id/stop — stop and cancel a campaign ─────────────
router.post('/:id/stop', (req, res) => {
  const campaign = campaigns.find(c => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  campaign.status    = 'cancelled';
  campaign.updatedAt = new Date().toISOString();
  stopDialler(campaign.id);

  logger.info('Campaign stopped/cancelled', { id: campaign.id });
  broadcast('campaign_stopped', { campaignId: campaign.id, name: campaign.name });
  res.json({ message: 'Campaign stopped', campaign });
});

// ─── GET /api/campaigns/:id/leads — show leads for a campaign ─────────────
router.get('/:id/leads', (req, res) => {
  const { leadsStore } = require('./leads');
  const campaign = campaigns.find(c => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const leads = leadsStore.filter(l => l.campaignId === req.params.id);
  const unclaimed = leadsStore.filter(l => !l.campaignId && l.status === 'pending');

  const byStatus = leads.reduce((acc, l) => {
    acc[l.status] = (acc[l.status] || 0) + 1;
    return acc;
  }, {});

  res.json({
    total: leads.length,
    byStatus,
    unclaimedLeads: unclaimed.length,
    leads: leads.slice(0, 20),
    scheduleNow: isWithinSchedule(campaign),
  });
});

// ─── Schedule helpers ─────────────────────────────────────────────────────

// Returns true if the current clock time falls within the campaign's
// per-day calling schedule (evaluated in the campaign's own timezone).
function isWithinSchedule(campaign) {
  const tz  = campaign.timezone || 'Europe/London';
  const now = new Date();

  // Use Intl.DateTimeFormat for reliable short weekday in the campaign timezone.
  // toLocaleDateString can return locale-specific formats; this always gives just the weekday part.
  const dayKey = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: tz })
    .format(now)
    .toLowerCase()
    .replace(/[^a-z]/g, ''); // strip punctuation — some ICU builds append '.'

  const sched = campaign.schedule?.[dayKey];

  // Current HH:MM in campaign timezone (24-hour, zero-padded)
  const hhmm = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz,
  }).format(now).replace(/[^0-9:]/g, '');

  const within = !!(sched?.enabled && hhmm >= sched.from && hhmm <= sched.to);

  logger.info('isWithinSchedule', {
    campaignId: campaign.id,
    tz,
    dayKey,
    hhmm,
    schedEnabled: sched?.enabled,
    from: sched?.from,
    to: sched?.to,
    result: within,
  });

  return within;
}

// ─── Auto-start scheduler — checks every 60 s for due campaigns ───────────
setInterval(() => {
  const now = new Date();
  campaigns.forEach(campaign => {
    if (campaign.status === 'scheduled' && campaign.scheduledAt) {
      if (new Date(campaign.scheduledAt) <= now) {
        logger.info('Auto-starting scheduled campaign', { id: campaign.id, name: campaign.name });
        campaign.status    = 'active';
        campaign.startedAt = now.toISOString();
        campaign.updatedAt = now.toISOString();
        broadcast('campaign_started', { campaignId: campaign.id, name: campaign.name });
        runDialler(campaign);
      }
    }
  });
}, 60 * 1000);

// ─── Dialler helpers ──────────────────────────────────────────────────────

function stopDialler(campaignId) {
  const state = diallerState[campaignId];
  if (state) {
    state.running = false;
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  }
}

async function runDialler(campaign) {
  const { leadsStore } = require('./leads');

  const DELAY_BETWEEN_CALLS = 8000; // 8 s gap between dials

  diallerState[campaign.id] = { running: true, timer: null };
  const state = diallerState[campaign.id];

  // Startup diagnostics — visible in Railway logs
  const pendingLeads = leadsStore.filter(l => l.campaignId === campaign.id && l.status === 'pending');
  const allCampaignLeads = leadsStore.filter(l => l.campaignId === campaign.id);
  const unclaimed = leadsStore.filter(l => !l.campaignId && l.status === 'pending');
  logger.info('Dialler starting', {
    campaignId:    campaign.id,
    name:          campaign.name,
    agentId:       campaign.agentId,
    pendingLeads:  pendingLeads.length,
    totalLeads:    allCampaignLeads.length,
    unclaimedLeads: unclaimed.length,
    timezone:      campaign.timezone,
    schedule:      campaign.schedule,
    withinSchedule: isWithinSchedule(campaign),
  });

  // Only dial leads explicitly assigned to this campaign — no unclaimed fallback.
  // The fallback caused multiple campaigns to call the same number simultaneously.
  const getNextLead = () =>
    leadsStore.find(l => l.campaignId === campaign.id && l.status === 'pending');

  const dialNext = async () => {
    if (!state.running) return;
    const freshCampaign = campaigns.find(c => c.id === campaign.id);
    if (!freshCampaign || freshCampaign.status !== 'active') return;

    // Respect per-day calling hours — if outside schedule, wait 5 min and retry
    if (!isWithinSchedule(freshCampaign)) {
      logger.info('Campaign outside calling hours — waiting', { id: campaign.id });
      broadcast('campaign_waiting', { campaignId: campaign.id, reason: 'outside_hours' });
      state.timer = setTimeout(dialNext, 5 * 60 * 1000);
      return;
    }

    const lead = getNextLead();
    if (!lead) {
      if (freshCampaign) {
        freshCampaign.status    = 'completed';
        freshCampaign.updatedAt = new Date().toISOString();
      }
      state.running = false;
      const reached = freshCampaign?.reached || 0;
      logger.info('Campaign completed — no more leads', { id: campaign.id, reached });
      broadcast('campaign_completed', { campaignId: campaign.id, reached });
      return;
    }

    lead.status = 'calling';
    broadcast('campaign_dial_attempt', {
      campaignId: campaign.id,
      phone: lead.phone,
      name: lead.name || `${lead.firstName || ''} ${lead.lastName || ''}`.trim(),
    });

    try {
      const result = await twilio.makeOutboundCall({
        toNumber:   lead.phone,
        agentId:    campaign.agentId || 'rachel',
        leadData: {
          name:      lead.name,
          fname:     lead.firstName,
          lname:     lead.lastName,
          dob:       lead.age,
          address:   lead.address,
          town:      lead.town,
          country:   lead.country,
          postcode:  lead.postcode,
          provider:  lead.provider,
          email:     lead.email,
        },
      });
      // Track CallSid → lead so status callback can update outcome
      if (result?.twilioCallSid) callSidToLead[result.twilioCallSid] = lead;
      lead.status   = 'called';
      lead.calledAt = new Date().toISOString();
      freshCampaign.reached = (freshCampaign.reached || 0) + 1;
      logger.info('Campaign dialler: call placed', { campaignId: campaign.id, phone: lead.phone, sid: result?.twilioCallSid });
    } catch (err) {
      lead.status = 'error';
      lead.error  = err.message;
      logger.warn('Campaign dialler: call failed', { phone: lead.phone, error: err.message });
      broadcast('campaign_dial_failed', {
        campaignId: campaign.id,
        phone: lead.phone,
        error: err.message,
      });
    }

    if (state.running) {
      state.timer = setTimeout(dialNext, DELAY_BETWEEN_CALLS);
    }
  };

  dialNext();
}

module.exports = router;
module.exports.updateLeadOutcome = updateLeadOutcome;
