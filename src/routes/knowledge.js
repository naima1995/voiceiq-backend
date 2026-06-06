const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const path     = require('path');
const logger   = require('../utils/logger');

// ─── In-memory store ──────────────────────────────────────────────────────
const knowledgeBases = [];
let nextId = 1000;

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

// ─── Webpage fetcher ─────────────────────────────────────────────────────
async function fetchWebpage(url) {
  const axios = require('axios');
  const res = await axios.get(url, {
    timeout: 10000,
    headers: { 'User-Agent': 'VoiceIQ-KnowledgeBot/1.0' },
    maxContentLength: 5 * 1024 * 1024,
  });
  // Strip HTML tags and collapse whitespace
  const text = res.data
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s{2,}/g, '\n')
    .trim();
  return text;
}

// ─── GET /api/knowledge — list all ───────────────────────────────────────
router.get('/', (req, res) => {
  const list = knowledgeBases.map(({ content, ...rest }) => rest); // omit full content from list
  res.json({ knowledgeBases: list, total: list.length });
});

// ─── GET /api/knowledge/:id — get single with content ────────────────────
router.get('/:id', (req, res) => {
  const kb = knowledgeBases.find(k => k.id === parseInt(req.params.id));
  if (!kb) return res.status(404).json({ error: 'Knowledge base not found' });
  res.json(kb);
});

// ─── POST /api/knowledge — create (file / text / url) ────────────────────
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
      // Store filename + placeholder — transcription can be wired to Whisper API later
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

  const kb = {
    id:          nextId++,
    name:        name.trim(),
    description: description?.trim() || '',
    agentId:     agentId || null,
    type:        type,
    fileName,
    fileType,
    fileSize:    fileSize || null,
    charCount:   content.length,
    content,
    createdAt:   new Date().toISOString(),
  };

  knowledgeBases.unshift(kb);
  logger.info('Knowledge base created', { id: kb.id, name: kb.name, type, agentId, chars: content.length });

  const { content: _, ...response } = kb;
  res.status(201).json(response);
});

// ─── PATCH /api/knowledge/:id — update name/agentId ──────────────────────
router.patch('/:id', (req, res) => {
  const kb = knowledgeBases.find(k => k.id === parseInt(req.params.id));
  if (!kb) return res.status(404).json({ error: 'Knowledge base not found' });

  if (req.body.name)        kb.name        = req.body.name.trim();
  if (req.body.agentId !== undefined) kb.agentId = req.body.agentId;
  if (req.body.description !== undefined) kb.description = req.body.description;

  logger.info('Knowledge base updated', { id: kb.id });
  const { content: _, ...response } = kb;
  res.json(response);
});

// ─── DELETE /api/knowledge/:id ────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  const idx = knowledgeBases.findIndex(k => k.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Knowledge base not found' });

  const [removed] = knowledgeBases.splice(idx, 1);
  logger.info('Knowledge base deleted', { id: removed.id, name: removed.name });
  res.json({ deleted: true, id: removed.id });
});

// ─── Internal: get KB content for an agent (used by call session) ─────────
function getKnowledgeForAgent(agentId) {
  const kbs = knowledgeBases.filter(k => k.agentId === agentId || k.agentId === null);
  if (!kbs.length) return null;
  return kbs.map(k => `=== ${k.name} ===\n${k.content}`).join('\n\n');
}

module.exports = router;
module.exports.getKnowledgeForAgent = getKnowledgeForAgent;
