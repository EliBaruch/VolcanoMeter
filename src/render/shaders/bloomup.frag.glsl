// 9-tap tent upsample, blended additively into the next larger level.
uniform sampler2D uTex;
uniform vec2 uTexel;
in vec2 vUV;
out vec4 o;
void main() {
  vec2 t = uTexel;
  vec3 r = texture(uTex, vUV).rgb * 4.0;
  r += (texture(uTex, vUV + vec2(t.x, 0.0)).rgb + texture(uTex, vUV - vec2(t.x, 0.0)).rgb + texture(uTex, vUV + vec2(0.0, t.y)).rgb + texture(uTex, vUV - vec2(0.0, t.y)).rgb) * 2.0;
  r += texture(uTex, vUV + t).rgb + texture(uTex, vUV - t).rgb + texture(uTex, vUV + vec2(t.x, -t.y)).rgb + texture(uTex, vUV + vec2(-t.x, t.y)).rgb;
  o = vec4(r / 16.0, 1.0);
}
