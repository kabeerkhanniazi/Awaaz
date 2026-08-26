# Vox Sonus — build plan

Written 26 August 2026. Hackathon runs **1–30 September 2026**; submissions close
**30 September, 8:00 PM PKT**. That is five weeks, and roughly one of them is already
spent on the work below.

---

## Where the plan diverged from the source report

The report in `report-voice-ai.pdf` specified a **local edge pipeline**: AssemblyAI
streaming STT into `llama-cpp-python` running Llama-3-8B Q4_K_M, into XTTS-v2 or Kokoro
for speech, all inside 6 GB of RAM on an AMD Ryzen box, with sequential model loading to
avoid an OOM crash.

That architecture is sound for the thing it was designed for — a device that runs with no
network. It is the wrong architecture for **a website that hosts five agents**, and the
brief changed to a website. Three reasons:

1. **It does not survive judging.** A judge opens your URL. Under the edge plan, their
   audio would have to reach your Ryzen machine, queue behind every other visitor for the
   one Llama instance that fits in RAM, and wait through an unload/reload cycle between
   the LLM and the TTS model on every single turn. Concurrency is one. Latency is seconds.
2. **The 6 GB constraint was about a device, not a server.** Once the agents are hosted,
   the constraint simply stops applying — there is no reason to run a quantised 8B model
   sequentially in and out of memory to serve a web page.
3. **AssemblyAI ships the whole stack behind one connection.** The Voice Agent API does
   STT (Universal-3.5 Pro), turn detection, LLM routing, TTS and JSON-Schema tool calling
   over a single WebSocket. The hackathon explicitly offers this as one of its two tracks.
   Rebuilding those pieces locally would spend the entire month reproducing what the
   sponsor's API does better, and score *worse* on "Application of Technology" for it.

**What was kept from the report:** every system prompt (hardened for voice and tool use),
the four commercial concepts and their Pakistani market rationale, the Buddy persona, and
the code-switching requirement — which turned out to be the hardest and most interesting
constraint. See *Risk 1* below.

The edge pipeline is not wasted. It is the right answer for a follow-on offline device,
and it is worth one slide in the deck as the roadmap.

---

## Phase 0 — Research and decisions ✅ done

- Read the source report; extracted the four commercial concepts, the Buddy persona and
  the hardware constraints.
- Pulled the hackathon rules: dates, the two tracks, the four judging criteria, and the
  full submission checklist.
- Read the Voice Agent API surface: `session.update` inline configuration, the complete
  event list, client-side function tools, the 15 voices, the 18 input languages.
- Cloned `AssemblyAI/voice-agent-starter-python` and read the official browser client,
  which is where the token flow and both audio worklets come from.
- Extracted the Reflect Notes design system down to exact hex values, type scale and the
  inset-glow elevation rule.
- **Decided: Voice Agent API track, browser-direct WebSocket, tools client-side.**

## Phase 1 — Working product ✅ done

Everything in this repo. Runs on `python3 server/main.py` with no dependencies.

- Stdlib HTTP server: token minting, agent catalogue, tool dispatch, static hosting.
- Five agents fully specified in `server/agent_defs.py`, including 18 tools across the
  four commercial desks.
- Four seeded mock systems of record with Pakistani context — PKR, PKT, Sehat Sahulat,
  Karachi/Lahore/Islamabad nodes, Kiryana-supplying distributors.
- Browser client: capture and playback worklets, barge-in, tool-call round trip with the
  `reply.done` queueing discipline the docs require.
- Three pages — vision, roster, call — on the Reflect design system.
- The audio-reactive orb, tinted per agent, six states.
- Verified: all routes render, no console errors, no horizontal overflow, error paths
  produce actionable messages.

**Not yet verified: a live voice call.** That needs a real API key, which is yours to
supply. See Phase 2.

---

## Phase 2 — First live call 🔴 needs you

**This is the gate. Nothing after it can be trusted until it is done.**

1. Register for the hackathon on lablab.ai and on their Discord. Sign up for AssemblyAI
   **through the lablab link** so the free credits attach — if you already have an
   account, log out first, then use the link.
2. Put the key in `.env` and run `python3 server/aai.py`. It should print
   `OK - key accepted`.
3. Start the server, open Chrome, call **Northgate**, and book an appointment end to end.
4. Then work down the list, watching the **Tool calls** tab each time:
   - Meridian: ask about order `88450`, the delayed one.
   - Corvus: give `0300 1234567` — it should lead with the Clifton outage before you
     finish complaining.
   - Halden: `HG-1042` is deliberately locked; `HG-3901` has no MFA and must be refused
     a phone reset.
   - Buddy: talk to it in Roman Urdu and see whether it stays in character.

