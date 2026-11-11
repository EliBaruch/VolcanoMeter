// Static layer, rendered once per resize.
//   A.rgb = rock albedo (gamma 2 encoded), A.a = relief height
//   B.r = stars, B.g = far ridge, B.b = near ridge, B.a = ground coverage
uniform vec3 uView; // world min x, min y, units per pixel
uniform float uSeed;

layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;

vec3 palette(float h) {
  vec3 basalt = vec3(0.034, 0.033, 0.037);
  vec3 andesite = vec3(0.072, 0.059, 0.050);
  vec3 tephra = vec3(0.150, 0.112, 0.072);
  vec3 ash = vec3(0.112, 0.106, 0.100);
  vec3 scoria = vec3(0.112, 0.050, 0.035);
  if (h < 0.34) return mix(basalt, andesite, h / 0.34);
  if (h < 0.56) return mix(andesite, tephra, (h - 0.34) / 0.22);
  if (h < 0.76) return mix(ash, andesite, (h - 0.56) / 0.20);
  if (h < 0.90) return mix(scoria, basalt, (h - 0.76) / 0.14);
  return ash * 1.08;
}

// layered beds along coordinate s; seam returns the bed-boundary darkness
vec3 beds(float s, float freq, float seed, out float seam) {
  float x = s * freq + 0.9 * snoise(vec2(s * freq * 0.31, seed));
  float i = floor(x);
  float f = fract(x);
  vec3 a = palette(hash11(i * 1.73 + seed));
  vec3 b = palette(hash11((i + 1.0) * 1.73 + seed));
  float e = smoothstep(0.80, 1.0, f);
  seam = exp(-pow((f - 0.93) / 0.045, 2.0));
  return mix(a, b, e);
}

float terrainRough(float x) {
  return terrainH(x) + 0.0038 * snoise(vec2(x * 52.0, 3.1)) + 0.0016 * snoise(vec2(x * 141.0, 7.7));
}

float starLayer(vec2 p, float scale, float px, float seed) {
  vec2 g = p * scale;
  vec2 id = floor(g);
  vec2 f = fract(g);
  vec2 o = hash22(id + seed);
  float b = hash21(id * 1.31 + seed + 5.0);
  b = pow(b, 30.0);
  float r = px * scale * (0.55 + 0.75 * b);
  float d = length(f - (0.15 + 0.7 * o));
  return b * exp(-d * d / (r * r)) * 1.5;
}

