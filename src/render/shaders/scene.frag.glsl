// Main scene: sky, cut rock, magma, plume, fountain, surface lava. HDR linear.
uniform vec3 uView;      // world min x, min y, units per pixel
uniform vec4 uBakeView;  // world min x, min y, 1 / width, 1 / height
uniform vec2 uBakeTexel;
uniform sampler2D uBakeA;
uniform sampler2D uBakeB;
uniform sampler2D uSim;
uniform sampler2D uLava;
uniform vec2 uLavaRange; // x0, 1 / (x1 - x0)
uniform float uLavaOn;
uniform float uTime;
uniform float uLevelY;
uniform float uHeat;
uniform float uErupt;
uniform float uPlume;     // plume opacity
uniform float uPlumeH;    // plume height above the vent
uniform float uPlumeT;    // integrated rise of the plume
uniform float uFountH;    // fountain height
uniform float uFountT;    // integrated fountain scroll
uniform float uVentGlow;
uniform float uFlowPhase; // integrated chute flow
uniform float uFlash;
uniform vec2 uFlashPos;
uniform float uWind;
uniform vec2 uShake;
uniform vec4 uBubble[4];  // x, radius, height, unused
uniform int uOct;         // detail level

out vec4 o;

const vec3 GLOW = vec3(1.0, 0.36, 0.075);

float surfaceY(float x) {
  float y = uLevelY;
  y += 0.0024 * snoise(vec2(x * 36.0, uTime * 0.7)) * (0.5 + uHeat);
  y += 0.0010 * sin(x * 170.0 + uTime * 3.3);
  for (int i = 0; i < 4; i++) {
    vec4 b = uBubble[i];
    if (b.z > 0.0) {
      float d = (x - b.x) / b.y;
      y += b.z * exp(-d * d);
    }
  }
  return y;
}

// ---- magma ----------------------------------------------------------------
vec3 magmaColor(vec2 p, float dCav, float dDike, float along, float surfY) {
  vec4 s = texture(uSim, worldToSim(p));
  float T = s.r;

  // detail rides with the chute flow
  float cw = conduitW(p.y);
  float dx = (p.x - conduitX(p.y)) / max(cw, 0.001);
  float inChute = smoothstep(-0.31, -0.25, p.y) * (1.0 - smoothstep(1.0, 1.4, abs(dx)));
  vec2 q = p;
  q.y -= uFlowPhase * inChute * (0.55 + 0.45 * (1.0 - min(dx * dx, 1.0)));

  float t = uTime;
  float n1 = fbm3(vec3(q * 13.0, t * 0.06), uOct);
  vec2 w = q + 0.035 * vec2(n1, fbm3(vec3(q * 13.0 + 21.0, t * 0.06), 2));
  float n2 = fbm3(vec3(w * 37.0, t * 0.13), 3);
  float cells = ridged(w * 21.0 + vec2(0.0, t * 0.02), 3);

  float raw = T * (0.90 + 0.48 * n1) + 0.10 * n2;
  // compress the top end so the hottest melt keeps its structure instead of clipping to white
  float temp = 1.12 * (1.0 - exp(-1.30 * raw));

  // cooled skin, torn by bright seams
  float crust = smoothstep(0.32, 0.72, s.g + 0.30 * n1 + 0.12 * n2);
  float seams = pow(cells, 5.0);
  temp = mix(temp, temp * 0.34 + seams * 0.75 * T, crust);
  temp += seams * 0.16 * T;

  // chilled margin against the rock, hotter core
  temp *= mix(0.66, 1.0, smoothstep(0.0, 0.007, -dCav));
  if (dDike < 0.0) temp *= mix(1.0, 0.55, along);

  // the free surface carries a darker, cracked skin
  float skin = inChute * exp(-max(surfY - p.y, 0.0) / 0.006) * (1.0 - uErupt);
  temp = mix(temp, temp * 0.55 + seams * 0.5, skin * 0.8);

  vec3 c = blackbody(temp);
  // cold crust still has a faint body colour
  c += vec3(0.020, 0.012, 0.010) * (1.0 - smoothstep(0.1, 0.4, temp));
  return c;
}

