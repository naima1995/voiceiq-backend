const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const path     = require('path');
const logger   = require('../utils/logger');
const { PrismaClient } = require('@prisma/client');
const prisma   = new PrismaClient();

// ─── NATO Phonetic Alphabet — built-in KB entry ───────────────────────────
const PHONETIC_ALPHABET_CONTENT = `PHONETIC ALPHABET — USE WHEN CONFIRMING POSTCODES, NAMES, OR REFERENCE NUMBERS

When spelling out any letter to a client on the phone, always use the NATO phonetic word alongside it.
Format: say the letter, then say "for [phonetic word]".

Example postcode E17 6TF:
→ "That's E for Echo, one seven, six, T for Tango, F for Foxtrot."

Full NATO Phonetic Alphabet:
A - Alpha
B - Bravo
C - Charlie
D - Delta
E - Echo
F - Foxtrot
G - Golf
H - Hotel
I - India
J - Juliet
K - Kilo
L - Lima
M - Mike
N - November
O - Oscar
P - Papa
Q - Quebec
R - Romeo
S - Sierra
T - Tango
U - Uniform
V - Victor
W - Whiskey
X - X-ray
Y - Yankee
Z - Zulu

NUMBERS: Always read numbers individually digit by digit unless it's a well-known format.
- E17 6TF → "E for Echo, one seven, six, T for Tango, F for Foxtrot"
- SW1A 2AA → "S for Sierra, W for Whiskey, one, A for Alpha, two, A for Alpha, A for Alpha"

USAGE RULES:
1. Always use phonetics when confirming a postcode with the client.
2. Use phonetics whenever spelling a name letter by letter.
3. Read digits individually — never group them (say "one seven", not "seventeen").
4. After spelling out, repeat the full value back: "So that's E17 6TF — is that correct?"
5. If the client gives you a letter that sounds ambiguous (e.g. B/P, D/T, M/N), confirm using phonetics: "Was that B for Bravo or P for Papa?"
`;

// Seed the built-in NATO entry if it doesn't exist yet
async function seedBuiltinKB() {
  try {
    const existing = await prisma.knowledgeBase.findFirst({ where: { builtin: true } });
    if (!existing) {
      await prisma.knowledgeBase.create({
        data: {
          name:        'Phonetic Alphabet (Postcode Confirmation)',
          description: 'NATO phonetic alphabet for confirming postcodes, names, and reference numbers on calls.',
          agentId:     null,
          type:        'text',
          fileName:    'Built-in',
          fileType:    'TEXT',
          fileSize:    null,
          charCount:   PHONETIC_ALPHABET_CONTENT.length,
          content:     PHONETIC_ALPHABET_CONTENT,
          builtin:     true,
        },
      });
      logger.info('Built-in NATO phonetic KB seeded to database');
    }
  } catch (err) {
    logger.warn('Could not seed built-in KB — DB may not be ready yet', { error: err.message });
  }
}
seedBuiltinKB();

// ─── Multer — memory storage, 20MB limit ─────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.docx', '.txt', '.xlsx', '.xls', '.csv', '.mp3', '.mp4', '.wav', '.m4a', '.ogg', '.webm'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error(`Unsupported file type: ${ext}. Allowed: ${allowed.join(', ')}`));
  },
});

// ─── File parser ──────────────────────────────────────────────────────────
async function parseFile(buffer, originalname) {
  const ext = path.extname(originalname).toLowerCase();

  if (ext === '.txt' || ext === '.csv') {
    return buffer.toString('utf-8');
  }

  if (ext === '.pdf') {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buffer);
    return data.text;
  }

  if (ext === '.docx') {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (ext === '.xlsx' || ext === '.xls') {
    const XLSX = require('xlsx');
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    return workbook.SheetNames.map(name => {
      const sheet = workbook.Sheets[name];
      return `[Sheet: ${name}]\n${XLSX.utils.sheet_to_csv(sheet)}`;
    }).join('\n\n');
  }

  throw new Error(`Cannot parse file type: ${ext}`);
}

// ─── Webpage fetcher ──────────────────────────────────────────────────────
async function fetchWebpage(url) {
  const axios = require('axios');
  const res = await axios.get(url, {
    timeout: 10000,
    headers: { 'User-Agent': 'VoiceIQ-KnowledgeBot/1.0' },
    maxContentLength: 5 * 1024 * 1024,
  });
  return res.data
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s{2,}/g, '\n')
    .trim();
}

// ─── GET /api/knowledge — list all ───────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const rows = await prisma.knowledgeBase.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, name: true, description: true, agentId: true,
        type: true, fileName: true, fileType: true, fileSize: true,
        charCount: true, builtin: true, createdAt: true,
        // content intentionally excluded from list
      },
    });
    res.json({ knowledgeBases: rows, total: rows.length });
  } catch (err) {
    logger.error('Failed to list knowledge bases', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch knowledge bases' });
  }
});

