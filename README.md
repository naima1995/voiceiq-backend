# VoiceIQ Backend API

Node.js/Express backend for the VoiceIQ AI calling platform.

## Stack
- **Runtime**: Node.js 18+
- **AI**: Google Gemini 1.5 Flash / Pro (`@google/generative-ai`)
- **Voice**: ElevenLabs TTS — British accents
- **Calling**: Microsoft Teams via Microsoft Graph API + MSAL
- **Calendar**: Google Calendar API
- **Realtime**: WebSocket (ws) for live call monitoring

---

## Quick Start

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# Fill in all values — see sections below

# 3. Dev server (auto-restart)
npm run dev

# 4. Health check
curl http://localhost:3001/health
```

---

## API Reference

All routes require `x-api-key: <your API_KEY>` header except `/health` and `/api/webhooks/*`.

### Teams / Calling
| Method | Route | Description |
|--------|-------|-------------|
| GET    | `/api/teams/numbers` | List Teams phone numbers |
| GET    | `/api/teams/oauth/connect` | Get Microsoft OAuth URL |
| POST   | `/api/teams/calls/outbound` | Initiate an outbound AI call |
| POST   | `/api/teams/calls/:callId/turn` | Process a conversation turn |
| POST   | `/api/teams/calls/:callId/end` | End call + generate summary |
| POST   | `/api/teams/calls/:teamsCallId/transfer` | Transfer to human |
| GET    | `/api/teams/calls/active` | List active sessions |

### Calendar
| Method | Route | Description |
|--------|-------|-------------|
| GET    | `/api/calendar/oauth/connect` | Get Google OAuth URL |
| GET    | `/api/calendar/slots` | Get available booking slots |
| GET    | `/api/calendar/events` | List upcoming events |
| POST   | `/api/calendar/book` | Book a meeting |
| PATCH  | `/api/calendar/events/:id/reschedule` | Reschedule |
| DELETE | `/api/calendar/events/:id` | Cancel |

### Voice / AI
| Method | Route | Description |
|--------|-------|-------------|
| GET    | `/api/voice/voices` | List configured agents |
| POST   | `/api/voice/tts` | Text → speech (MP3) |
| POST   | `/api/voice/sentiment` | Analyse sentiment |
| POST   | `/api/voice/objection` | Generate objection response |
| POST   | `/api/voice/greeting` | Generate opening greeting |

### Agents
| Method | Route | Description |
|--------|-------|-------------|
| GET    | `/api/agents` | List agents |
| POST   | `/api/agents` | Create agent |
| PATCH  | `/api/agents/:id` | Update agent |
| DELETE | `/api/agents/:id` | Delete agent |

### Calls
| Method | Route | Description |
|--------|-------|-------------|
| GET    | `/api/calls` | Call log (paginated) |
| GET    | `/api/calls/:callId` | Single call detail |
| GET    | `/api/calls/analytics/summary` | Today's stats |

### WebSocket
Connect to `ws://localhost:3001/ws?api_key=<your_key>` for live events:
- `call_started` `call_ended` `call_transferred`
- `agent_speaking` `prospect_speaking`
- `meeting_booked` `sentiment_update` `call_summary`

---

## Configuration

### 1. Gemini (Google AI)
1. Go to [aistudio.google.com](https://aistudio.google.com) → Get API key
2. Set `GEMINI_API_KEY` and `GEMINI_MODEL` in `.env`
3. Models: `gemini-1.5-flash` (fast, cheap) or `gemini-1.5-pro` (smarter)

### 2. ElevenLabs
1. [elevenlabs.io](https://elevenlabs.io) → Profile → API Key
2. Go to Voice Library → copy the Voice ID for each voice
3. Set `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_SOPHIA`, `VOICE_JAMES`, `VOICE_CHARLOTTE`

### 3. Microsoft Teams
1. **Azure Portal** → App Registrations → New registration
2. Name: `VoiceIQ`, Accounts: `Single tenant`
3. Add API permissions:
   - `Calls.Initiate.All` (Application)
   - `Calls.AccessMedia.All` (Application)
   - `OnlineMeetings.ReadWrite.All` (Application)
4. Grant admin consent
5. Certificates & Secrets → New client secret → copy it
6. Set `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`
7. Set `CALLBACK_BASE_URL` to your public URL (see ngrok below)

### 4. Google Calendar
1. [console.cloud.google.com](https://console.cloud.google.com) → New project
2. Enable **Google Calendar API**
3. OAuth consent screen → External → add your email
4. Credentials → OAuth Client ID → Web application
5. Add redirect URI: `http://localhost:3001/api/calendar/oauth/callback`
6. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
7. Run OAuth flow once to get refresh token:
   ```bash
   curl http://localhost:3001/api/calendar/oauth/connect
   # Open the URL → authorise → copy refresh_token from response
   # Paste into .env as GOOGLE_REFRESH_TOKEN
   ```

---

## Public Webhook URL (required for Teams)

Teams must reach your server to send call events. In dev, use ngrok:

```bash
npm install -g ngrok
ngrok http 3001
# Copy the https URL e.g. https://abc123.ngrok.io
# Set CALLBACK_BASE_URL=https://abc123.ngrok.io in .env
```

In production, your Render/Railway URL is the CALLBACK_BASE_URL.

---

## Deploy to Render (free tier)

1. Push to GitHub:
```bash
git init && git add . && git commit -m "VoiceIQ backend"
git remote add origin https://github.com/YOUR_USERNAME/voiceiq-backend.git
git push -u origin main
```

2. Go to [render.com](https://render.com) → New → Web Service → Connect repo
3. Settings:
   - Build command: `npm install`
   - Start command: `npm start`
   - Environment: Node
4. Add all `.env` values under Environment Variables
5. Your URL: `https://voiceiq-backend.onrender.com`
6. Set `CALLBACK_BASE_URL` to this URL
7. Set `FRONTEND_URL` to your Vercel frontend URL

---

## Project Structure

```
src/
├── index.js              # Express server + WebSocket init
├── middleware/
│   ├── auth.js           # API key validation
│   ├── errorHandler.js   # Global error handler
│   └── rateLimiter.js    # Rate limiting
├── routes/
│   ├── teams.js          # Teams calls + Gemini + ElevenLabs orchestration
│   ├── calendar.js       # Google Calendar CRUD
│   ├── voice.js          # TTS + sentiment + objection handling
│   ├── agents.js         # Agent config management
│   ├── calls.js          # Call log + analytics
│   └── webhooks.js       # Microsoft Graph call event callbacks
├── services/
│   ├── teams.js          # Microsoft Graph API + MSAL auth
│   ├── gemini.js         # Gemini conversation sessions + summaries
│   ├── elevenlabs.js     # ElevenLabs TTS + streaming
│   ├── calendar.js       # Google Calendar booking logic
│   └── websocket.js      # Live frontend event broadcasting
└── utils/
    └── logger.js         # Winston logger
```
