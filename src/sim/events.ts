import type { FrameState } from '../render/renderer';
import { Kind, type Particles } from '../render/particles';
import type { LavaFlow } from '../render/lavaFlow';
import { CHAMBER_TOP, conduitW, conduitX, levelToY, RIM_Y } from './geometry';
import { Noise1D, Rng } from './random';
import type { Volcano } from './volcanoState';

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

interface Bubble {
  x: number;
  r: number;
  h: number;
  t: number;
  dur: number;
  live: boolean;
}

interface Burst {
  x: number;
  y: number;
  r: number;
  s: number;
  t: number;
  dur: number;
  live: boolean;
}

/** Receives the one-off events, so sound can follow the picture. */
export interface EffectListener {
  bubble(x: number, radius: number, heat: number): void;
  tremor(strength: number): void;
  eruption(): void;
  lightning(x: number, strength: number): void;
}

export interface EffectOptions {
  /** 0..1, scales screen shake (reduced-motion users get less) */
  shakeScale: number;
  lowPower: boolean;
}

/**
 * Everything unscripted: gas bubbles, tremors, spatter, lightning, wind.
 * Events arrive on a Poisson clock seeded from OS entropy, with rates tied to
 * heat, so no two seconds (or sessions) play out the same way.
 */
export class Effects {
  readonly state: FrameState;
  private rng = new Rng();
  private noise = new Noise1D(this.rng);
  private bubbles: Bubble[] = [];
  private bursts: Burst[] = [];
  private tremor = 0;
  private flashQueue: number[] = [];
  private ventGlow = 0;
  private plume = 0.1;
  private plumeH = 0.15;
  private sparkDebt = 0;
  private bombDebt = 0;
  private emberDebt = 0;
  private maxPlumeH = 2.2;
  private maxFountH = 0.6;
  opts: EffectOptions;
  listener: EffectListener | null = null;

  constructor(opts: EffectOptions) {
    this.opts = opts;
    for (let i = 0; i < 4; i++) {
      this.bubbles.push({ x: 0, r: 0.01, h: 0, t: 0, dur: 1, live: false });
      this.bursts.push({ x: 0, y: 0, r: 0.03, s: 0, t: 0, dur: 1, live: false });
    }
    this.state = {
      time: this.rng.range(0, 600),
      dt: 0,
      levelY: CHAMBER_TOP,
      flow: 0,
      flowPhase: 0,
      heat: 0,
      erupt: 0,
      audio: 0,
      plume: 0.1,
      plumeH: 0.15,
      plumeT: this.rng.range(0, 50),
      fountH: 0.3,
      fountT: 0,
      ventGlow: 0,
      flash: 0,
      flashX: 0,
      flashY: 1,
      wind: 0.3,
      shakeX: 0,
      shakeY: 0,
      bubbles: new Float32Array(16),
      bursts: new Float32Array(16),
    };
  }

  /** How high the eruption column may climb (set from the visible sky). */
  setSkyTop(y: number): void {
    this.maxPlumeH = Math.max(0.9, y - RIM_Y + 0.35);
    this.maxFountH = Math.min(0.72, Math.max(0.3, (y - RIM_Y) * 0.86));
  }

