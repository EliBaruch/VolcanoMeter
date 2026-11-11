// Turns raw microphone features into a single "how heated is this
// conversation" value in [0, 1]. Pure logic: no browser APIs, unit-tested.

export interface AudioFeatures {
  /** overall level, dBFS (RMS) */
  levelDb: number;
  /** share of energy in the speech band (300-3400 Hz), 0..1 */
  speechRatio: number;
  /** energy at 1-4 kHz relative to 200-1000 Hz, dB. Raised voices tilt upward. */
  tiltDb: number;
}

const SEGMENT_SECONDS = 2.5;
const SEGMENTS = 12; // 30 s of history for the room baseline

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

export class HeatModel {
  /** 0 = needs real shouting, 1 = reacts to mildly raised voices */
  sensitivity = 0.5;

  heat = 0;
  /** instantaneous excitement after envelope smoothing, 0..1 */
  drive = 0;
  /** loudness above the room baseline, dB (for the UI meter) */
  aboveDb = 0;

  /** learned level of the quiet room, dBFS */
  floorDb = -60;
  private floorReady = false;
  private segMin: number[] = [];
  /** levels seen in the current segment, 1 dB bins from -100 dBFS */
  private hist = new Uint16Array(101);
  private histCount = 0;
  private segTime = 0;
  /** seconds of input still to discard (stream start-up) */
  private settling = 0.6;
  private speechRef = 22;
  private tiltRef = -14;
  private activeTime = 0;
  private env = 0;
  private activity = 0;
  private accum = 0;

  /** Forget the learned room and voices; relearn from scratch. */
  recalibrate(): void {
    this.floorReady = false;
    this.segMin = [];
    this.segTime = 0;
    this.hist.fill(0);
    this.histCount = 0;
    this.settling = 0.6;
    this.speechRef = 22;
    this.tiltRef = -14;
    this.activeTime = 0;
    this.env = 0;
    this.activity = 0;
    this.accum = 0;
    this.heat = 0;
    this.drive = 0;
  }

  /**
   * Discard the next moments of input. A microphone that has just been
   * (re)opened delivers a burst of digital silence or a click before real sound.
   */
  settle(seconds = 0.6): void {
    this.settling = Math.max(this.settling, seconds);
  }

  /** The level that 10% of the current segment's frames fall below. */
  private lowLevel(): number {
    const want = this.histCount * 0.1;
    let seen = 0;
    for (let i = 0; i <= 100; i++) {
      seen += this.hist[i];
      if (seen > want) return i - 100;
    }
    return 0;
  }

  /** The eruption vents pressure: called once when an eruption ends. */
  release(factor = 0.45): void {
    this.heat *= factor;
    this.accum = 0;
  }