// ─── GET /api/knowledge/:id — get single with content ────────────────────
router.get('/:id', async (req, res) => {
  try {
    const kb = await prisma.knowledgeBase.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!kb) return res.status(404).json({ error: 'Knowledge base not found' });
    res.json(kb);
  } catch (err) {
    logger.error('Failed to fetch knowledge base', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch knowledge base' });
  }
});

// ─── POST /api/knowledge — create (file / text / url / media) ────────────
router.post('/', upload.single('file'), async (req, res) => {
  const { name, agentId, description, type = 'file', textContent, url } = req.body;

  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });

  let content = '';
  let fileName = null;
  let fileType = null;
  let fileSize = null;

  try {
    if (type === 'file') {
      if (!req.file) return res.status(400).json({ error: 'File is required' });
      content  = await parseFile(req.file.buffer, req.file.originalname);
      fileName = req.file.originalname;
      fileType = path.extname(req.file.originalname).toLowerCase().replace('.', '').toUpperCase();
      fileSize = req.file.size;

    } else if (type === 'text') {
      if (!textContent?.trim()) return res.status(400).json({ error: 'Content is required' });
      content  = textContent.trim();
      fileName = 'Written content';
      fileType = 'TEXT';

    } else if (type === 'url') {
      if (!url?.trim()) return res.status(400).json({ error: 'URL is required' });
      content  = await fetchWebpage(url.trim());
      fileName = url.trim();
      fileType = 'URL';

    } else if (type === 'media') {
      if (!req.file) return res.status(400).json({ error: 'Media file is required' });
      content  = `[Media file uploaded: ${req.file.originalname}]\n\nTranscription pending. File size: ${(req.file.size / 1024).toFixed(1)} KB.\n\nTo enable automatic transcription, connect a Whisper or Google Speech-to-Text API key in Settings.`;
      fileName = req.file.originalname;
      fileType = path.extname(req.file.originalname).toLowerCase().replace('.', '').toUpperCase();
      fileSize = req.file.size;

    } else {
      return res.status(400).json({ error: `Unknown type: ${type}` });
    }
  } catch (err) {
    return res.status(422).json({ error: `Content processing failed: ${err.message}` });
  }

  try {
    const kb = await prisma.knowledgeBase.create({
      data: {
        name:        name.trim(),
        description: description?.trim() || '',
        agentId:     agentId || null,
        type,
        fileName,
        fileType,
        fileSize:    fileSize || null,
        charCount:   content.length,
        content,
      },
    });

    logger.info('Knowledge base created', { id: kb.id, name: kb.name, type, agentId, chars: content.length });
    const { content: _, ...response } = kb;
    res.status(201).json(response);
  } catch (err) {
    logger.error('Failed to save knowledge base', { error: err.message });
    res.status(500).json({ error: 'Failed to save knowledge base' });
  }
});

// ─── PATCH /api/knowledge/:id — update name / agentId / description ───────
router.patch('/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const kb = await prisma.knowledgeBase.findUnique({ where: { id } });
    if (!kb) return res.status(404).json({ error: 'Knowledge base not found' });

    const updated = await prisma.knowledgeBase.update({
      where: { id },
      data: {
        ...(req.body.name        !== undefined && { name:        req.body.name.trim() }),
        ...(req.body.agentId     !== undefined && { agentId:     req.body.agentId }),
        ...(req.body.description !== undefined && { description: req.body.description }),
      },
    });

    logger.info('Knowledge base updated', { id });
    const { content: _, ...response } = updated;
    res.json(response);
  } catch (err) {
    logger.error('Failed to update knowledge base', { error: err.message });
    res.status(500).json({ error: 'Failed to update knowledge base' });
  }
});

// ─── DELETE /api/knowledge/:id ────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const kb = await prisma.knowledgeBase.findUnique({ where: { id } });
    if (!kb) return res.status(404).json({ error: 'Knowledge base not found' });
    if (kb.builtin) return res.status(403).json({ error: 'Built-in knowledge bases cannot be deleted.' });

    await prisma.knowledgeBase.delete({ where: { id } });
    logger.info('Knowledge base deleted', { id, name: kb.name });
    res.json({ deleted: true, id });
  } catch (err) {
    logger.error('Failed to delete knowledge base', { error: err.message });
    res.status(500).json({ error: 'Failed to delete knowledge base' });
  }
});

// ─── Internal: get KB content for an agent (used by call session) ─────────
async function getKnowledgeForAgent(agentId) {
  try {
    const kbs = await prisma.knowledgeBase.findMany({
      where: { OR: [{ agentId }, { agentId: null }] },
      orderBy: { createdAt: 'asc' },
    });
    if (!kbs.length) return null;
    return kbs.map(k => `=== ${k.name} ===\n${k.content}`).join('\n\n');
  } catch (err) {
    logger.warn('Failed to load knowledge bases for agent', { agentId, error: err.message });
    return null;
  }
}

module.exports = router;
module.exports.getKnowledgeForAgent = getKnowledgeForAgent;
