const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const logger  = require('../utils/logger');

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
  campaigns.splice(idx, 1);
  res.json({ deleted: true });
});

module.exports = router;
