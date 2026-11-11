// CPU mirror of the geometry in src/render/shaders/common.glsl.
// Keep the two in sync: particles and lava flows collide against these.

export const RIM_Y = 0.625;
export const CHAMBER_TOP = -0.275;

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export function terrainH(x: number): number {
  const a = Math.abs(x);
  const s = x > 0 ? 0.445 : 0.405;
  const cone = 0.7 * Math.exp(-Math.pow(a / s, 1.25));
  const far = smoothstep(0.35, 1.3, a);
  const roll = 0.03 * Math.sin(x * 1.3 + 0.7) + 0.018 * Math.sin(x * 2.9 + 2.1);
  const bumps =
    0.009 * Math.sin(x * 9.0 + 1.3) + 0.005 * Math.sin(x * 17.0 + 4.1) + 0.0025 * Math.sin(x * 37.0 + 0.5);
  return cone + roll * far + bumps * smoothstep(0.05, 0.25, a) + 0.02;
}

export function conduitX(y: number): number {
  const env = 1 - smoothstep(0.18, 0.56, y);
  return env * (0.03 * Math.sin(y * 6.0 + 0.8) + 0.012 * Math.sin(y * 15.0 + 2.0));
}

export function conduitW(y: number): number {
  let w = 0.0215 + 0.0055 * Math.sin(y * 19.0 + 1.0) + 0.0028 * Math.sin(y * 47.0);
  const funnel = smoothstep(0.48, 0.635, y);
  w += 0.058 * funnel * funnel;
  const root = 1 - smoothstep(-0.31, -0.2, y);
  w += 0.05 * root * root;
  return w;
}

/** World height of the magma surface for a fill level in [0, 1]. */
export function levelToY(level: number): number {
  return CHAMBER_TOP + (RIM_Y - CHAMBER_TOP) * Math.min(1.02, Math.max(0, level));
}

/** Half width of the crater opening at the rim. */
export const RIM_HALF_WIDTH = conduitW(RIM_Y);
