import { describe, expect, it } from 'vitest';
import { Volcano } from '../src/sim/volcanoState';

const DT = 1 / 60;

function run(v: Volcano, seconds: number, heat: number): { began: number; ended: number } {
  let began = 0;
  let ended = 0;
  for (let t = 0; t < seconds; t += DT) {
    v.update(heat, DT);
    if (v.justBegan) began++;
    if (v.justEnded) ended++;
    expect(v.level).toBeGreaterThanOrEqual(0);
    expect(v.level).toBeLessThanOrEqual(1.02);
    expect(v.erupt).toBeGreaterThanOrEqual(0);
    expect(v.erupt).toBeLessThanOrEqual(1);
  }
  return { began, ended };
}

describe('Volcano', () => {
  it('rests when there is no heat', () => {
    const v = new Volcano();
    run(v, 30, 0);
    expect(v.phase).toBe('dormant');
    expect(v.level).toBeLessThan(0.01);
  });

  it('raises the magma in step with heat', () => {
    const levels = [0.2, 0.5, 0.8].map((h) => {
      const v = new Volcano();
      run(v, 20, h);
      return v.level;
    });
    expect(levels[0]).toBeLessThan(levels[1]);
    expect(levels[1]).toBeLessThan(levels[2]);
    expect(levels[2]).toBeLessThan(0.95);
  });

  it('labels the phases in order', () => {
    const v = new Volcano();
    run(v, 20, 0.2);
    expect(v.phase).toBe('stirring');
    run(v, 20, 0.5);
    expect(v.phase).toBe('rising');
    run(v, 20, 0.85);
    expect(v.phase).toBe('critical');
  });

  it('does not erupt below the threshold, however long', () => {
    const v = new Volcano();
    const r = run(v, 180, 0.9);
    expect(r.began).toBe(0);
    expect(v.erupt).toBe(0);
  });

  it('does not erupt on a brief spike to the top', () => {
    const v = new Volcano();
    run(v, 20, 0.85);
    const r = run(v, 1.0, 1);
    run(v, 10, 0.6);
    expect(r.began).toBe(0);
    expect(v.phase).not.toBe('erupting');
  });

  it('erupts when heat is held at the top', () => {
    const v = new Volcano();
    const r = run(v, 12, 1);
    expect(r.began).toBe(1);
    expect(v.phase).toBe('erupting');
    expect(v.erupt).toBeGreaterThan(0.9);
    expect(v.level).toBeGreaterThan(0.98);
  });

  it('runs its course, then cools and settles', () => {
    const v = new Volcano();
    run(v, 12, 1);
    const r = run(v, 5, 0.2);
    expect(r.ended).toBe(1);
    expect(v.phase).toBe('cooling');
    run(v, 40, 0);
    expect(v.erupt).toBe(0);
    expect(v.phase).toBe('dormant');
  });

  it('cannot erupt forever, and rests before erupting again', () => {
    const v = new Volcano();
    const r = run(v, 50, 1);
    expect(r.began).toBe(1);
    expect(r.ended).toBe(1);
    // straight after: refractory, even with heat pinned at the top
    const again = run(v, 4, 1);
    expect(again.began).toBe(0);
    expect(v.phase).not.toBe('erupting');
    // eventually it can go again
    const later = run(v, 40, 1);
    expect(later.began).toBeGreaterThanOrEqual(1);
  });

  it('ignores a non-positive or absurd time step', () => {
    const v = new Volcano();
    v.update(1, 0);
    v.update(1, -5);
    v.update(1, NaN);
    expect(v.level).toBe(0);
    v.update(1, 1e6);
    expect(Number.isFinite(v.level)).toBe(true);
  });
});
