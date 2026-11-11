import { describe, expect, it } from 'vitest';
import { EchoCanceller } from '../src/audio/echo';
import { extractFeatures, HeatModel } from '../src/audio/heat';

const SR = 48000;
const BINS = 1024;
const BIN_HZ = SR / 2 / BINS;
const DT = 1 / 30;

/** deterministic noise so the tests do not flake */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

type Shape = (hz: number) => number; // power per bin

const roomNoise: Shape = () => 2e-9;
/** eruption roar as a small speaker plays it: no bass, plenty of mids */
const roar: Shape = (hz) => (hz < 350 ? 0 : hz < 2500 ? 3e-4 : 2e-5);
/** deep rumble as a full-range speaker plays it */
const rumble: Shape = (hz) => (hz < 250 ? 4e-3 : 1e-7);
const voice = (gain: number): Shape => (hz) => (hz > 150 && hz < 3800 ? gain / (1 + Math.pow(hz / 900, 2)) : 0);

/** one analyser frame: each bin's power fluctuates like real noise does */
function frame(shapes: Array<[Shape, number]>, rand: () => number, noise: Float32Array | null): Float32Array {
  const out = new Float32Array(BINS);
  for (let i = 0; i < BINS; i++) {
    const hz = i * BIN_HZ;
    const fl = noise ? noise[i] : -Math.log(1 - rand() * 0.999);
    let p = 0;
    for (const [shape, g] of shapes) p += shape(hz) * g;
    out[i] = 10 * Math.log10(p * fl + 1e-20);
  }
  return out;
}

function timeFor(db: Float32Array): Float32Array {
  let p = 0;
  for (let i = 0; i < db.length; i++) p += Math.pow(10, db[i] / 10);
  const a = Math.sqrt(p);
  const t = new Float32Array(64);
  for (let i = 0; i < 64; i++) t[i] = i % 2 ? a : -a;
  return t;
}

interface Scene {
  /** what the app plays, per second of the run (0 = silent) */
  playing: (t: number) => number;
  sound: Shape;
  /** how loudly the microphone hears the speakers (power ratio) */
  coupling: number;
  /** people talking: power gain at time t (0 = nobody) */
  talking: (t: number) => number;
  seconds: number;
  cancel: boolean;
  sensitivity?: number;
}

/** Runs a scene through the canceller and the heat model; returns the heat over time. */
function simulate(sc: Scene): { heat: number[]; model: HeatModel } {
  const rand = rng(7);
  const canceller = new EchoCanceller();
  const model = new HeatModel();
  model.sensitivity = sc.sensitivity ?? 0.5;
  const heat: number[] = [];
  // the echo arrives a few frames late, as it does through real speakers
  const delay = 4;
  const past: Float32Array[] = [];
  // the app's output carries an irregular flutter in loudness (see sound.ts)
  const flutter: number[] = [];
  let fv = 1;
  let ft = 0;
  let fg = 1;
  for (let t = 0; t < sc.seconds + 1; t += DT) {
    if ((ft -= DT) <= 0) {
      fv = fv === 1 ? 0.8 : 1;
      ft = 0.12 + rand() * 0.28;
    }
    fg += (fv - fg) * 0.6;
    flutter.push(fg * fg);
  }
  const play = (t: number): number => (t < 0 ? 0 : sc.playing(t) * flutter[Math.floor(t / DT)]);
  for (let t = 0; t < sc.seconds; t += DT) {
    const fl = new Float32Array(BINS);
    for (let i = 0; i < BINS; i++) fl[i] = -Math.log(1 - rand() * 0.999);
    past.push(fl);
    const level = play(t);
    const ref = level > 0 ? frame([[sc.sound, level]], rand, fl) : null;
    const late = past[Math.max(0, past.length - 1 - delay)];
    const lateLevel = play(t - delay * DT);
    // syllables: talking comes in bursts with gaps
    const syl = (t * 3.1) % 1 > 0.18 ? sc.talking(t) : 0;
    // the echo carries the reference's fine jitter, blurred by the room and by timing
    const blur = new Float32Array(BINS);
    for (let i = 0; i < BINS; i++) blur[i] = 0.65 * late[i] + 0.35 * -Math.log(1 - rand() * 0.999);
    const echo = frame([[sc.sound, lateLevel * sc.coupling]], rand, blur);
    const rest = frame(
      [
        [roomNoise, 1],
        [voice(1), syl],
      ],
      rand,
      null,
    );
    const mic = new Float32Array(BINS);
    for (let i = 0; i < BINS; i++) mic[i] = 10 * Math.log10(Math.pow(10, echo[i] / 10) + Math.pow(10, rest[i] / 10));
    canceller.process(mic, SR, sc.cancel ? ref : null, SR, DT);
    const f = extractFeatures(timeFor(mic), mic, SR, sc.cancel ? canceller.binGain : undefined);
    model.update(f, DT);
    heat.push(model.heat);
  }
  return { heat, model };
}

