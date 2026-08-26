/* ---------------------------------------------------------------------------
   The voice session.

   The browser talks straight to AssemblyAI - our server only mints the token
   and runs the tool calls. Audio is PCM16 mono at 24 kHz, base64 inside JSON
   frames, in both directions.

   The two AudioWorklets are adapted from AssemblyAI's official browser
   starter. They are worth keeping close to the original: the capture side
   resamples because a browser may quietly ignore the sample rate an
   AudioContext asks for, and the playback side is a ring buffer rather than
   one AudioBufferSource per chunk, which is what stops the clicking and drift
   you get under network jitter.
--------------------------------------------------------------------------- */

const WIRE_RATE = 24000;

const CAPTURE_WORKLET = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ratio = sampleRate / ${WIRE_RATE};
    this._pos = 0; this._prev = 0; this._src = null; this._out = null;
  }
  _toPcm(samples, len) {
    const pcm = new Int16Array(len);
    for (let i = 0; i < len; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return pcm;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    if (this._ratio === 1) {
      const pcm = this._toPcm(ch, ch.length);
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
      return true;
    }
    const n = ch.length;
    if (!this._src || this._src.length < n + 1) {
      this._src = new Float32Array(n + 1);
      this._out = new Float32Array(Math.ceil((n + 1) / this._ratio) + 2);
    }
    const src = this._src, out = this._out;
    src[0] = this._prev; src.set(ch, 1);
    let outLen = 0, pos = this._pos;
    while (pos < n) {
      const i = Math.floor(pos), frac = pos - i;
      out[outLen++] = src[i] + (src[i + 1] - src[i]) * frac;
      pos += this._ratio;
    }
    this._pos = pos - n;
    this._prev = ch[n - 1];
    if (outLen) {
      const pcm = this._toPcm(out, outLen);
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}
registerProcessor('capture', CaptureProcessor);
`;

const PLAYBACK_WORKLET = `
class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ring = new Float32Array(sampleRate * 30);
    this._writePos = 0; this._readPos = 0; this._available = 0;
    this._step = ${WIRE_RATE} / sampleRate;
    this._rsPos = 0; this._rsPrev = 0;
    this._drained = false;
    this._rms = 0; this._frames = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'stop') {
        this._writePos = this._readPos = this._available = 0;
        this._rsPos = this._rsPrev = 0;
        return;
      }
      const int16 = new Int16Array(e.data);
      if (!int16.length) return;
      if (this._drained) { this._rsPrev = 0; this._rsPos = 0; this._drained = false; }
      if (this._step === 1) {
        for (let i = 0; i < int16.length; i++) this._push(int16[i] / 32768);
        return;
      }
      const n = int16.length;
      let pos = this._rsPos;
      while (pos < n) {
        const i = Math.floor(pos), frac = pos - i;
        const a = i === 0 ? this._rsPrev : int16[i - 1] / 32768;
        const b = int16[i] / 32768;
        this._push(a + (b - a) * frac);
        pos += this._step;
      }
      this._rsPos = pos - n;
      this._rsPrev = int16[n - 1] / 32768;
    };
  }
  _push(v) {
    if (this._available < this._ring.length) {
      this._ring[this._writePos] = v;
      this._writePos = (this._writePos + 1) % this._ring.length;
      this._available++;
    }
  }
  process(inputs, outputs) {
    const output = outputs[0], out = output[0], cap = this._ring.length;
    let sum = 0;
    for (let i = 0; i < out.length; i++) {
      if (this._available > 0) {
        out[i] = this._ring[this._readPos];
        this._readPos = (this._readPos + 1) % cap;
        this._available--;
      } else { out[i] = 0; this._drained = true; }
      sum += out[i] * out[i];
    }
    for (let ch = 1; ch < output.length; ch++) output[ch].set(out);
    // Report level from the samples actually leaving for the speaker, so the
    // orb is in sync with what the listener hears rather than what arrived.
    this._rms = Math.sqrt(sum / out.length);
    if ((this._frames++ & 3) === 0) this.port.postMessage({ rms: this._rms });
    return true;
  }
}
registerProcessor('playback', PlaybackProcessor);
`;

const blobUrl = (code) => URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));

async function addWorklet(ctx, code, name) {
  const url = blobUrl(code);
  try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
  return new AudioWorkletNode(ctx, name);
}

function b64encode(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function b64decode(str) {
  const raw = atob(str);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/* ------------------------------------------------------------------------- */

export class VoiceSession {
  /**
   * @param {string} agentId  which of the five agents to run
   * @param {object} handlers { onState, onUserPartial, onUserFinal,
   *                            onAgentPartial, onAgentFinal, onTool,
   *                            onLevel, onError, onEnd }
   */
  constructor(agentId, handlers = {}) {
    this.agentId = agentId;
    this.on = handlers;
    this.ws = null;
    this.ready = false;
    this.closing = false;
    this.micLevel = 0;
    this.agentLevel = 0;

    // Tool results must not be sent while the agent is mid-reply, or the turn
    // taking breaks. Queue them and flush once reply.done is the latest event.
    this.pendingTools = [];
    this.lastEvent = null;

    this.agentText = '';
    this.liveReply = null;
    this.printedReply = null;
  }

  _state(s) { this.on.onState?.(s); }

  async start(voice = '') {
    this.closing = false;
    this._state('connecting');

    const query = voice ? `?voice=${encodeURIComponent(voice)}` : '';
    const res = await fetch(`/api/session/${this.agentId}${query}`);
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload.token) {
      const err = new Error(payload.hint || payload.error || 'Could not start a session.');
      this.on.onError?.(err.message);
      this._state('error');
      throw err;
    }
    this.sessionConfig = payload.session;

    // Two contexts, created inside the click handler so Safari starts them.
    this.captureCtx = new AudioContext({ sampleRate: WIRE_RATE });
    this.playbackCtx = new AudioContext({ sampleRate: WIRE_RATE });
    await Promise.all([this.captureCtx.resume(), this.playbackCtx.resume()]);

    this.playback = await addWorklet(this.playbackCtx, PLAYBACK_WORKLET, 'playback');
    this.playback.connect(this.playbackCtx.destination);
    this.playback.port.onmessage = ({ data }) => {
      if (typeof data?.rms === 'number') {
        this.agentLevel = Math.min(1, data.rms * 3.4);
        this._emitLevel();
      }
    };

    this.mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,   // without this the agent hears itself
        noiseSuppression: false,  // the API does its own; doubling up hurts
        autoGainControl: false,
      },
    });

    const source = this.captureCtx.createMediaStreamSource(this.mic);
    const capture = await addWorklet(this.captureCtx, CAPTURE_WORKLET, 'capture');
    source.connect(capture);

    // A separate analyser for the meter, so measuring never touches the
    // samples on their way to the wire.
    this.analyser = this.captureCtx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.35;
    source.connect(this.analyser);
    this._buf = new Uint8Array(this.analyser.frequencyBinCount);
    this._pollMic();

    const url = new URL(payload.ws_url);
    url.searchParams.set('token', payload.token);
    this.ws = new WebSocket(url);

    capture.port.onmessage = ({ data }) => {
      if (!this.ready || this.ws?.readyState !== 1) return;
      this.ws.send(JSON.stringify({ type: 'input.audio', audio: b64encode(new Uint8Array(data)) }));
    };

    this.ws.onopen = () => {
      // Everything about the agent is configured here, inline. Nothing is
      // stored on AssemblyAI's side, so the repo is the single source of truth.
      this.ws.send(JSON.stringify({ type: 'session.update', session: this.sessionConfig }));
    };

    this.ws.onmessage = ({ data }) => this._handle(JSON.parse(data));
    this.ws.onclose = () => { this.ready = false; if (!this.closing) this._state('idle'); this.on.onEnd?.(); };
    this.ws.onerror = () => { this.on.onError?.('The connection to AssemblyAI dropped.'); this._state('error'); };
  }

  _pollMic() {
    const tick = () => {
      if (!this.analyser) return;
      this.analyser.getByteTimeDomainData(this._buf);
      let sum = 0;
      for (let i = 0; i < this._buf.length; i++) {
        const v = (this._buf[i] - 128) / 128;
        sum += v * v;
      }
      this.micLevel = Math.min(1, Math.sqrt(sum / this._buf.length) * 4.2);
      this._emitLevel();
      this._micRaf = requestAnimationFrame(tick);
    };
    this._micRaf = requestAnimationFrame(tick);
  }

  _emitLevel() {
    // Whichever side owns the turn drives the orb.
    const speaking = this.on.currentState?.() === 'speaking';
    this.on.onLevel?.(speaking ? this.agentLevel : this.micLevel);
  }

  _handle(msg) {
    switch (msg.type) {
      case 'session.ready':
        this.ready = true;
        this.sessionId = msg.session_id;
        this._state('listening');
        break;

      case 'input.speech.started':
        // Barge-in: empty the ring so the agent stops mid-word.
        this.playback?.port.postMessage('stop');
        this.lastEvent = 'input.speech.started';
        this._state('listening');
        break;

      case 'input.speech.stopped':
        this._state('thinking');
        break;

      case 'reply.started':
        this.lastEvent = 'reply.started';
        this._state('speaking');
        break;

      case 'reply.audio': {
        const bytes = b64decode(msg.data);
        this.playback?.port.postMessage(bytes.buffer, [bytes.buffer]);
        break;
      }

      case 'transcript.user.delta':
        this.on.onUserPartial?.(msg.text || '');
        break;

      case 'transcript.user':
        this.on.onUserFinal?.(msg.text || '');
        break;

      case 'transcript.agent.delta': {
        // The final line arrives before its audio finishes playing, so deltas
        // keep coming after it is printed. printedReply stops them rebuilding
        // the same sentence underneath.
        if (msg.reply_id && msg.reply_id === this.printedReply) break;
        if (msg.reply_id !== this.liveReply) { this.liveReply = msg.reply_id; this.agentText = ''; }
        this.agentText = appendDelta(this.agentText, msg.delta || '');
        this.on.onAgentPartial?.(this.agentText);
        break;
      }

      case 'transcript.agent':
        this.printedReply = msg.reply_id ?? this.printedReply;
        this.agentText = '';
        this.on.onAgentFinal?.(msg.text || '', !!msg.interrupted);
        break;

      case 'reply.done':
        this.lastEvent = 'reply.done';
        if (msg.status === 'interrupted') {
          this.playback?.port.postMessage('stop');
          this.pendingTools = [];   // a discarded turn's results are stale
        } else {
          this._flushTools();
        }
        this._state('listening');
        break;

      case 'tool.call':
        this._runTool(msg);
        break;

      case 'session.error':
        this.on.onError?.(`${msg.code}: ${msg.message}`);
        this._state('error');
        break;

      case 'session.ended':
        this.closing = true;
        this.ws?.close();
        break;

      default:
        break;
    }
  }

  async _runTool(msg) {
    const entry = {
      callId: msg.call_id,
      name: msg.name,
      args: msg.arguments || {},
      status: 'running',
      result: null,
    };
    this.on.onTool?.(entry);

    let result;
    try {
      const res = await fetch(`/api/tools/${this.agentId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: msg.name, arguments: msg.arguments || {} }),
      });
      const body = await res.json();
      result = body.result ?? { error: 'no result' };
    } catch (err) {
      result = { error: `tool transport failed: ${err.message}` };
    }

    entry.status = result?.error ? 'error' : 'done';
    entry.result = result;
    this.on.onTool?.(entry);

    this.pendingTools.push({ call_id: msg.call_id, result });
    this._flushTools();
  }

  _flushTools() {
    // Only safe while the agent is not mid-reply.
    if (this.lastEvent !== 'reply.done' && this.lastEvent !== null) return;
    if (!this.pendingTools.length || this.ws?.readyState !== 1) return;
    for (const t of this.pendingTools) {
      this.ws.send(JSON.stringify({
        type: 'tool.result',
        call_id: t.call_id,
        result: JSON.stringify(t.result),   // must be a JSON string, not an object
      }));
    }
    this.pendingTools = [];
  }

  stop() {
    this.closing = true;
    if (this.ws?.readyState === 1) {
      // Close cleanly so the session record is finalised, with the socket as
      // a fallback if the server does not answer.
      this.ws.send(JSON.stringify({ type: 'session.end' }));
      const socket = this.ws;
      setTimeout(() => { if (socket.readyState === 1) socket.close(); }, 2000);
    } else {
      this.ws?.close();
    }
    this.ready = false;
    if (this._micRaf) cancelAnimationFrame(this._micRaf);
    this.analyser = null;
    this.playback?.port.postMessage('stop');
    this.mic?.getTracks().forEach((t) => t.stop());
    this.captureCtx?.close().catch(() => {});
    this.playbackCtx?.close().catch(() => {});
    this.captureCtx = this.playbackCtx = this.playback = this.mic = null;
    this.micLevel = this.agentLevel = 0;
    this.on.onLevel?.(0);
    this._state('idle');
  }
}

/* Deltas arrive with a leading space sometimes and without it other times. */
const ATTACHES_LEFT = /^[.,!?;:%°)\]}…'"’”]/;
const NO_SPACE_AFTER = /[([{$\-\/'"‘“]$/;

export function appendDelta(text, delta) {
  if (!delta) return text;
  if (!text) return delta;
  if (/^\s/.test(delta) || /\s$/.test(text)) return text + delta;
  if (ATTACHES_LEFT.test(delta) || NO_SPACE_AFTER.test(text)) return text + delta;
  return `${text} ${delta}`;
}
