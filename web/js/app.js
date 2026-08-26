/* ---------------------------------------------------------------------------
   Router and pages. Three routes: the vision, the roster, the call.
--------------------------------------------------------------------------- */

import { Orb, heroOrb } from './orb.js';
import { VoiceSession } from './voice.js';

const app = document.getElementById('app');
let CATALOG = null;
let teardown = null;   // whatever the current page needs to release

/* --- tiny DOM helper ------------------------------------------------------ */

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') {
      // Custom properties are invisible to Object.assign on a CSSStyleDeclaration,
      // so --tint has to go through setProperty or it silently does nothing.
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, val);
        else el.style[prop] = val;
      }
    }
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

function icon(path) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.innerHTML = path;
  return svg;
}

const ICONS = {
  wave: '<path d="M2 12h2M7 6v12M12 3v18M17 7v10M22 12h-2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18"/>',
  plug: '<path d="M9 3v6M15 3v6M6 9h12v3a6 6 0 0 1-12 0V9ZM12 18v3"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/>',
  shield: '<path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6l7-3Z"/>',
  phone: '<path d="M5 3h4l2 5-3 2a12 12 0 0 0 6 6l2-3 5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 5a2 2 0 0 1 2-2Z"/>',
};

const nav = (path) => (e) => { e.preventDefault(); go(path); };

/* --- shell ---------------------------------------------------------------- */

function navbar(active) {
  return h('nav', { class: 'nav' },
    h('div', { class: 'nav-pill' },
      h('a', { class: 'brand', href: '/', onclick: nav('/') },
        h('span', { class: 'brand-mark' }), 'Awaaz'),
      h('div', { class: 'nav-links' },
        h('a', { class: `nav-link${active === 'home' ? ' on' : ''}`, href: '/', onclick: nav('/') }, 'Vision'),
        h('a', { class: `nav-link${active === 'agents' ? ' on' : ''}`, href: '/agents', onclick: nav('/agents') }, 'Agents'),
        h('a', { class: 'nav-link', href: 'https://www.assemblyai.com/docs/voice-agents/voice-agent-api', target: '_blank', rel: 'noopener' }, 'API docs')),
      h('a', { class: 'btn', href: '/agents', onclick: nav('/agents'),
               style: { marginLeft: 'auto' } }, 'Start a call')));
}

function footer() {
  return h('footer', { class: 'foot' },
    h('div', { class: 'wrap' },
      h('div', { class: 'foot-in' },
        h('p', {},
          'Awaaz — ',
          h('span', { lang: 'ur', dir: 'rtl', class: 'urdu' }, 'آواز'),
          ', Urdu for voice. Built on the AssemblyAI Voice Agent API for the AssemblyAI Voice Agent Hackathon, September 2026.'),
        h('div', { class: 'foot-links' },
          h('a', { href: 'https://www.assemblyai.com/docs/voice-agents/voice-agent-api', target: '_blank', rel: 'noopener' }, 'Voice Agent API'),
          h('a', { href: 'https://lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon', target: '_blank', rel: 'noopener' }, 'Hackathon'),
          h('a', { href: '/agents', onclick: nav('/agents') }, 'Agents')))));
}

/* =========================================================================
   Landing
   ========================================================================= */

