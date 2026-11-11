/** Fast seedable generator (sfc32), seeded from the OS entropy pool by default. */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed?: Uint32Array) {
    const s = seed ?? Rng.entropy();
    this.a = s[0] | 0;
    this.b = s[1] | 0;
    this.c = s[2] | 0;
    this.d = s[3] | 1;
    for (let i = 0; i < 16; i++) this.next();
  }

  static entropy(): Uint32Array {
    const s = new Uint32Array(4);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(s);
    else for (let i = 0; i < 4; i++) s[i] = (Math.random() * 0xffffffff) >>> 0;
    return s;
  }

  /** uniform in [0, 1) */
  next(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** roughly normal, mean 0, sd 1 */
  gauss(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.7320508;
  }

  /** true with the probability of at least one Poisson event at `rate` per second */
  chance(rate: number, dt: number): boolean {
    return this.next() < 1 - Math.exp(-rate * dt);
  }
}

/** Smooth 1D noise in [-1, 1] over a random lattice; never the same twice across sessions. */
export class Noise1D {
  private table = new Float32Array(512);

  constructor(rng: Rng) {
    for (let i = 0; i < 512; i++) this.table[i] = rng.next() * 2 - 1;
  }

  at(x: number): number {
    const i = Math.floor(x);
    const f = x - i;
    const u = f * f * f * (f * (f * 6 - 15) + 10);
    const a = this.table[i & 511];
    const b = this.table[(i + 1) & 511];
    return a + (b - a) * u;
  }

  /** two octaves */
  fbm(x: number): number {
    return this.at(x) * 0.65 + this.at(x * 2.37 + 91.7) * 0.35;
  }
}
