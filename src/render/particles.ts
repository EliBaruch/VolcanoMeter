import { conduitW, conduitX, terrainH } from '../sim/geometry';
import type { ParticleSource } from './renderer';

export enum Kind {
  Spark = 0, // fountain spray
  Bomb = 1, // large clots on ballistic arcs
  Ember = 2, // light, buoyant
  Spatter = 3, // small blobs thrown up inside the chute
}

const STRIDE = 7;
const GRAVITY = 0.46;

/**
 * Pre-allocated pool; nothing is allocated per frame.
 * data layout per particle: x, y, vx, vy, size, temperature, alpha
 */
export class Particles implements ParticleSource {
  readonly capacity: number;
  readonly data: Float32Array;
  count = 0;
  /** soft cap, lowered in low-power mode */
  limit: number;

  private life: Float32Array;
  private maxLife: Float32Array;
  private grav: Float32Array;
  private drag: Float32Array;
  private cool: Float32Array;
  private kind: Uint8Array;
  private seed: Float32Array;

  constructor(capacity = 3200) {
    this.capacity = capacity;
    this.limit = capacity;
    this.data = new Float32Array(capacity * STRIDE);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.grav = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.cool = new Float32Array(capacity);
    this.kind = new Uint8Array(capacity);
    this.seed = new Float32Array(capacity);
  }

  spawn(
    kind: Kind,
    x: number,
    y: number,
    vx: number,
    vy: number,
    size: number,
    temp: number,
    life: number,
    seed: number,
  ): void {
    if (this.count >= this.limit) return;
    const i = this.count++;
    const o = i * STRIDE;
    const d = this.data;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = vx;
    d[o + 3] = vy;
    d[o + 4] = size;
    d[o + 5] = temp;
    d[o + 6] = 1;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.kind[i] = kind;
    this.seed[i] = seed;
    switch (kind) {
      case Kind.Spark:
        this.grav[i] = 1;
        this.drag[i] = 0.55;
        this.cool[i] = 0.26;
        break;
      case Kind.Bomb:
        this.grav[i] = 1;
        this.drag[i] = 0.08;
        this.cool[i] = 0.1;
        break;
      case Kind.Ember:
        this.grav[i] = -0.12;
        this.drag[i] = 1.6;
        this.cool[i] = 0.2;
        break;
      default:
        this.grav[i] = 1;
        this.drag[i] = 0.3;
        this.cool[i] = 0.22;
    }
  }

  private kill(i: number): void {
    const last = --this.count;
    if (i !== last) {
      const d = this.data;
      const a = i * STRIDE;
      const b = last * STRIDE;
      for (let k = 0; k < STRIDE; k++) d[a + k] = d[b + k];
      this.life[i] = this.life[last];
      this.maxLife[i] = this.maxLife[last];
      this.grav[i] = this.grav[last];
      this.drag[i] = this.drag[last];
      this.cool[i] = this.cool[last];
      this.kind[i] = this.kind[last];
      this.seed[i] = this.seed[last];
    }
  }

  /**
   * @param surfY  magma surface height in the chute
   * @param onLand called when a clot lands on the slopes (x, size)
   */
  update(dt: number, time: number, surfY: number, wind: number, onLand: (x: number, size: number) => void): void {
    const d = this.data;
    for (let i = this.count - 1; i >= 0; i--) {
      const o = i * STRIDE;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.kill(i);
        continue;
      }
      const kind = this.kind[i];
      let vx = d[o + 2];
      let vy = d[o + 3];
      vy -= GRAVITY * this.grav[i] * dt;
      const drag = Math.exp(-this.drag[i] * dt);
      // drag acts relative to the wind
      vx = wind * 0.1 + (vx - wind * 0.1) * drag;
      vy *= drag;
      if (kind === Kind.Ember) {
        const s = this.seed[i];
        vx += Math.sin(time * 3.1 + s * 40) * 0.25 * dt;
        vy += Math.cos(time * 2.3 + s * 23) * 0.12 * dt;
      }
      const x = d[o] + vx * dt;
      const y = d[o + 1] + vy * dt;
      d[o] = x;
      d[o + 1] = y;
      d[o + 2] = vx;
      d[o + 3] = vy;

      const temp = d[o + 5] - this.cool[i] * dt;
      d[o + 5] = temp;
      const age = this.life[i] / this.maxLife[i];
      d[o + 6] = Math.min(1, age * 4);
      if (temp < 0.14) {
        this.kill(i);
        continue;
      }

      // collisions: the chute (and the open air above the crater) is hollow
      const inChute = y > -0.4 && Math.abs(x - conduitX(y)) < conduitW(y);
      if (inChute) {
        if (y < surfY && vy < 0) {
          this.kill(i);
          continue;
        }
      } else if (y < terrainH(x)) {
        if (kind === Kind.Bomb || (kind === Kind.Spark && d[o + 4] > 0.0026)) onLand(x, d[o + 4]);
        this.kill(i);
        continue;
      }
    }
  }
}
