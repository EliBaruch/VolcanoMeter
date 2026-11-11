in vec2 vC;
in float vTemp;
in float vAlpha;
in float vAspect;
out vec4 o;
void main() {
  // capsule falloff so streaks keep round ends
  float along = max(abs(vC.y) * vAspect - (vAspect - 1.0), 0.0);
  float d2 = vC.x * vC.x + along * along;
  float core = exp(-d2 * 3.2);
  float head = mix(0.55, 1.0, smoothstep(-1.0, 1.0, vC.y));
  if (core < 0.012) discard;
  o = vec4(blackbody(vTemp) * core * head * vAlpha, 1.0);
}
