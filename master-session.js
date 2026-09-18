/**
 * Kabeer's private voice session with his secretary.
 *
 * The phone streams its mic to the gateway as binary PCM16 (24 kHz, mono); this
 * module relays it to a server-side AssemblyAI Voice Agent session and sends the
 * agent's speech back to the phone the same way. The agent is briefed from the
 * screened call's live transcript, and acts through tools, which are forwarded to
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

const BASE_PROMPT = `You are Kabeer's personal secretary. Right now you are talking privately with Kabeer himself, on his phone, about a caller you are screening on another line. The caller cannot hear this conversation.

How to talk to Kabeer:
- Address him directly ("John from Acme is calling about..."). Be very brief: one or two short sentences.
- Only state facts from the call notes below or the live notes you receive. If you don't know something yet, say the secretary line is still finding out. Never invent details.
- If he asks what the caller said, summarise it faithfully.

Acting on his instructions. Call the matching tool, then confirm in a few words:
- connect_caller: he wants to talk to the caller himself ("connect me", "put him through", "I'll take it").
- hold_caller: he wants the caller to wait. Pass the minutes he says; use 2 if he doesn't say.
- relay_message: he wants the caller told something, for example "tell him I'll call back tomorrow". Pass his message as he said it. Relaying a message does NOT end the call.
- end_call: only when he clearly says to end or finish the call ("end the call", "let him go", "hang up", "that's all").
- add_task: whenever he asks you to remind him of something, note something, or follow up later ("remind me to send the invoice"). Use it in addition to any other tool he asks for in the same breath.
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
      },
      required: ['task'],
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
    case 'add_task':
      return args.task ? { command: 'task', task: String(args.task).slice(0, 300) } : null;
    default:
      return null;
  }
}

function notesFrom(transcript) {
  if (!transcript.length) return 'No one has said anything yet on the secretary line.';
  return transcript.map(t => `${t.speaker}: ${t.text}`).join('\n');
}

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
    this.callerInfoShared = call.transcript.some(t => t.speaker === 'Caller');
    this.lastUrgentAt = 0;
    this.pendingEnd = null;        // { command, timer } while waiting out END_GRACE_MS
    this.userTurnOpen = false;     // Kabeer spoke and the agent hasn't answered yet
    this.lastTaskAt = 0;

    this.ws = new WebSocket('wss://agents.assemblyai.com/v1/ws', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    this.ws.on('open', () => this._configure());
    this.ws.on('message', (data) => this._onAgentMessage(data));
    this.ws.on('close', (code) => this._finish(code === 1000 ? null : `closed (${code})`));
    this.ws.on('error', (err) => this._finish(err.message));
    this._sendPhone({ type: 'MASTER_SESSION_STATE', callId: call.callId, state: 'connecting' });
  }

  _configure() {
    this._sendAgent({
      type: 'session.update',
      session: {
        system_prompt: `${BASE_PROMPT}\n\nCall notes so far:\n${notesFrom(this.call.transcript)}`,
        output: { voice: VOICE },
        tools: TOOLS,
      },
    });
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
        this._sendAgent({
          type: 'reply.create',
          instructions: this.callerInfoShared
            ? 'Greet Kabeer in a few words and brief him: who is calling and why, from the call notes.'
            : 'Greet Kabeer in a few words and tell him someone is on the line and you are finding out who it is.',
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

  /** A new line on the screened call; speaks up only for first info or urgency. */
  onCallTranscript(speaker, text) {
    if (!this.ready) return;
    this._sendAgent({
      type: 'conversation.message',
      role: 'system',
      content: `Live note from the secretary line. ${speaker}: ${text}`,
    });
    if (speaker !== 'Caller') return;

    const now = Date.now();
    if (URGENT.test(text) && now - this.lastUrgentAt > URGENT_COOLDOWN_MS) {
      this.lastUrgentAt = now;
      this.callerInfoShared = true;
      this._sendAgent({
        type: 'reply.create',
        instructions: 'The caller just said something that sounds urgent. Tell Kabeer in one short sentence.',
      });
    } else if (!this.callerInfoShared && text.trim().split(/\s+/).length >= 4) {
      this.callerInfoShared = true;
      this._sendAgent({
        type: 'reply.create',
        instructions: 'The caller has started explaining. In one short sentence, tell Kabeer who is calling and why, as far as you know.',
      });
    }
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
    this._sendPhone({
      type: 'MASTER_SESSION_STATE',
      callId: this.call.callId,
      state: error ? 'error' : 'ended',
      ...(error ? { error: String(error) } : {}),
    });
    this.onEnded();
  }

  _sendAgent(payload) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  _sendPhone(payload) {
    if (this.phoneWs.readyState === WebSocket.OPEN) this.phoneWs.send(JSON.stringify(payload));
  }
}

module.exports = { MasterSession };
