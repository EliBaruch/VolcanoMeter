import { mixFor, type Mix } from './mix';

/**
 * The volcano's voice, generated live with Web Audio: nothing is a recording
 * and nothing loops audibly. Continuous layers follow heat and eruption; short
 * one-off sounds are triggered by the same random events that drive the picture.
 *
 * The loudest layers sit below ~250 Hz on purpose. The heat model ignores sound
 * with little speech-band energy, so the volcano does not heat itself up by
 * hearing its own rumble (the microphone also runs echo cancellation).
 */

export interface SoundState {
  heat: number;
  level: number;
  erupt: number;
  wind: number;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Brown (random-walk) noise, normalised. Most of its energy is at low frequencies. */
function brownNoise(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const n = Math.floor(seconds * ctx.sampleRate);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let v = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    v = (v + (Math.random() * 2 - 1) * 0.02) * 0.998;
    d[i] = v;
    peak = Math.max(peak, Math.abs(v));
  }
  // cross-fade the ends so the loop point is silent
  const fade = Math.min(n >> 2, Math.floor(0.25 * ctx.sampleRate));
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    d[i] = d[i] * t + d[n - fade + i] * (1 - t);
  }
  const g = 0.9 / (peak || 1);
  for (let i = 0; i < n; i++) d[i] *= g;
  return buf;
}

function whiteNoise(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const n = Math.floor(seconds * ctx.sampleRate);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

/** Sparse, irregular clicks: spatter landing and rock cracking as it cools. */
function crackleNoise(ctx: BaseAudioContext, seconds: number, perSecond: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(seconds * sr);
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  const count = Math.floor(seconds * perSecond);
  for (let c = 0; c < count; c++) {
    const at = Math.floor(Math.random() * (n - sr * 0.05));
    const len = Math.floor(sr * (0.002 + Math.random() * Math.random() * 0.02));
    const amp = 0.15 + Math.pow(Math.random(), 3) * 0.85;
    let lp = 0;
    const k = 0.25 + Math.random() * 0.6;
    for (let i = 0; i < len; i++) {
      lp += ((Math.random() * 2 - 1) - lp) * k;
      d[at + i] += lp * amp * Math.pow(1 - i / len, 2);
    }
  }
  return buf;
}

/** Impulse response for an open, rocky space. */
function impulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(seconds * sr);
  const buf = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      // darker as it decays, like air absorbing the highs
      lp += ((Math.random() * 2 - 1) - lp) * (0.55 - 0.45 * t);
      d[i] = lp * Math.pow(1 - t, 2.6);
    }
  }
  return buf;
}

export interface SoundOptions {
  /** render into this context instead of the speakers (tests) */
  context?: BaseAudioContext;
  volume?: number;
  enabled?: boolean;
  lowPower?: boolean;
}

export class VolcanoSound {
  private ctx: BaseAudioContext | null = null;
  private readonly external: boolean;
  private enabled: boolean;
  private volume: number;
  private lowPower: boolean;
  private hidden = false;

  private master!: GainNode;
  private bus!: GainNode; // layers that get reverb
  private wet!: GainNode;
  private brown!: AudioBuffer;
  private white!: AudioBuffer;

  private rumbleGain!: GainNode;
  private rumbleLp: BiquadFilterNode[] = [];
  private subGain!: GainNode;
  private subOsc: OscillatorNode[] = [];
  private churnGain!: GainNode;
  private churnBp!: BiquadFilterNode;
  private hissGain!: GainNode;
  private roarGain!: GainNode;
  private roarLp: BiquadFilterNode[] = [];
  private crackleGain!: GainNode;
  private windGain!: GainNode;
  private windBp!: BiquadFilterNode;

  private wander = 0;
  private wanderTarget = 0;
  private wanderClock = 0;
  private lastThud = 0;

  constructor(opts: SoundOptions = {}) {
    this.enabled = opts.enabled ?? true;
    this.volume = opts.volume ?? 0.7;
    this.lowPower = opts.lowPower ?? false;
    this.external = !!opts.context;
    if (opts.context) {
      this.ctx = opts.context;
      this.build(opts.context);
    }
  }

