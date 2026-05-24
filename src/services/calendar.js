const { google } = require('googleapis');
const logger = require('../utils/logger');

// ─── OAuth2 Client ────────────────────────────────────────────────────────
function getOAuthClient() {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  // Use stored refresh token (set after first OAuth flow)
  if (process.env.GOOGLE_REFRESH_TOKEN) {
    client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  }

  return client;
}

function getCalendarClient() {
  const auth = getOAuthClient();
  return google.calendar({ version: 'v3', auth });
}

// ─── OAuth Flow helpers ───────────────────────────────────────────────────
function getOAuthUrl() {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events',
    ],
  });
}

async function handleOAuthCallback(code) {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);
  // Log refresh token — user must save this to .env as GOOGLE_REFRESH_TOKEN
  logger.info('Google OAuth tokens received — save refresh_token to .env', {
    hasRefreshToken: !!tokens.refresh_token,
  });
  return tokens;
}

// ─── Get Available Slots ──────────────────────────────────────────────────
async function getAvailableSlots({ daysAhead = 7, slotDurationMins = 30, workingHours = { start: 9, end: 18 } }) {
  const calendar = getCalendarClient();
  const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';

  const now = new Date();
  const timeMax = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

  // Get busy periods
  const freeBusy = await calendar.freebusy.query({
    requestBody: {
      timeMin: now.toISOString(),
      timeMax: timeMax.toISOString(),
      timeZone: 'Europe/London',
      items: [{ id: calendarId }],
    },
  });

  const busy = freeBusy.data.calendars[calendarId]?.busy || [];
  const slots = [];

  // Walk through each day and find free slots
  for (let day = 1; day <= daysAhead; day++) {
    const date = new Date(now);
    date.setDate(date.getDate() + day);
    const dayOfWeek = date.getDay();

    // Skip weekends
    if (dayOfWeek === 0 || dayOfWeek === 6) continue;

    const dayStart = new Date(date);
    dayStart.setHours(workingHours.start, 0, 0, 0);

    const dayEnd = new Date(date);
    dayEnd.setHours(workingHours.end, 0, 0, 0);

    let cursor = new Date(dayStart);

    while (cursor < dayEnd) {
      const slotEnd = new Date(cursor.getTime() + slotDurationMins * 60 * 1000);
      if (slotEnd > dayEnd) break;

      // Check if slot overlaps with any busy period
      const isBusy = busy.some(b => {
        const bStart = new Date(b.start);
        const bEnd   = new Date(b.end);
        return cursor < bEnd && slotEnd > bStart;
      });

      if (!isBusy) {
        slots.push({
          start: cursor.toISOString(),
          end:   slotEnd.toISOString(),
          label: formatSlotLabel(cursor),
          date:  formatDate(cursor),
        });
      }

      cursor = new Date(cursor.getTime() + slotDurationMins * 60 * 1000);
    }
  }

  logger.debug('Available slots found', { count: slots.length, daysAhead });
  return slots;
}

