// The volcano's behaviour given a heat value in [0, 1]. Deterministic and
// free of browser APIs so it can be unit-tested.

export type Phase = 'dormant' | 'stirring' | 'rising' | 'critical' | 'erupting' | 'cooling';

const HOLD_TO_ERUPT = 2.0; // seconds at the top before it blows
const MIN_ERUPTION = 9;
const MAX_ERUPTION = 38;
const REFRACTORY = 14; // quiet period after an eruption

export class Volcano {
  /** magma fill of the chute: 0 = chamber only, 1 = brimming at the crater */
  level = 0;
  /** rate of change of level, per second */
  levelVel = 0;
  phase: Phase = 'dormant';
  /** eruption intensity envelope, 0..1 */
  erupt = 0;
  /** seconds since the current eruption began */
  eruptTime = 0;
  /** set for one update when an eruption ends */
  justEnded = false;
  /** set for one update when an eruption begins */
  justBegan = false;

  private hold = 0;
  private rest = 0;
  private erupting = false;
  private cooling = 0;

  update(heat: number, dt: number): void {
    this.justEnded = false;
    this.justBegan = false;
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.1);
    heat = Math.min(1, Math.max(0, heat));

    this.rest = Math.max(0, this.rest - dt);

    // ---- trigger ----------------------------------------------------------
    if (!this.erupting) {
      if (heat >= 0.96 && this.level > 0.9 && this.rest <= 0) this.hold += dt;
      else this.hold = Math.max(0, this.hold - dt * 0.6);
      if (this.hold >= HOLD_TO_ERUPT) {
        this.erupting = true;
        this.justBegan = true;
        this.eruptTime = 0;
        this.hold = 0;
        this.cooling = 0;
      }
    } else {
      this.eruptTime += dt;
      const spent = this.eruptTime > MAX_ERUPTION;
      if ((this.eruptTime > MIN_ERUPTION && heat < 0.7) || spent) {
        this.erupting = false;
        this.justEnded = true;
        this.rest = REFRACTORY;
        this.cooling = 10;
      }
    }

    // ---- eruption envelope: violent onset, slow decay -------------------------
    if (this.erupting) {
      this.erupt += (1 - this.erupt) * (1 - Math.exp(-dt / 0.45));
    } else {
      this.erupt *= Math.exp(-dt / 3.2);
      if (this.erupt < 0.002) this.erupt = 0;
    }
    this.cooling = Math.max(0, this.cooling - dt);

    // ---- magma column: a damped spring chasing the pressure --------------------
    let target = Math.pow(heat, 0.9);
    if (this.erupting) target = 1.06;
    else if (this.cooling > 0 || this.rest > 0) target = Math.min(target, 0.62);
    const k = this.erupting ? 14 : 6;
    const c = this.erupting ? 5.5 : 3.4;
    const acc = k * (target - this.level) - c * this.levelVel;
    this.levelVel += acc * dt;
    this.level += this.levelVel * dt;
    if (this.level < 0) {
      this.level = 0;
      this.levelVel = Math.max(0, this.levelVel);
    }
    if (this.level > 1.02) {
      this.level = 1.02;
      this.levelVel = Math.min(0, this.levelVel);
    }

    // ---- phase label ----------------------------------------------------------------
    if (this.erupting) this.phase = 'erupting';
    else if (this.erupt > 0.05 || this.cooling > 0) this.phase = 'cooling';
    else if (this.level >= 0.76) this.phase = 'critical';
    else if (this.level >= 0.42) this.phase = 'rising';
    else if (this.level >= 0.08) this.phase = 'stirring';
    else this.phase = 'dormant';
  }

  /** Nudge the column (gas slug, tremor). */
  kick(dv: number): void {
    this.levelVel += dv;
  }
}
