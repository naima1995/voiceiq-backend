const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const XLSX    = require('xlsx');
const logger  = require('../utils/logger');

// ─── Multer — in-memory storage (no disk writes) ──────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10 MB max
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
      'application/vnd.ms-excel', // .xls
    ];
    if (allowed.includes(file.mimetype) || file.originalname.match(/\.(xlsx|xls)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Only Excel files (.xlsx, .xls) are accepted'));
    }
  },
});

// ─── In-memory leads store ────────────────────────────────────────────────
const leadsStore = [];

// ─── POST /api/leads/upload — parse Excel and store leads ─────────────────
router.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const workbook  = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet     = workbook.Sheets[sheetName];
    const rows      = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (!rows.length) return res.status(400).json({ error: 'Excel sheet is empty' });

    // Normalise column names — accept common variants
    const normalise = (row) => {
      const r = Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k.trim().toLowerCase().replace(/\s+/g, '_'), String(v).trim()])
      );
      return {
        name:        r.name        || r.full_name   || r.contact_name || '',
        phone:       r.phone       || r.phone_number || r.mobile       || r.telephone || r.number || '',
        company:     r.company     || r.company_name || r.organisation  || '',
        email:       r.email       || r.email_address || '',
        notes:       r.notes       || r.note          || '',
        importedAt:  new Date().toISOString(),
      };
    };

    const leads = rows.map(normalise).filter(l => l.phone); // require phone number
    const skipped = rows.length - leads.length;

    // Store leads
    leadsStore.push(...leads);

    logger.info('Leads uploaded from Excel', {
      file:    req.file.originalname,
      total:   rows.length,
      imported: leads.length,
      skipped,
    });

    res.json({
      success:  true,
      imported: leads.length,
      skipped,
      total:    rows.length,
      leads:    leads.slice(0, 5), // preview first 5
    });
  } catch (err) {
    logger.error('Excel parse error', { error: err.message });
    res.status(400).json({ error: `Could not parse Excel file: ${err.message}` });
  }
});

// ─── GET /api/leads — return stored leads ─────────────────────────────────
router.get('/', (req, res) => {
  const { page = 1, limit = 100 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  res.json({
    leads: leadsStore.slice(offset, offset + parseInt(limit)),
    total: leadsStore.length,
  });
});

// ─── DELETE /api/leads — clear all leads ──────────────────────────────────
router.delete('/', (req, res) => {
  leadsStore.splice(0);
  res.json({ cleared: true });
});

module.exports = router;
