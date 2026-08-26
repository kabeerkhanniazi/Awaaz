# Awaaz

**آواز** — Urdu for *voice*.

Five voice agents you can call in a browser, built on the **AssemblyAI Voice Agent API**
for the [AssemblyAI Voice Agent Hackathon](https://lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon)
(1–30 September 2026).

Four of them run a commercial phone desk and call real tools to do it. The fifth has no
tools at all, because it is not there to get anything done.

| Agent | Role | Sector | Tools |
|---|---|---|---|
| Northgate Family Practice | Clinic front desk | Healthcare | 5 |
| Meridian Supply | Returns and order status | B2B distribution | 4 |
| Corvus Broadband | Billing and outage line | Telecom / ISP | 4 |
| Halden Group | Tier-1 IT service desk | Corporate IT | 5 |
| Buddy | Someone to talk to | Companionship | 0 |

---

## Run it

Python 3.9+ is the only requirement. There is no `pip install`, no virtualenv, no build step.

```bash
cp .env.example .env
```

Put your key in `.env`:

```
ASSEMBLYAI_API_KEY=your_key_here
```

Get one at [assemblyai.com/dashboard/api-keys](https://www.assemblyai.com/dashboard/api-keys).
For the hackathon, sign up through the lablab.ai link to claim the free credits.

```bash
python3 server/main.py
```

Open <http://localhost:3000> in Chrome or Edge and press Connect. The server tells you on
startup whether your key was accepted; without one the site still loads and every agent is
readable, but Connect will fail with a message saying why.

Check the key on its own at any time:

```bash
python3 server/aai.py
```

---

## How it works

The browser opens **one WebSocket straight to AssemblyAI**. Speech recognition, turn
detection, the language model and the voice all live behind that single connection. The
Python server is deliberately small and does only two things: it mints a short-lived token
so the API key never reaches the page, and it runs the tool calls.

```
browser ──── PCM16 24kHz base64 ────▶  wss://agents.assemblyai.com/v1/ws
   ▲                                            │
   │ reply.audio                                │ tool.call
   │                                            ▼
   └──────── tool.result ◀──── POST /api/tools/<agent> ──── mock systems of record
```

- **Capture** — an `AudioWorklet` resamples the microphone to 24 kHz PCM16. It resamples
  rather than trusting `AudioContext({sampleRate})` because a browser may quietly ignore
  the rate you ask for.
- **Playback** — a ring-buffer `AudioWorklet`, not one `AudioBufferSource` per chunk, which
  is what avoids the clicking and drift you get under network jitter. Barge-in flushes the
  ring the moment `input.speech.started` arrives, so the agent stops mid-word.
- **Tools** — declared inline as client-side function tools in `session.update`. That means
  no public HTTPS callback URL is needed and the business logic stays in this repo. Results
  are queued and only sent when `reply.done` is the latest event, which is what keeps turn
  taking intact.

### Files

```
server/
  main.py        HTTP server: /api/catalog, /api/session/<agent>, /api/tools/<agent>, static
  aai.py         AssemblyAI REST client (token minting), standard library only
  agent_defs.py  the five agents: prompts, voices, tools, keyterms  ← edit agents here
  mockdb.py      seeded mock systems of record: clinic, ERP, node map, directory
web/
  index.html     shell
  css/tokens.css design tokens
  css/app.css    components
  js/app.js      router and the three pages
  js/orb.js      the orb
  js/voice.js    WebSocket session and the two audio worklets
docs/
  BUILD-PLAN.md  phased plan through to hackathon submission
```

To change what an agent says or does, edit `server/agent_defs.py` and reload the page. The
system prompt shown in the app's Briefing tab is the same string sent to the API, so the two
can never drift.

---

## Why English only

We built the bilingual version first, listened to it, and cut it.

An earlier build steered recognition with `language_codes: ["en", "hi"]`, on the reasoning
that spoken Urdu and Hindi share their phonology and everyday vocabulary. **The recognition
side held up well. The output voice did not.** The Voice Agent API's voices are trained on
European-language phonology; handed South Asian vocabulary they produce an accent awkward
enough to undercut everything else on the call. An agent that mispronounces the caller's own
words sounds materially worse than one that simply speaks good English.

So the agents run `language_codes: ["en"]` and speak English throughout.

This costs less than it might appear. Pakistani commercial phone lines already run
substantially in English — private clinics, B2B distribution, corporate IT desks. AssemblyAI
lists Hindi voices as on the roadmap; when they ship, this is one field in
`server/agent_defs.py` and a decision worth reopening.

The name stayed. Awaaz is Urdu for voice.

## Design

The interface follows the [Reflect Notes design system](https://styles.refero.design/style/e7f92774-3c08-402b-917d-020ba1f3d489):
a monochromatic dark canvas with a violet undertone, one lavender accent used as sparse
punctuation, and elevation carried entirely by inset rim-light glows — there is not a single
drop shadow in the stylesheet. Headlines are medium weight, never bold. The system describes
itself as reading like a constellation map rather than a dashboard, which is what the star
field, the orbiting particles and the restraint everywhere else are for.

The orb is a single 2D canvas. Its shape comes from three summed sines rather than real
noise, which reads as organic and costs almost nothing per frame — that matters because it
runs beside a live audio pipeline. Each agent's colour steers the orb's core while the
conversational state (`idle`, `listening`, `thinking`, `speaking`, `error`) drives the halo
and the motion, so the five agents stay visually distinct without the state becoming
illegible. Amplitude comes from an `AnalyserNode` on whichever side currently owns the turn.

---

## Try saying

Each agent's Briefing tab lists prompts that exercise its tools. A few to start with:

- **Northgate** — *"I need an appointment tomorrow morning"*, then give a name and number.
- **Meridian** — *"What is the status of order eight eight four five zero"* (that one is delayed).
- **Corvus** — *"My internet has been down since this morning"*, number `0300 1234567` (a live outage).
- **Halden** — *"I'm locked out, employee ID H G one zero four two"*.
- **Buddy** — *"Today was a really long day"*.

Watch the **Tool calls** tab while you talk: every call, its arguments and the raw result
appear as they happen.

---

## Licence

MIT.
