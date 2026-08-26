/* ---------------------------------------------------------------------------
   The orb.

   One canvas carrying the whole state of the call: idle breathing, listening,
   thinking, speaking, error. Each agent's colour steers the core while the
   state drives the halo and the motion, so five agents stay distinct without
   the state becoming illegible.

   What makes it read as glass rather than a filled circle:
     - the silhouette is fbm noise sampled around a circle, so it never repeats
     - a real blur pass, composited additively, gives bloom instead of a stack
       of translucent strokes pretending to be one
     - the rim is a conic gradient with a bright band travelling around it,
       which is what light doing a circuit of a sphere actually looks like
     - the edge carries a two-hue chromatic fringe, half a pixel apart

   Cost discipline matters because this runs beside a live audio pipeline: the
   silhouette is evaluated once per frame into a point buffer and reused by
   every pass, and the blur happens at half resolution.
--------------------------------------------------------------------------- */

const TAU = Math.PI * 2;
const STEPS = 120;          // silhouette resolution; bezier-smoothed, so more is wasted work
const BLOOM_SCALE = 0.5;    // blur pass runs at half res

/* --- value noise ---------------------------------------------------------- */

const PERM = new Uint8Array(512);
(function seedPermutation() {
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i++) table[i] = i;
  let s = 1337;
  for (let i = 255; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    const tmp = table[i]; table[i] = table[j]; table[j] = tmp;
  }
  for (let i = 0; i < 512; i++) PERM[i] = table[i & 255];
})();

const smooth = (t) => t * t * (3 - 2 * t);

function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const X = xi & 255, Y = yi & 255;
  const a = PERM[(PERM[X] + Y) & 511] / 255;
  const b = PERM[(PERM[X + 1] + Y) & 511] / 255;
  const c = PERM[(PERM[X] + Y + 1) & 511] / 255;
  const d = PERM[(PERM[X + 1] + Y + 1) & 511] / 255;
  const u = smooth(xf), v = smooth(yf);
  const top = a + (b - a) * u;
  return top + ((c + (d - c) * u) - top) * v;
}

function fbm(x, y) {
  return vnoise(x, y) * 0.62
       + vnoise(x * 2.1 + 5.2, y * 2.1 + 1.3) * 0.26
       + vnoise(x * 4.3 + 9.1, y * 4.3 + 7.7) * 0.12;
}

/* --- palette -------------------------------------------------------------- */

const STATES = {
  // State drives motion, deformation and glow. Hue is left to the agent tint,
  // because state is already legible from the dot and label under the orb, and
  // an orb that changes colour per state stops reading as that agent's orb.
  // Error is the exception: red has to stay red however the agent is coloured.
  idle:       { core: [176, 158, 255], halo: [ 92,  80, 226], drift: 0.10, wobble: 0.026, glow: 0.62 },
  connecting: { core: [200, 180, 255], halo: [ 98,  86, 232], drift: 0.55, wobble: 0.030, glow: 0.76 },
  listening:  { core: [186, 168, 255], halo: [100, 200, 190], drift: 0.20, wobble: 0.032, glow: 0.86 },
  thinking:   { core: [220, 170, 255], halo: [126,  96, 238], drift: 1.05, wobble: 0.040, glow: 0.92 },
  speaking:   { core: [196, 186, 255], halo: [150, 134, 252], drift: 0.45, wobble: 0.058, glow: 1.00 },
  error:      { core: [255, 150, 150], halo: [180,  60,  80], drift: 0.06, wobble: 0.024, glow: 0.54 },
};

const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const lerp = (a, b, t) => a + (b - a) * t;
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

/* --- orb ------------------------------------------------------------------ */

export class Orb {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.tint = hexToRgb(opts.tint) || hexToRgb('#9382ff');

    this.buf = document.createElement('canvas');
    this.bctx = this.buf.getContext('2d');