function landing() {
  const heroCanvas = h('canvas', { class: 'orb-canvas' });

  const page = h('div', {},
    navbar('home'),

    h('header', { class: 'hero' },
      h('div', { class: 'wrap' },
        h('span', { class: 'badge' }, h('span', { class: 'badge-dot' }), 'AssemblyAI Voice Agent API · Universal-3.5 Pro'),
        h('h1', { class: 't-display' },
          'The phone line that ', h('span', { class: 't-gradient' }, 'never puts you on hold')),
        h('p', { class: 'hero-sub t-body-lg' },
          'Five production-shaped voice agents you can call in the browser. Four run a real commercial desk. One just listens. All of them speak the way people in Pakistan actually speak, in the middle of the sentence they switch languages in.'),
        h('div', { class: 'hero-cta' },
          h('a', { class: 'btn btn-lg', href: '/agents', onclick: nav('/agents') }, 'Talk to an agent'),
          h('a', { class: 'btn btn-ghost btn-lg', href: '#how' }, 'How it works')),
        h('p', { class: 'hero-note' }, 'Works in Chrome and Edge. Your microphone never leaves your machine unencrypted.'),

        h('div', { class: 'orb-stage', style: { margin: '72px auto 0', '--tint': '#9382ff' } }, heroCanvas))),

    // --- the problem ------------------------------------------------------
    h('section', { class: 'section' },
      h('div', { class: 'wrap' },
        h('div', { class: 'section-head' },
          h('span', { class: 'eyebrow' }, 'The problem'),
          h('h2', { class: 't-heading' }, 'Every one of these calls is already answered by a queue'),
          h('p', { class: 't-body-lg t-dim', style: { marginTop: '20px' } },
            'A clinic in PECHS runs two phone lines against three hundred callers a day. A distributor loses an afternoon to shopkeepers asking where the truck is. When a fibre node drops in Clifton, eighteen hundred households ring the same number inside ten minutes. The answers already exist in a calendar, an ERP, a node map. Nobody can read them out fast enough.')),

        h('div', { class: 'features' },
          [['Healthcare', 'Routine scheduling crowds out the calls that need a person.', ICONS.phone],
           ['Distribution', 'Status checks that the ERP could answer without a human.', ICONS.globe],
           ['Telecom', 'Outage spikes no call-centre rota can be staffed for.', ICONS.bolt],
           ['Corporate IT', 'Tier-1 resets consuming the capacity meant for Tier-2.', ICONS.shield]]
            .map(([t, d, ic]) => h('div', { class: 'feature' },
              h('div', { class: 'f-icon' }, icon(ic)),
              h('h3', {}, t),
              h('p', {}, d)))))),

    // --- how it works -----------------------------------------------------
    h('section', { class: 'section', id: 'how' },
      h('div', { class: 'wrap' },
        h('div', { class: 'section-head' },
          h('span', { class: 'eyebrow' }, 'How it works'),
          h('h2', { class: 't-heading' }, 'One socket, the whole voice stack'),
          h('p', { class: 't-body-lg t-dim', style: { marginTop: '20px' } },
            'The browser opens a single WebSocket to AssemblyAI carrying PCM16 at 24 kHz. Speech recognition, turn detection, the language model and the voice all live behind that one connection. Our server does two small things: it mints a short-lived token so the API key never reaches the page, and it runs the tool calls against the systems of record.')),

        h('div', { class: 'pipeline' },
          [['01', 'Capture', 'An AudioWorklet resamples the microphone to 24 kHz PCM16 and streams it as base64 frames.'],
           ['02', 'Understand', 'Universal-3.5 Pro transcribes across English and Hindustani, and decides when your turn ended.'],
           ['03', 'Decide', 'The model answers under a per-agent system prompt, and calls a tool when it needs a real fact.'],
           ['04', 'Act', 'The tool call comes back to us over the same socket. We query the mock system and return a result.'],
           ['05', 'Speak', 'Audio streams back and plays through a ring buffer. Speak over it and it stops mid-word.']]
            .map(([n, t, d]) => h('div', { class: 'stage' },
              h('div', { class: 'n' }, n),
              h('h4', {}, t),
              h('p', {}, d)))))),

    // --- scope ------------------------------------------------------------
    h('section', { class: 'section' },
      h('div', { class: 'wrap' },
        h('div', { class: 'section-head' },
          h('span', { class: 'eyebrow' }, 'Scope'),
          h('h2', { class: 't-heading' }, 'What is actually built')),

        h('dl', { class: 'scope' },
          [['Five agents', 'Four commercial desks with working tool calls, and one companion agent with none. Every system prompt is readable in the app before you dial.'],
           ['Real tool calling', `${CATALOG.agents.reduce((n, x) => n + x.tools.length, 0)} client-side function tools across the four commercial agents, backed by seeded mock systems: a clinic calendar, a distributor ledger, an ISP node map, a corporate directory.`],
           ['Live barge-in', 'Speak over the agent and playback stops mid-word, because the ring buffer is flushed the moment turn detection fires.'],
           ['Code-switching', 'Input is steered to English and Hindi together, which is what captures the Urdu-English mix people actually use on the phone.'],
           ['Inspectable behaviour', 'Every tool call, its arguments and its raw result are shown live beside the transcript. Nothing about the agent is hidden from the person talking to it.']]
            .map(([t, d]) => h('div', { class: 'scope-row' }, h('dt', {}, t), h('dd', {}, d)))))),

    // --- honesty ----------------------------------------------------------
    h('section', { class: 'section' },
      h('div', { class: 'wrap' },
        h('div', { class: 'section-head' },
          h('span', { class: 'eyebrow' }, 'One straight answer'),
          h('h2', { class: 't-heading' }, 'About Urdu')),
        h('div', { class: 'note', style: { maxWidth: '760px' } },
          h('h4', {}, 'Urdu is not on the supported language list, and we did not pretend otherwise.'),
          h('p', {}, 'The Voice Agent API transcribes eighteen languages. Urdu is not one of them, and there is no Urdu output voice. Building this on a claim that it was would have fallen apart the first time a judge spoke into it.'),
          h('p', {}, 'What is supported is Hindi. Spoken conversational Urdu and Hindi are the same language in the mouth: they share their phonology and nearly all of their everyday vocabulary, and diverge in script and in formal register, neither of which survives a phone call. So input is steered to English and Hindi together, and the result is that "mujhe kal subah ki appointment chahiye" transcribes correctly. The agents reply in English, keeping the Urdu words a caller would use.'),
          h('p', {}, 'AssemblyAI lists Hindi output voices as on the roadmap. On the day they ship, these agents become natively bilingual by changing one field.'),
          h('p', {}, 'The product is named for the thing it could not quite have. Awaaz is Urdu for voice.')))),

    h('section', { class: 'section', style: { paddingBottom: '0' } },
      h('div', { class: 'wrap', style: { textAlign: 'center' } },
        h('h2', { class: 't-heading-lg' }, 'Pick a desk and call it'),
        h('p', { class: 't-body-lg t-dim', style: { maxWidth: '520px', margin: '20px auto 36px' } },
          'Five agents are live. Every one of them answers on the first ring.'),
        h('a', { class: 'btn btn-lg', href: '/agents', onclick: nav('/agents') }, 'See the roster'))),

    footer());

  requestAnimationFrame(() => {
    const orb = heroOrb(heroCanvas);
    teardown = () => orb.destroy();
  });

  return page;
}