  get running(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** Must be called from a tap or key press: browsers block sound otherwise. */
  start(): void {
    if (!this.enabled) return;
    if (!this.ctx) {
      const Ctx: typeof AudioContext | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      try {
        const ctx = new Ctx({ latencyHint: 'playback' });
        this.ctx = ctx;
        this.build(ctx);
      } catch {
        this.ctx = null;
        return;
      }
    }
    this.wake();
  }

  private wake(): void {
    const ctx = this.ctx;
    if (!ctx || this.external || this.hidden || !this.enabled) return;
    if (ctx.state !== 'running') void (ctx as AudioContext).resume().catch(() => undefined);
    const t = ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(this.volume, t, 0.4);
  }

  private sleep(): void {
    const ctx = this.ctx;
    if (!ctx || this.external) return;
    const t = ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(0, t, 0.08);
    window.setTimeout(() => {
      if ((!this.enabled || this.hidden) && ctx.state === 'running') void (ctx as AudioContext).suspend().catch(() => undefined);
    }, 500);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) this.start();
    else this.sleep();
  }

  setVolume(v: number): void {
    this.volume = clamp(v, 0, 1);
    if (this.ctx && this.enabled && !this.hidden) {
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
    }
  }

  setLowPower(on: boolean): void {
    this.lowPower = on;
    if (this.ctx) this.wet.gain.setTargetAtTime(on ? 0 : 0.24, this.ctx.currentTime, 0.2);
  }