// ---- eruption column --------------------------------------------------------
vec4 plume(vec2 p) {
  float yr = p.y - (RIM_Y - 0.02);
  if (uPlume < 0.004 || yr < -0.02) return vec4(0.0);
  float H = max(uPlumeH, 0.06);
  float u = yr / H;
  if (u > 1.35) return vec4(0.0);

  float cx = uWind * (0.10 * yr + 0.30 * yr * yr / (0.35 + yr));
  float umbrella = smoothstep(0.55, 1.0, u) * uErupt;
  float rad = 0.050 + yr * (0.15 + 0.20 * uErupt) + 0.55 * umbrella * H * 0.45;
  float d = (p.x - cx) / rad;
  if (abs(d) > 1.9) return vec4(0.0);

  vec2 q = vec2(p.x - cx, yr);
  vec2 qa = q * 7.5;
  qa.y -= uPlumeT * 7.5;
  vec2 qb = q * 2.7 + 13.0;
  qb.y -= uPlumeT * 2.7 * 0.8;
  float warp = snoise(q * 1.7 + vec2(0.0, -uPlumeT * 1.2));
  float na = fbm(qa + warp * 0.5, uOct);
  float nb = fbm(qb + warp * 0.35, uOct);
  float big = smoothstep(0.05, 0.9, yr);
  float n = mix(na, nb * 1.15, big);
  // puffy billows
  float puff = 1.0 - abs(mix(na, nb, big * 0.6));
  n = mix(n, puff * 1.3 - 0.65, 0.45);

  float body = (1.0 - d * d * 0.85) + n * 0.72 + 0.04;
  float dens = smoothstep(0.0, 0.55, body);
  float top = 1.0 - smoothstep(0.72, 1.12, u + 0.22 * n);
  float foot = smoothstep(-0.02, 0.05, yr);
  float a = dens * top * foot * uPlume;
  if (a < 0.002) return vec4(0.0);

  float shade = smoothstep(-0.55, 0.75, n) * (0.75 - 0.25 * clamp(d, -1.0, 1.0));
  vec3 steam = mix(vec3(0.030, 0.034, 0.048), vec3(0.120, 0.130, 0.165), shade);
  vec3 ash = mix(vec3(0.0045, 0.0042, 0.0050), vec3(0.050, 0.046, 0.050), shade);
  vec3 c = mix(steam, ash, clamp(uErupt * 1.4 + uHeat * 0.3, 0.0, 1.0));

  // lit from the vent below
  float under = exp(-yr / (0.085 + 0.13 * uErupt)) * uVentGlow;
  float inner = exp(-d * d * 2.5);
  c += GLOW * under * (0.10 + 0.55 * (1.0 - shade) * inner) * (0.7 + 0.5 * uErupt);
  // lightning inside the cloud
  float fl = uFlash * exp(-length(p - uFlashPos) / 0.22);
  c += vec3(0.75, 0.82, 1.35) * fl * (0.7 + 1.5 * shade);

  return vec4(c, a);
}

vec3 fountain(vec2 p) {
  if (uErupt < 0.01) return vec3(0.0);
  float yr = p.y - (RIM_Y - 0.05);
  float u = yr / max(uFountH, 0.05);
  if (u < 0.0 || u > 1.25) return vec3(0.0);
  float w = 0.022 + 0.075 * u + 0.055 * u * u;
  float sway = 0.02 * snoise(vec2(uTime * 0.9, yr * 3.0)) * u + uWind * 0.05 * u * u;
  float d = (p.x - sway) / w;
  float streak = fbm(vec2(p.x * 44.0, yr * 9.0 - uFountT * 9.0), 4) * 0.5 + 0.5;
  float clot = fbm(vec2(p.x * 16.0 + 5.0, yr * 5.0 - uFountT * 5.0), 3) * 0.5 + 0.5;
  float core = exp(-d * d * 2.4) * pow(max(1.0 - u, 0.0), 1.25);
  float I = core * (0.22 + 1.5 * streak * streak) * (0.45 + clot) * uErupt;
  float temp = mix(1.02, 0.40, u) * (0.68 + 0.48 * streak);
  return blackbody(temp) * I * 1.7;
}

