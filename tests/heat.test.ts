import { describe, expect, it } from 'vitest';
import { extractFeatures, HeatModel, type AudioFeatures } from '../src/audio/heat';

const DT = 1 / 30;

const quiet = (): AudioFeatures => ({ levelDb: -62 + Math.random() * 2, speechRatio: 0.2, tiltDb: -18 });

/** syllables with gaps, like talking; `gap` is the share of time spent silent */
function speech(t: number, levelDb: number, tiltDb: number, gap: number): AudioFeatures {
  const phase = (t * 3.1) % 1;
  if (phase < gap) return quiet();
  return { levelDb: levelDb + Math.sin(t * 17) * 2, speechRatio: 0.75, tiltDb };
}

function run(m: HeatModel, seconds: number, f: (t: number) => AudioFeatures, t0 = 0): number {
  let peak = 0;
  for (let t = 0; t < seconds; t += DT) {
    m.update(f(t0 + t), DT);
    peak = Math.max(peak, m.heat);
  }
  return peak;
}

const calmTalk = (t: number): AudioFeatures => speech(t, -34, -15, 0.35);
const shouting = (t: number): AudioFeatures => speech(t, -11, -6, 0.1);

describe('HeatModel', () => {
  it('stays cold in a quiet room', () => {
    const m = new HeatModel();
    expect(run(m, 60, quiet)).toBeLessThan(0.03);
  });

  it('stays cold in a steadily noisy room', () => {
    const m = new HeatModel();
    const fan = (): AudioFeatures => ({ levelDb: -38 + Math.random(), speechRatio: 0.5, tiltDb: -10 });
    expect(run(m, 60, fan)).toBeLessThan(0.05);
  });

  it('stays calm during a normal conversation', () => {
    const m = new HeatModel();
    run(m, 5, quiet);
    expect(run(m, 120, calmTalk)).toBeLessThan(0.2);
  });

  it('does not erupt on a single loud burst', () => {
    const m = new HeatModel();
    run(m, 5, quiet);
    run(m, 30, calmTalk);
    const peak = run(m, 1.2, shouting, 30);
    expect(peak).toBeLessThan(0.5);
    run(m, 40, calmTalk, 32);
    expect(m.heat).toBeLessThan(0.25);
  });

  it('reaches the top under sustained shouting', () => {
    const m = new HeatModel();
    run(m, 5, quiet);
    run(m, 30, calmTalk);
    run(m, 20, shouting, 30);
    expect(m.heat).toBeGreaterThan(0.96);
  });

  it('climbs partway for raised voices', () => {
    const m = new HeatModel();
    run(m, 5, quiet);
    run(m, 30, calmTalk);
    run(m, 20, (t) => speech(t, -25, -11, 0.2), 30);
    expect(m.heat).toBeGreaterThan(0.25);
    expect(m.heat).toBeLessThan(0.95);
  });

  it('cools down once people calm down', () => {
    const m = new HeatModel();
    run(m, 5, quiet);
    run(m, 30, calmTalk);
    run(m, 20, shouting, 30);
    run(m, 75, calmTalk, 50);
    expect(m.heat).toBeLessThan(0.2);
  });

  it('is more reactive at higher sensitivity', () => {
    const raised = (t: number): AudioFeatures => speech(t, -27, -12, 0.2);
    const heatAt = (sens: number): number => {
      const m = new HeatModel();
      m.sensitivity = sens;
      run(m, 5, quiet);
      run(m, 30, calmTalk);
      run(m, 20, raised, 30);
      return m.heat;
    };
    expect(heatAt(0.9)).toBeGreaterThan(heatAt(0.5));
    expect(heatAt(0.5)).toBeGreaterThanOrEqual(heatAt(0.1));
  });

  it('is not fooled by dropouts of digital silence', () => {
    const m = new HeatModel();
    const silence: AudioFeatures = { levelDb: -Infinity, speechRatio: 0, tiltDb: -20 };
    run(m, 5, quiet);
    // a few dead frames, as a stream delivers when it is reopened
    for (let i = 0; i < 6; i++) m.update(silence, DT);
    run(m, 10, quiet);
    expect(m.floorDb).toBeGreaterThan(-70);
    expect(run(m, 90, calmTalk)).toBeLessThan(0.2);
  });

  it('ignores input while a reopened stream settles', () => {
    const m = new HeatModel();
    run(m, 5, quiet);
    run(m, 30, calmTalk);
    const before = m.heat;
    m.settle(1);
    run(m, 0.9, () => ({ levelDb: -1, speechRatio: 0.9, tiltDb: 0 }));
    expect(m.heat).toBe(before);
  });

  it('never leaves [0, 1] and survives bad input', () => {
    const m = new HeatModel();
    for (let i = 0; i < 2000; i++) {
      m.update({ levelDb: i % 7 === 0 ? -Infinity : 5, speechRatio: 2, tiltDb: 99 }, i % 11 === 0 ? 0 : 0.5);
      expect(m.heat).toBeGreaterThanOrEqual(0);
      expect(m.heat).toBeLessThanOrEqual(1);
      expect(Number.isFinite(m.heat)).toBe(true);
    }
  });
});

describe('extractFeatures', () => {
  const sampleRate = 48000;
  const n = 2048;

  function tone(hz: number, amp: number): Float32Array {
    const t = new Float32Array(n);
    for (let i = 0; i < n; i++) t[i] = amp * Math.sin((2 * Math.PI * hz * i) / sampleRate);
    return t;
  }

  function spectrum(peaks: Array<[number, number]>): Float32Array {
    const f = new Float32Array(n / 2).fill(-120);
    const binHz = sampleRate / 2 / f.length;
    for (const [hz, db] of peaks) f[Math.round(hz / binHz)] = db;
    return f;
  }

  it('measures level in dBFS', () => {
    const f = extractFeatures(tone(440, 0.5), spectrum([[440, -20]]), sampleRate);
    expect(f.levelDb).toBeCloseTo(20 * Math.log10(0.5 / Math.SQRT2), 0);
  });

  it('reports silence as very quiet, not NaN', () => {
    const f = extractFeatures(new Float32Array(n), new Float32Array(n / 2).fill(-Infinity), sampleRate);
    expect(f.levelDb).toBeLessThan(-150);
    expect(Number.isFinite(f.tiltDb)).toBe(true);
    expect(f.speechRatio).toBe(0);
  });

  it('separates speech-band energy from rumble', () => {
    const voice = extractFeatures(tone(800, 0.3), spectrum([[800, -20]]), sampleRate);
    const rumble = extractFeatures(tone(90, 0.3), spectrum([[90, -20]]), sampleRate);
    expect(voice.speechRatio).toBeGreaterThan(0.9);
    expect(rumble.speechRatio).toBeLessThan(0.1);
  });

  it('reports a brighter tilt for more high-frequency energy', () => {
    const dull = extractFeatures(tone(500, 0.3), spectrum([[500, -20], [2500, -40]]), sampleRate);
    const bright = extractFeatures(tone(500, 0.3), spectrum([[500, -20], [2500, -24]]), sampleRate);
    expect(bright.tiltDb).toBeGreaterThan(dull.tiltDb);
  });
});
