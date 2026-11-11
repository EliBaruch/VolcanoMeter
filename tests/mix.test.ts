import { describe, expect, it } from 'vitest';
import { mixFor, type Mix } from '../src/audio/mix';

const loudness = (m: Mix): number => m.rumble + m.sub + m.churn + m.hiss + m.roar + m.crackle + m.wind;

describe('mixFor', () => {
  it('is silent at rest', () => {
    const m = mixFor(0, 0, 0);
    expect(loudness(m)).toBe(0);
    expect(m.roar).toBe(0);
    expect(m.sub).toBe(0);
  });

  it('gets louder as the heat rises', () => {
    let prev = -1;
    for (let h = 0; h <= 1.0001; h += 0.1) {
      const m = mixFor(h, h, 0);
      const now = m.rumble + m.sub + m.churn;
      expect(now).toBeGreaterThan(prev);
      prev = now;
    }
  });

  it('is loudest in eruption, by a wide margin', () => {
    expect(loudness(mixFor(1, 1, 1))).toBeGreaterThan(loudness(mixFor(1, 1, 0)) * 1.8);
    expect(mixFor(1, 1, 1).roar).toBeGreaterThan(0.5);
  });

  it('only vents gas when the magma is near the crater', () => {
    expect(mixFor(0.9, 0.3, 0).hiss).toBe(0);
    expect(mixFor(0.9, 0.95, 0).hiss).toBeGreaterThan(0.02);
  });

  it('keeps the wind for the quieter moments', () => {
    expect(mixFor(0.25, 0.25, 0).wind).toBeGreaterThan(mixFor(1, 1, 0).wind);
    expect(mixFor(1, 1, 1).wind).toBe(0);
  });

  it('stays in range for any input', () => {
    for (const v of [-5, 0, 0.5, 1, 7, NaN, Infinity]) {
      const m = mixFor(v, v, v);
      for (const [k, x] of Object.entries(m)) {
        expect(Number.isFinite(x), k).toBe(true);
        expect(x, k).toBeGreaterThanOrEqual(0);
        if (!k.endsWith('Cut')) expect(x, k).toBeLessThanOrEqual(1);
      }
      expect(m.rumbleCut).toBeLessThan(260);
    }
  });
});
