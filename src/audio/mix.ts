// How loud each layer of the volcano's sound is for a given state.
// Pure numbers, no browser APIs, so it can be unit-tested.

export interface Mix {
  /** deep noise rumble, linear gain */
  rumble: number;
  /** low-pass cutoff of the rumble, Hz */
  rumbleCut: number;
  /** sub tones under the rumble */
  sub: number;
  /** churning magma */
  churn: number;
  /** gas venting at the crater */
  hiss: number;
  /** eruption roar */
  roar: number;
  /** low-pass cutoff of the roar, Hz */
  roarCut: number;
  /** spatter and cooling-rock crackle */
  crackle: number;
  /** night wind */
  wind: number;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/**
 * @param heat  0..1
 * @param level magma fill of the chute, 0..1
 * @param erupt eruption intensity, 0..1
 */
export function mixFor(heat: number, level: number, erupt: number): Mix {
  heat = clamp01(Number.isFinite(heat) ? heat : 0);
  level = clamp01(Number.isFinite(level) ? level : 0);
  erupt = clamp01(Number.isFinite(erupt) ? erupt : 0);
  return {
    rumble: clamp01(0.42 * Math.pow(heat, 1.7) + 0.75 * erupt),
    rumbleCut: 55 + 55 * heat + 95 * erupt,
    sub: clamp01(0.22 * smoothstep(0.3, 1, heat) + 0.45 * erupt),
    churn: clamp01(0.15 * Math.pow(heat, 1.3) * (0.35 + 0.65 * smoothstep(0, 0.5, level)) * (1 - 0.4 * erupt)),
    hiss: clamp01(0.07 * smoothstep(0.55, 1, level) * (0.35 + 0.65 * heat) * (1 - erupt) + 0.10 * erupt),
    roar: clamp01(0.8 * Math.pow(erupt, 1.3)),
    roarCut: 260 + 1500 * erupt,
    crackle: clamp01(0.05 * smoothstep(0.7, 1, heat) * (1 - erupt) + 0.5 * erupt),
    // a breath of wind once the volcano stirs; a sleeping volcano is silent
    wind: 0.014 * smoothstep(0.02, 0.2, heat) * (1 - 0.6 * heat) * (1 - erupt),
  };
}
