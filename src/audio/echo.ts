// Removes the app's own sound from what the microphone hears.
//
// The app knows exactly what it is playing: the reference spectrum, tapped at
// the output. Sound like a rumble or a roar is never steady; its loudness in
// each frequency band jitters from moment to moment in a pattern that is
// unique to it (the output also carries a faint flutter to make sure of that).
// The canceller checks, band by band, whether the microphone's jitter follows
// the output's jitter a moment later. Only the app's own sound can do that;
// people talking cannot. Where it does, the ratio of the two levels is the
// coupling from speaker to microphone, and the predicted echo is subtracted
// before any "is someone shouting?" logic runs.
//
// Everything is done on band powers, so the exact delay and phase between
// speaker and microphone do not matter. Pure logic, unit-tested.

const BANDS = 22;
const F_LO = 60;
const F_HI = 8000;
/** frames of history used for the estimate (about 6 s of the app making sound) */
const WINDOW = 180;
/** largest speaker-to-microphone delay searched, in frames (about a third of a second) */
const MAX_LAG = 10;
const RING = WINDOW + MAX_LAG + 2;
const MIN_FRAMES = 75;
/**
 * How closely the best-following third of the bands must track the output
 * before anything is learned. Speech lines up with the output's jitter only by
 * chance, at about a quarter of this.
 */
const CONFIDENT = 0.35;
/** a single band must follow at least this well to have its own coupling learned */
const BAND_CONFIDENT = 0.3;
/** predicted echo is scaled up a little: leftover echo is worse than slightly dulled speech */
const OVERSUBTRACT = 2.2;
/** reference quieter than this (linear power) is treated as silence */
const REF_FLOOR = 1e-10;

function bandOf(hz: number): number {
  if (hz < F_LO || hz > F_HI) return -1;
  const b = Math.floor((Math.log(hz / F_LO) / Math.log(F_HI / F_LO)) * BANDS);
  return b >= BANDS ? BANDS - 1 : b;
}

export class EchoCanceller {
  /** per microphone bin: fraction of power that is not the app's own sound (0..1) */
  binGain = new Float32Array(0);
  /** share of this frame's microphone power attributed to the app's own sound */
  echoShare = 0;
  /** speaker-to-microphone delay currently assumed, in frames */
  lag = 2;
  /** how closely the microphone as a whole follows the flutter right now, -1..1 */
  follows = 0;
  /** test aid: per-band detail of how the output and the microphone follow the flutter */
  diagnose = false;
  micFollows = '';
  jumps = 0;

  private micMap: Int8Array = new Int8Array(0);
  private micRate = 0;
  private refMap: Int8Array = new Int8Array(0);
  private refRate = 0;
  private mic = new Float64Array(BANDS);
  private ref = new Float64Array(BANDS);
  private micMean = new Float64Array(BANDS);
  private refMean = new Float64Array(BANDS);
  /** rings of raw reference power and of both signals with their slow trend removed */
  private refRaw = new Float64Array(BANDS * RING);
  private micRaw = new Float64Array(BANDS * RING);
  private refVar = new Float64Array(BANDS * RING);
  private micVar = new Float64Array(BANDS * RING);
  private coupling = new Float64Array(BANDS);
  private bandVar = new Float64Array(BANDS);
  private bandRef = new Float64Array(BANDS);
  private lagScore = new Float64Array(MAX_LAG + 1);
  private bandRho = new Float64Array(BANDS);
  private bandTop = new Float64Array(BANDS);
  private micSlow = new Float64Array(BANDS);
  private micSlow3 = new Float64Array(BANDS);
  private envSlow = new Float64Array(BANDS);
  /** what each band of the output has sounded like over the last couple of seconds */
  private refUsual = new Float64Array(BANDS);
  private gain = new Float64Array(BANDS);
  private head = 0;
  private frames = 0;
  private primed = false;
  private soundingFor = 0;
  /** frames for which the best delay has stayed put */
  private settled = 0;
  private lastBest = -1;
  /** consecutive frames in which the microphone clearly followed the flutter */
  private sure = 0;
  /** true once the microphone has been seen to follow the speakers at least once */
  private learned = false;
  /** seconds of output heard so far without having learned anything */
  private grace = 0;