  update(f: AudioFeatures, dt: number): number {
    if (!(dt > 0)) return this.heat;
    dt = Math.min(dt, 0.25);
    const level = clamp(f.levelDb, -100, 0);

    if (this.settling > 0) {
      this.settling -= dt;
      return this.heat;
    }

    // ---- room baseline: the quiet moments of the last 30 s --------------------
    // A low percentile rather than the minimum, so a few frames of digital
    // silence or a dropout cannot drag the baseline down.
    this.hist[Math.round(level + 100)]++;
    this.histCount++;
    if (this.histCount < 8 && this.segMin.length === 0) return this.heat;
    const low = this.lowLevel();
    if (!this.floorReady) {
      this.floorDb = low;
      this.floorReady = true;
    }
    this.segTime += dt;
    let floorTarget = this.histCount >= 8 ? low : 0;
    for (const m of this.segMin) floorTarget = Math.min(floorTarget, m);
    if (this.segTime >= SEGMENT_SECONDS) {
      this.segMin.push(low);
      if (this.segMin.length > SEGMENTS) this.segMin.shift();
      this.hist.fill(0);
      this.histCount = 0;
      this.segTime = 0;
    }
    floorTarget = clamp(floorTarget, -90, -30);
    // fall quickly, rise slowly
    const fk = floorTarget < this.floorDb ? 1 - Math.exp(-dt / 0.15) : 1 - Math.exp(-dt / 4);
    this.floorDb += (floorTarget - this.floorDb) * fk;

    const above = level - this.floorDb;
    this.aboveDb = above;
    const active = above > 9 && f.speechRatio > 0.32;

    // ---- learn what "normal" sounds like for these voices and this mic --------
    if (active) {
      this.activeTime += dt;
      const learning = this.activeTime < 6;
      const up = learning ? 1.2 : 70;
      const down = learning ? 1.2 : 35;
      const tau = above > this.speechRef ? up : down;
      this.speechRef += (above - this.speechRef) * (1 - Math.exp(-dt / tau));
      this.speechRef = clamp(this.speechRef, 12, 46);
      const ttau = f.tiltDb > this.tiltRef ? up : down;
      this.tiltRef += (f.tiltDb - this.tiltRef) * (1 - Math.exp(-dt / ttau));
      this.tiltRef = clamp(this.tiltRef, -30, 0);
    }

    // ---- excitement of this instant ---------------------------------------------
    let e = 0;
    if (active) {
      const bias = (this.sensitivity - 0.5) * 16;
      const excess = above - this.speechRef + bias;
      // ordinary speech swings a few dB around its own average: ignore that
      let loud = clamp((excess - 5) / 12, 0, 1);
      // close to clipping is loud no matter what was learned
      loud = Math.max(loud, smoothstep(-12, -3, level));
      const tilt = clamp((f.tiltDb - this.tiltRef - 2 + bias * 0.25) / 8, 0, 1);
      e = clamp(loud * (0.8 + 0.5 * tilt) + 0.12 * tilt * smoothstep(0.05, 0.3, loud), 0, 1);
      e *= smoothstep(1.5, 6, this.activeTime);
    }

    // fast attack, slower release so gaps between syllables do not drop out
    const ek = e > this.env ? 1 - Math.exp(-dt / 0.12) : 1 - Math.exp(-dt / 0.9);
    this.env += (e - this.env) * ek;

    // how continuous the talking is: arguments leave few pauses
    this.activity += ((active ? 1 : 0) - this.activity) * (1 - Math.exp(-dt / 3));
    const density = 0.65 + 0.6 * smoothstep(0.35, 0.85, this.activity);
    this.drive = clamp(this.env * density, 0, 1);

    // a long, moderately heated exchange slowly builds pressure too
    if (this.drive > 0.42) this.accum += dt * (this.drive - 0.42) * 0.012;
    else this.accum -= dt * 0.006;
    this.accum = clamp(this.accum, 0, 0.35);

    const target = clamp((this.drive + this.accum * Math.min(1, this.drive * 3)) * 1.12, 0, 1.12);
    const tau = target > this.heat ? 5 : 22;
    this.heat += (target - this.heat) * (1 - Math.exp(-dt / tau));
    this.heat = clamp(this.heat, 0, 1);
    return this.heat;
  }
}

/**
 * Reduce one analyser frame to features.
 * @param time   time-domain samples in [-1, 1]
 * @param freqDb magnitude spectrum in dB (AnalyserNode.getFloatFrequencyData)
 */
export function extractFeatures(time: Float32Array, freqDb: Float32Array, sampleRate: number): AudioFeatures {
  let sum = 0;
  let mean = 0;
  for (let i = 0; i < time.length; i++) mean += time[i];
  mean /= time.length || 1;
  for (let i = 0; i < time.length; i++) {
    const v = time[i] - mean;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / (time.length || 1));
  const levelDb = 20 * Math.log10(rms + 1e-9);

  const binHz = sampleRate / 2 / freqDb.length;
  let low = 0;
  let high = 0;
  let speech = 0;
  let total = 0;
  const last = Math.min(freqDb.length - 1, Math.floor(8000 / binHz));
  for (let i = Math.max(1, Math.floor(60 / binHz)); i <= last; i++) {
    const hz = i * binHz;
    const db = freqDb[i];
    if (!(db > -200)) continue;
    const p = Math.pow(10, db / 10);
    total += p;
    if (hz >= 300 && hz <= 3400) speech += p;
    if (hz >= 200 && hz < 1000) low += p;
    else if (hz >= 1000 && hz <= 4000) high += p;
  }
  const speechRatio = total > 0 ? speech / total : 0;
  const tiltDb = low > 0 && high > 0 ? 10 * Math.log10(high / low) : -20;
  return { levelDb, speechRatio, tiltDb: clamp(tiltDb, -40, 20) };
}
