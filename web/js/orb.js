/* ---------------------------------------------------------------------------
   The orb.

   A single canvas that carries the whole state of the call: idle breathing,
   listening (rim reacts to the microphone), thinking (an internal current
   speeds up), speaking (the body swells with the agent's own audio), and
   error. Everything is drawn from the palette in tokens.css so it belongs to
   the same system as the rest of the page.

   Shape comes from summed sines rather than real noise - three harmonics is
   enough to read as organic and costs almost nothing per frame, which matters
   because this runs beside a live audio pipeline.
--------------------------------------------------------------------------- */

const TAU = Math.PI * 2;

const STATES = {
  idle:       { core: [168, 150, 255], halo: [ 80,  70, 228], drift: 0.10, wobble: 0.020, glow: 0.55 },
  connecting: { core: [200, 180, 255], halo: [ 90,  78, 235], drift: 0.42, wobble: 0.030, glow: 0.70 },
  listening:  { core: [186, 156, 255], halo: [ 94, 230, 184], drift: 0.16, wobble: 0.028, glow: 0.78 },
  thinking:   { core: [229, 156, 255], halo: [122,  88, 240], drift: 0.85, wobble: 0.042, glow: 0.86 },
  speaking:   { core: [156, 178, 255], halo: [147, 130, 255], drift: 0.34, wobble: 0.052, glow: 1.00 },
  error:      { core: [255, 150, 150], halo: [180,  60,  80], drift: 0.06, wobble: 0.016, glow: 0.50 },
};

const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const lerp = (a, b, t) => a + (b - a) * t;
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

export class Orb {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    // Each agent owns a colour. It steers the orb's core so the five read as
    // five different things, while the state palette still drives the halo -
    // that way "listening" and "error" stay legible whatever the tint is.
    this.tint = hexToRgb(opts.tint) || hexToRgb('#9382ff');

    this.state = 'idle';
    this.target = STATES.idle;
    // Rendered palette lags the target so state changes cross-fade rather
    // than cut, which is the difference between a toy and a product.
    this.cur = {
      core: [...STATES.idle.core], halo: [...STATES.idle.halo],
      drift: STATES.idle.drift, wobble: STATES.idle.wobble, glow: STATES.idle.glow,
    };

    this.level = 0;        // smoothed audio level, 0..1
    this.rawLevel = 0;
    this.phase = 0;        // rotation accumulator
    this.t = 0;
    this.ripples = [];
    this.running = false;
    this.reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false;

    this.particles = Array.from({ length: 42 }, (_, i) => ({
      a: (i / 42) * TAU + Math.random() * 0.4,
      r: 0.74 + Math.random() * 0.5,
      s: 0.05 + Math.random() * 0.22,
      z: 0.35 + Math.random() * 0.65,
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
    this.w = w;
    this.h = h;
    this.cx = w / 2;
    this.cy = h / 2;
    this.R = Math.min(w, h) * 0.31;
  }

  setState(name) {
    if (!STATES[name] || name === this.state) return;
    this.state = name;
    this.target = STATES[name];
    if (name === 'speaking') this.ripples.push({ r: 1, a: 0.34 });
  }

  /** level: 0..1 from an AnalyserNode, whichever side is currently active. */
  setLevel(v) {
    this.rawLevel = Math.max(0, Math.min(1, v || 0));
  }

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

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
  }

  destroy() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
  }

  step(dt) {
    // Attack fast, release slow: the orb should jump on a syllable and settle
    // gently, the way a VU meter does.
    const k = this.rawLevel > this.level ? 14 : 4.5;
    this.level += (this.rawLevel - this.level) * Math.min(1, k * dt);

    const T = this.target;
    const blend = Math.min(1, 3.2 * dt);
    // Error is the one state that must not be tinted away - a red orb has to
    // stay red however the agent is coloured.
    const pull = this.state === 'error' ? 0 : 0.80;
    const core = lerp3(T.core, this.tint, pull);
    const halo = lerp3(T.halo, this.tint, pull * 0.62);
    this.cur.core = lerp3(this.cur.core, core, blend);
    this.cur.halo = lerp3(this.cur.halo, halo, blend);
    this.cur.drift = lerp(this.cur.drift, T.drift, blend);
    this.cur.wobble = lerp(this.cur.wobble, T.wobble, blend);
    this.cur.glow = lerp(this.cur.glow, T.glow, blend);

    const speed = this.reduced ? 0 : 1;
    this.t += dt * speed;
    this.phase += dt * (0.22 + this.cur.drift * 1.5 + this.level * 0.8) * speed;

    for (const p of this.particles) {
      p.a += dt * p.s * (0.25 + this.cur.drift) * speed;
      p.tw += dt * 1.6 * speed;
    }

    if (this.state === 'speaking' && this.level > 0.42 && Math.random() < dt * 4) {
      this.ripples.push({ r: 1, a: 0.2 });
    }
    this.ripples = this.ripples.filter((rp) => {
      rp.r += dt * 0.85;
      rp.a -= dt * 0.34;
      return rp.a > 0.01 && rp.r < 2.6;
    });
  }

