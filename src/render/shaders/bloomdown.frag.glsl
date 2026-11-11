// 13-tap downsample; the first level also applies a soft threshold.
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uThreshold; // < 0 disables
in vec2 vUV;
out vec4 o;
vec3 pre(vec3 c) {
  if (uThreshold < 0.0) return c;
  float b = max(c.r, max(c.g, c.b));
  float k = uThreshold * 0.6;
  float soft = clamp(b - uThreshold + k, 0.0, 2.0 * k);
  soft = soft * soft / (4.0 * k + 1e-4);
  float w = max(soft, b - uThreshold) / max(b, 1e-4);
  c *= w;
  // tame single-pixel fireflies
  return c / (1.0 + 0.06 * b);
}
void main() {
  vec2 t = uTexel;
  vec3 a = pre(texture(uTex, vUV + t * vec2(-2.0, 2.0)).rgb);
  vec3 b = pre(texture(uTex, vUV + t * vec2(0.0, 2.0)).rgb);
  vec3 c = pre(texture(uTex, vUV + t * vec2(2.0, 2.0)).rgb);
  vec3 d = pre(texture(uTex, vUV + t * vec2(-2.0, 0.0)).rgb);
  vec3 e = pre(texture(uTex, vUV).rgb);
  vec3 f = pre(texture(uTex, vUV + t * vec2(2.0, 0.0)).rgb);
  vec3 g = pre(texture(uTex, vUV + t * vec2(-2.0, -2.0)).rgb);
  vec3 h = pre(texture(uTex, vUV + t * vec2(0.0, -2.0)).rgb);
  vec3 i = pre(texture(uTex, vUV + t * vec2(2.0, -2.0)).rgb);
  vec3 j = pre(texture(uTex, vUV + t * vec2(-1.0, 1.0)).rgb);
  vec3 k = pre(texture(uTex, vUV + t * vec2(1.0, 1.0)).rgb);
  vec3 l = pre(texture(uTex, vUV + t * vec2(-1.0, -1.0)).rgb);
  vec3 m = pre(texture(uTex, vUV + t * vec2(1.0, -1.0)).rgb);
  vec3 r = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  o = vec4(r, 1.0);
}
