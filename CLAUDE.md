# VoiceIQ Backend — Claude Guidelines

## ⚠️ Git Rules — ALWAYS FOLLOW
- **NEVER `git push` without asking the user first.** Make the commit, then ask "Ready to push?" before running `git push`.
- **NEVER modify `DEFAULT_PROTECTION_SCRIPT` contents** without explicit user instruction. Structural additions (phase labels, step markers) must also be approved first.

---

## Project Overview
VoiceIQ is a UK-based AI outbound calling platform for a **protection advisory service**. The backend handles Twilio telephony, Gemini AI conversations, ElevenLabs TTS, Google Calendar bookings, and lead management.

- **Repo:** `naima1995/voiceiq-backend` — branch `feature/twilio`
- **Deployed:** Railway (Node.js/Express)
- **Frontend:** separate repo `naima1995/voiceiq` on Vercel (`main` branch)

---

## Architecture

```
Twilio call → /api/webhooks/twilio/answer → Gemini (greeting) → ElevenLabs TTS → <Gather><Play>audio</Play></Gather>
Caller speaks → Twilio → /api/webhooks/twilio/speech → Gemini (response) → ElevenLabs TTS → <Gather><Play>audio</Play></Gather>
```

### Key services
| Service | File | Purpose |
|---|---|---|
| Gemini 2.5 Flash | `src/services/gemini.js` | AI conversation engine |
| ElevenLabs | `src/services/elevenlabs.js` | Text-to-speech |
| Twilio | `src/services/twilio.js` | Outbound calling + AMD |
| Google Calendar | `src/services/calendar.js` | Booking tasks |
| WebSocket | `src/services/websocket.js` | Live call monitoring (use `broadcast()` — no `emit.raw`) |

### Key routes
| Route | File | Notes |
|---|---|---|
| `POST /api/webhooks/twilio/answer` | `webhooks.js` | Call answered — starts Gemini session, plays greeting |
| `POST /api/webhooks/twilio/speech` | `webhooks.js` | Each speech turn — Gemini + ElevenLabs |
| `POST /api/webhooks/twilio/amd` | `webhooks.js` | Answering machine detection callback |
| `POST /api/campaigns/:id/start` | `campaigns.js` | Starts dialler loop |
| `POST /api/campaigns/:id/pause` | `campaigns.js` | Pauses dialler loop |
| `GET /api/voice/audio/:id` | `voice.js` | Serves cached ElevenLabs audio to Twilio |

---

## Critical TwiML Rules

### ALWAYS nest `<Play>` inside `<Gather>`
```xml
<!-- CORRECT — timeout starts after audio finishes -->
<Gather input="speech" action="${speechUrl}" method="POST" speechTimeout="auto" language="en-GB" timeout="15">
  <Play>${audioUrl}</Play>
</Gather>
<Redirect method="POST">${speechUrl}</Redirect>

<!-- WRONG — timeout runs while audio plays → SpeechResult always empty -->
<Play>${audioUrl}</Play>
<Gather ...></Gather>
```

### Never `<Hangup/>` in catch blocks
Catch blocks must re-gather to keep the call alive. A `<Hangup/>` in a catch block silently drops every call on any transient error:
```javascript
// CORRECT
} catch (err) {
  logger.error('...', { error: err.message });
  res.type('text/xml').send(twiml(`
    <Gather input="speech" action="${speechUrl}" method="POST" speechTimeout="auto" language="en-GB" timeout="15">
      <Say language="en-GB">Sorry, one moment.</Say>
    </Gather>
    <Redirect method="POST">${speechUrl}</Redirect>
  `));
}
```

### Silence handling — retry once then hangup
`silence` counter is passed as a query param. On first silence re-gather; on second hang up cleanly.

---

## Gemini Configuration

- **Model:** `process.env.GEMINI_MODEL || 'gemini-2.5-flash'`
- **`maxOutputTokens`:** fixed at **1024**. Do NOT reduce — Gemini 2.5 Flash uses internal reasoning tokens on top of output tokens. Low values cause truncated JSON → parse failure → fallback speech on every turn.
- **`thinkingConfig: { thinkingBudget: 0 }`:** REQUIRED for real-time phone calls. Without it, Gemini 2.5 Flash's thinking mode adds 1–5 seconds of latency per turn AND consumes tokens from the output budget. Disabling thinking is safe — the system prompt provides all necessary context.
- **`temperature`:** mapped from agent `creativity` setting (0–1.0)
- **`responseMimeType`:** always `'application/json'` — responses must be valid JSON
- **Fallback response:** parse errors return a graceful fallback (not `hangUpNow`) to keep the call alive