  /** Organic radius: three harmonics, amplitude driven by state and audio. */
  radiusAt(theta, R) {
    const amp = this.cur.wobble * (0.42 + this.level * 1.5);
    const p = this.phase;
    return R * (1
      + amp * Math.sin(3 * theta + p * 1.7)
      + amp * 0.62 * Math.sin(5 * theta - p * 1.15 + 1.3)
      + amp * 0.38 * Math.sin(2 * theta + p * 0.65 + 2.6));
  }

  blobPath(ctx, R) {
    ctx.beginPath();
    const steps = 128;
    for (let i = 0; i <= steps; i++) {
      const th = (i / steps) * TAU;
      const r = this.radiusAt(th, R);
      const x = this.cx + Math.cos(th) * r;
      const y = this.cy + Math.sin(th) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  draw() {
    const ctx = this.ctx;
    const { core, halo, glow } = this.cur;
    // Breathing is always present, so the orb never looks frozen at rest.
    const breathe = 1 + Math.sin(this.t * 0.85) * 0.022;
    const R = this.R * breathe * (1 + this.level * 0.13);

    ctx.clearRect(0, 0, this.w, this.h);

    // --- 1. atmosphere ----------------------------------------------------
    // Stop the atmosphere exactly at the shorter canvas edge. Letting it run
    // past would clip mid-gradient and draw a visible square around the orb.
    const reach = Math.min(R * 3.0, Math.min(this.w, this.h) * 0.5);
    const atm = ctx.createRadialGradient(this.cx, this.cy, R * 0.55, this.cx, this.cy, reach);
    const aStrength = (0.16 + this.level * 0.20) * glow;
    atm.addColorStop(0, rgba(halo, aStrength));
    atm.addColorStop(0.42, rgba(halo, aStrength * 0.30));
    atm.addColorStop(1, rgba(halo, 0));
    ctx.fillStyle = atm;
    ctx.fillRect(0, 0, this.w, this.h);

    // --- 2. ripples -------------------------------------------------------
    for (const rp of this.ripples) {
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, R * rp.r, 0, TAU);
      ctx.strokeStyle = rgba(core, rp.a * 0.55);
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // --- 3. constellation -------------------------------------------------
    for (const p of this.particles) {
      const rr = R * (1.25 + p.r * 0.62);
      // A shallow ellipse reads as orbit rather than a flat scatter.
      const x = this.cx + Math.cos(p.a) * rr;
      const y = this.cy + Math.sin(p.a) * rr * 0.62;
      const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(p.tw));
      const a = tw * p.z * (0.30 + this.level * 0.45) * glow;
      ctx.beginPath();
      ctx.arc(x, y, 0.7 + p.z * 0.9, 0, TAU);
      ctx.fillStyle = rgba(core, a);
      ctx.fill();
    }

    // --- 4. body ----------------------------------------------------------
    ctx.save();
    this.blobPath(ctx, R);
    ctx.clip();

    const body = ctx.createRadialGradient(
      this.cx - R * 0.30, this.cy - R * 0.34, R * 0.05,
      this.cx, this.cy, R * 1.16,
    );
    body.addColorStop(0.00, rgba(lerp3(core, [255, 255, 255], 0.55), 0.96));
    body.addColorStop(0.28, rgba(core, 0.80));
    body.addColorStop(0.68, rgba(halo, 0.52));
    body.addColorStop(1.00, 'rgba(6,3,23,0.94)');
    ctx.fillStyle = body;
    ctx.fillRect(this.cx - R * 1.5, this.cy - R * 1.5, R * 3, R * 3);

    // internal aurora currents
    ctx.globalCompositeOperation = 'lighter';
    const currents = [
      { a: this.phase * 0.9,        d: 0.40, s: 0.62, c: [229, 156, 255] },
      { a: this.phase * -0.62 + 2.1, d: 0.46, s: 0.54, c: [156, 178, 255] },
      { a: this.phase * 0.44 + 4.2,  d: 0.32, s: 0.70, c: core },
    ];
    for (const cu of currents) {
      const gx = this.cx + Math.cos(cu.a) * R * cu.d;
      const gy = this.cy + Math.sin(cu.a) * R * cu.d;
      const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, R * cu.s);
      const strength = (0.16 + this.level * 0.24) * glow;
      g.addColorStop(0, rgba(cu.c, strength));
      g.addColorStop(1, rgba(cu.c, 0));
      ctx.fillStyle = g;
      ctx.fillRect(this.cx - R * 1.5, this.cy - R * 1.5, R * 3, R * 3);
    }

    // specular highlight, upper-left, fixed like a real light source
    const sx = this.cx - R * 0.34;
    const sy = this.cy - R * 0.40;
    const spec = ctx.createRadialGradient(sx, sy, 0, sx, sy, R * 0.52);
    spec.addColorStop(0, 'rgba(255,255,255,0.34)');
    spec.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = spec;
    ctx.fillRect(this.cx - R * 1.5, this.cy - R * 1.5, R * 3, R * 3);

    // inner shadow along the lower-right, so the sphere has weight
    ctx.globalCompositeOperation = 'source-over';
    const dx = this.cx + R * 0.44;
    const dy = this.cy + R * 0.50;
    const dark = ctx.createRadialGradient(dx, dy, R * 0.12, dx, dy, R * 1.05);
    dark.addColorStop(0, 'rgba(3,0,20,0.50)');
    dark.addColorStop(1, 'rgba(3,0,20,0)');
    ctx.fillStyle = dark;
    ctx.fillRect(this.cx - R * 1.5, this.cy - R * 1.5, R * 3, R * 3);

    ctx.restore();

    // --- 5. rim light -----------------------------------------------------
    // The cosmic gradient from the design system, rotating slowly so the rim
    // reads as light travelling around a sphere.
    const rim = ctx.createLinearGradient(
      this.cx + Math.cos(this.phase * 0.5) * R, this.cy + Math.sin(this.phase * 0.5) * R,
      this.cx - Math.cos(this.phase * 0.5) * R, this.cy - Math.sin(this.phase * 0.5) * R,
    );
    const rimPull = this.state === 'error' ? 0 : 0.42;
    const r0 = lerp3([229, 156, 255], this.tint, rimPull);
    const r1 = lerp3([186, 156, 255], this.tint, rimPull);
    const r2 = lerp3([156, 178, 255], this.tint, rimPull);
    rim.addColorStop(0.00, rgba(r0, 0.72 * glow));
    rim.addColorStop(0.50, rgba(r1, 0.86 * glow));
    rim.addColorStop(1.00, rgba(r2, 0.62 * glow));

    this.blobPath(ctx, R);
    ctx.strokeStyle = rim;
    ctx.lineWidth = 1.15 + this.level * 1.5;
    ctx.stroke();

    // a second, wider pass at low alpha reads as bloom around the rim
    this.blobPath(ctx, R * 1.012);
    ctx.strokeStyle = rgba(core, 0.14 * glow);
    ctx.lineWidth = 5 + this.level * 7;
    ctx.stroke();
  }
}

/* ---------------------------------------------------------------------------
   Static decorative orb for the landing hero. Same visual language, no audio,
   no state machine - it just breathes.
--------------------------------------------------------------------------- */

export function heroOrb(canvas) {
  const orb = new Orb(canvas, { tint: '#9382ff' });
  orb.setState('idle');
  let t = 0;
  const tick = () => {
    if (!orb.running) return;
    t += 0.016;
    // A slow synthetic swell so the hero orb has life without a microphone.
    orb.setLevel(0.16 + 0.16 * (0.5 + 0.5 * Math.sin(t * 0.62)));
    setTimeout(tick, 60);
  };
  orb.start();
  tick();
  return orb;
}