  private map(n: number, rate: number): Int8Array {
    const m = new Int8Array(n);
    const binHz = rate / 2 / n;
    for (let i = 0; i < n; i++) m[i] = bandOf(i * binHz);
    return m;
  }

  reset(): void {
    this.refRaw.fill(0);
    this.refVar.fill(0);
    this.micVar.fill(0);
    this.coupling.fill(0);
    this.micMean.fill(0);
    this.refMean.fill(0);
    this.frames = 0;
    this.primed = false;
    this.soundingFor = 0;
    this.settled = 0;
    this.sure = 0;
    this.learned = false;
    this.grace = 0;
  }

  /** Sum over the window of a(t) * b(t - lag), for two rings starting at the given offsets. */
  private dot(a: Float64Array, ao: number, b: Float64Array, bo: number, lag: number, n: number): number {
    let sum = 0;
    let i = this.head;
    let j = this.head - lag;
    if (j < 0) j += RING;
    for (let k = 0; k < n; k++) {
      sum += a[ao + i] * b[bo + j];
      if (--i < 0) i = RING - 1;
      if (--j < 0) j = RING - 1;
    }
    return sum;
  }

  /**
   * @param micDb   microphone spectrum, dB per bin (AnalyserNode.getFloatFrequencyData)
   * @param refDb   spectrum of what the app is playing right now, or null if it is silent
   */
  process(micDb: Float32Array, micRate: number, refDb: Float32Array | null, refRate: number, dt: number): void {
    if (this.binGain.length !== micDb.length || this.micRate !== micRate) {
      this.binGain = new Float32Array(micDb.length);
      this.micMap = this.map(micDb.length, micRate);
      this.micRate = micRate;
    }
    const mic = this.mic;
    mic.fill(0);
    for (let i = 0; i < micDb.length; i++) {
      const b = this.micMap[i];
      if (b >= 0 && micDb[i] > -200) mic[b] += Math.pow(10, micDb[i] / 10);
    }

    const ref = this.ref;
    ref.fill(0);
    let refTotal = 0;
    if (refDb) {
      if (this.refMap.length !== refDb.length || this.refRate !== refRate) {
        this.refMap = this.map(refDb.length, refRate);
        this.refRate = refRate;
      }
      for (let i = 0; i < refDb.length; i++) {
        const b = this.refMap[i];
        if (b >= 0 && refDb[i] > -200) {
          const p = Math.pow(10, refDb[i] / 10);
          ref[b] += p;
          refTotal += p;
        }
      }
    }

    // ---- record this frame ------------------------------------------------------
    // Only moments when the app is actually making sound are kept: silence says
    // nothing about how the microphone hears the speakers.
    // A lone pop in a silence is too short to learn from, and a few of them
    // strung together look like a pattern by accident: wait for sustained sound.
    this.soundingFor = refTotal > REF_FLOOR ? this.soundingFor + dt : 0;
    const sounding = this.soundingFor > 1;
    if (sounding) {
      this.head = (this.head + 1) % RING;
      this.frames = Math.min(this.frames + 1, WINDOW);
    }
    // Only the fastest jitter is compared, frame against frame. Anything slower
    // is removed first: the volcano gets louder as people do (that is its job),
    // and that must never be mistaken for the microphone following the speakers.
    const a = 1 - Math.exp(-Math.min(dt, 0.2) / 0.08);
    if (!this.primed) {
      // start the trend at the first frame, or both signals would appear to switch on together
      for (let b = 0; b < BANDS; b++) {
        this.refMean[b] = Math.max(ref[b], 0.001 * refTotal);
        this.refUsual[b] = this.refMean[b];
        this.micMean[b] = mic[b];
      }
      this.primed = true;
    }
    let jumped = 0;
    for (let b = 0; b < BANDS && sounding; b++) {
      // Small speakers distort: bass they cannot play comes out as harmonics in
      // higher bands. So every band also "sees" a trace of the total output.
      const r = Math.max(ref[b], 0.001 * refTotal);
      this.refUsual[b] += (r - this.refUsual[b]) * (1 - Math.exp(-Math.min(dt, 0.2) / 2));
      const m = mic[b];
      this.refMean[b] += (r - this.refMean[b]) * a;
      this.micMean[b] += (m - this.micMean[b]) * a;
      const at = b * RING + this.head;
      this.refRaw[at] = r;
      this.micRaw[at] = m;
      // Deviations are capped at the size of the trend itself. A sudden jump in
      // level (the blast, someone starting to shout) would otherwise drown out
      // the small, steady flutter for as long as it stays in the window.
      const rm = this.refMean[b];
      const mm = this.micMean[b];
      const dr = r - rm;
      const dm = m - mm;
      const drc = dr > rm ? rm : dr < -rm ? -rm : dr;
      if (drc !== dr) jumped++;
      this.refVar[at] = drc;
      const dmc = dm > mm ? mm : dm < -mm ? -mm : dm;
      if (dmc !== dm) jumped++;
      this.micVar[at] = dmc;
    }
    if (sounding) {
      if (jumped > BANDS) {
        this.jumps++;
        // Most of the spectrum jumped at once (a sound starting or stopping).
        // This frame says nothing about the fine jitter, so leave it out, and start
        // the trends afresh at the new level instead of letting them catch up slowly.
        for (let b = 0; b < BANDS; b++) {
          this.refVar[b * RING + this.head] = 0;
          this.micVar[b * RING + this.head] = 0;
          this.refMean[b] = Math.max(ref[b], 0.001 * refTotal);
          this.micMean[b] = mic[b];
        }
      }
    }

    const n = this.frames;
    if (n >= MIN_FRAMES && sounding) {
      // ---- after what delay does the microphone follow the output best? ------------
      // Each band is checked on its own, then the bands that follow best are
      // averaged. The app's sound may only reach the microphone in part of the
      // spectrum (a phone speaker plays no bass), and that part is enough.
      const mm = this.bandVar;
      const rr = this.bandRef;
      for (let b = 0; b < BANDS; b++) {
        mm[b] = this.dot(this.micVar, b * RING, this.micVar, b * RING, 0, n);
        rr[b] = this.dot(this.refVar, b * RING, this.refVar, b * RING, 0, n);
      }
      const rho = this.bandRho;
      const top = this.bandTop;
      const third = Math.ceil(BANDS / 3);
      const scores = this.lagScore;
      let follows = 0;
      let best = this.lag;
      for (let lag = 0; lag <= MAX_LAG; lag++) {
        for (let b = 0; b < BANDS; b++) {
          const o = b * RING;
          top[b] = mm[b] > 0 && rr[b] > 0 ? this.dot(this.micVar, o, this.refVar, o, lag, n) / Math.sqrt(mm[b] * rr[b]) : 0;
        }
        top.sort();
        let score = 0;
        for (let k = BANDS - third; k < BANDS; k++) score += top[k];
        score /= third;
        scores[lag] = score;
        if (score > follows) {
          follows = score;
          best = lag;
        }
      }
      // A real echo arrives after one particular delay and matches nowhere else.
      // A chance resemblance (speech, a few pops) matches about as well at any
      // delay, and the best delay keeps wandering. So: judge the match by how
      // far it stands out from the other delays, and insist that the delay holds still.
      let others = 0;
      let count = 0;
      for (let lag = 0; lag <= MAX_LAG; lag++) {
        if (Math.abs(lag - best) > 2) {
          others += scores[lag];
          count++;
        }
      }
      follows -= count > 0 ? Math.max(0, others / count) : 0;
      this.settled = Math.abs(best - this.lastBest) <= 1 ? this.settled + 1 : 0;
      this.lastBest = best;
      if (this.settled >= 30 && follows > 0.2) this.lag = best;
      if (this.settled < 30) follows = 0;
      this.follows = follows;
      for (let b = 0; b < BANDS; b++) {
        const o = b * RING;
        rho[b] = mm[b] > 0 && rr[b] > 0 ? this.dot(this.micVar, o, this.refVar, o, this.lag, n) / Math.sqrt(mm[b] * rr[b]) : 0;
      }
      if (this.diagnose) this.micFollows = Array.from(rho, (x) => x.toFixed(1)).join(' ');

      // ---- coupling per band ---------------------------------------------------------
      this.sure = follows > CONFIDENT ? this.sure + 1 : 0;
      // it has to hold for half a second: a chance resemblance does not last
      if (this.sure >= 15) {
        this.learned = true;
        const ease = 1 - Math.exp(-dt / 1.0);
        for (let b = 0; b < BANDS; b++) {
          if (rho[b] < BAND_CONFIDENT) continue;
          // This band of the microphone is following the output, so what it
          // hears there is mostly the app: the ratio of the two average levels
          // is how loudly the microphone hears the speakers.
          const o = b * RING;
          let sm = 0;
          let sr = 0;
          let i = this.head;
          let k = this.head - this.lag;
          if (k < 0) k += RING;
          for (let q = 0; q < n; q++) {
            sm += this.micRaw[o + i];
            sr += this.refRaw[o + k];
            if (--i < 0) i = RING - 1;
            if (--k < 0) k = RING - 1;
          }
          if (sr <= 0) continue;
          const est = sm / sr;
          // a band heard for the first time takes the estimate as it is
          if (this.coupling[b] === 0) this.coupling[b] = est;
          else this.coupling[b] += (est - this.coupling[b]) * ease;
        }
      } else {
        // No clear evidence (someone is talking over it, or it is inaudible).
        // The coupling of a device barely changes, so keep what was learned.
        const slow = 1 - Math.exp(-dt / 120);
        for (let b = 0; b < BANDS; b++) this.coupling[b] -= this.coupling[b] * slow;
      }
    }

    // The very first time the app makes sound, nothing is known yet about how
    // loudly the microphone hears it. Ignore the microphone for a moment rather
    // than risk reacting to ourselves; if nothing is learned (headphones), carry on.
    let deaf = false;
    if (!this.learned && refTotal > REF_FLOOR && this.grace < 4) {
      this.grace += dt;
      deaf = true;
    }

    // ---- subtract the predicted echo --------------------------------------------------
    let micTotal = 0;
    let removed = 0;
    const ease = 1 - Math.exp(-dt / 0.6);
    for (let b = 0; b < BANDS; b++) {
      const base = b * RING;
      // the loudest of the frames around the delay, to cover reverberation and timing jitter
      let env = 0;
      for (let d = this.lag - 1; d <= this.lag + 2; d++) {
        if (d < 0) continue;
        let i = this.head - d;
        if (i < 0) i += RING;
        if (this.refRaw[base + i] > env) env = this.refRaw[base + i];
      }
      const m = mic[b];
      micTotal += m;
      // The echo is part of what the microphone hears, so it can never be louder
      // than that. If the prediction is, the coupling is stale (volume turned
      // down, headphones plugged in): pull it back at once.
      this.micSlow[b] += (m - this.micSlow[b]) * ease;
      this.envSlow[b] += (env - this.envSlow[b]) * ease;
      if (this.envSlow[b] > REF_FLOOR && this.coupling[b] * this.envSlow[b] > 3 * this.micSlow[b]) {
        this.coupling[b] = (3 * this.micSlow[b]) / this.envSlow[b];
      }
      let g = 1;
      // a band not learned yet borrows from the nearest band that has been:
      // a speaker that is audible at one pitch is audible at the next
      let c = this.coupling[b];
      for (let d = 1; c === 0 && d < BANDS; d++) {
        if (b - d >= 0 && this.coupling[b - d] > 0) c = this.coupling[b - d];
        else if (b + d < BANDS && this.coupling[b + d] > 0) c = this.coupling[b + d];
      }
      const echo = OVERSUBTRACT * c * env;
      if (echo > 0 && m > 0) {
        // judged on the last few frames together: noise jitters from one frame to the next
        const steady = this.micSlow3[b] = 0.6 * this.micSlow3[b] + 0.4 * m;
        const clean = steady - echo;
        g = clean > 0 ? Math.min(1, clean / steady) : 0;
        // a band that is mostly echo carries no trustworthy information
        if (g < 0.3) g = 0;
      }
      // One-off sounds (a bubble, a thud, thunder, the blast) are over before
      // anything can be learned about them. The app knows the moment it plays
      // one, so it simply does not listen in that band while it sounds.
      if (env > REF_FLOOR && env > 3 * this.refUsual[b]) g = 0;
      if (deaf) g = 0;
      this.gain[b] = g;
      removed += m * (1 - g);
    }
    this.echoShare = micTotal > 0 ? removed / micTotal : 0;
    const out = this.binGain;
    for (let i = 0; i < out.length; i++) {
      const b = this.micMap[i];
      out[i] = b >= 0 ? this.gain[b] : 1;
    }
  }
}
