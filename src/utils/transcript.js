const prisma  = require('./prisma');
const logger  = require('./logger');

// Save one or more turns to the transcript for a call
async function appendTranscript(callId, messages) {
  if (!callId || !messages?.length) return;
  try {
    await prisma.transcriptMessage.createMany({
      data: messages.map(m => ({ callId, role: m.role, text: m.text })),
    });
  } catch (err) {
    logger.warn('Failed to save transcript', { callId, error: err.message });
  }
}

// Fetch the full transcript for a call, ordered oldest-first
async function getTranscript(callId) {
  return prisma.transcriptMessage.findMany({
    where:   { callId },
    orderBy: { ts: 'asc' },
    select:  { role: true, text: true, ts: true },
  });
}

// Delete transcript messages older than 24 hours — call periodically
async function purgeOldTranscripts() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  try {
    const { count } = await prisma.transcriptMessage.deleteMany({
      where: { ts: { lt: cutoff } },
    });
    if (count > 0) logger.info('Transcript purge complete', { deleted: count });
  } catch (err) {
    logger.warn('Transcript purge failed', { error: err.message });
  }
}

// Run purge on startup then every hour
purgeOldTranscripts();
setInterval(purgeOldTranscripts, 60 * 60 * 1000);

module.exports = { appendTranscript, getTranscript };