**What to report back:** whether the agents call the right tools unprompted, whether
barge-in feels instant, and — most importantly — **how the code-switched Urdu transcribes**.
That last one decides Phase 3.

## Phase 3 — Tuning 🟡 needs you, ~4 days

Voice work cannot be done by reading code; it needs someone listening.

- **Prompts.** Expect two or three rounds. The usual failures are agents that answer from
  memory instead of calling a tool, and agents that talk too long. Both are prompt fixes.
- **Turn detection.** If it cuts you off, or waits too long, tune `input.turn_detection`
  (`min_silence`, `interruption_delay`) in `agent_defs.py`.
- **Keyterms.** Add every product name, node ID and Urdu term that transcribes wrong.
  This is the cheapest accuracy win available and it is worth doing carefully.
- **Voices.** The picker on the call page exists so you can A/B them live. Pick per agent.

## Phase 4 — Deployment 🟡 ~1 day

Judges need a URL. The server is stdlib-only, so almost anything hosts it.

- Render or Railway, `python3 server/main.py`, one env var (`ASSEMBLYAI_API_KEY`), and the
  platform's `PORT` is already honoured.
- **Must be HTTPS** — browsers refuse `getUserMedia` on plain HTTP from a non-localhost
  origin. Both platforms give you TLS by default.
- Anyone with the URL can start sessions billed to your key. Note the burn rate
  (~$4.50/hour of open session) and consider taking the link down between judging windows.

## Phase 5 — Submission 🔴 needs you, ~2 days

The checklist from the rules, in the order I would do it:

- [ ] **Public GitHub repo** — MIT licensed, as the rules require. Push this repo.
- [ ] **Demo URL** — from Phase 4.
- [ ] **Video presentation** — the one judges actually weigh. Script below.
- [ ] **Slide deck** — problem, architecture, the Urdu decision, business value, roadmap.
- [ ] Title, short and long description, technology and category tags, cover image.

### Video script (aim for 3 minutes)

1. **0:00** The problem, spoken over the landing page. A clinic with two phone lines. A
   fibre node dropping in Clifton and 1,840 households ringing at once.
2. **0:30** Call Corvus. Say *"mera internet subah se band hai"* in Urdu. It identifies
   you, and leads with the outage and the ETA before you have finished the sentence.
   **Cut to the Tool calls tab** — `lookup_account` and `check_node_status`, live, with
   real results. This single shot carries Application of Technology and Business Value.
3. **1:15** Interrupt it mid-sentence to show barge-in stopping the audio dead.
4. **1:35** Call Halden with `HG-3901` and let it *refuse* the password reset because no
   MFA is enrolled. A demo that shows the guardrail holding is worth more than three that
   show happy paths.
5. **2:10** Buddy, in Roman Urdu, thirty seconds. Tonal contrast with the four desks.
6. **2:35** The Urdu slide. Say plainly that Urdu is unsupported, that you routed it
   through Hindi's acoustic model, and why that works. Judges reward this.

---

## Risks

**1. Urdu transcription quality — the one that matters.**
Urdu is not a supported input language; we steer with `["en","hi"]` on the reasoning that
spoken Urdu and Hindi are the same language in the mouth. That reasoning is sound but it
is **unproven until Phase 2**. If accuracy disappoints, in order of preference: add heavy
`keyterms` for the vocabulary that misses; drop to `["en"]` and lean on the fact that
Pakistani English is itself heavily code-switched; or, last resort, reposition the demo
around English-first callers. Find out on day one, not in week four.

**2. Being one of five hundred order-status bots.**
Originality is a quarter of the score. The defensible ground is the *combination* — five
agents in one product, tool calls visible to the person talking, a companion agent beside
four commercial desks, and a language decision made honestly and explained. Lead with
that, not with "we built a voice agent".

**3. Credit burn.** Sessions bill on connection time, not speech. Hang up when you are not
testing.

**4. Leaving the video to the last day.** It is a quarter of the score on its own and the
deadline is fixed at 8:00 PM PKT on 30 September. Shoot a rough cut in week two.

---

## Suggested calendar

| When | What | Whose |
|---|---|---|
| Now → 1 Sep | Key, register, Phase 2 end-to-end call | **You** |
| Week of 1 Sep | Phase 3 tuning, report Urdu findings | **You** + me |
| Week of 8 Sep | Deploy, rough-cut the video | Both |
| Week of 15 Sep | Second agent pass, slides | Both |
| Week of 22 Sep | Final video, submission assets | **You** |
| 26–29 Sep | Submit. Do not wait for the 30th. | **You** |

The single most valuable thing you can do this week is Phase 2. Everything downstream is
tuning, and tuning needs an ear on a real call.
