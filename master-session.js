/**
 * Kabeer's private voice session with his secretary.
 *
 * The phone streams its mic to the gateway as binary PCM16 (24 kHz, mono); this
 * module relays it to a server-side AssemblyAI Voice Agent session and sends the
 * agent's speech back to the phone the same way. The agent is briefed from the
 * caller details the screening secretary confirmed (name, reason, urgency) plus
 * the live transcript, and acts through tools, which are forwarded to
 * the phone as MASTER_COMMAND so voice commands and the on-screen buttons run the
 * same code.
 */
const WebSocket = require('ws');

const VOICE = 'alba'; // same voice as the caller-facing secretary: it's one person
const URGENT = /\b(urgent|emergency|hospital|accident|asap|immediately|right away|police|ambulance|critical|dying|injured)\b/i;
const URGENT_COOLDOWN_MS = 30 * 1000;
// "End the call ... and remind me to X" often has a pause in the middle: wait
// this long after "end" before acting, in case Kabeer is still talking
const END_GRACE_MS = 2500;
const TASK_DEDUPE_MS = 10 * 1000;
// How long the first identity briefing waits for CALLER_CONTEXT from the phone
const CONTEXT_WAIT_MS = 700;

const BASE_PROMPT = `You are Kabeer's personal secretary. Right now you are talking privately with Kabeer himself, on his phone, about a caller you are screening on another line. The caller cannot hear this conversation.

How to talk to Kabeer:
- Address him directly ("John from Acme is calling about..."). Be very brief: one or two short sentences.
- The caller's name, company and reason are known ONLY when they appear under "Confirmed caller details" or in a live note starting "Confirmed caller details". Until then, say the caller hasn't given a name yet. Never guess or make up a name, company or reason.
- Other facts come only from the call notes and live notes. If you don't know something, say the secretary line is still finding out.
- If he asks what the caller said, summarise it faithfully.

Acting on his instructions. Call the matching tool, then confirm in a few words:
- connect_caller: he wants to talk to the caller himself ("connect me", "put him through", "I'll take it").
- hold_caller: he wants the caller to wait. Pass the minutes he says; use 2 if he doesn't say.
- relay_message: he wants the caller told something, for example "tell him I'll call back tomorrow". Pass his message as he said it. Relaying a message does NOT end the call.
- end_call: only when he clearly says to end or finish the call ("end the call", "let him go", "hang up", "that's all").
- add_task: whenever he asks you to remind him of something, note something, or follow up later ("remind me to send the invoice"). Use it in addition to any other tool he asks for in the same breath. If he says when ("tomorrow", "by Friday", "next Monday"), pass the due date, worked out from today's date below.
If you are unsure whether he wants the call ended, relay his message and ask him whether to end the call. If you are not sure what he wants at all, ask him.
When ending the call, confirm in at most five words (for example "Done, ending the call") and then stay quiet.`;

const TOOLS = [
  {
    type: 'function',
    name: 'connect_caller',
    description: 'Kabeer wants to speak to the caller himself right now.',
    parameters: { type: 'object', properties: {}, required: [] },
    execution_mode: 'interactive',
  },
  {
    type: 'function',
    name: 'hold_caller',
    description: 'Kabeer wants the caller to wait on the line.',
    parameters: {
      type: 'object',
      properties: {
        minutes: { type: 'integer', description: 'How many minutes the caller should hold. 2 if Kabeer does not say.' },
      },
      required: ['minutes'],
    },
    execution_mode: 'interactive',
  },
  {
    type: 'function',
    name: 'relay_message',
    description: 'Kabeer wants the secretary to tell the caller something.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: "What Kabeer wants the caller told, in Kabeer's own words." },
      },
      required: ['message'],
    },
    execution_mode: 'interactive',
  },
  {
    type: 'function',
    name: 'end_call',
    description: 'Kabeer wants the call ended; the secretary says goodbye to the caller.',
    parameters: { type: 'object', properties: {}, required: [] },
    execution_mode: 'interactive',
  },
  {
    type: 'function',
    name: 'add_task',
    description: 'Kabeer wants a reminder or follow-up task saved for this call.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task, phrased as a to-do, e.g. "Send John Carter a copy of the invoice".' },
        due: {
          type: 'string',
          description: 'Due date as YYYY-MM-DD if Kabeer said when, otherwise an empty string.',
        },
      },
      required: ['task', 'due'],
    },
    execution_mode: 'interactive',
  },
];

