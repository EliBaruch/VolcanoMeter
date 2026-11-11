// Magma temperature field. Each frame is advected from the previous one, so
// the motion has history and never loops.
//   r = temperature, g = crust (how long this parcel has been cool)
uniform sampler2D uPrev;
uniform float uTime;
uniform float uDt;
uniform float uLevelY; // world height of the magma surface in the chute
uniform float uFlow;   // vertical speed of the magma column (world units / s)
uniform float uHeat;
uniform float uErupt;
uniform float uInit;
uniform float uAudio;  // live loudness, stirs the flow
uniform vec4 uBurst[4]; // x, y, radius, strength

in vec2 vUV;
out vec4 o;

vec2 curl(vec2 p, float t) {
  const float e = 0.02;
  float a = snoise3(vec3(p + vec2(0.0, e), t));
  float b = snoise3(vec3(p - vec2(0.0, e), t));
  float c = snoise3(vec3(p + vec2(e, 0.0), t));
  float d = snoise3(vec3(p - vec2(e, 0.0), t));
  return vec2(a - b, d - c) / (2.0 * e);
}

void main() {
  vec2 p = simToWorld(vUV);
  float dCav = cavitySDF(p);
  if (dCav > 0.03) {
    o = vec4(0.0);
    return;
  }
  if (uInit > 0.5) {
    float n = fbm(p * 9.0 + 3.0, 4);
    o = vec4(0.42 + 0.22 * n, 0.25 + 0.3 * fbm(p * 14.0 + 40.0, 3), 0.0, 1.0);
    return;
  }

  float vigor = 0.25 + 1.6 * uHeat + 1.2 * uErupt + 0.5 * uAudio;
  float t = uTime;

  // turbulent stirring at two scales
  vec2 v = curl(p * 4.2 + vec2(0.0, 7.0), t * 0.07) * 0.0085 * vigor;
  v += curl(p * 11.0 + 3.0, t * 0.16) * 0.0035 * vigor;

  // the chute: fast core, slow drag at the walls, moves with the column
  float cw = conduitW(p.y);
  float dx = (p.x - conduitX(p.y)) / max(cw, 0.001);
  float inChute = smoothstep(-0.33, -0.24, p.y) * (1.0 - smoothstep(0.85, 1.25, abs(dx)));
  float core = 1.0 - min(dx * dx, 1.0);
  float convect = (core - 0.45) * (0.010 + 0.030 * uHeat);
  v.y += inChute * (uFlow * (0.4 + 0.9 * core) + convect + uErupt * 0.55 * core);
  v.x *= 1.0 - 0.6 * inChute;

  // a slow overturning roll in the chamber that wanders with time
  vec2 q = (p - CHAMBER_C) / CHAMBER_R;
  float inChamber = 1.0 - smoothstep(0.7, 1.05, length(q));
  float sway = snoise(vec2(t * 0.021, 3.0));
  v += inChamber * vec2(-q.y, q.x * 0.33) * 0.012 * vigor * sway;
  // feed toward the chute while the column rises
  v += inChamber * normalize(vec2(conduitX(CHAMBER_TOP) - p.x, CHAMBER_TOP - p.y + 0.05)) * max(uFlow, 0.0) * 0.22;

  // never pull in the cold rock outside the hollow
  vec2 from = p - v * uDt;
  if (cavitySDF(from) > 0.0) from = p;
  vec4 s = texture(uPrev, worldToSim(from));
  float T = s.r;
  float crust = s.g;

  // fresh heat arrives from below in drifting blobs
  float floorHeat = 1.0 - smoothstep(-0.56, -0.43, p.y);
  float blobs = smoothstep(0.05, 0.6, snoise3(vec3(p * 9.0, t * 0.21)));
  T += uDt * floorHeat * blobs * (0.28 + 1.2 * uHeat + 0.3 * uErupt);

  // relax toward the bulk temperature
  float bulk = 0.34 + 0.36 * uHeat + 0.10 * uErupt;
  T += (bulk - T) * uDt * 0.16;

  // an eruption drives fresh, hot melt up the chute
  T += inChute * uErupt * uDt * 2.2 * max(1.0 - T, 0.0) * (0.55 + 0.45 * core);

  // losses: at the free surface, at the walls, in the narrow fractures
  float along;
  float dDike = dikeSDF(p, along);
  float surf = inChute * exp(-max(uLevelY - p.y, 0.0) / 0.014);
  float wall = exp(dCav / 0.004);
  T -= uDt * (0.42 * surf * (1.0 - uErupt) + 0.06 * wall);
  // a rising column is fed from the hot core of the chamber
  T += inChute * uDt * 0.5 * max(bulk + 0.12 - T, 0.0) * core;
  if (dDike < 0.004) {
    T += (mix(0.50, 0.16, along) * (0.7 + 0.5 * uHeat) - T) * uDt * 0.8;
  }

  // gas bursts
  for (int i = 0; i < 4; i++) {
    vec4 b = uBurst[i];
    if (b.w > 0.0) {
      vec2 d = (p - b.xy) / b.z;
      T += b.w * exp(-dot(d, d)) * uDt * 5.0;
    }
  }

  // nothing above the surface
  float above = inChute * smoothstep(0.0, 0.012, p.y - uLevelY - 0.004);
  T *= exp(-uDt * 7.0 * above);

  // skin forms on melt cooler than its surroundings and is torn by hotter melt
  crust += uDt * (0.22 * (1.0 - smoothstep(bulk - 0.24, bulk - 0.03, T)) - 2.4 * smoothstep(bulk + 0.02, bulk + 0.30, T));
  crust -= uDt * 0.35 * inChute * uHeat;
  crust += uDt * 0.5 * surf * (1.0 - uErupt);
  crust -= uDt * (0.9 * uErupt + 0.25 * uHeat * uHeat);

  o = vec4(clamp(T, 0.0, 1.15), clamp(crust, 0.0, 1.0), 0.0, 1.0);
}
