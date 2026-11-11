import './ui/styles.css';
import { HeatModel } from './audio/heat';
import { Mic } from './audio/mic';
import { VolcanoSound } from './audio/sound';
import { LavaFlow } from './render/lavaFlow';
import { Particles } from './render/particles';
import { Renderer } from './render/renderer';
import { Effects } from './sim/events';
import { Volcano } from './sim/volcanoState';
import { Hud, loadSettings } from './ui/hud';

function fatal(msg: string): void {
  const f = document.getElementById('fatal');
  if (f) {
    f.textContent = msg;
    f.hidden = false;
  }
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function micErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'The microphone is blocked. Allow it for this site in your browser settings, then press Start again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone was found on this device.';
  }
  if (name === 'NotReadableError') {
    return 'Another app is using the microphone. Close it, then press Start again.';
  }
  return err instanceof Error ? err.message : 'The microphone could not be opened.';
}

function boot(): void {
  const params = new URLSearchParams(location.search);
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const settings = loadSettings();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const scaleParam = Number(params.get('scale'));
  let renderer: Renderer;
  try {
    renderer = new Renderer(canvas, {
      fixedScale: scaleParam > 0 ? Math.min(1, Math.max(0.25, scaleParam)) : undefined,
      lowPower: settings.lowPower,
    });
  } catch (e) {
    console.error(e);
    fatal('This browser cannot draw the volcano (WebGL 2 is unavailable). Try a current version of Chrome, Safari, Edge or Firefox.');
    return;
  }

  const volcano = new Volcano();
  const heatModel = new HeatModel();
  heatModel.sensitivity = settings.sensitivity;
  const mic = new Mic();
  const sound = new VolcanoSound({ enabled: settings.sound, volume: settings.volume, lowPower: settings.lowPower });
  void mic.setEchoCancellation(settings.sound);
  const particles = new Particles();
  const lava = new LavaFlow();
  const effects = new Effects({ shakeScale: reducedMotion.matches ? 0 : 1, lowPower: settings.lowPower });
  effects.listener = {
    bubble: (x, r, h) => sound.bubble(x, r, h),
    tremor: (a) => sound.tremor(a),
    eruption: () => sound.blast(),
    lightning: (x, a) => sound.thunder(x, a),
  };
  // browsers only allow sound after a tap or key press; the first one anywhere starts it
  const unlock = (): void => sound.start();
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock, { passive: true });
  reducedMotion.addEventListener('change', () => {
    effects.opts.shakeScale = reducedMotion.matches ? 0 : 1;
  });

  let mode: 'intro' | 'mic' | 'demo' = 'intro';
  let manualHeat = 0;
  // the lock is released by the browser whenever the page is hidden, so it is re-taken on return
  const keepAwake = async (): Promise<void> => {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible' && mode !== 'intro') {
        await navigator.wakeLock.request('screen');
      }
    } catch {
      /* not allowed right now (battery saver, background); try again on next visibility change */
    }
  };

  const startMic = async (): Promise<void> => {
    hud.setBusy(true);
    try {
      await mic.start();
      heatModel.recalibrate();
      mode = 'mic';
      hud.setMic('on', 'Listening');
      hud.enter();
      void keepAwake();
    } catch (e) {
      const msg = micErrorMessage(e);
      if (mode === 'intro') hud.showIntroError(msg);
      hud.setMic('error', msg);
    } finally {
      hud.setBusy(false);
    }
  };

  const startDemo = (): void => {
    mic.stop();
    mode = 'demo';
    hud.setMic('demo', 'Manual mode');
    hud.setManual(manualHeat);
    hud.enter();
    void keepAwake();
  };

  const hud = new Hud(settings, {
    onStart: () => void startMic(),
    onDemo: startDemo,
    onMicToggle: () => {
      if (mode === 'mic') startDemo();
      else void startMic();
    },
    onRecalibrate: () => heatModel.recalibrate(),
    onSensitivity: (v) => {
      heatModel.sensitivity = v;
    },
    onSound: (on) => {
      sound.setEnabled(on);
      // reopening the microphone keeps what was learned about the room
      void mic.setEchoCancellation(on).catch(() => undefined);
    },
    onVolume: (v) => sound.setVolume(v),
    onLowPower: (on) => {
      effects.opts.lowPower = on;
      sound.setLowPower(on);
      renderer.setLowPower(on);
      renderer.resize(true);
    },
    onManual: (v) => {
      manualHeat = v;
    },
  });

  // a freshly opened stream starts with silence or a click: do not learn from it
  mic.onOpen = () => heatModel.settle();
  mic.onLost = () => {
    hud.setMic('error', 'The microphone disconnected');
  };

  // ?demo or ?demo=0.6 skips the start screen (also used by automated tests)
  if (params.has('demo')) {
    const v = Number(params.get('demo'));
    manualHeat = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
    startDemo();
  }

  document.addEventListener('visibilitychange', () => {
    sound.setHidden(document.visibilityState !== 'visible');
    if (document.visibilityState === 'visible') {
      void mic.resume();
      void keepAwake();
      last = performance.now();
    }
  });

  window.addEventListener('keydown', (e) => {
    if (mode !== 'demo') return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') manualHeat = Math.min(1, manualHeat + 0.05);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') manualHeat = Math.max(0, manualHeat - 0.05);
    else return;
    hud.setManual(manualHeat);
  });

  const onResize = (): void => {
    if (renderer.resize()) effects.setSkyTop(renderer.view.maxY);
  };
  new ResizeObserver(onResize).observe(canvas);
  renderer.resize(true);
  effects.setSkyTop(renderer.view.maxY);

  let last = performance.now();
  let audioClock = 0;
  let hudClock = 0;
  let audioLevel = 0;
  let frames = 0;

  const frame = (now: number): void => {
    requestAnimationFrame(frame);
    const interval = now - last;
    const resting = volcano.phase === 'dormant' && volcano.erupt === 0 && !lava.active && particles.count === 0;

    // cap at about 60 fps on fast displays, and 30 fps while the volcano is at rest
    const throttled = resting && mode !== 'intro';
    if (interval < (throttled ? 30 : 13)) return;
    last = now;
    const dt = Math.min(0.1, Math.max(0.001, interval / 1000));
    renderer.reportFrame(interval, now, throttled);
    frames++;

    // ---- listen ----------------------------------------------------------------
    let heat = 0;
    if (mode === 'mic') {
      audioClock += dt;
      if (audioClock >= 1 / 30) {
        const f = mic.read(sound.reference(), audioClock);
        if (f) {
          heatModel.update(f, audioClock);
          audioLevel = smoothstep(8, 42, heatModel.aboveDb);
        }
        audioClock = 0;
      }
      heat = heatModel.heat;
    } else if (mode === 'demo') {
      heat = manualHeat;
      audioLevel = 0;
    }

    // ---- simulate ----------------------------------------------------------------
    volcano.update(heat, dt);
    if (volcano.justEnded && mode === 'mic') heatModel.release();
    effects.update(volcano, heat, audioLevel, dt, particles, lava);
    const s = effects.state;
    particles.update(dt, s.time, s.levelY, s.wind, (x, size) => {
      lava.addSpatter(x, size);
      sound.thud(x, size);
    });
    sound.update({ heat: s.heat, level: volcano.level, erupt: s.erupt, wind: s.wind }, dt);

    // ---- draw ----------------------------------------------------------------------
    renderer.render(s, particles, lava);

    hudClock += dt;
    if (hudClock > 0.1) {
      hudClock = 0;
      const shown = volcano.phase === 'erupting' ? 1 : heat;
      hud.update(volcano.phase, shown, mode === 'mic' ? heatModel.aboveDb : null);
    }
  };
  requestAnimationFrame(frame);

  // hooks for automated tests and curious people in the console
  (window as unknown as Record<string, unknown>).__volcano = {
    setHeat(v: number) {
      if (mode !== 'demo') startDemo();
      manualHeat = Math.min(1, Math.max(0, v));
      hud.setManual(manualHeat);
    },
    async probeSound(heat: number, level: number, erupt: number, opts?: Record<string, unknown>) {
      const m = await import('./audio/soundProbe');
      return m.probeSound({ heat, level, erupt, wind: 0.4 }, opts);
    },
    get state() {
      return {
        mode,
        heat: mode === 'mic' ? heatModel.heat : manualHeat,
        drive: heatModel.drive,
        aboveDb: heatModel.aboveDb,
        floorDb: heatModel.floorDb,
        echo: mic.echoState,
        level: volcano.level,
        phase: volcano.phase,
        erupt: volcano.erupt,
        particles: particles.count,
        plume: effects.state.plume,
        plumeH: effects.state.plumeH,
        scale: renderer.scale,
        simTime: effects.state.time,
        sound: sound.running,
        frames,
      };
    },
  };

  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => undefined);
    });
  }
}

boot();