void main() {
  vec2 p = uView.xy + gl_FragCoord.xy * uView.z;
  float px = uView.z;

  float th = terrainRough(p.x);
  float ground = smoothstep(-0.75, 0.75, (th - p.y) / px);

  // ---- sky statics ------------------------------------------------------
  float stars = starLayer(p, 19.0, px, 1.0 + uSeed) + starLayer(p, 43.0, px, 9.0 + uSeed) * 0.55 + starLayer(p, 97.0, px, 4.0) * 0.30;
  // faint galactic dust band
  float band = exp(-pow((p.y - 0.95 - 0.35 * p.x) / 0.32, 2.0));
  stars += band * (0.030 + 0.035 * fbm(p * 3.0 + 4.0, 4)) * 0.8;

  float r1 = 0.085 + 0.060 * fbm(vec2(p.x * 1.6 + 3.0, 0.5), 5) + 0.02 * sin(p.x * 0.9 + 1.0);
  float r2 = 0.035 + 0.045 * fbm(vec2(p.x * 2.6 + 11.0, 2.5), 5) + 0.012 * snoise(vec2(p.x * 14.0, 1.0));
  float farRidge = smoothstep(-1.0, 1.0, (r1 - p.y) / px);
  float nearRidge = smoothstep(-1.0, 1.0, (r2 - p.y) / px);

  // ---- rock ---------------------------------------------------------------
  float dCav = cavitySDF(p);
  float baseline = 0.02 + 0.012 * sin(p.x * 2.0 + 0.3);
  float hs = terrainH(p.x);

  // warp used to break up the bedding
  vec2 wp = p + 0.012 * vec2(fbm(p * 7.0 + 3.0, 3), fbm(p * 7.0 + 19.0, 3));
  float disrupt = exp(-max(dCav, 0.0) / 0.05);
  wp += disrupt * 0.02 * vec2(snoise(p * 21.0), snoise(p * 21.0 + 31.0));

  // bedding inside the cone follows older, smaller cones
  float fr = clamp((wp.y - baseline) / max(hs - baseline, 0.02), 0.0, 1.2);
  float sCone = pow(fr, 0.85) + 0.03 * fbm(vec2(p.x * 3.0, fr * 2.0), 3);
  // country rock below is gently folded and nearly flat
  float sUnder = wp.y + 0.045 * sin(p.x * 1.15 + 0.4) + 0.03 * fbm(vec2(p.x * 1.3, 4.0), 3) + 0.25 * (p.x * 0.05);

  float seamA;
  float seamB;
  float seamC;
  float seamD;
  vec3 cone = beds(sCone, 13.0, 3.0 + uSeed, seamA);
  vec3 coneFine = beds(sCone, 71.0, 8.0, seamB);
  cone = cone * (0.72 + 0.56 * dot(coneFine, vec3(1.6)));
  vec3 under = beds(sUnder, 9.0, 21.0 + uSeed, seamC);
  vec3 underFine = beds(sUnder, 47.0, 2.0, seamD);
  under = under * (0.70 + 0.60 * dot(underFine, vec3(1.6)));
  // older, colder rock is greyer
  under = mix(under, vec3(dot(under, vec3(0.33))) * vec3(1.04, 1.0, 0.95), 0.30);

  float inCone = smoothstep(-0.012, 0.012, wp.y - baseline + 0.006 * snoise(vec2(p.x * 9.0, 2.0)));
  vec3 alb = mix(under, cone, inCone);
  float seam = mix(max(seamC, seamD * 0.5), max(seamA, seamB * 0.5), inCone);
  // contact soil between old ground and the cone
  float contact = exp(-pow((wp.y - baseline) / 0.006, 2.0)) * smoothstep(0.1, 0.3, abs(p.x));
  alb = mix(alb, vec3(0.035, 0.030, 0.026), contact * 0.7);

  // deep crystalline basement
  float deep = 1.0 - smoothstep(-0.92, -0.62, p.y + 0.05 * snoise(vec2(p.x * 2.3, 9.0)) + 0.02 * snoise(p * 9.0));
  vec2 cr = voronoi(p * 85.0);
  vec3 granite = mix(vec3(0.060, 0.058, 0.066), vec3(0.150, 0.130, 0.125), smoothstep(0.15, 0.55, cr.x)) * (0.8 + 0.4 * hash21(floor(p * 85.0)));
  alb = mix(alb, granite, deep * 0.85);
  seam *= 1.0 - deep;

  // grain
  float grain = snoise(p * 310.0) * 0.5 + snoise(p * 127.0) * 0.5;
  alb *= 1.0 + 0.16 * grain;
  float blotch = fbm(p * 4.3 + 7.0, 4);
  alb *= 1.0 + 0.28 * blotch;

  // fractures
  vec2 v1 = voronoi(p * 5.5 + 0.6 * vec2(fbm(p * 5.0, 3), fbm(p * 5.0 + 9.0, 3)));
  vec2 v2 = voronoi(p * 31.0 + 0.4 * vec2(snoise(p * 13.0), snoise(p * 13.0 + 5.0)));
  float crackMask = smoothstep(-0.15, 0.45, fbm(p * 2.1 + 50.0, 3));
  float crack1 = (1.0 - smoothstep(0.0, 0.022, v1.y)) * (0.25 + 0.75 * crackMask);
  float crack2 = (1.0 - smoothstep(0.0, 0.045, v2.y)) * (0.08 + 0.92 * disrupt);
  float crack = max(crack1 * 0.85, crack2 * 0.6);
  alb *= 1.0 - 0.50 * crack;

  // old solidified intrusions (pale grey) cutting the bedding
  float t0;
  float dk = sdSegment(p + 0.01 * vec2(snoise(p * 17.0), 0.0), vec2(-0.20, -0.30), vec2(-0.44, 0.19), t0) - 0.0030;
  float dk2 = sdSegment(p + 0.01 * vec2(snoise(p * 15.0 + 3.0), 0.0), vec2(0.15, -0.29), vec2(0.21, 0.30), t0) - 0.0024;
  float oldDike = 1.0 - smoothstep(0.0, 0.003, min(dk, dk2));
  alb = mix(alb, vec3(0.088, 0.086, 0.088) * (0.85 + 0.3 * grain), oldDike * 0.8);

  // baked, oxidised and sulphur-stained rock next to the hollow
  float nearCav = exp(-max(dCav, 0.0) / 0.040);
  float rind = exp(-max(dCav, 0.0) / 0.0075);
  vec3 oxid = vec3(0.155, 0.060, 0.038) * (0.8 + 0.5 * blotch);
  alb = mix(alb, oxid, nearCav * 0.55);
  float sulph = smoothstep(0.25, 0.7, fbm(p * 15.0 + 2.0, 3)) * exp(-max(dCav, 0.0) / 0.03) * smoothstep(0.25, 0.6, p.y);
  alb = mix(alb, vec3(0.30, 0.25, 0.085), sulph * 0.5);
  alb = mix(alb, vec3(0.022, 0.018, 0.018), rind * 0.8);

  // weathered skin under the surface, darker lava crust on the upper slopes
  float depth = th - p.y;
  float skin = 1.0 - smoothstep(0.0, 0.010 + 0.006 * snoise(vec2(p.x * 30.0, 1.0)), depth);
  vec3 soil = mix(vec3(0.040, 0.036, 0.034), vec3(0.020, 0.019, 0.022), smoothstep(0.1, 0.5, p.y));
  alb = mix(alb, soil * (0.8 + 0.5 * grain), skin * 0.9);

  // relief height: beds stand proud, seams and cracks are recessed
  float height = 0.55 + 0.22 * blotch + 0.10 * grain - 0.24 * seam - 0.40 * crack + 0.15 * oldDike - 0.2 * rind;

  // ---- back wall seen through the open chute --------------------------------
  if (dCav < 0.0) {
    float dx = (p.x - conduitX(p.y)) / max(conduitW(p.y), 0.001);
    float streak = fbm(vec2(p.x * 60.0, p.y * 9.0), 4);
    vec3 wall = mix(vec3(0.022, 0.018, 0.017), vec3(0.058, 0.042, 0.034), 0.5 + 0.5 * streak);
    wall *= 0.55 + 0.45 * pow(abs(dx), 1.6);
    wall *= 1.0 + 0.2 * grain;
    float edge = smoothstep(-0.006, 0.0, dCav);
    alb = mix(wall, alb, edge);
    height = mix(0.45 + 0.3 * streak, height, edge);
  }

  alb = clamp(alb, 0.0, 1.0);
  oA = vec4(sqrt(alb), clamp(height, 0.0, 1.0));
  oB = vec4(clamp(stars, 0.0, 1.0), farRidge, nearRidge, ground);
}
