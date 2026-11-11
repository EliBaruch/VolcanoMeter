import { RIM_HALF_WIDTH, terrainH } from '../sim/geometry';
import type { LavaSource } from './renderer';

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Lava running down the outer slopes: a 1D sheet that creeps downhill,
 * cools, forms a front and freezes in place.
 */
export class LavaFlow implements LavaSource {
  readonly cells = 512;
  readonly x0 = -1.75;
  readonly x1 = 1.75;
  readonly data = new Float32Array(this.cells * 2);
  active = false;

  private next = new Float32Array(this.cells * 2);
  private downhill = new Int16Array(this.cells);
  private slope = new Float32Array(this.cells);
  private srcL: number;
  private srcR: number;
  /** cells over the open crater: there is no ground there for lava to lie on */
  private craterL: number;
  private craterR: number;
  private dx: number;

  constructor() {
    this.dx = (this.x1 - this.x0) / this.cells;
    const h = new Float32Array(this.cells);
    for (let i = 0; i < this.cells; i++) h[i] = terrainH(this.cellX(i));
    for (let i = 0; i < this.cells; i++) {
      const l = i > 0 ? h[i - 1] : Infinity;
      const r = i < this.cells - 1 ? h[i + 1] : Infinity;
      const j = l < r ? i - 1 : i + 1;
      const drop = h[i] - Math.min(l, r);
      this.downhill[i] = drop > 0 ? j : -1;
      this.slope[i] = Math.max(0, drop / this.dx);
    }
    this.srcL = this.cellAt(-RIM_HALF_WIDTH - 0.014);
    this.srcR = this.cellAt(RIM_HALF_WIDTH + 0.014);
    this.craterL = this.cellAt(-RIM_HALF_WIDTH - 0.005);
    this.craterR = this.cellAt(RIM_HALF_WIDTH + 0.005);
    // make sure the sources drain outward, not back into the crater
    this.downhill[this.srcL] = this.srcL - 1;
    this.downhill[this.srcR] = this.srcR + 1;
  }

  private cellX(i: number): number {
    return this.x0 + (i + 0.5) * this.dx;
  }

  private cellAt(x: number): number {
    return Math.min(this.cells - 1, Math.max(0, Math.floor((x - this.x0) / this.dx)));
  }

  /** A clot landed on the slope and stays there glowing. */
  addSpatter(x: number, size: number): void {
    // a small glowing patch spread over neighbouring cells, never a spike
    const c = this.cellAt(x);
    const add = 0.03 + size * 6;
    for (let k = -1; k <= 1; k++) {
      const i = c + k;
      if (i < 0 || i >= this.cells) continue;
      const o = i * 2;
      const w = k === 0 ? 1 : 0.55;
      if (this.data[o] < 0.3) this.data[o] = Math.min(0.3, this.data[o] + add * w);
      this.data[o + 1] = Math.max(this.data[o + 1], 0.8 * w);
    }
    this.active = true;
  }

  /**
   * @param left  overflow over the left rim this frame, 0..1
   * @param right overflow over the right rim this frame, 0..1
   */
  update(dt: number, left: number, right: number): void {
    if (left > 0.001 || right > 0.001) this.active = true;
    if (!this.active) return;
    const a = this.data;
    const b = this.next;
    const rate = 6.5;
    if (left > 0.001) {
      a[this.srcL * 2] += rate * left * dt;
      a[this.srcL * 2 + 1] = 1;
    }
    if (right > 0.001) {
      a[this.srcR * 2] += rate * right * dt;
      a[this.srcR * 2 + 1] = 1;
    }

    b.set(a);
    let total = 0;
    for (let i = 0; i < this.cells; i++) {
      const o = i * 2;
      const amt = a[o];
      if (amt <= 0) continue;
      const heat = a[o + 1];
      const j = this.downhill[i];
      if (j >= 0 && j < this.cells) {
        // hot and thick flows; cool or thin stalls (this is what makes a front)
        const mobility = smoothstep(0.1, 0.42, heat) * smoothstep(0.035, 0.16, amt);
        const speed = (0.006 + 0.027 * Math.min(this.slope[i], 1.6)) * mobility;
        const frac = Math.min(0.45, (speed * dt) / this.dx);
        const move = amt * frac;
        if (move > 0) {
          const jo = j * 2;
          const had = b[jo];
          b[o] -= move;
          b[jo] = had + move;
          b[jo + 1] = had + move > 0 ? (b[jo + 1] * had + heat * move) / (had + move) : heat;
        }
      }
    }
    // molten lava levels itself out, so the sheet stays smooth instead of stepping cell to cell
    const d = Math.min(0.24, 14 * dt);
    for (let i = 0; i < this.cells - 1; i++) {
      const o = i * 2;
      const p = o + 2;
      const a0 = b[o];
      const a1 = b[p];
      const from = a0 > a1 ? o : p;
      const to = a0 > a1 ? p : o;
      if (b[from] < 0.1 || b[from + 1] < 0.14) continue;
      const move = Math.abs(a0 - a1) * d * smoothstep(0.14, 0.4, b[from + 1]);
      const had = b[to];
      b[to + 1] = (b[to + 1] * had + b[from + 1] * move) / (had + move || 1);
      b[from] -= move;
      b[to] = had + move;
    }

    // while the vent feeds it, lava stays insulated; once the supply stops it skins over quickly
    const fed = left > 0.001 || right > 0.001;
    const chill = fed ? 0.03 : 0.075;
    for (let i = 0; i < this.cells; i++) {
      const o = i * 2;
      let amt = b[o];
      let heat = b[o + 1];
      if (amt > 0) {
        heat -= dt * (chill + 0.014 / (amt + 0.15));
        if (heat < 0) heat = 0;
        // frozen rock weathers away so the cone returns to rest
        if (heat < 0.05) amt -= dt * (0.05 + 0.25 * amt);
        if (amt < 0.001) {
          amt = 0;
          heat = 0;
        }
      } else {
        heat = 0;
      }
      a[o] = amt;
      a[o + 1] = heat;
      total += amt;
    }
    for (let i = this.craterL + 1; i < this.craterR; i++) {
      total -= a[i * 2];
      a[i * 2] = 0;
      a[i * 2 + 1] = 0;
    }
    if (total < 0.002 && left <= 0.001 && right <= 0.001) {
      a.fill(0);
      this.active = false;
    }
  }
}
