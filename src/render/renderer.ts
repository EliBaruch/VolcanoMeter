import commonSrc from './shaders/common.glsl?raw';
import fullscreenVert from './shaders/fullscreen.vert.glsl?raw';
import bakeFrag from './shaders/bake.frag.glsl?raw';
import simFrag from './shaders/sim.frag.glsl?raw';
import sceneFrag from './shaders/scene.frag.glsl?raw';
import particleVert from './shaders/particle.vert.glsl?raw';
import particleFrag from './shaders/particle.frag.glsl?raw';
import bloomDownFrag from './shaders/bloomdown.frag.glsl?raw';
import bloomUpFrag from './shaders/bloomup.frag.glsl?raw';
import compositeFrag from './shaders/composite.frag.glsl?raw';

const HEADER = '#version 300 es\nprecision highp float;\nprecision highp int;\n';

const SIM_W = 384;
const SIM_H = 288;
const QUALITY_STEPS = [1, 0.85, 0.72, 0.6, 0.5];

/** Everything the picture depends on for one frame. */
export interface FrameState {
  time: number;
  dt: number;
  levelY: number;
  flow: number;
  flowPhase: number;
  heat: number;
  erupt: number;
  audio: number;
  plume: number;
  plumeH: number;
  plumeT: number;
  fountH: number;
  fountT: number;
  ventGlow: number;
  flash: number;
  flashX: number;
  flashY: number;
  wind: number;
  shakeX: number;
  shakeY: number;
  /** 4 x (x, radius, height, unused) */
  bubbles: Float32Array;
  /** 4 x (x, y, radius, strength) */
  bursts: Float32Array;
}

export interface ParticleSource {
  readonly count: number;
  /** count x 7 floats: x, y, vx, vy, size, temperature, alpha */
  readonly data: Float32Array;
}

export interface LavaSource {
  readonly active: boolean;
  readonly cells: number;
  readonly x0: number;
  readonly x1: number;
  /** cells x 2 floats: amount, heat */
  readonly data: Float32Array;
}

interface Program {
  prog: WebGLProgram;
  u: Map<string, WebGLUniformLocation | null>;
}

interface Target {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
}

export interface RendererOptions {
  /** fixed render scale (testing); disables adaptation */
  fixedScale?: number;
  lowPower?: boolean;
  seed?: number;
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private gl!: WebGL2RenderingContext;
  private floatTargets = false;
  private progs: Record<string, Program> = {};
  private vao!: WebGLVertexArrayObject;
  private particleVao!: WebGLVertexArrayObject;
  private particleBuf!: WebGLBuffer;
  private particleCap = 0;
  private bakeFbo!: WebGLFramebuffer;
  private bakeA!: WebGLTexture;
  private bakeB!: WebGLTexture;
  private sim: Target[] = [];
  private simIndex = 0;
  private simInit = true;
  private scene: Target | null = null;
  private bloom: Target[] = [];
  private lavaTex!: WebGLTexture;
  private lavaCells = 0;

  private width = 0;
  private height = 0;
  private viewMinX = 0;
  private viewMinY = 0;
  private upp = 1;
  private qualityIndex = 0;
  private fixedScale: number | null;
  private lowPower: boolean;
  private seed: number;
  private slowTime = 0;
  private fastTime = 0;
  private upFailures = 0;
  private lastStepUp = 0;
  private lost = false;

