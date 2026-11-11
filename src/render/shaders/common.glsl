// ---------------------------------------------------------------------------
// Shared noise + volcano geometry. The geometry functions are mirrored in
// src/sim/geometry.ts so the CPU particle/lava simulation agrees with the
// picture. Keep the two in sync.
// ---------------------------------------------------------------------------

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

// 2D simplex noise, range about [-1, 1]
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

// 3D simplex noise, range about [-1, 1]
float snoise3(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

const mat2 ROT = mat2(0.80, 0.60, -0.60, 0.80);

// fractal noise in [-1, 1]
float fbm(vec2 p, int oct) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < oct; i++) {
    s += a * snoise(p);
    p = ROT * p * 2.03 + 17.3;
    a *= 0.5;
  }
  return s;
}

float fbm3(vec3 p, int oct) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < oct; i++) {
    s += a * snoise3(p);
    p = p * 2.02 + vec3(11.1, 5.7, 3.3);
    a *= 0.5;
  }
  return s;
}

// ridged fractal in [0, 1]
float ridged(vec2 p, int oct) {
  float a = 0.5;
  float s = 0.0;
  float w = 0.0;
  for (int i = 0; i < oct; i++) {
    float n = 1.0 - abs(snoise(p));
    s += a * n * n;
    w += a;
    p = ROT * p * 2.1 + 9.1;
    a *= 0.5;
  }
  return s / w;
}

// cellular noise: x = distance to nearest point, y = distance to nearest edge
vec2 voronoi(vec2 x) {
  vec2 n = floor(x);
  vec2 f = fract(x);
  vec2 mg;
  vec2 mr;
  float md = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = hash22(n + g);
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < md) {
        md = d;
        mr = r;
        mg = g;
      }
    }
  }
  float me = 8.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      vec2 g = mg + vec2(float(i), float(j));
      vec2 o = hash22(n + g);
      vec2 r = g + o - f;
      if (dot(mr - r, mr - r) > 0.00001) {
        me = min(me, dot(0.5 * (mr + r), normalize(r - mr)));
      }
    }
  }
  return vec2(sqrt(md), me);
}

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

float sdSegment(vec2 p, vec2 a, vec2 b, out float t) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * t);
}

// ---------------------------------------------------------------------------
// Geometry (world units: ground near y = 0, crater rim near y = 0.6)
// ---------------------------------------------------------------------------

const float RIM_Y = 0.625;        // magma level at which the crater brims over
const float CHAMBER_TOP = -0.275; // where the chute leaves the chamber
const vec2 CHAMBER_C = vec2(0.03, -0.42);
const vec2 CHAMBER_R = vec2(0.47, 0.150);

// smooth terrain height (mirrored in geometry.ts)
float terrainH(float x) {
  float a = abs(x);
  float s = x > 0.0 ? 0.445 : 0.405;
  float cone = 0.70 * exp(-pow(a / s, 1.25));
  float far = smoothstep(0.35, 1.3, a);
  float roll = 0.030 * sin(x * 1.3 + 0.7) + 0.018 * sin(x * 2.9 + 2.1);
  float bumps = 0.009 * sin(x * 9.0 + 1.3) + 0.005 * sin(x * 17.0 + 4.1) + 0.0025 * sin(x * 37.0 + 0.5);
  return cone + roll * far + bumps * smoothstep(0.05, 0.25, a) + 0.02;
}

// centre line of the chute (mirrored in geometry.ts)
float conduitX(float y) {
  float env = 1.0 - smoothstep(0.18, 0.56, y);
  return env * (0.030 * sin(y * 6.0 + 0.8) + 0.012 * sin(y * 15.0 + 2.0));
}

// half width of the chute (mirrored in geometry.ts)
float conduitW(float y) {
  float w = 0.0215 + 0.0055 * sin(y * 19.0 + 1.0) + 0.0028 * sin(y * 47.0);
  float funnel = smoothstep(0.48, 0.635, y);
  w += 0.058 * funnel * funnel;
  float root = 1.0 - smoothstep(-0.31, -0.20, y);
  w += 0.05 * root * root;
  return w;
}

float chamberSDF(vec2 p) {
  vec2 q = (p - CHAMBER_C) / CHAMBER_R;
  float d = (length(q) - 1.0) * CHAMBER_R.y;
  d += 0.016 * sin(p.x * 9.0 + 1.0) * sin(p.y * 13.0 + 0.5) + 0.010 * sin(p.x * 23.0 + 2.0);
  return d;
}

// two magma-filled fractures leaving the chamber
float dikeSDF(vec2 p, out float along) {
  float t1;
  float t2;
  vec2 w = vec2(0.012 * sin(p.y * 31.0 + p.x * 9.0), 0.010 * sin(p.x * 27.0 + 1.7));
  float d1 = sdSegment(p + w, vec2(0.33, -0.33), vec2(0.60, 0.035), t1) - mix(0.014, 0.0025, t1);
  float d2 = sdSegment(p + w.yx, vec2(-0.36, -0.40), vec2(-0.86, -0.315), t2) - mix(0.013, 0.002, t2);
  along = d1 < d2 ? t1 : t2;
  return min(d1, d2);
}

float conduitSDF(vec2 p) {
  float d = abs(p.x - conduitX(p.y)) - conduitW(p.y);
  return max(d, CHAMBER_C.y - p.y);
}

// signed distance to the hollow (chute + chamber + fractures); negative inside
float cavitySDF(vec2 p) {
  float along;
  float d = smin(conduitSDF(p), chamberSDF(p), 0.035);
  return min(d, dikeSDF(p, along));
}

// simulation texture covers this world rectangle
const vec2 SIM_MIN = vec2(-0.90, -0.66);
const vec2 SIM_MAX = vec2(0.90, 0.70);
vec2 worldToSim(vec2 p) { return (p - SIM_MIN) / (SIM_MAX - SIM_MIN); }
vec2 simToWorld(vec2 uv) { return SIM_MIN + uv * (SIM_MAX - SIM_MIN); }

// incandescent colour for a temperature in [0, ~1.3] (HDR, linear)
vec3 blackbody(float t) {
  t = max(t, 0.0);
  vec3 c = vec3(0.0);
  c += vec3(0.55, 0.012, 0.0) * smoothstep(0.08, 0.38, t);
  c += vec3(1.55, 0.26, 0.004) * smoothstep(0.30, 0.62, t);
  c += vec3(2.6, 1.25, 0.10) * smoothstep(0.55, 0.88, t);
  c += vec3(3.4, 3.0, 1.55) * smoothstep(0.82, 1.20, t);
  return c;
}