  update(v: Volcano, heat: number, audio: number, dt: number, particles: Particles, lava: LavaFlow): void {
    const s = this.state;
    const rng = this.rng;
    const E = v.erupt;
    s.dt = dt;
    s.time += dt;
    const t = s.time;
    s.heat += (heat - s.heat) * (1 - Math.exp(-dt / 0.5));
    s.audio += (audio - s.audio) * (1 - Math.exp(-dt / 0.15));
    const pulse = 0.78 + 0.22 * this.noise.fbm(t * 0.9) + 0.12 * this.noise.at(t * 3.7 + 40);
    s.erupt = E * Math.max(0.35, pulse);

    const range = RIM_Y - CHAMBER_TOP;
    const level = Math.min(1, v.level);
    // slow, irregular breathing of the column
    const breathe = 0.006 * this.noise.fbm(t * 0.23 + 7) * (0.4 + heat);
    s.levelY = levelToY(level) + breathe;
    s.flow = v.levelVel * range;
    s.flowPhase += dt * (s.flow + 0.010 + 0.030 * heat + 0.55 * s.erupt);
    s.wind = 0.32 + 0.5 * this.noise.fbm(t * 0.027 + 3);

    // ---- vent glow -------------------------------------------------------------------
    const glowTarget = smoothstep(0.5, 1.0, level) * (0.35 + 0.5 * heat) + 1.35 * s.erupt;
    this.ventGlow += (glowTarget - this.ventGlow) * (1 - Math.exp(-dt / 0.35));
    s.ventGlow = this.ventGlow * (0.9 + 0.1 * this.noise.at(t * 5.3));

    // ---- steam at rest, ash column in eruption --------------------------------------------
    const plumeTarget = E > 0.02 ? 0.97 : 0.10 + 0.30 * heat;
    const ptau = plumeTarget > this.plume ? 1.4 : 14;
    this.plume += (plumeTarget - this.plume) * (1 - Math.exp(-dt / ptau));
    if (E > 0.3) {
      this.plumeH = Math.min(this.maxPlumeH, this.plumeH + dt * (0.16 + 0.22 * E));
    } else {
      const rest = 0.15 + 0.36 * heat;
      // the spent column thins out before it shrinks
      const htau = this.plumeH > rest ? 26 : 3;
      this.plumeH += (rest - this.plumeH) * (1 - Math.exp(-dt / htau));
    }
    s.plume = this.plume;
    s.plumeH = this.plumeH;
    s.plumeT += dt * (0.030 + 0.045 * heat + 0.40 * s.erupt);

    s.fountH = this.maxFountH * (0.42 + 0.58 * E) * (0.80 + 0.20 * this.noise.fbm(t * 1.1 + 17));
    s.fountT += dt * (1.3 + 1.3 * s.erupt);

    // ---- gas bubbles doming and bursting at the surface ---------------------------------------
    const surfY = s.levelY;
    const cx = conduitX(surfY);
    const cw = conduitW(surfY);
    if (E < 0.2 && rng.chance(0.12 + 2.4 * heat * heat + 1.2 * audio, dt)) {
      const b = this.bubbles.find((q) => !q.live);
      if (b) {
        b.live = true;
        b.t = 0;
        b.dur = rng.range(0.5, 1.6) / (0.6 + heat);
        b.r = cw * rng.range(0.16, 0.5);
        b.x = cx + (rng.next() * 2 - 1) * (cw - b.r) * 0.85;
        b.h = b.r * rng.range(0.35, 0.95) * (0.5 + heat);
      }
    }
    for (let i = 0; i < 4; i++) {
      const b = this.bubbles[i];
      let h = 0;
      if (b.live) {
        b.t += dt;
        const u = b.t / b.dur;
        if (u >= 1) {
          b.live = false;
          this.pop(b, surfY, heat, particles);
          this.listener?.bubble(b.x, b.r, heat);
          v.kick(-0.01 * heat);
        } else {
          h = b.h * u * u * (1.15 - 0.15 * u);
        }
      }
      s.bubbles[i * 4] = b.x;
      s.bubbles[i * 4 + 1] = b.r;
      s.bubbles[i * 4 + 2] = h;
      s.bubbles[i * 4 + 3] = 0;
    }

    // ---- hot slugs injected into the simulation -----------------------------------------------------
    if (rng.chance(0.25 + 1.6 * heat + 1.5 * E + 1.5 * audio, dt)) {
      const q = this.bursts.find((b) => !b.live);
      if (q) {
        q.live = true;
        q.t = 0;
        q.dur = rng.range(0.4, 1.4);
        if (rng.next() < 0.6) {
          // somewhere in the chamber
          const a = rng.range(0, Math.PI * 2);
          const rr = Math.sqrt(rng.next()) * 0.8;
          q.x = 0.03 + Math.cos(a) * 0.47 * rr;
          q.y = -0.42 + Math.sin(a) * 0.15 * rr;
          q.r = rng.range(0.025, 0.07);
        } else {
          // somewhere in the filled chute
          q.y = rng.range(CHAMBER_TOP, Math.max(CHAMBER_TOP + 0.01, surfY - 0.01));
          q.x = conduitX(q.y) + rng.range(-0.5, 0.5) * conduitW(q.y);
          q.r = rng.range(0.012, 0.03);
        }
        q.s = rng.range(0.25, 0.9) * (0.5 + heat);
      }
    }
    for (let i = 0; i < 4; i++) {
      const q = this.bursts[i];
      let str = 0;
      if (q.live) {
        q.t += dt;
        const u = q.t / q.dur;
        if (u >= 1) q.live = false;
        else str = q.s * Math.sin(Math.PI * u);
      }
      s.bursts[i * 4] = q.x;
      s.bursts[i * 4 + 1] = q.y;
      s.bursts[i * 4 + 2] = q.r;
      s.bursts[i * 4 + 3] = str;
    }

    // ---- tremors and shake --------------------------------------------------------------------------------
    if (rng.chance(0.015 + 0.55 * heat * heat * heat, dt)) {
      const kick = rng.range(0.0012, 0.0045) * (0.4 + heat);
      this.tremor = Math.max(this.tremor, kick);
      v.kick(rng.range(-0.03, 0.06) * heat);
      this.listener?.tremor(kick / 0.0063);
    }
    if (v.justBegan) {
      this.tremor = 0.012;
      this.listener?.eruption();
    }
    this.tremor *= Math.exp(-dt / 0.55);
    const rumble = 0.0009 * smoothstep(0.75, 1, heat) + 0.0042 * s.erupt;
    const amp = (this.tremor + rumble) * this.opts.shakeScale;
    s.shakeX = amp * this.noise.at(t * 31.0 + 11);
    s.shakeY = amp * this.noise.at(t * 37.0 + 73);

    // ---- lightning in the ash --------------------------------------------------------------------------------
    s.flash *= Math.exp(-dt / 0.09);
    if (E > 0.4 && this.plumeH > 0.45 && rng.chance(0.38 * E, dt)) {
      const yr = rng.range(0.2, Math.min(this.plumeH * 0.95, this.maxPlumeH));
      s.flashX = s.wind * (0.1 * yr + (0.3 * yr * yr) / (0.35 + yr)) + rng.range(-0.18, 0.18);
      s.flashY = RIM_Y + yr;
      this.flashQueue.push(t);
      if (rng.next() < 0.65) this.flashQueue.push(t + rng.range(0.06, 0.16));
      if (rng.next() < 0.3) this.flashQueue.push(t + rng.range(0.2, 0.34));
      this.listener?.lightning(s.flashX, rng.range(0.45, 1));
    }
    while (this.flashQueue.length && this.flashQueue[0] <= t) {
      this.flashQueue.shift();
      s.flash = Math.max(s.flash, rng.range(0.55, 1));
    }

    // ---- particles ---------------------------------------------------------------------------------------------
    const lp = this.opts.lowPower;
    particles.limit = lp ? 1100 : particles.capacity;
    // the fountain needs magma at the vent: no sparks from an empty crater
    const fed = smoothstep(0.86, 0.98, v.level);
    if (s.erupt * fed > 0.02) {
      this.sparkDebt += dt * s.erupt * fed * (lp ? 300 : 820);
      this.bombDebt += dt * s.erupt * fed * (lp ? 16 : 42);
      const fh = s.fountH;
      while (this.sparkDebt >= 1) {
        this.sparkDebt -= 1;
        const sp = Math.sqrt(2 * 0.46 * fh) * rng.range(0.45, 1.25);
        const ang = rng.gauss() * 0.19 + s.wind * 0.05;
        particles.spawn(
          Kind.Spark,
          rng.range(-0.035, 0.035),
          RIM_Y - rng.range(0.0, 0.05),
          Math.sin(ang) * sp,
          Math.cos(ang) * sp,
          rng.range(0.0011, 0.0034),
          rng.range(0.85, 1.25),
          rng.range(1.2, 3.6),
          rng.next(),
        );
      }
      while (this.bombDebt >= 1) {
        this.bombDebt -= 1;
        const sp = rng.range(0.42, 1.0) * (0.75 + 0.35 * s.erupt);
        const ang = rng.gauss() * 0.42;
        particles.spawn(
          Kind.Bomb,
          rng.range(-0.04, 0.04),
          RIM_Y - 0.01,
          Math.sin(ang) * sp,
          Math.cos(ang) * sp,
          rng.range(0.003, 0.0075),
          rng.range(0.9, 1.15),
          rng.range(4, 8),
          rng.next(),
        );
      }
    }
    // embers lofted by hot gas once the column is high
    const emberRate = (lp ? 5 : 14) * heat * smoothstep(0.3, 0.9, level) * (1 - E);
    this.emberDebt += dt * emberRate;
    while (this.emberDebt >= 1) {
      this.emberDebt -= 1;
      particles.spawn(
        Kind.Ember,
        cx + rng.range(-0.8, 0.8) * cw,
        surfY + 0.004,
        rng.range(-0.03, 0.03),
        rng.range(0.10, 0.34) * (0.6 + heat),
        rng.range(0.0008, 0.0018),
        rng.range(0.7, 1.0),
        rng.range(1.2, 3.4),
        rng.next(),
      );
    }

    // ---- lava spilling over the rim ------------------------------------------------------------------------------
    if (E > 0.25) {
      const over = smoothstep(0.25, 0.8, E);
      const sideBias = 0.5 + 0.5 * this.noise.fbm(t * 0.11 + 55);
      const l = over * (0.35 + 0.9 * sideBias) * (0.7 + 0.3 * this.noise.at(t * 0.8));
      const r = over * (0.35 + 0.9 * (1 - sideBias)) * (0.7 + 0.3 * this.noise.at(t * 0.7 + 9));
      lava.update(dt, Math.max(0, l), Math.max(0, r));
    } else {
      lava.update(dt, 0, 0);
    }
  }

  /** A bubble bursts: throw clots up the chute. */
  private pop(b: Bubble, surfY: number, heat: number, particles: Particles): void {
    const rng = this.rng;
    const n = Math.round((3 + 26 * heat) * (b.r / 0.012) * (this.opts.lowPower ? 0.5 : 1));
    for (let i = 0; i < n; i++) {
      const ang = rng.gauss() * 0.5;
      const sp = rng.range(0.07, 0.30) * (0.45 + 0.9 * heat);
      particles.spawn(
        Kind.Spatter,
        b.x + rng.range(-1, 1) * b.r * 0.6,
        surfY + b.h * 0.6,
        Math.sin(ang) * sp * 0.5,
        Math.cos(ang) * sp,
        rng.range(0.0009, 0.0026),
        rng.range(0.75, 1.1),
        rng.range(0.5, 1.6),
        rng.next(),
      );
    }
  }
}