  /** Silence while the page is in the background. */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    if (hidden) this.sleep();
    else this.wake();
  }

  // ---------------------------------------------------------------------------
  private loop(buffer: AudioBuffer, rate: number, offset: number): AudioBufferSourceNode {
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = buffer;
    s.loop = true;
    s.playbackRate.value = rate;
    s.start(0, offset % buffer.duration);
    return s;
  }

  private build(ctx: BaseAudioContext): void {
    this.brown = brownNoise(ctx, 4.3);
    this.white = whiteNoise(ctx, 2.9);

    // output: volume -> limiter -> speakers
    this.master = ctx.createGain();
    this.master.gain.value = this.external ? this.volume : 0;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -9;
    limiter.knee.value = 6;
    limiter.ratio.value = 14;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    this.master.connect(limiter).connect(ctx.destination);

    // reverb send for everything except the deepest layers
    this.bus = ctx.createGain();
    this.bus.connect(this.master);
    const verb = ctx.createConvolver();
    verb.buffer = impulse(ctx, 2.4);
    this.wet = ctx.createGain();
    this.wet.gain.value = this.lowPower ? 0 : 0.24;
    this.bus.connect(verb).connect(this.wet).connect(this.master);

    // rumble: two decorrelated low-passed noise beds, slightly left and right
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    this.rumbleGain.connect(this.master);
    [
      { rate: 1, off: 0, pan: -0.45 },
      { rate: 0.83, off: 1.9, pan: 0.45 },
    ].forEach((c) => {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 60;
      lp.Q.value = 0.8;
      const pan = ctx.createStereoPanner();
      pan.pan.value = c.pan;
      this.loop(this.brown, c.rate, c.off).connect(lp).connect(pan).connect(this.rumbleGain);
      this.rumbleLp.push(lp);
    });

    // sub tones that beat against each other
    this.subGain = ctx.createGain();
    this.subGain.gain.value = 0;
    this.subGain.connect(this.master);
    [33, 40.5, 57].forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = i === 2 ? 0.35 : 0.6;
      o.connect(g).connect(this.subGain);
      o.start();
      this.subOsc.push(o);
    });

    // churn: thick, slow movement of the melt
    this.churnGain = ctx.createGain();
    this.churnGain.gain.value = 0;
    this.churnBp = ctx.createBiquadFilter();
    this.churnBp.type = 'bandpass';
    this.churnBp.frequency.value = 190;
    this.churnBp.Q.value = 0.9;
    this.loop(this.brown, 1.71, 0.7).connect(this.churnBp).connect(this.churnGain).connect(this.bus);

    // gas venting: kept above the speech band
    this.hissGain = ctx.createGain();
    this.hissGain.gain.value = 0;
    const hissHp = ctx.createBiquadFilter();
    hissHp.type = 'highpass';
    hissHp.frequency.value = 4200;
    hissHp.Q.value = 0.5;
    this.loop(this.white, 1, 0.3).connect(hissHp).connect(this.hissGain).connect(this.bus);

    // eruption roar
    this.roarGain = ctx.createGain();
    this.roarGain.gain.value = 0;
    this.roarGain.connect(this.bus);
    [
      { rate: 2.3, off: 1.1, pan: -0.6 },
      { rate: 1.93, off: 3.0, pan: 0.6 },
    ].forEach((c) => {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 300;
      lp.Q.value = 0.6;
      const pan = ctx.createStereoPanner();
      pan.pan.value = c.pan;
      this.loop(this.brown, c.rate, c.off).connect(lp).connect(pan).connect(this.roarGain);
      this.roarLp.push(lp);
    });

    // a thinner mid layer so the roar still carries on small speakers that cannot play bass
    const mid = ctx.createBiquadFilter();
    mid.type = 'bandpass';
    mid.frequency.value = 620;
    mid.Q.value = 0.55;
    const midGain = ctx.createGain();
    midGain.gain.value = 0.05;
    this.loop(this.white, 0.8, 2.1).connect(mid).connect(midGain).connect(this.roarGain);

    // crackle: two loops of different length and speed, so the pattern does not come round
    this.crackleGain = ctx.createGain();
    this.crackleGain.gain.value = 0;
    const crHp = ctx.createBiquadFilter();
    crHp.type = 'highpass';
    crHp.frequency.value = 3600;
    crHp.connect(this.crackleGain).connect(this.bus);
    this.loop(crackleNoise(ctx, 3.1, 26), 1, 0).connect(crHp);
    const pan = ctx.createStereoPanner();
    pan.pan.value = 0.5;
    this.loop(crackleNoise(ctx, 4.7, 17), 0.87, 1.3).connect(pan).connect(crHp);

    // a little night wind when all is calm
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windBp = ctx.createBiquadFilter();
    this.windBp.type = 'bandpass';
    this.windBp.frequency.value = 200;
    this.windBp.Q.value = 0.7;
    this.loop(this.white, 0.6, 1.4).connect(this.windBp).connect(this.windGain).connect(this.bus);
  }

  // ---------------------------------------------------------------------------
  /** Follow the volcano. Call once per frame (or once, before an offline render). */
  update(s: SoundState, dt: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.external && (ctx.state !== 'running' || !this.enabled)) return;
    const m: Mix = mixFor(s.heat, s.level, s.erupt);
    const t = ctx.currentTime;
    const instant = this.external;
    const set = (p: AudioParam, v: number, tau: number): void => {
      if (instant) p.setValueAtTime(v, t);
      else p.setTargetAtTime(v, t, tau);
    };

    // a slow random drift keeps the continuous layers from sounding static
    this.wanderClock -= dt;
    if (this.wanderClock <= 0) {
      this.wanderTarget = Math.random() * 2 - 1;
      this.wanderClock = 0.4 + Math.random() * 1.8;
    }
    this.wander += (this.wanderTarget - this.wander) * Math.min(1, dt * 1.5);
    const w = instant ? 0 : this.wander;

    set(this.rumbleGain.gain, m.rumble * (1 + 0.25 * w), 0.25);
    this.rumbleLp[0].frequency.setTargetAtTime(m.rumbleCut * (1 + 0.15 * w), t, 0.3);
    this.rumbleLp[1].frequency.setTargetAtTime(m.rumbleCut * (1 - 0.12 * w), t, 0.3);
    set(this.subGain.gain, m.sub, 0.3);
    this.subOsc[0].frequency.setTargetAtTime(33 + 2.5 * w + 5 * s.erupt, t, 0.8);
    this.subOsc[1].frequency.setTargetAtTime(40.5 - 2 * w + 4 * s.erupt, t, 0.8);
    set(this.churnGain.gain, m.churn * (1 + 0.5 * w), 0.2);
    this.churnBp.frequency.setTargetAtTime(170 + 70 * s.heat + 40 * w, t, 0.4);
    set(this.hissGain.gain, m.hiss * (1 + 0.3 * w), 0.3);
    set(this.roarGain.gain, m.roar, 0.12);
    this.roarLp[0].frequency.setTargetAtTime(m.roarCut * (1 + 0.2 * w), t, 0.2);
    this.roarLp[1].frequency.setTargetAtTime(m.roarCut * (1 - 0.15 * w), t, 0.2);
    set(this.crackleGain.gain, m.crackle, 0.2);
    set(this.windGain.gain, m.wind * (0.6 + 0.6 * clamp(s.wind, 0, 1)), 1.5);
    // kept under the speech band, like everything that plays while the volcano is quiet
    this.windBp.frequency.setTargetAtTime(160 + 90 * clamp(s.wind, 0, 1) + 25 * w, t, 2);
  }

  // ---- one-off sounds --------------------------------------------------------------
  private ready(): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;
    return this.external || (ctx.state === 'running' && this.enabled && !this.hidden);
  }

  private panned(x: number, dest: AudioNode): AudioNode {
    const p = this.ctx!.createStereoPanner();
    p.pan.value = clamp(x * 1.1, -0.85, 0.85);
    p.connect(dest);
    return p;
  }

  /** Short burst of filtered noise with an exponential tail. */
  private burst(
    buffer: AudioBuffer,
    at: number,
    dur: number,
    gain: number,
    type: BiquadFilterType,
    f0: number,
    f1: number,
    q: number,
    dest: AudioNode,
    attack = 0.004,
  ): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, at);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), at + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(at, Math.random() * (buffer.duration - 0.1));
    src.stop(at + dur + 0.05);
  }

  /** Sine that slides in pitch, with an exponential tail. */
  private tone(at: number, dur: number, gain: number, f0: number, f1: number, dest: AudioNode, attack = 0.006): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, at);
    o.frequency.exponentialRampToValueAtTime(Math.max(18, f1), at + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(dest);
    o.start(at);
    o.stop(at + dur + 0.05);
  }

  /** A gas bubble bursts at the magma surface. */
  bubble(x: number, radius: number, heat: number, delay = 0): void {
    if (!this.ready()) return;
    const at = this.ctx!.currentTime + delay;
    const out = this.panned(x * 3, this.bus);
    // bigger bubbles are lower
    const f = clamp(150 * (0.011 / Math.max(radius, 0.003)), 70, 330) * (0.85 + Math.random() * 0.3);
    const amp = (0.05 + 0.10 * heat) * clamp(radius / 0.012, 0.5, 1.6);
    this.tone(at, 0.16 + Math.random() * 0.1, amp, f, f * (1.5 + Math.random() * 0.6), out, 0.012);
    this.burst(this.brown, at + 0.02, 0.12, amp * 0.9, 'bandpass', 260, 140, 1.2, out);
  }

  /** The ground shifts. */
  tremor(strength: number, delay = 0): void {
    if (!this.ready()) return;
    const at = this.ctx!.currentTime + delay;
    const a = clamp(strength, 0, 1);
    this.tone(at, 0.9, 0.30 * a, 52, 27, this.master, 0.03);
    this.burst(this.brown, at, 1.1, 0.5 * a, 'lowpass', 120, 50, 0.7, this.master, 0.05);
  }

  /** The eruption begins. */
  blast(delay = 0): void {
    if (!this.ready()) return;
    const at = this.ctx!.currentTime + delay;
    this.tone(at, 2.4, 0.85, 88, 22, this.master, 0.012);
    this.burst(this.brown, at, 2.8, 0.9, 'lowpass', 2600, 110, 0.6, this.bus, 0.01);
    this.burst(this.white, at, 0.5, 0.22, 'highpass', 3800, 5200, 0.5, this.bus, 0.002);
    // debris raining back a moment later
    this.burst(this.white, at + 0.7, 2.2, 0.06, 'highpass', 4500, 3800, 0.5, this.bus, 0.6);
  }

  /** Lightning in the ash: a crack, then a long roll. */
  thunder(x: number, strength: number, delay = 0): void {
    if (!this.ready()) return;
    const at = this.ctx!.currentTime + delay + 0.12 + Math.random() * 0.4;
    const a = clamp(strength, 0.2, 1);
    const out = this.panned(x, this.bus);
    this.burst(this.white, at, 0.16, 0.20 * a, 'highpass', 3600, 4400, 0.6, out, 0.002);
    this.burst(this.brown, at + 0.03, 2.6 + Math.random(), 0.55 * a, 'lowpass', 210, 55, 0.7, out, 0.06);
    this.tone(at + 0.02, 1.4, 0.22 * a, 64, 30, out, 0.03);
  }

  /** A lava bomb lands on the slope. */
  thud(x: number, size: number): void {
    if (!this.ready()) return;
    const t = this.ctx!.currentTime;
    if (t - this.lastThud < 0.11) return;
    this.lastThud = t;
    const a = clamp(size / 0.006, 0.3, 1.3);
    const out = this.panned(x, this.bus);
    this.tone(t, 0.22, 0.10 * a, 78 + Math.random() * 30, 38, out, 0.004);
    this.burst(this.brown, t, 0.18, 0.12 * a, 'bandpass', 230, 120, 0.9, out, 0.003);
  }
}
