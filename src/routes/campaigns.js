const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const logger  = require('../utils/logger');
const twilio  = require('../services/twilio');
const { broadcast } = require('../services/websocket');

// ─── Per-campaign dialler state ───────────────────────────────────────────
// Maps campaignId → { running: bool, timer: Timeout | null }
const diallerState = {};

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

  const campaign = {
    id:         uuidv4(),
    name,
    agentId:    agentId   || 'james',
    script:     script    || '',
    dailyLimit: parseInt(dailyLimit) || 200,
    startDate:  startDate || new Date().toISOString().split('T')[0],
    timezone:   timezone  || 'Europe/London',
    schedule:   schedule  || defaultSchedule,
    status:     'draft',
    leadCount:  0,
    reached:    0,
    booked:     0,
    createdAt:  new Date().toISOString(),
  };

  campaigns.unshift(campaign);
  logger.info('Campaign created', { id: campaign.id, name });
  res.status(201).json(campaign);
});

// ─── PATCH /api/campaigns/:id — update status or attach leads ─────────────
router.patch('/:id', (req, res) => {
  const campaign = campaigns.find(c => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const allowed = ['name', 'agentId', 'status', 'leadCount', 'reached', 'booked', 'script', 'dailyLimit'];
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

// ─── GET /api/campaigns/:id/leads — show leads for a campaign ─────────────
router.get('/:id/leads', (req, res) => {
  const { leadsStore } = require('./leads');
  const campaign = campaigns.find(c => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const leads = leadsStore.filter(
    l => l.campaignId === req.params.id || (!l.campaignId && l.status === 'pending')
  );

  const byStatus = leads.reduce((acc, l) => {
    acc[l.status] = (acc[l.status] || 0) + 1;
    return acc;
  }, {});

  res.json({ total: leads.length, byStatus, leads: leads.slice(0, 20) });
});

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

  const getNextLead = () =>
    leadsStore.find(l => l.campaignId === campaign.id && l.status === 'pending')
    || leadsStore.find(l => !l.campaignId && l.status === 'pending');

  const dialNext = async () => {
    if (!state.running) return;
    const freshCampaign = campaigns.find(c => c.id === campaign.id);
    if (!freshCampaign || freshCampaign.status !== 'active') return;

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
      await twilio.makeOutboundCall({
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
      lead.status   = 'called';
      lead.calledAt = new Date().toISOString();
      freshCampaign.reached = (freshCampaign.reached || 0) + 1;
      logger.info('Campaign dialler: call placed', { campaignId: campaign.id, phone: lead.phone });
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