/* =========================================================================
   Selection
   ========================================================================= */

function agentCard(a) {
  return h('a', {
    class: 'card', href: `/call/${a.id}`, onclick: nav(`/call/${a.id}`),
    style: { '--tint': a.accent },
  },
    h('div', { class: 'card-top' },
      h('div', { class: 'card-orb' }),
      h('div', { class: 'card-meta' },
        h('div', { class: 'role' }, a.role),
        h('h3', {}, a.name))),
    h('p', { class: 'card-line' }, a.tagline),
    h('div', { class: 'card-caps' }, a.capabilities.slice(0, 3).map((c) => h('span', { class: 'tag' }, c))),
    h('div', { class: 'card-foot' },
      h('div', { class: 'left' },
        h('span', { class: 'card-tag' }, a.sector),
        h('span', { class: 'tools' }, a.tools.length ? `${a.tools.length} tools` : 'conversation only')),
      h('span', { class: 'go' }, 'Call', h('span', { class: 'arrow' }, '→'))));
}

function selection() {
  const commercial = CATALOG.agents.filter((a) => a.category === 'commercial');
  const personal = CATALOG.agents.filter((a) => a.category === 'personal');

  return h('div', {},
    navbar('agents'),
    h('div', { class: 'wrap' },
      h('header', { class: 'page-head' },
        h('span', { class: 'eyebrow' }, 'The roster'),
        h('h1', { class: 't-heading-lg' }, 'Five agents, five different jobs'),
        h('p', { class: 't-body-lg' },
          'Four of these answer a commercial phone line and call real tools to do it. The fifth has no tools at all, because it is not there to get anything done.')),

      h('div', { class: 'cat-head' },
        h('h2', { class: 't-sub' }, 'Commercial'),
        h('span', { class: 'count' }, `${commercial.length} agents`),
        h('hr', { class: 'rule' })),
      h('div', { class: 'grid' }, commercial.map(agentCard)),

      h('div', { class: 'cat-head' },
        h('h2', { class: 't-sub' }, 'Personal'),
        h('span', { class: 'count' }, `${personal.length} agent`),
        h('hr', { class: 'rule' })),
      h('div', { class: 'grid' }, personal.map(agentCard))),
    footer());
}