// ─── Book a Meeting ───────────────────────────────────────────────────────
async function bookMeeting({
  title,
  startTime,
  endTime,
  attendeeEmail,
  attendeeName,
  agentName,
  purpose,
  notes,
  priority = 'normal',
  tags = [],
  addTeamsLink = false,
  addGoogleMeetLink = true,
}) {
  const calendar = getCalendarClient();
  const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';

  // Build rich event description
  const description = buildEventDescription({
    attendeeName,
    attendeeEmail,
    purpose,
    notes,
    agentName,
    priority,
    tags,
  });

  const event = {
    summary: title || `Meeting with ${attendeeName}`,
    description,
    start: {
      dateTime: startTime,
      timeZone: 'Europe/London',
    },
    end: {
      dateTime: endTime || addMinutesToIso(startTime, 30),
      timeZone: 'Europe/London',
    },
    attendees: [
      { email: attendeeEmail, displayName: attendeeName },
    ],
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 24 * 60 }, // 24hr email reminder
        { method: 'popup', minutes: 15 },       // 15min popup
      ],
    },
    sendUpdates: 'all', // Sends invite email to attendee
  };

  // Add Google Meet conferencing
  if (addGoogleMeetLink) {
    event.conferenceData = {
      createRequest: {
        requestId: `voiceiq-${Date.now()}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    };
  }

  const response = await calendar.events.insert({
    calendarId,
    requestBody: event,
    conferenceDataVersion: addGoogleMeetLink ? 1 : 0,
    sendNotifications: true,
  });

  const created = response.data;
  logger.info('Meeting booked', {
    eventId:      created.id,
    attendee:     attendeeEmail,
    start:        startTime,
    meetLink:     created.conferenceData?.entryPoints?.[0]?.uri,
  });

  return {
    eventId:     created.id,
    htmlLink:    created.htmlLink,
    meetLink:    created.conferenceData?.entryPoints?.[0]?.uri || null,
    title:       created.summary,
    start:       created.start.dateTime,
    end:         created.end.dateTime,
    attendee:    attendeeEmail,
    status:      created.status,
  };
}

// ─── Reschedule a Meeting ─────────────────────────────────────────────────
async function rescheduleMeeting({ eventId, newStartTime, newEndTime, reason }) {
  const calendar = getCalendarClient();
  const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';

  // Fetch existing event first
  const existing = await calendar.events.get({ calendarId, eventId });
  const event = existing.data;

  const durationMs = new Date(event.end.dateTime) - new Date(event.start.dateTime);
  const computedEnd = newEndTime || new Date(new Date(newStartTime).getTime() + durationMs).toISOString();

  const updated = await calendar.events.patch({
    calendarId,
    eventId,
    sendNotifications: true,
    requestBody: {
      start: { dateTime: newStartTime, timeZone: 'Europe/London' },
      end:   { dateTime: computedEnd,  timeZone: 'Europe/London' },
      description: event.description + `\n\n[Rescheduled by VoiceIQ AI — ${new Date().toLocaleDateString('en-GB')}${reason ? `: ${reason}` : ''}]`,
    },
  });

  logger.info('Meeting rescheduled', { eventId, newStartTime });
  return { eventId, rescheduled: true, newStart: newStartTime, newEnd: computedEnd };
}

// ─── Cancel a Meeting ─────────────────────────────────────────────────────
async function cancelMeeting({ eventId, reason }) {
  const calendar = getCalendarClient();
  const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';

  await calendar.events.patch({
    calendarId,
    eventId,
    sendNotifications: true,
    requestBody: {
      status: 'cancelled',
      description: `[Cancelled by VoiceIQ AI — ${new Date().toLocaleDateString('en-GB')}${reason ? `: ${reason}` : ''}]`,
    },
  });

  logger.info('Meeting cancelled', { eventId });
  return { eventId, cancelled: true };
}

// ─── List Upcoming Events ─────────────────────────────────────────────────
async function listUpcomingEvents({ maxResults = 20, daysAhead = 14 }) {
  const calendar = getCalendarClient();
  const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';

  const response = await calendar.events.list({
    calendarId,
    timeMin:      new Date().toISOString(),
    timeMax:      new Date(Date.now() + daysAhead * 86400000).toISOString(),
    maxResults,
    singleEvents: true,
    orderBy:      'startTime',
    timeZone:     'Europe/London',
  });

  return (response.data.items || []).map(ev => ({
    id:       ev.id,
    title:    ev.summary,
    start:    ev.start?.dateTime || ev.start?.date,
    end:      ev.end?.dateTime   || ev.end?.date,
    attendees: ev.attendees?.map(a => ({ email: a.email, name: a.displayName, status: a.responseStatus })) || [],
    meetLink: ev.conferenceData?.entryPoints?.[0]?.uri || null,
    htmlLink: ev.htmlLink,
  }));
}

// ─── Helpers ──────────────────────────────────────────────────────────────
function buildEventDescription({ attendeeName, attendeeEmail, purpose, notes, agentName, priority, tags }) {
  const lines = [
    `📞 Booked by VoiceIQ AI Agent: ${agentName}`,
    `👤 Contact: ${attendeeName} (${attendeeEmail})`,
    `🎯 Purpose: ${purpose || 'Discovery call'}`,
    `⚡ Priority: ${priority}`,
    tags?.length ? `🏷 Tags: ${tags.join(', ')}` : null,
    '',
    notes ? `📝 Notes from AI conversation:\n${notes}` : null,
    '',
    `---`,
    `Booked: ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })} (UK time)`,
  ];

  return lines.filter(Boolean).join('\n');
}

function formatSlotLabel(date) {
  return date.toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/London',
  });
}

function formatDate(date) {
  return date.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long',
    timeZone: 'Europe/London',
  });
}

function addMinutesToIso(isoString, minutes) {
  return new Date(new Date(isoString).getTime() + minutes * 60000).toISOString();
}

module.exports = {
  getOAuthUrl,
  handleOAuthCallback,
  getAvailableSlots,
  bookMeeting,
  rescheduleMeeting,
  cancelMeeting,
  listUpcomingEvents,
};