// ---- sky ----------------------------------------------------------------------
vec3 sky(vec2 p, vec4 B) {
  float h = max(p.y, 0.0);
  vec3 zen = vec3(0.008, 0.013, 0.034);
  vec3 mid = vec3(0.026, 0.036, 0.086);
  vec3 hor = vec3(0.120, 0.074, 0.082);
  vec3 c = mix(hor, mid, smoothstep(0.0, 0.45, h));
  c = mix(c, zen, smoothstep(0.3, 1.6, h));
  // last light in the west
  float west = exp(-pow((p.x + 1.6) / 1.5, 2.0));
  c += vec3(0.46, 0.17, 0.055) * exp(-h * 5.0) * west * 0.55;
  c += vec3(0.10, 0.045, 0.075) * exp(-h * 2.4) * 0.30;

  // clouds
  vec2 cp = vec2(p.x * 0.62 + uTime * 0.0035, p.y * 1.9);
  float cl = fbm(cp * 1.5 + vec2(0.0, 3.0), uOct);
  float cl2 = fbm(cp * 0.45 + 9.0, 2);
  float bandY = smoothstep(0.22, 0.60, p.y) * (1.0 - smoothstep(1.25, 2.3, p.y));
  float cov = smoothstep(0.10, 0.62, cl + 0.35 * cl2) * bandY;

  // stars
  float tw = 0.84 + 0.16 * sin(uTime * 2.3 + 55.0 * snoise(p * 9.0));
  c += B.r * vec3(0.80, 0.88, 1.0) * tw * (1.0 - cov) * smoothstep(0.03, 0.4, h) * 0.85;

  float lit = smoothstep(-0.1, 0.5, cl);
  vec3 cc = mix(vec3(0.014, 0.017, 0.030), vec3(0.070, 0.082, 0.125), lit);
  cc += vec3(0.30, 0.11, 0.05) * exp(-h * 3.2) * west * 0.5;
  // the volcano lights the cloud base
  float vg = exp(-length((p - vec2(0.0, 0.75)) * vec2(0.8, 1.0)) / 0.55);
  cc += GLOW * vg * uVentGlow * 0.40 * (1.2 - lit);
  c = mix(c, cc, cov * 0.82);

  // distant ranges with haze
  vec3 hazeCol = mix(hor, mid, 0.35) + vec3(0.46, 0.17, 0.055) * west * 0.12;
  vec3 farC = mix(vec3(0.020, 0.022, 0.036), hazeCol, 0.42);
  vec3 nearC = mix(vec3(0.010, 0.011, 0.018), hazeCol, 0.14);
  float vl = exp(-abs(p.x) / 0.9) * uVentGlow;
  farC += GLOW * vl * 0.020;
  nearC += GLOW * vl * 0.030;
  c = mix(c, farC, B.g);
  c = mix(c, nearC, B.b);
  return c;
}