/* =========================================================================
   Conversation
   ========================================================================= */

function callPage(agentId) {
  const a = CATALOG.agents.find((x) => x.id === agentId);
  if (!a) return notFound();

  let state = 'idle';
  let session = null;
  let orb = null;
  let toolCount = 0;
  let lineCount = 0;

  const canvas = h('canvas', { class: 'orb-canvas' });
  const hint = h('div', { class: 'orb-hint' }, 'Press Connect, then just talk');
  const statusEl = h('div', { class: 'call-status', 'data-state': 'idle' },
    h('span', { class: 'dot' }), h('span', { class: 'label' }, 'Not connected'));

  const banner = h('div', { class: 'banner', hidden: true });

  const voiceSelect = h('select', { class: 'select' },
    ...CATALOG.voices.map((v) => h('option', {
      value: v.id, selected: v.id === a.voice ? 'selected' : null,
    }, `${v.label} · ${v.accent}, ${v.note}`)));

  const connectBtn = h('button', { class: 'btn btn-lg', onclick: () => toggle() }, 'Connect');
  const meterEl = h('div', { class: 'meter' }, h('span', {}, '00:00'), h('span', {}, 'idle'));

  // --- rail -------------------------------------------------------------
  const transcriptBody = h('div', { class: 'rail-body' },
    h('p', { class: 'rail-empty' }, 'The conversation will appear here, both sides, as it happens.'));
  const toolsBody = h('div', { class: 'rail-body', hidden: true },
    h('p', { class: 'rail-empty' }, a.tools.length
      ? 'Every tool this agent calls will show up here with its arguments and the raw result it got back.'
      : 'This agent has no tools. It only talks.'));
  const briefBody = h('div', { class: 'rail-body brief', hidden: true }, ...briefing(a));

  const tabs = [
    h('button', { class: 'rail-tab on', onclick: () => tab(0) }, 'Transcript', h('span', { class: 'n' })),
    h('button', { class: 'rail-tab', onclick: () => tab(1) }, 'Tool calls', h('span', { class: 'n' })),
    h('button', { class: 'rail-tab', onclick: () => tab(2) }, 'Briefing'),
  ];
  const bodies = [transcriptBody, toolsBody, briefBody];

  function tab(i) {
    tabs.forEach((t, n) => t.classList.toggle('on', n === i));
    bodies.forEach((b, n) => { b.hidden = n !== i; });
  }

  // --- transcript rendering ----------------------------------------------
  const partials = {};

  function clearEmpty(el) { el.querySelector('.rail-empty')?.remove(); }

  function lineEl(who, text, partial) {
    return h('div', { class: `line ${who}${partial ? ' partial' : ''}` },
      h('span', { class: 'who' }, who === 'agent' ? a.name : 'You'),
      h('span', { class: 'said' }, text));
  }

  function setPartial(who, text) {
    if (!text) return;
    clearEmpty(transcriptBody);
    if (partials[who]) {
      partials[who].querySelector('.said').textContent = text;
    } else {
      partials[who] = lineEl(who, text, true);
      transcriptBody.append(partials[who]);
    }
    transcriptBody.scrollTop = transcriptBody.scrollHeight;
  }

  function addLine(who, text) {
    if (!text) return;
    clearEmpty(transcriptBody);
    partials[who]?.remove();
    delete partials[who];
    transcriptBody.append(lineEl(who, text, false));
    transcriptBody.scrollTop = transcriptBody.scrollHeight;
    lineCount++;
    tabs[0].querySelector('.n').textContent = lineCount;
  }

  // --- tool rendering -----------------------------------------------------
  const toolEls = new Map();

  function renderTool(entry) {
    clearEmpty(toolsBody);
    let el = toolEls.get(entry.callId);
    if (!el) {
      el = h('div', { class: 'tool-card' });
      toolEls.set(entry.callId, el);
      toolsBody.append(el);
      toolCount++;
      tabs[1].querySelector('.n').textContent = toolCount;
    }
    const mark = entry.status === 'running'
      ? h('span', { class: 'spin' })
      : h('span', { class: entry.status === 'done' ? 'ok' : 'bad' }, entry.status === 'done' ? '✓' : '!');
    el.replaceChildren(
      h('div', { class: 't-name' }, mark, entry.name),
      h('div', { class: 't-args' }, JSON.stringify(entry.args)),
      entry.result ? h('pre', {}, JSON.stringify(entry.result, null, 2)) : null);
    toolsBody.scrollTop = toolsBody.scrollHeight;
  }

  // --- state --------------------------------------------------------------
  const LABELS = {
    idle: 'Not connected',
    connecting: 'Connecting',
    listening: 'Listening',
    thinking: 'Thinking',
    speaking: `${a.name} is speaking`,
    error: 'Something went wrong',
  };

  function setState(s) {
    state = s;
    statusEl.dataset.state = s;
    statusEl.querySelector('.label').textContent = LABELS[s] || s;
    orb?.setState(s);
    meterEl.children[1].textContent = s;
    hint.style.opacity = s === 'idle' ? '1' : '0';
    voiceSelect.disabled = s !== 'idle' && s !== 'error';
    connectBtn.textContent = s === 'idle' || s === 'error' ? 'Connect' : 'End call';
    connectBtn.className = s === 'idle' || s === 'error' ? 'btn btn-lg' : 'btn btn-danger btn-lg';
    connectBtn.disabled = s === 'connecting';
  }

  let started = 0, timer = null;
  function startTimer() {
    started = Date.now();
    timer = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      meterEl.children[0].textContent =
        `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    }, 1000);
  }

  async function toggle() {
    if (session) { session.stop(); session = null; clearInterval(timer); return; }
    banner.hidden = true;
    session = new VoiceSession(a.id, {
      currentState: () => state,
      onState: setState,
      onUserPartial: (t) => setPartial('you', t),
      onUserFinal: (t) => addLine('you', t),
      onAgentPartial: (t) => setPartial('agent', t),
      onAgentFinal: (t) => addLine('agent', t),
      onTool: renderTool,
      onLevel: (v) => orb?.setLevel(v),
      onError: (m) => {
        banner.hidden = false;
        banner.replaceChildren(h('div', {}, h('strong', {}, 'Could not connect. '), m));
      },
      onEnd: () => { session = null; clearInterval(timer); },
    });
    try {
      await session.start(voiceSelect.value);
      startTimer();
    } catch {
      session = null;
      setState('error');
    }
  }

  const page = h('div', {},
    navbar('agents'),
    h('div', { class: 'call', style: { '--tint': a.accent } },
      h('div', { class: 'stage-col' },
        h('div', { class: 'call-head' },
          h('div', { class: 'role' }, a.role),
          h('h1', {}, a.name)),
        banner,
        h('div', { class: 'orb-stage', style: { '--tint': a.accent } }, canvas, hint),
        statusEl,
        h('div', { class: 'call-controls' },
          h('div', { class: 'picker' },
            h('label', { for: 'voice' }, 'Voice'),
            voiceSelect),
          connectBtn,
          h('a', { class: 'btn btn-quiet btn-lg', href: '/agents', onclick: nav('/agents') }, 'Back')),
        meterEl),

      h('aside', { class: 'rail' },
        h('div', { class: 'rail-tabs' }, ...tabs),
        ...bodies)));

  requestAnimationFrame(() => {
    orb = new Orb(canvas, { tint: a.accent });
    orb.start();
    orb.setState('idle');
  });

  teardown = () => { session?.stop(); orb?.destroy(); clearInterval(timer); };
  return page;
}

function briefing(a) {
  return [
    h('h4', {}, 'What it does'),
    h('p', {}, a.tagline),
    h('h4', {}, 'The problem'),
    h('p', {}, a.problem),
    h('h4', {}, 'Business value'),
    h('p', {}, a.value),
    h('h4', {}, 'Try saying'),
    ...a.try_saying.map((s) => h('span', { class: 'say' }, s)),
    h('h4', {}, 'Capabilities'),
    h('ul', {}, ...a.capabilities.map((c) => h('li', {}, c))),
    ...(a.tools.length ? [
      h('h4', {}, `Tools (${a.tools.length})`),
      h('ul', {}, ...a.tools.map((t) => h('li', {},
        h('code', { style: { color: 'var(--accent)', fontFamily: 'var(--font-mono)', fontSize: '12px' } }, t.name),
        ' — ', t.description))),
    ] : []),
    h('h4', {}, 'System prompt'),
    h('pre', {}, a.system_prompt),
  ];
}

/* --- fallbacks ------------------------------------------------------------ */

function notFound() {
  return h('div', {}, navbar(''),
    h('div', { class: 'wrap' },
      h('header', { class: 'page-head' },
        h('h1', { class: 't-heading' }, 'Nothing here'),
        h('p', { class: 't-body-lg' }, 'That page does not exist.'),
        h('a', { class: 'btn', href: '/agents', onclick: nav('/agents'), style: { marginTop: '24px' } }, 'See the agents'))),
    footer());
}

/* --- router --------------------------------------------------------------- */

function render(path) {
  teardown?.();
  teardown = null;
  app.replaceChildren();

  let view;
  if (path === '/' || path === '') view = landing();
  else if (path === '/agents') view = selection();
  else if (path.startsWith('/call/')) view = callPage(path.slice(6));
  else view = notFound();

  app.append(view);
  window.scrollTo(0, 0);
}

function go(path) {
  if (path === location.pathname) return;
  history.pushState({}, '', path);
  render(path);
}

window.addEventListener('popstate', () => render(location.pathname));

// Let in-page anchors keep working without the router intercepting them.
document.addEventListener('click', (e) => {
  const link = e.target.closest?.('a[href^="#"]');
  if (!link) return;
  const target = document.querySelector(link.getAttribute('href'));
  if (target) { e.preventDefault(); target.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
});

(async function boot() {
  try {
    CATALOG = await (await fetch('/api/catalog')).json();
  } catch {
    app.append(h('div', { class: 'wrap', style: { padding: '120px 0' } },
      h('h1', { class: 't-heading' }, 'The server is not answering'),
      h('p', { class: 't-body-lg t-dim', style: { marginTop: '16px' } },
        'Start it with python server/main.py and reload this page.')));
    return;
  }
  render(location.pathname);
})();