const calm = 4e-6; // ordinary talking at the microphone, about 20 dB over the room
const shout = 1.3e-4; // 15 dB louder
const after = (heat: number[], seconds: number): number => Math.max(...heat.slice(Math.floor(seconds / DT)));

describe('EchoCanceller', () => {
  // a quiet room, then calm talk, then the app erupts loudly while nobody speaks
  const selfNoise = (cancel: boolean, sound: Shape, sensitivity: number): Scene => ({
    playing: (t) => (t > 40 ? 1 : 0),
    sound,
    coupling: 0.3,
    talking: (t) => (t > 6 && t < 36 ? calm : 0),
    seconds: 75,
    cancel,
    sensitivity,
  });

  it('confirms the problem: without it, the roar of a small speaker heats the volcano', () => {
    const { heat } = simulate(selfNoise(false, roar, 1));
    expect(after(heat, 42)).toBeGreaterThan(0.5);
  });

  // At full sensitivity even calm talk warms the volcano a little, so compare with
  // the moment just before the app starts making noise: it must only cool from there.
  const staysCool = (heat: number[]): void => {
    const before = heat[Math.floor(39.5 / DT)];
    expect(after(heat, 40)).toBeLessThan(before + 0.05);
    expect(heat[heat.length - 1]).toBeLessThan(before * 0.5 + 0.02);
  };

  it('removes the roar, even at full sensitivity', () => {
    staysCool(simulate(selfNoise(true, roar, 1)).heat);
  });

  it('removes a deep rumble, even at full sensitivity', () => {
    staysCool(simulate(selfNoise(true, rumble, 1)).heat);
  });

  it('removes the roar when the speakers are much louder than the people', () => {
    const scene = selfNoise(true, roar, 1);
    scene.coupling = 30;
    staysCool(simulate(scene).heat);
  });

  it('still hears people shouting over the roar', () => {
    const { heat } = simulate({
      playing: (t) => (t > 40 ? 1 : 0),
      sound: roar,
      coupling: 0.01,
      talking: (t) => (t > 6 && t < 36 ? calm : t > 46 ? shout : 0),
      seconds: 75,
      cancel: true,
    });
    // as hot as the same shouting gets with no sound playing at all
    const silent = simulate({
      playing: () => 0,
      sound: roar,
      coupling: 0,
      talking: (t) => (t > 6 && t < 36 ? calm : t > 46 ? shout : 0),
      seconds: 75,
      cancel: true,
    }).heat;
    expect(after(silent, 50)).toBeGreaterThan(0.6);
    // some dulling is the price of never reacting to ourselves; it must stay small
    expect(after(heat, 50)).toBeGreaterThan(after(silent, 50) - 0.2);
  });

  it('does not dull detection when the output cannot be heard at all (headphones)', () => {
    const scene = (cancel: boolean): Scene => ({
      playing: () => 1,
      sound: roar,
      coupling: 0,
      talking: (t) => (t > 6 && t < 36 ? calm : t > 40 ? shout : 0),
      seconds: 62,
      cancel,
    });
    const withIt = simulate(scene(true)).heat;
    const without = simulate(scene(false)).heat;
    expect(after(withIt, 45)).toBeGreaterThan(0.6);
    expect(Math.max(...withIt.slice(0, Math.floor(36 / DT)))).toBeLessThan(0.2);
    expect(Math.abs(after(withIt, 45) - after(without, 45))).toBeLessThan(0.1);
  });

  it('passes everything through when the app is silent', () => {
    const c = new EchoCanceller();
    const rand = rng(3);
    const mic = frame([[voice(1), calm]], rand, null);
    for (let i = 0; i < 60; i++) c.process(mic, SR, null, 0, DT);
    expect(c.echoShare).toBe(0);
    expect(Math.min(...c.binGain)).toBe(1);
  });

  it('adapts when the volume is turned up', () => {
    const { heat } = simulate({
      playing: () => 1,
      sound: roar,
      coupling: 0.02,
      talking: (t) => (t > 6 && t < 36 ? calm : 0),
      seconds: 40,
      cancel: true,
      sensitivity: 1,
    });
    const louder = simulate({
      playing: (t) => (t > 45 ? 8 : 1),
      sound: roar,
      coupling: 0.02,
      talking: (t) => (t > 6 && t < 36 ? calm : 0),
      seconds: 80,
      cancel: true,
      sensitivity: 1,
    }).heat;
    expect(Math.max(...heat)).toBeLessThan(0.2);
    expect(after(louder, 47)).toBeLessThan(0.1);
  });
});