void main() {
  vec2 p = uView.xy + gl_FragCoord.xy * uView.z + uShake;
  float px = uView.z;
  vec2 buv = (p - uBakeView.xy) * uBakeView.zw;
  vec4 A = texture(uBakeA, buv);
  vec4 B = texture(uBakeB, buv);

  float along;
  float dDike = dikeSDF(p, along);
  float dCh = chamberSDF(p);
  float dCav = min(smin(conduitSDF(p), dCh, 0.035), dDike);
  if (abs(dCav) < 0.016) {
    dCav += 0.0030 * snoise(p * 46.0) + 0.0013 * snoise(p * 128.0);
  }
  float surfY = surfaceY(p.x);
  float inCav = smoothstep(px * 0.75, -px * 0.75, dCav);
  bool reservoir = dDike < 0.004 || dCh < 0.004;
  float filled = reservoir ? 1.0 : smoothstep(px * 0.75, -px * 0.75, p.y - surfY);
  float magma = inCav * filled;

  // the open crater above the rim shows sky
  float lip = RIM_Y + 0.013 + 0.004 * snoise(vec2(p.x * 31.0, 2.0));
  float openAir = inCav * (1.0 - filled) * smoothstep(-0.003, 0.003, p.y - lip);
  float skyAmt = max(1.0 - B.a, openAir);

  vec3 col = vec3(0.0);

  // ---- rock and back wall ----------------------------------------------------
  if (skyAmt < 0.999 && magma < 0.999) {
    vec3 alb = A.rgb * A.rgb;
    float hx = texture(uBakeA, buv + vec2(uBakeTexel.x, 0.0)).a;
    float hy = texture(uBakeA, buv + vec2(0.0, uBakeTexel.y)).a;
    vec3 N = normalize(vec3((A.a - hx) * 4.5, (A.a - hy) * 4.5, 1.0));

    vec3 Lm = normalize(vec3(-0.50, 0.58, 0.64));
    float moon = max(dot(N, Lm), 0.0);
    vec3 lit = alb * (vec3(0.23, 0.25, 0.32) * 0.85 + vec3(0.64, 0.68, 0.82) * moon * 1.05);
    // rock far below is lit less
    lit *= mix(0.42, 1.0, smoothstep(-1.5, -0.35, p.y));
    lit *= mix(1.0, 0.72, smoothstep(0.9, 2.2, abs(p.x)));

    // distance and direction to the nearest molten rock
    float yq = clamp(p.y, CHAMBER_TOP, surfY);
    vec2 axis = vec2(conduitX(yq), yq);
    vec2 toAxis = axis - p;
    float dChute = max(length(vec2(max(abs(toAxis.x) - conduitW(yq), 0.0), toAxis.y)), 0.0);
    float dRes = max(min(dCh, dDike * 2.2 + 0.004), 0.0);
    float dMag = min(dChute, dRes);
    vec2 toRes = vec2(clamp(p.x, -0.38, 0.44), CHAMBER_C.y) - p;
    vec2 dir = dChute < dRes ? toAxis : toRes;
    vec3 Lg = normalize(vec3(normalize(dir + 1e-5), 0.42));
    float ndl = 0.25 + 0.75 * max(dot(N, Lg), 0.0);

    float power = 0.55 + 2.2 * uHeat + 0.9 * uErupt;
    float g = exp(-dMag / 0.012) * 2.6 + exp(-dMag / 0.050) * 0.70 + exp(-dMag / 0.20) * 0.055;
    vec3 gc = mix(vec3(1.0, 0.27, 0.045), vec3(1.0, 0.46, 0.11), clamp(uHeat + uErupt, 0.0, 1.0));
    float openCav = inCav * (1.0 - filled);
    lit += alb * gc * g * ndl * power * 2.4 * (1.0 - 0.6 * openCav);

    // incandescent contact and glowing fractures
    float veins = 1.0 - smoothstep(0.12, 0.42, A.a);
    lit += blackbody(0.50 * exp(-dMag / 0.0045) * (0.8 + 0.4 * uHeat));
    lit += blackbody(0.62 * veins * exp(-dMag / 0.030) * (0.55 + 0.6 * uHeat));

    // fume drifting up the open chute, lit from below
    float open = inCav * (1.0 - filled);
    if (open > 0.001) {
      float dx = (p.x - conduitX(p.y)) / max(conduitW(p.y), 0.001);
      float f = fbm(vec2(dx * 2.2 + 3.0, p.y * 13.0 - uTime * (0.22 + 0.5 * uHeat)), 3) * 0.5 + 0.5;
      float reach = exp(-max(p.y - surfY, 0.0) / (0.10 + 0.30 * uHeat));
      lit = mix(lit, gc * (0.06 + 0.30 * uHeat) * reach, open * f * (0.20 + 0.25 * uHeat));
      lit += gc * open * exp(-max(p.y - surfY, 0.0) / 0.018) * 0.12 * power;
    }
    col = lit;
  }

  // ---- magma -------------------------------------------------------------------
  if (magma > 0.001) {
    vec3 m = magmaColor(p, dCav, dDike, along, surfY);
    // bright meniscus line where the surface meets the air
    float men = reservoir ? 0.0 : exp(-abs(p.y - surfY) / (px * 1.5 + 0.0015));
    m += blackbody(0.75 + 0.3 * uHeat) * men * 0.35;
    col = mix(col, m, magma);
  }

  // ---- sky, plume, fountain ------------------------------------------------------
  if (skyAmt > 0.001) {
    vec3 s = sky(p, B);
    float r = length((p - vec2(0.0, RIM_Y + 0.03)) * vec2(1.0, 0.8));
    s += GLOW * uVentGlow * (exp(-r / 0.075) * 0.30 + exp(-r / 0.34) * 0.07);
    vec4 pl = plume(p);
    s = mix(s, pl.rgb, pl.a);
    s += fountain(p) * (1.0 - 0.5 * pl.a);
    col = mix(col, s, skyAmt);
  }

  // ---- lava running down the flanks ------------------------------------------------
  if (uLavaOn > 0.5) {
    float dAb = p.y - terrainH(p.x);
    if (dAb > -0.06 && dAb < 0.09) {
      vec2 L = texture(uLava, vec2((p.x - uLavaRange.x) * uLavaRange.y, 0.5)).rg;
      if (L.r > 0.002) {
        float thick = min(L.r, 1.6) * 0.021 * (0.85 + 0.3 * snoise(vec2(p.x * 55.0, uTime * 0.3)));
        float inL = smoothstep(px, -px, dAb - thick) * smoothstep(-0.0045 - px, -0.0045 + px, dAb);
        float sgn = p.x > 0.0 ? 1.0 : -1.0;
        float n = fbm(vec2(p.x * 75.0 - sgn * uTime * 0.35 * L.g, dAb * 150.0), 3);
        float temp = L.g * (0.80 + 0.55 * n);
        temp *= mix(1.0, 0.50, smoothstep(0.35, 1.0, dAb / max(thick, 1e-4)));
        vec3 lc = blackbody(temp) + vec3(0.014, 0.011, 0.011);
        col = mix(col, lc, inL);
        float halo = L.g * L.g * min(L.r * 3.0, 1.0) * exp(-abs(dAb - thick * 0.5) / 0.020);
        col += GLOW * halo * 0.30 * (1.0 - inL);
      }
    }
  }

  // sheet lightning tints everything a little
  col += vec3(0.05, 0.06, 0.10) * uFlash * 0.6;

  o = vec4(max(col, 0.0), 1.0);
}