  constructor(canvas: HTMLCanvasElement, opts: RendererOptions = {}) {
    this.canvas = canvas;
    this.fixedScale = opts.fixedScale ?? null;
    this.lowPower = opts.lowPower ?? false;
    this.seed = opts.seed ?? Math.random() * 50;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false;
      this.init();
      this.resize(true);
    });
    this.init();
  }

  get isLost(): boolean {
    return this.lost;
  }

  get scale(): number {
    return this.fixedScale ?? QUALITY_STEPS[this.qualityIndex] * (this.lowPower ? 0.75 : 1);
  }

  /** World rectangle currently on screen. */
  get view(): { minX: number; minY: number; maxX: number; maxY: number; upp: number } {
    return {
      minX: this.viewMinX,
      minY: this.viewMinY,
      maxX: this.viewMinX + this.width * this.upp,
      maxY: this.viewMinY + this.height * this.upp,
      upp: this.upp,
    };
  }

  setLowPower(on: boolean): void {
    if (on === this.lowPower) return;
    this.lowPower = on;
    this.allocTargets();
  }

  // -------------------------------------------------------------------------
  private init(): void {
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.floatTargets = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));

    this.progs = {
      bake: this.program(fullscreenVert, bakeFrag, true),
      sim: this.program(fullscreenVert, simFrag, true),
      scene: this.program(fullscreenVert, sceneFrag, true),
      particle: this.program(particleVert, particleFrag, true),
      down: this.program(fullscreenVert, bloomDownFrag, false),
      up: this.program(fullscreenVert, bloomUpFrag, false),
      composite: this.program(fullscreenVert, compositeFrag, true),
    };

    this.vao = gl.createVertexArray()!;

    // particle geometry: one quad, instanced
    this.particleVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.particleVao);
    const quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.particleBuf = gl.createBuffer()!;
    this.particleCap = 0;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 28, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);

    // magma simulation (ping-pong)
    this.sim = [this.target(SIM_W, SIM_H, true), this.target(SIM_W, SIM_H, true)];
    this.simIndex = 0;
    this.simInit = true;

    this.lavaTex = gl.createTexture()!;
    this.lavaCells = 0;
    gl.bindTexture(gl.TEXTURE_2D, this.lavaTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.bakeFbo = gl.createFramebuffer()!;
    this.bakeA = gl.createTexture()!;
    this.bakeB = gl.createTexture()!;
    this.scene = null;
    this.bloom = [];
    this.width = 0;
    this.height = 0;

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  private program(vs: string, fs: string, withCommon: boolean): Program {
    const gl = this.gl;
    const compile = (type: number, src: string): WebGLShader => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
        const log = gl.getShaderInfoLog(s);
        throw new Error(`Shader compile failed: ${log}`);
      }
      return s;
    };
    const v = compile(gl.VERTEX_SHADER, HEADER + vs);
    const f = compile(gl.FRAGMENT_SHADER, HEADER + (withCommon ? commonSrc : '') + fs);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, v);
    gl.attachShader(prog, f);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error(`Program link failed: ${gl.getProgramInfoLog(prog)}`);
    }
    gl.deleteShader(v);
    gl.deleteShader(f);
    return { prog, u: new Map() };
  }

  private loc(p: Program, name: string): WebGLUniformLocation | null {
    let l = p.u.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(p.prog, name);
      p.u.set(name, l);
    }
    return l;
  }

  private target(w: number, h: number, hdr: boolean): Target {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (hdr && this.floatTargets) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex, w, h };
  }

  private freeTarget(t: Target | null): void {
    if (!t) return;
    this.gl.deleteFramebuffer(t.fbo);
    this.gl.deleteTexture(t.tex);
  }

  // -------------------------------------------------------------------------
  /** Match the canvas to its CSS size. Returns true if anything changed. */
  resize(force = false): boolean {
    const cssW = Math.max(1, this.canvas.clientWidth);
    const cssH = Math.max(1, this.canvas.clientHeight);
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    const maxPixels = this.lowPower ? 1.4e6 : 2.8e6;
    const px = cssW * cssH * dpr * dpr;
    if (px > maxPixels) dpr *= Math.sqrt(maxPixels / px);
    const w = Math.max(2, Math.round(cssW * dpr));
    const h = Math.max(2, Math.round(cssH * dpr));
    if (!force && w === this.width && h === this.height) return false;
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;

    // frame the volcano: fit the narrower of the two must-show extents
    const needW = 1.36;
    const needH = 2.0;
    this.upp = Math.max(needW / w, needH / h);
    const viewW = w * this.upp;
    const viewH = h * this.upp;
    this.viewMinX = -viewW / 2;
    this.viewMinY = -0.80 - (viewH - needH) * 0.3;

    this.bake();
    this.allocTargets();
    return true;
  }

  private allocTargets(): void {
    if (!this.width) return;
    const s = this.scale;
    const w = Math.max(2, Math.round(this.width * s));
    const h = Math.max(2, Math.round(this.height * s));
    if (this.scene && this.scene.w === w && this.scene.h === h) return;
    this.freeTarget(this.scene);
    this.bloom.forEach((t) => this.freeTarget(t));
    this.scene = this.target(w, h, true);
    this.bloom = [];
    let bw = Math.max(2, w >> 1);
    let bh = Math.max(2, h >> 1);
    for (let i = 0; i < 6 && Math.min(bw, bh) >= 6; i++) {
      this.bloom.push(this.target(bw, bh, true));
      bw = Math.max(2, bw >> 1);
      bh = Math.max(2, bh >> 1);
    }
  }

  private bake(): void {
    const gl = this.gl;
    const w = this.width;
    const h = this.height;
    for (const tex of [this.bakeA, this.bakeB]) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bakeFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.bakeA, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.bakeB, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    const p = this.progs.bake;
    gl.useProgram(p.prog);
    gl.uniform3f(this.loc(p, 'uView'), this.viewMinX, this.viewMinY, this.upp);
    gl.uniform1f(this.loc(p, 'uSeed'), this.seed);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // -------------------------------------------------------------------------
  /**
   * Feed the measured frame interval so resolution can follow the device.
   * `throttled` means the caller is deliberately skipping frames.
   */
  reportFrame(intervalMs: number, now: number, throttled: boolean): void {
    if (this.fixedScale !== null || throttled || intervalMs > 250) return;
    if (intervalMs > 24) {
      this.slowTime += intervalMs;
      this.fastTime = 0;
    } else if (intervalMs < 18.5) {
      this.fastTime += intervalMs;
      this.slowTime = Math.max(0, this.slowTime - intervalMs * 0.5);
    } else {
      this.fastTime = 0;
    }
    if (this.slowTime > 1500 && this.qualityIndex < QUALITY_STEPS.length - 1) {
      if (now - this.lastStepUp < 8000) this.upFailures++;
      this.qualityIndex++;
      this.slowTime = 0;
      this.fastTime = 0;
      this.allocTargets();
    } else if (this.fastTime > 9000 && this.qualityIndex > 0 && this.upFailures < 2) {
      this.qualityIndex--;
      this.fastTime = 0;
      this.slowTime = 0;
      this.lastStepUp = now;
      this.allocTargets();
    }
  }

  // -------------------------------------------------------------------------
  render(s: FrameState, particles: ParticleSource, lava: LavaSource): void {
    if (this.lost || !this.scene) return;
    const gl = this.gl;
    const scale = this.scale;
    const oct = this.lowPower ? 3 : scale >= 0.72 ? 5 : 4;

    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);

    // ---- 1. magma simulation ------------------------------------------------
    {
      const src = this.sim[this.simIndex];
      const dst = this.sim[1 - this.simIndex];
      const p = this.progs.sim;
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, dst.w, dst.h);
      gl.useProgram(p.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(this.loc(p, 'uPrev'), 0);
      gl.uniform1f(this.loc(p, 'uTime'), s.time);
      gl.uniform1f(this.loc(p, 'uDt'), Math.min(s.dt, 0.05));
      gl.uniform1f(this.loc(p, 'uLevelY'), s.levelY);
      gl.uniform1f(this.loc(p, 'uFlow'), s.flow);
      gl.uniform1f(this.loc(p, 'uHeat'), s.heat);
      gl.uniform1f(this.loc(p, 'uErupt'), s.erupt);
      gl.uniform1f(this.loc(p, 'uAudio'), s.audio);
      gl.uniform1f(this.loc(p, 'uInit'), this.simInit ? 1 : 0);
      gl.uniform4fv(this.loc(p, 'uBurst[0]'), s.bursts);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.simIndex = 1 - this.simIndex;
      this.simInit = false;
    }

    // ---- 2. lava flow strip ---------------------------------------------------
    if (lava.active) {
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this.lavaTex);
      if (this.lavaCells !== lava.cells) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, lava.cells, 1, 0, gl.RG, gl.FLOAT, lava.data);
        this.lavaCells = lava.cells;
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, lava.cells, 1, gl.RG, gl.FLOAT, lava.data);
      }
    }

    // ---- 3. scene --------------------------------------------------------------
    const sc = this.scene;
    const uppScene = this.upp / (sc.w / this.width);
    {
      const p = this.progs.scene;
      gl.bindFramebuffer(gl.FRAMEBUFFER, sc.fbo);
      gl.viewport(0, 0, sc.w, sc.h);
      gl.useProgram(p.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.bakeA);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.bakeB);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.sim[this.simIndex].tex);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this.lavaTex);
      gl.uniform1i(this.loc(p, 'uBakeA'), 0);
      gl.uniform1i(this.loc(p, 'uBakeB'), 1);
      gl.uniform1i(this.loc(p, 'uSim'), 2);
      gl.uniform1i(this.loc(p, 'uLava'), 3);
      gl.uniform3f(this.loc(p, 'uView'), this.viewMinX, this.viewMinY, uppScene);
      gl.uniform4f(
        this.loc(p, 'uBakeView'),
        this.viewMinX,
        this.viewMinY,
        1 / (this.width * this.upp),
        1 / (this.height * this.upp),
      );
      gl.uniform2f(this.loc(p, 'uBakeTexel'), 1.25 / this.width, 1.25 / this.height);
      gl.uniform2f(this.loc(p, 'uLavaRange'), lava.x0, 1 / (lava.x1 - lava.x0));
      gl.uniform1f(this.loc(p, 'uLavaOn'), lava.active && this.lavaCells > 0 ? 1 : 0);
      gl.uniform1f(this.loc(p, 'uTime'), s.time);
      gl.uniform1f(this.loc(p, 'uLevelY'), s.levelY);
      gl.uniform1f(this.loc(p, 'uHeat'), s.heat);
      gl.uniform1f(this.loc(p, 'uErupt'), s.erupt);
      gl.uniform1f(this.loc(p, 'uPlume'), s.plume);
      gl.uniform1f(this.loc(p, 'uPlumeH'), s.plumeH);
      gl.uniform1f(this.loc(p, 'uPlumeT'), s.plumeT);
      gl.uniform1f(this.loc(p, 'uFountH'), s.fountH);
      gl.uniform1f(this.loc(p, 'uFountT'), s.fountT);
      gl.uniform1f(this.loc(p, 'uVentGlow'), s.ventGlow);
      gl.uniform1f(this.loc(p, 'uFlowPhase'), s.flowPhase);
      gl.uniform1f(this.loc(p, 'uFlash'), s.flash);
      gl.uniform2f(this.loc(p, 'uFlashPos'), s.flashX, s.flashY);
      gl.uniform1f(this.loc(p, 'uWind'), s.wind);
      gl.uniform2f(this.loc(p, 'uShake'), s.shakeX, s.shakeY);
      gl.uniform4fv(this.loc(p, 'uBubble[0]'), s.bubbles);
      gl.uniform1i(this.loc(p, 'uOct'), oct);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // ---- 4. particles (additive, into the HDR scene) ------------------------------
    if (particles.count > 0) {
      const p = this.progs.particle;
      const n = particles.count;
      gl.useProgram(p.prog);
      gl.bindVertexArray(this.particleVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuf);
      if (this.particleCap < particles.data.length) {
        gl.bufferData(gl.ARRAY_BUFFER, particles.data.byteLength, gl.DYNAMIC_DRAW);
        this.particleCap = particles.data.length;
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, particles.data, 0, n * 7);
      gl.uniform3f(this.loc(p, 'uView'), this.viewMinX, this.viewMinY, uppScene);
      gl.uniform2f(this.loc(p, 'uRes'), sc.w, sc.h);
      gl.uniform2f(this.loc(p, 'uShake'), s.shakeX, s.shakeY);
      gl.uniform1f(this.loc(p, 'uStretch'), 0.022);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(this.vao);
    }

    // ---- 5. bloom ------------------------------------------------------------------
    {
      const p = this.progs.down;
      gl.useProgram(p.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(this.loc(p, 'uTex'), 0);
      let src: Target = sc;
      for (let i = 0; i < this.bloom.length; i++) {
        const dst = this.bloom[i];
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
        gl.viewport(0, 0, dst.w, dst.h);
        gl.bindTexture(gl.TEXTURE_2D, src.tex);
        gl.uniform2f(this.loc(p, 'uTexel'), 1 / src.w, 1 / src.h);
        gl.uniform1f(this.loc(p, 'uThreshold'), i === 0 ? 0.85 : -1);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        src = dst;
      }
      const up = this.progs.up;
      gl.useProgram(up.prog);
      gl.uniform1i(this.loc(up, 'uTex'), 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      for (let i = this.bloom.length - 2; i >= 0; i--) {
        const from = this.bloom[i + 1];
        const dst = this.bloom[i];
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
        gl.viewport(0, 0, dst.w, dst.h);
        gl.bindTexture(gl.TEXTURE_2D, from.tex);
        gl.uniform2f(this.loc(up, 'uTexel'), 1 / from.w, 1 / from.h);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.disable(gl.BLEND);
    }

    // ---- 6. composite to the screen ---------------------------------------------------
    {
      const p = this.progs.composite;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.width, this.height);
      gl.useProgram(p.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sc.tex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.bloom.length ? this.bloom[0].tex : sc.tex);
      gl.uniform1i(this.loc(p, 'uScene'), 0);
      gl.uniform1i(this.loc(p, 'uBloom'), 1);
      gl.uniform2f(this.loc(p, 'uRes'), this.width, this.height);
      gl.uniform3f(this.loc(p, 'uView'), this.viewMinX, this.viewMinY, this.upp);
      gl.uniform1f(this.loc(p, 'uTime'), s.time);
      gl.uniform1f(this.loc(p, 'uHeat'), s.heat);
      gl.uniform1f(this.loc(p, 'uErupt'), s.erupt);
      gl.uniform1f(this.loc(p, 'uLevelY'), s.levelY);
      gl.uniform1f(this.loc(p, 'uExposure'), 1.15);
      gl.uniform1f(this.loc(p, 'uBloomAmt'), this.bloom.length ? 0.11 : 0);
      gl.uniform1f(this.loc(p, 'uFlash'), s.flash);
      gl.uniform1f(this.loc(p, 'uSeed'), this.seed);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }
}
