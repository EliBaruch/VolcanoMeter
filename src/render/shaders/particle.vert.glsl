// Instanced streaks: each particle is a quad stretched along its velocity.
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aPV;  // position, velocity
layout(location = 2) in vec3 aST;  // size, temperature, alpha
uniform vec3 uView;
uniform vec2 uRes;
uniform vec2 uShake;
uniform float uStretch;
out vec2 vC;
out float vTemp;
out float vAlpha;
out float vAspect;
void main() {
  float sp = length(aPV.zw);
  vec2 dir = sp > 1e-4 ? aPV.zw / sp : vec2(0.0, 1.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float halfLen = aST.x + sp * uStretch;
  vec2 w = aPV.xy + dir * aCorner.y * halfLen + nrm * aCorner.x * aST.x - uShake;
  vec2 ndc = ((w - uView.xy) / uView.z) / uRes * 2.0 - 1.0;
  gl_Position = vec4(ndc, 0.0, 1.0);
  vC = aCorner;
  vTemp = aST.y;
  vAlpha = aST.z;
  vAspect = halfLen / max(aST.x, 1e-5);
}