### Agent script pipeline
```
agents.js DEFAULT_PROTECTION_SCRIPT
  → getAgent(agentId) in webhooks.js answer handler
  → gemini.startSession({ agentConfig: { script, settings, ... } })
  → buildSystemPrompt() → system instruction
```
**Both** the answer handler AND the speech handler must call `getAgent(agentId)` — forgetting it in one causes `agentConfig` to be undefined and crashes the webhook.

---

## ElevenLabs Voice IDs
Default voice IDs are hardcoded for `james` and `rachel` only:
```
rachel:  '21m00Tcm4TlvDq8ikWAM'   (Southern British female — default agent)
james:   'AZnzlk1XvdvUeBnXmlld'
shelley: '' → must set ELEVENLABS_VOICE_SHELLEY in Railway
alexis:  '' → must set ELEVENLABS_VOICE_ALEXIS in Railway
```
If a voice ID is empty string, `textToSpeech()` throws → call drops. Always check Railway env vars when using shelley/alexis.

### Natural pauses
Keep `<break>` durations short — long pauses create dead air on a phone call:
```javascript
'.':  150ms   (was 400ms — caused noticeable gaps)
'?':  150ms
',':   75ms
'—':  100ms
```

---

## Agent Settings → API Parameters
| UI Slider | Backend parameter | Range |
|---|---|---|
| Creativity | Gemini `temperature` | 0.0–1.0 |
| Patience | Gemini `maxOutputTokens` | 300–600 |
| Stability | ElevenLabs `stability` | 0.0–1.0 |
| Voice Speed | ElevenLabs `style` | 0.0–1.0 |
| Conversation Style | System prompt tone modifier | casual / formal |

---

## Protection Survey Prompt
All 4 agents use `DEFAULT_PROTECTION_SCRIPT` in `agents.js`. Key rules:
- **NEVER** mention a company name — always "on behalf of a local independent financial advisor"
- Reference provider from lead data: *"I can see you've got your cover with [Provider]"*
- Max 3 survey questions before close
- Do NOT ask for salary, health details, or sensitive personal info
- Booking → `bookMeeting: true` + capture date/time → Google Calendar task

---

## Voicemail / Screener Detection (3 layers)
1. **Twilio AMD** (`machineDetection: 'Enable'`) — network level, fires async to `/api/webhooks/twilio/amd`
2. **Regex patterns** (`AI_SCREENER_PATTERNS` in webhooks.js) — 18 patterns covering Google/Apple/Bixby/voicemail
3. **Gemini `hangUpNow` flag** — mid-call detection

All three paths use silent `<Hangup/>` — no voicemail message is ever left.

---

## Lead Data Flow
```
Excel upload → leads.js (normalise + validate phone) → leadsStore[]
  Fields: Title, Fname, Lname, Phone, Address1-3, Town, Country, Postcode, Age, Life, Provider, Email
  → campaignId stored on each lead at upload time

Campaign start → runDialler() → makeOutboundCall({ leadData })
  → URLSearchParams: leadFname, leadLname, leadProvider, leadPost, etc.
  → webhooks.js query params → Gemini first-turn context message
```

---

## Railway Environment Variables (required)
```
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
TWILIO_PHONE_NUMBER
CALLBACK_BASE_URL        # e.g. https://voiceiq-backend.up.railway.app
ELEVENLABS_API_KEY
ELEVENLABS_VOICE_RACHEL  # optional — has hardcoded fallback
ELEVENLABS_VOICE_JAMES   # optional — has hardcoded fallback
ELEVENLABS_VOICE_SHELLEY # required if using Shelley
ELEVENLABS_VOICE_ALEXIS  # required if using Alexis
GEMINI_API_KEY
GEMINI_MODEL             # optional — defaults to gemini-2.5-flash
COMPANY_NAME             # optional — defaults to VoiceIQ
FRONTEND_URL             # Vercel URL for CORS
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REFRESH_TOKEN
```

---

## WebSocket Events
Use `broadcast(type, data)` from `services/websocket.js`. There is **no** `emit.raw()` method.
```javascript
const { broadcast } = require('../services/websocket');
broadcast('campaign_started', { campaignId, name });
```
Typed helpers available: `emit.callStarted`, `emit.callEnded`, `emit.meetingBooked`, etc.

---

## In-Memory Stores (lost on restart)
- `campaigns[]` in campaigns.js
- `leadsStore[]` in leads.js
- `agents Map` in agents.js
- `sessions Map` in gemini.js (active call sessions)
- `cache Map` in audioCache.js (5 min TTL)
- `knowledgeBases[]` in knowledge.js (builtin NATO phonetics pre-seeded with id=1)