// Tool name -> MASTER_COMMAND the phone understands
function toCommand(name, args) {
  switch (name) {
    case 'connect_caller':
      return { command: 'connect' };
    case 'hold_caller': {
      const minutes = Math.min(30, Math.max(1, Math.round(Number(args.minutes) || 2)));
      return { command: 'hold', minutes };
    }
    case 'relay_message':
      return args.message ? { command: 'relay', message: String(args.message).slice(0, 300) } : null;
    case 'end_call':
      return { command: 'end' };
    case 'add_task': {
      if (!args.task) return null;
      const due = /^\d{4}-\d{2}-\d{2}$/.test(String(args.due || '')) ? String(args.due) : undefined;
      return { command: 'task', task: String(args.task).slice(0, 300), ...(due ? { due } : {}) };
    }
    default:
      return null;
  }
}

// Kabeer's local date, for due dates like "tomorrow" (the server runs in UTC)
const TIME_ZONE = process.env.KABEER_TIMEZONE || 'Asia/Karachi';

function todayLine(now = new Date()) {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'long' }).format(now);
  return `Today is ${weekday}, ${date} (Kabeer's time).`;
}

function notesFrom(transcript) {
  if (!transcript.length) return 'No one has said anything yet on the secretary line.';
  return transcript.map(t => `${t.speaker}: ${t.text}`).join('\n');
}

function detailsFrom(details = {}, context = null) {
  const lines = [
    `Name: ${details.name || 'not given yet'}`,
    `Company: ${details.company || 'not given'}`,
    `Reason: ${details.reason || 'not given yet'}`,
    `Urgent: ${details.urgent ? 'yes' : 'not stated'}`,
  ];
  if (details.message) lines.push(`Message for Kabeer: ${details.message}`);
  if (details.callback) lines.push(`Call back: ${details.callback}`);
  if (context?.relationship) {
    // From Kabeer's own contacts on his phone
    lines.push(`In Kabeer's contacts as: ${context.relationship}`);
    if (context.company) lines.push(`Contact's company: ${context.company}`);
    if (context.note) lines.push(`Kabeer's note about them: ${context.note}`);
  }
  return lines.join('\n');
}

const hasIdentity = (details = {}) => Boolean(details.name || details.reason);