    this.state = 'idle';
    this.target = STATES.idle;
    this.cur = {
      core: [...STATES.idle.core], halo: [...STATES.idle.halo],
      drift: STATES.idle.drift, wobble: STATES.idle.wobble, glow: STATES.idle.glow,
    };

    this.level = 0;
    this.rawLevel = 0;
    this.phase = 0;
    this.t = 0;
    this.running = false;
    this.reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false;

    // Reused every frame; allocating per-frame is what makes canvas work stutter.
    this.pts = new Float32Array(STEPS * 2);

    this.motes = Array.from({ length: 54 }, (_, i) => ({
      a: (i / 54) * TAU + Math.random() * 0.5,
      r: 0.70 + Math.random() * 0.62,
      s: 0.04 + Math.random() * 0.20,
      z: Math.random(),                  // depth: also decides front or behind
      tw: Math.random() * TAU,
    }));

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.buf.width = Math.max(1, Math.round(w * BLOOM_SCALE));
    this.buf.height = Math.max(1, Math.round(h * BLOOM_SCALE));
    this.w = w; this.h = h;
    this.cx = w / 2; this.cy = h / 2;
    this.R = Math.min(w, h) * 0.30;
  }

  setState(name) {
    if (!STATES[name] || name === this.state) return;
    this.state = name;
    this.target = STATES[name];
  }

  setLevel(v) { this.rawLevel = Math.max(0, Math.min(1, v || 0)); }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.step(dt);
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() { this.running = false; if (this.raf) cancelAnimationFrame(this.raf); }

  destroy() { this.stop(); window.removeEventListener('resize', this._onResize); }

  step(dt) {
    // Attack fast, release slow: jump on a syllable, settle gently.
    const k = this.rawLevel > this.level ? 16 : 4.2;
    this.level += (this.rawLevel - this.level) * Math.min(1, k * dt);

    const T = this.target;
    const blend = Math.min(1, 3.2 * dt);
    // Error must stay red however the agent is tinted.
    const pull = this.state === 'error' ? 0 : 0.90;
    this.cur.core = lerp3(this.cur.core, lerp3(T.core, this.tint, pull), blend);
    this.cur.halo = lerp3(this.cur.halo, lerp3(T.halo, this.tint, pull * 0.86), blend);
    this.cur.drift = lerp(this.cur.drift, T.drift, blend);
    this.cur.wobble = lerp(this.cur.wobble, T.wobble, blend);
    this.cur.glow = lerp(this.cur.glow, T.glow, blend);

    const speed = this.reduced ? 0 : 1;
    this.t += dt * speed;
    this.phase += dt * (0.20 + this.cur.drift * 1.4 + this.level * 0.9) * speed;
    for (const m of this.motes) {
      m.a += dt * m.s * (0.22 + this.cur.drift) * speed;
      m.tw += dt * 1.5 * speed;
    }
  }

  /* Silhouette: fbm sampled around a circle, so the curve closes on itself and
     the shape evolves without ever repeating. Computed once, reused by every
     pass in the frame. */
  buildSilhouette(R) {
    const amp = this.cur.wobble * (0.55 + this.level * 1.35);
    const dx = this.t * 0.16, dy = this.t * 0.11;
    const pts = this.pts;
    for (let i = 0; i < STEPS; i++) {
      const th = (i / STEPS) * TAU;
      const ct = Math.cos(th), st = Math.sin(th);
      const n1 = fbm(ct * 1.15 + dx, st * 1.15 + dy) - 0.5;
      const n2 = fbm(ct * 2.4 - dy * 1.7, st * 2.4 + dx * 1.3) - 0.5;
      const r = R * (1 + amp * (n1 * 1.6 + n2 * 0.28));
      pts[i * 2] = this.cx + ct * r;
      pts[i * 2 + 1] = this.cy + st * r;
    }
  }

  /* Closed Catmull-Rom through the points, so the outline is a smooth curve
     rather than a 168-sided polygon that shimmers as it turns. */
  tracePath(ctx, scale = 1) {
    const pts = this.pts, n = STEPS, cx = this.cx, cy = this.cy;
    const px = (i) => cx + (pts[((i % n) + n) % n * 2] - cx) * scale;
    const py = (i) => cy + (pts[((i % n) + n) % n * 2 + 1] - cy) * scale;
    ctx.beginPath();
    ctx.moveTo(px(0), py(0));
    for (let i = 0; i < n; i++) {
      const x0 = px(i - 1), y0 = py(i - 1);
      const x1 = px(i), y1 = py(i);
      const x2 = px(i + 1), y2 = py(i + 1);
      const x3 = px(i + 2), y3 = py(i + 2);
      ctx.bezierCurveTo(
        x1 + (x2 - x0) / 6, y1 + (y2 - y0) / 6,
        x2 - (x3 - x1) / 6, y2 - (y3 - y1) / 6,
        x2, y2,
      );
    }
    ctx.closePath();
  }

  /* The body, painted into whichever context is passed. Used twice: once for
     the bloom buffer, once for the real thing. */
  paintBody(ctx, R, cx, cy, bright) {
    const { core, halo } = this.cur;
    const box = [cx - R * 1.6, cy - R * 1.6, R * 3.2, R * 3.2];

    const body = ctx.createRadialGradient(
      cx - R * 0.32, cy - R * 0.36, R * 0.04, cx, cy, R * 1.18);
    body.addColorStop(0.00, rgba(lerp3(core, [255, 255, 255], 0.34), bright ? 1 : 0.97));
    body.addColorStop(0.20, rgba(lerp3(core, [255, 255, 255], 0.06), bright ? 0.95 : 0.88));
    body.addColorStop(0.52, rgba(core, bright ? 0.80 : 0.70));
    body.addColorStop(0.80, rgba(lerp3(halo, core, 0.35), bright ? 0.60 : 0.50));
    body.addColorStop(1.00, bright ? rgba(halo, 0.20) : 'rgba(6,3,23,0.96)');
    ctx.fillStyle = body;
    ctx.fillRect(...box);

    // Internal currents, positions domain-warped by noise so they wander like
    // something suspended in liquid rather than orbiting on rails.
    ctx.globalCompositeOperation = 'lighter';
    const tint = this.tint;
    const currents = [
      { seed: 0.0, span: 0.66, c: lerp3([229, 156, 255], tint, 0.62) },
      { seed: 3.7, span: 0.58, c: lerp3([156, 178, 255], tint, 0.62) },
      { seed: 7.1, span: 0.74, c: core },
      { seed: 11.4, span: 0.48, c: lerp3(core, [255, 255, 255], 0.28) },
    ];
    for (const cu of currents) {
      const wx = fbm(this.t * 0.20 + cu.seed, cu.seed * 0.5) - 0.5;
      const wy = fbm(cu.seed * 0.7, this.t * 0.20 + cu.seed) - 0.5;
      const gx = cx + wx * R * 1.15;
      const gy = cy + wy * R * 1.15;
      const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, R * cu.span);
      const strength = (0.23 + this.level * 0.30) * this.cur.glow * (bright ? 1.35 : 1);
      g.addColorStop(0, rgba(cu.c, strength));
      g.addColorStop(1, rgba(cu.c, 0));
      ctx.fillStyle = g;
      ctx.fillRect(...box);
    }

    // A core that brightens with the voice: the sense of something alive inside.
    const coreR = R * (0.16 + this.level * 0.20);
    const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    cg.addColorStop(0, `rgba(255,255,255,${(0.11 + this.level * 0.24) * this.cur.glow})`);
    cg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = cg;
    ctx.fillRect(...box);

    ctx.globalCompositeOperation = 'source-over';
  }

  draw() {
    const ctx = this.ctx;
    const { core, halo, glow } = this.cur;
    const breathe = 1 + Math.sin(this.t * 0.8) * 0.020;
    const R = this.R * breathe * (1 + this.level * 0.11);

    ctx.clearRect(0, 0, this.w, this.h);
    this.buildSilhouette(R);

    // --- atmosphere. Stops at the shorter edge so it cannot clip square. ---
    const reach = Math.min(R * 3.0, Math.min(this.w, this.h) * 0.5);
    const atm = ctx.createRadialGradient(this.cx, this.cy, R * 0.5, this.cx, this.cy, reach);
    const aStrength = (0.17 + this.level * 0.22) * glow;
    atm.addColorStop(0, rgba(halo, aStrength));
    atm.addColorStop(0.45, rgba(halo, aStrength * 0.28));
    atm.addColorStop(1, rgba(halo, 0));
    ctx.fillStyle = atm;
    ctx.fillRect(0, 0, this.w, this.h);

    // --- motes behind ------------------------------------------------------
    this.drawMotes(ctx, R, false);

    // --- bloom: a real blur pass, additively composited --------------------
    const bs = BLOOM_SCALE;
    const bctx = this.bctx;
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.clearRect(0, 0, this.buf.width, this.buf.height);
    bctx.save();
    bctx.scale(bs, bs);
    bctx.beginPath();
    bctx.arc(this.cx, this.cy, R * 1.02, 0, TAU);
    bctx.clip();
    this.paintBody(bctx, R, this.cx, this.cy, true);
    bctx.restore();

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.38 * glow;
    ctx.filter = `blur(${Math.round(R * 0.30)}px)`;
    ctx.drawImage(this.buf, 0, 0, this.w, this.h);
    ctx.restore();

    // --- body --------------------------------------------------------------
    ctx.save();
    this.tracePath(ctx);
    ctx.clip();
    this.paintBody(ctx, R, this.cx, this.cy, false);

    // weight: a shadow gathering at the lower right
    const dx = this.cx + R * 0.46, dy = this.cy + R * 0.52;
    const dark = ctx.createRadialGradient(dx, dy, R * 0.10, dx, dy, R * 1.08);
    dark.addColorStop(0, 'rgba(3,0,20,0.42)');
    dark.addColorStop(1, 'rgba(3,0,20,0)');
    ctx.fillStyle = dark;
    ctx.fillRect(this.cx - R * 1.6, this.cy - R * 1.6, R * 3.2, R * 3.2);

    // specular: fixed upper-left, like a real light in the room
    const sx = this.cx - R * 0.36, sy = this.cy - R * 0.42;
    const spec = ctx.createRadialGradient(sx, sy, 0, sx, sy, R * 0.50);
    spec.addColorStop(0, 'rgba(255,255,255,0.32)');
    spec.addColorStop(0.5, 'rgba(255,255,255,0.07)');
    spec.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = spec;
    ctx.fillRect(this.cx - R * 1.6, this.cy - R * 1.6, R * 3.2, R * 3.2);
    ctx.restore();

    // --- rim: a bright band travelling around a conic gradient -------------
    let rim;
    if (ctx.createConicGradient) {
      rim = ctx.createConicGradient(this.phase * 0.85, this.cx, this.cy);
      const hot = lerp3(core, [255, 255, 255], 0.86);
      rim.addColorStop(0.00, rgba(hot, 1.00 * glow));
      rim.addColorStop(0.06, rgba(core, 0.52 * glow));
      rim.addColorStop(0.22, rgba(halo, 0.16 * glow));
      rim.addColorStop(0.44, rgba(core, 0.30 * glow));
      rim.addColorStop(0.62, rgba(lerp3(core, [255, 255, 255], 0.5), 0.80 * glow));
      rim.addColorStop(0.70, rgba(core, 0.34 * glow));
      rim.addColorStop(0.90, rgba(halo, 0.18 * glow));
      rim.addColorStop(1.00, rgba(hot, 1.00 * glow));
    } else {
      // Older engines: a rotating linear gradient is the closest cheap stand-in.
      const a = this.phase * 0.85;
      rim = ctx.createLinearGradient(
        this.cx + Math.cos(a) * R, this.cy + Math.sin(a) * R,
        this.cx - Math.cos(a) * R, this.cy - Math.sin(a) * R);
      rim.addColorStop(0, rgba(lerp3(core, [255, 255, 255], 0.7), 0.9 * glow));
      rim.addColorStop(1, rgba(halo, 0.35 * glow));
    }
    // Wide soft pass, then the crisp line on top: a single stroke reads as an
    // outline drawn around a circle rather than light sitting on glass.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    this.tracePath(ctx);
    ctx.strokeStyle = rim;
    ctx.lineWidth = 6 + this.level * 9;
    ctx.globalAlpha = 0.20;
    ctx.stroke();
    ctx.restore();

    this.tracePath(ctx);
    ctx.strokeStyle = rim;
    ctx.lineWidth = 1.3 + this.level * 1.2;
    ctx.stroke();

    // The bright crescent a sphere catches on its lit side.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const ga = this.phase * 0.85;
    const gl = ctx.createLinearGradient(
      this.cx + Math.cos(ga) * R, this.cy + Math.sin(ga) * R,
      this.cx - Math.cos(ga) * R * 0.2, this.cy - Math.sin(ga) * R * 0.2);
    gl.addColorStop(0, `rgba(255,255,255,${0.62 * glow})`);
    gl.addColorStop(0.35, `rgba(255,255,255,${0.10 * glow})`);
    gl.addColorStop(1, 'rgba(255,255,255,0)');
    this.tracePath(ctx, 0.992);
    ctx.strokeStyle = gl;
    ctx.lineWidth = 2.2;
    ctx.stroke();
    ctx.restore();

    // chromatic fringe: two hues, half a pixel apart, barely there
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = 1;
    this.tracePath(ctx, 1.004);
    ctx.strokeStyle = `rgba(229,156,255,${0.22 * glow})`;
    ctx.stroke();
    this.tracePath(ctx, 0.996);
    ctx.strokeStyle = `rgba(140,190,255,${0.20 * glow})`;
    ctx.stroke();
    ctx.restore();

    // --- motes in front ----------------------------------------------------
    this.drawMotes(ctx, R, true);
  }

  drawMotes(ctx, R, front) {
    const { core, glow } = this.cur;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const m of this.motes) {
      if ((m.z > 0.5) !== front) continue;
      const rr = R * (1.20 + m.r * 0.72);
      const x = this.cx + Math.cos(m.a) * rr;
      // A shallow ellipse reads as an orbit rather than a flat scatter.
      const y = this.cy + Math.sin(m.a) * rr * 0.58;
      const tw = 0.30 + 0.70 * (0.5 + 0.5 * Math.sin(m.tw));
      const depth = front ? 0.55 + m.z * 0.45 : 0.25 + m.z * 0.5;
      const a = tw * depth * (0.26 + this.level * 0.42) * glow;
      const size = (front ? 1.0 : 0.7) + m.z * 0.8;
      const g = ctx.createRadialGradient(x, y, 0, x, y, size * 3);
      g.addColorStop(0, rgba(core, a));
      g.addColorStop(1, rgba(core, 0));
      ctx.fillStyle = g;
      ctx.fillRect(x - size * 3, y - size * 3, size * 6, size * 6);
    }
    ctx.restore();
  }
}

/* ---------------------------------------------------------------------------
   Decorative orb for the landing hero: same visual language, no microphone.
--------------------------------------------------------------------------- */

export function heroOrb(canvas) {
  const orb = new Orb(canvas, { tint: '#9382ff' });
  orb.setState('idle');
  let t = 0;
  const tick = () => {
    if (!orb.running) return;
    t += 0.06;
    // A slow synthetic swell, so the hero orb has life without audio.
    orb.setLevel(0.18 + 0.18 * (0.5 + 0.5 * Math.sin(t * 0.55))
                      + 0.06 * (0.5 + 0.5 * Math.sin(t * 1.9)));
    setTimeout(tick, 60);
  };
  orb.start();
  tick();
  return orb;
}
