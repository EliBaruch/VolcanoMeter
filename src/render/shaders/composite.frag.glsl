// Heat haze, bloom, tonemap, grade, grain.
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec2 uRes;
uniform vec3 uView; // world min x, min y, units per canvas pixel
uniform float uTime;
uniform float uHeat;
uniform float uErupt;
uniform float uLevelY;
uniform float uExposure;
uniform float uBloomAmt;
uniform float uFlash;
uniform float uSeed;
out vec4 o;

vec3 aces(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = uView.xy + gl_FragCoord.xy * uView.z;

  // shimmering air above hot rock: strongest over the vent and the open chute
  float col = exp(-pow(p.x / (0.10 + 0.22 * max(p.y - RIM_Y, 0.0)), 2.0));
  float rise = smoothstep(uLevelY - 0.01, uLevelY + 0.05, p.y) * exp(-max(p.y - uLevelY, 0.0) / (0.35 + 0.5 * uHeat));
  float haze = col * rise * (0.25 + 1.2 * uHeat + 1.0 * uErupt);
  vec2 hp = vec2(p.x * 26.0, p.y * 17.0 - uTime * 1.6);
  vec2 off = vec2(snoise(hp), snoise(hp + 37.0)) * haze * 0.0016;
  off.x *= uRes.y / uRes.x;
  uv += off;

  vec3 c = texture(uScene, uv).rgb;
  vec3 bloom = texture(uBloom, uv).rgb;
  c += bloom * uBloomAmt;

  c *= uExposure;
  c = aces(c);
  // grade: lift blues in the shadows a touch, keep highlights warm
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(c, c * vec3(0.94, 1.0, 1.10), (1.0 - smoothstep(0.0, 0.35, l)) * 0.5);
  c = pow(c, vec3(1.0 / 2.2));

  // vignette
  vec2 v = gl_FragCoord.xy / uRes - 0.5;
  c *= 1.0 - 0.42 * smoothstep(0.25, 0.95, length(v * vec2(1.0, 1.08)));

  // film grain + dither against banding
  float n = hash21(gl_FragCoord.xy + fract(uTime * 7.31 + uSeed) * 913.0);
  float n2 = hash21(gl_FragCoord.yx * 1.37 + fract(uTime * 3.17) * 517.0);
  c += (n + n2 - 1.0) * (0.014 + 0.012 * (1.0 - l));
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}