class MasterSession {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey AssemblyAI API key
   * @param {object} opts.call gateway call record (callId, transcript[])
   * @param {WebSocket} opts.phoneWs the phone's gateway socket
   * @param {(cmd: object) => void} opts.onCommand forwards a MASTER_COMMAND to the phone
   * @param {() => void} opts.onEnded called once when the session is over
   */
  constructor({ apiKey, call, phoneWs, onCommand, onEnded }) {
    this.call = call;
    this.phoneWs = phoneWs;
    this.onCommand = onCommand;
    this.onEnded = onEnded;
    this.ready = false;
    this.ended = false;
    this.replyActive = false;
    this.pendingResults = [];      // tool results held until the current reply is done
    // Kabeer has been told who is calling (from confirmed details)
    this.identityBriefed = false;
    this.urgentBriefed = false;
    this.lastUrgentAt = 0;
    this.pendingEnd = null;        // { command, timer } while waiting out END_GRACE_MS
    this.userTurnOpen = false;     // Kabeer spoke and the agent hasn't answered yet
    this.lastTaskAt = 0;
    this.kabeerEngaged = false;    // Kabeer has spoken to her about this call
    this.queuedReplies = [];       // reply.create waiting for the current reply to finish
    this.identityBriefingTimer = null; // first briefing, waiting briefly for CALLER_CONTEXT

    this.ws = new WebSocket('wss://agents.assemblyai.com/v1/ws', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    this.ws.on('open', () => this._configure());
    this.ws.on('message', (data) => this._onAgentMessage(data));
    this.ws.on('close', (code) => this._finish(code === 1000 ? null : `closed (${code})`));
    this.ws.on('error', (err) => this._finish(err.message));
    this._sendPhone({ type: 'MASTER_SESSION_STATE', callId: call.callId, state: 'connecting' });
  }

  _prompt() {
    return `${BASE_PROMPT}\n\n${todayLine()}\n\nConfirmed caller details:\n${detailsFrom(this.call.details, this.call.context)}\n\nCall notes so far:\n${notesFrom(this.call.transcript)}`;
  }

  _configure() {
    this._sendAgent({
      type: 'session.update',
      session: {
        system_prompt: this._prompt(),
        output: { voice: VOICE },
        tools: TOOLS,
      },
    });
  }

  // Live context goes into the system prompt itself (mutable mid-session):
  // conversation.message is accepted by the API but was not used by the agent
  _refreshPrompt() {
    this._sendAgent({ type: 'session.update', session: { system_prompt: this._prompt() } });
  }

  _onAgentMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (process.env.MASTER_DEBUG && msg.type !== 'reply.audio' && msg.type !== 'transcript.agent.delta') {
      console.log(`[Master debug] ${new Date().toISOString().slice(11, 23)} ${msg.type}${msg.text ? ` "${msg.text}"` : ''}`);
    }
    switch (msg.type) {
      case 'session.ready':
        this.ready = true;
        this._sendPhone({ type: 'MASTER_SESSION_STATE', callId: this.call.callId, state: 'listening' });
        // Brief Kabeer as soon as he's on
        this.identityBriefed = hasIdentity(this.call.details);
        this.urgentBriefed = Boolean(this.call.details?.urgent);
        this._sendAgent({
          type: 'reply.create',
          instructions: this.identityBriefed
            ? 'Greet Kabeer in a few words and brief him: who is calling and why, using only the confirmed caller details.'
            : "Greet Kabeer in a few words and tell him someone is on the line and the secretary is finding out who it is. Do not mention any name.",
        });
        break;
      case 'reply.started':
        this.replyActive = true;
        this.userTurnOpen = false;
        // The agent is answering; the countdown restarts once it has finished
        if (this.pendingEnd) clearTimeout(this.pendingEnd.timer);
        this._sendPhone({ type: 'MASTER_SESSION_STATE', callId: this.call.callId, state: 'speaking' });
        break;
      case 'reply.audio':
        if (this.phoneWs.readyState === WebSocket.OPEN) {
          this.phoneWs.send(Buffer.from(msg.data, 'base64'), { binary: true });
        }
        break;
      case 'reply.done':
        this.replyActive = false;
        if (msg.status === 'interrupted') {
          // Kabeer talked over the secretary: drop what's still queued on the phone
          this._sendPhone({ type: 'MASTER_AUDIO_FLUSH', callId: this.call.callId });
        }
        this._flushToolResults();
        // An interrupted reply means Kabeer is talking again: wait for the next answer
        if (this.pendingEnd && msg.status !== 'interrupted' && !this.userTurnOpen) this._armEnd();
        // A briefing held back while she was answering goes out now
        if (this.queuedReplies.length) this._sendAgent(this.queuedReplies.shift());
        this._sendPhone({ type: 'MASTER_SESSION_STATE', callId: this.call.callId, state: 'listening' });
        break;
      case 'input.speech.started':
        // Kabeer is still talking: don't end the call under him
        this.userTurnOpen = true;
        if (this.pendingEnd) clearTimeout(this.pendingEnd.timer);
        break;
      case 'input.speech.stopped':
        // Fallback if his speech gets no answer at all (e.g. background noise)
        if (this.pendingEnd) this._armEnd(6000);
        break;
      case 'transcript.user':
        // Kabeer is talking it over: the gateway won't have the caller leave a message
        this.kabeerEngaged = true;
        this._sendPhone({ type: 'MASTER_TRANSCRIPT', callId: this.call.callId, speaker: 'Master', text: msg.text });
        break;
      case 'transcript.agent':
        this._sendPhone({ type: 'MASTER_TRANSCRIPT', callId: this.call.callId, speaker: 'Secretary', text: msg.text });
        break;
      case 'tool.call': {
        // The docs show both a nested `tool` object and top-level fields
        const tool = msg.tool || msg;
        let args = tool.arguments || {};
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { args = {}; }
        }
        const command = toCommand(tool.name, args);
        console.log(`[Master] ${this.call.callId} tool ${tool.name} ${JSON.stringify(args)}`);
        if (command?.command === 'end') {
          // Held back until Kabeer has finished (see _armEnd)
          if (this.pendingEnd) clearTimeout(this.pendingEnd.timer);
          this.pendingEnd = { command, timer: null };
          if (!this.replyActive && !this.userTurnOpen) this._armEnd();
        } else if (command?.command === 'task') {
          // The agent sometimes restates a task it just saved: replace, don't duplicate
          const now = Date.now();
          const replacesPrevious = now - this.lastTaskAt < TASK_DEDUPE_MS;
          this.lastTaskAt = now;
          this.onCommand({ type: 'MASTER_COMMAND', callId: this.call.callId, ...command, replacesPrevious });
        } else if (command) {
          this.onCommand({ type: 'MASTER_COMMAND', callId: this.call.callId, ...command });
        }
        // result must be a string (an object is rejected as invalid_format)
        this.pendingResults.push({
          type: 'tool.result',
          call_id: tool.call_id,
          result: JSON.stringify(command ? { done: true } : { done: false, reason: 'unknown tool' }),
          is_error: !command,
        });
        if (!this.replyActive) this._flushToolResults();
        break;
      }
      case 'session.error':
      case 'error':
        console.warn(`[Master] ${this.call.callId} AssemblyAI error ${msg.code}: ${msg.message}`);
        if (!this.ready) this._finish(msg.message || msg.code);
        break;
      case 'session.ended':
        this._finish(null);
        break;
      default:
        break;
    }
  }

  // Ends the call once Kabeer has been quiet for `delay` after the agent's last answer
  _armEnd(delay = END_GRACE_MS) {
    const pending = this.pendingEnd;
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      if (this.pendingEnd !== pending) return;
      this.pendingEnd = null;
      this.onCommand({ type: 'MASTER_COMMAND', callId: this.call.callId, ...pending.command });
    }, delay);
  }

  // Tool results go out only after the reply that announced the tool is done
  _flushToolResults() {
    while (this.pendingResults.length) this._sendAgent(this.pendingResults.shift());
  }

  /** Mic audio from the phone (raw PCM16 24 kHz mono). */
  audioFromPhone(frame) {
    if (!this.ready) return;
    this._sendAgent({ type: 'input.audio', audio: Buffer.from(frame).toString('base64') });
  }

  /** A new line on the screened call: context only, speaks up for urgency. */
  onCallTranscript(speaker, text) {
    if (!this.ready) return;
    // call.transcript already holds this line (the gateway appends before calling)
    this._refreshPrompt();
    if (speaker !== 'Caller') return;

    const now = Date.now();
    if (URGENT.test(text) && now - this.lastUrgentAt > URGENT_COOLDOWN_MS) {
      this.lastUrgentAt = now;
      this.urgentBriefed = true;
      this._sendAgent({
        type: 'reply.create',
        instructions: 'The caller just said something that sounds urgent. Tell Kabeer in one short sentence.',
      });
    }
  }

  /** The screening secretary recorded (or corrected) the caller's details. */
  onCallerDetails() {
    if (!this.ready) return;
    const details = this.call.details;
    this._refreshPrompt();
    if (!this.identityBriefed && hasIdentity(details)) {
      this.identityBriefed = true;
      this.urgentBriefed = this.urgentBriefed || Boolean(details.urgent);
      // Give the phone a moment to say whether this is someone in Kabeer's
      // contacts (CALLER_CONTEXT) so the first briefing can mention it
      this.identityBriefingTimer = setTimeout(() => this._briefIdentity(), CONTEXT_WAIT_MS);
    } else if (details.urgent && !this.urgentBriefed) {
      this.urgentBriefed = true;
      this.lastUrgentAt = Date.now();
      this._sendAgent({
        type: 'reply.create',
        instructions: 'The caller says this is urgent. Tell Kabeer in one short sentence.',
      });
    }
  }

  /** Kabeer's phone matched the caller to one of his contacts. */
  onCallerContext() {
    if (!this.ready) return;
    this._refreshPrompt();
    // Still waiting to brief? Do it now, with the contact included
    if (this.identityBriefingTimer) this._briefIdentity();
  }

  _briefIdentity() {
    clearTimeout(this.identityBriefingTimer);
    this.identityBriefingTimer = null;
    if (this.ended) return;
    const known = this.call.context?.relationship;
    this._sendAgent({
      type: 'reply.create',
      instructions: `The secretary line has just confirmed:\n${detailsFrom(this.call.details, this.call.context)}\n` +
        `In one short sentence, tell Kabeer who is calling and why${known ? ', mentioning how he knows them' : ''}. ` +
        'Mention only what is confirmed above.',
    });
  }

  stop() {
    if (this.ended) return;
    if (this.ws.readyState === WebSocket.OPEN) {
      this._sendAgent({ type: 'session.end' });
      setTimeout(() => this.ws.close(), 1000);
    } else {
      this.ws.terminate();
    }
    this._finish(null);
  }

  _finish(error) {
    if (this.ended) return;
    this.ended = true;
    this.ready = false;
    if (this.pendingEnd) clearTimeout(this.pendingEnd.timer);
    this.pendingEnd = null;
    clearTimeout(this.identityBriefingTimer);
    this.identityBriefingTimer = null;
    this._sendPhone({
      type: 'MASTER_SESSION_STATE',
      callId: this.call.callId,
      state: error ? 'error' : 'ended',
      ...(error ? { error: String(error) } : {}),
    });
    this.onEnded();
  }

  _sendAgent(payload) {
    // reply.create sent while the agent is answering is silently dropped by
    // the API: hold it until that reply is done
    if (payload.type === 'reply.create' && this.replyActive) {
      this.queuedReplies.push(payload);
      return;
    }
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  _sendPhone(payload) {
    if (this.phoneWs.readyState === WebSocket.OPEN) this.phoneWs.send(JSON.stringify(payload));
  }
}

module.exports = { MasterSession };
