const express        = require('express');
const router         = express.Router();
const multer         = require('multer');
const XLSX           = require('xlsx');
const logger         = require('../utils/logger');
const normalisePhone             = require('../utils/normalisePhone');
const { validatePhone }          = require('../utils/normalisePhone');

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

    // Normalise column names to match the expected Excel format:
    // Title, Fname, Lname, Phone, Address (cols), Town, Country, Postcode, Age, Life, Provider
    const normalise = (row) => {
      const r = Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k.trim().toLowerCase().replace(/\s+/g, '_'), String(v).trim()])
      );

      // Build full name from Title + Fname + Lname
      const nameParts = [r.title, r.fname, r.lname].filter(Boolean);
      const name = nameParts.join(' ') || r.name || r.full_name || r.contact_name || '';

      // Build address from multiple address columns
      const addressParts = [
        r.address || r.address1 || r.addresses,
        r.address2 || r.addresses2,
        r.address3 || r.addresses3,
        r.town,
        r.country,
        r.postcode || r.post_code,
      ].filter(Boolean);

      return {
        name,
        title:     r.title    || '',
        firstName: r.fname    || r.first_name || '',
        lastName:  r.lname    || r.last_name  || '',
        phone:     normalisePhone(r.phone || r.phone_number || r.mobile || r.telephone || ''),
        address:   addressParts.join(', '),
        town:      r.town     || '',
        country:   r.country  || '',
        postcode:  r.postcode || r.post_code || '',
        age:       r.age      || '',
        life:      r.life     || '',
        provider:  r.provider || '',
        email:     r.email    || r.email_address || '',
        importedAt: new Date().toISOString(),
      };
    };

    const validLeads   = [];
    const skippedRows  = [];

    rows.forEach((row, i) => {
      const lead = normalise(row);
      const rawPhone = row.phone || row.Phone || row.PHONE ||
                       row.phone_number || row.mobile || row.telephone || '';

      if (!rawPhone || !String(rawPhone).trim()) {
        skippedRows.push({ row: i + 2, reason: 'No phone number provided' });
        return;
      }

      const validation = validatePhone(rawPhone);

      if (!validation.valid) {
        skippedRows.push({ row: i + 2, name: lead.name || '', phone: String(rawPhone), reason: validation.reason });
        return;
      }

      lead.phone = validation.number; // store normalised E.164
      lead.campaignId = req.body.campaignId || req.query.campaignId || null;
      lead.status = 'pending'; // pending | called | booked | no_answer | do_not_call
      lead.id = require('crypto').randomUUID();
      validLeads.push(lead);
    });

    leadsStore.push(...validLeads);

    logger.info('Leads uploaded from Excel', {
      file:     req.file.originalname,
      total:    rows.length,
      imported: validLeads.length,
      skipped:  skippedRows.length,
    });

    res.json({
      success:  true,
      imported: validLeads.length,
      skipped:  skippedRows.length,
      total:    rows.length,
      skippedDetails: skippedRows.slice(0, 20), // show up to 20 skipped
      leads:    validLeads.slice(0, 5),          // preview first 5 valid
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
module.exports.leadsStore = leadsStore;
