// Test-only helper, loaded on demand: renders the volcano's sound offline and
// answers two questions. Does each state sound the way it should (level,
// spectrum, no clipping)? And if the microphone heard the speakers with no echo
// cancellation at all, would the volcano heat itself up?

import { EchoCanceller } from './echo';
import { extractFeatures, HeatModel } from './heat';
import { VolcanoSound, type SoundState } from './sound';

export interface ProbeResult {
  rmsDb: number;
  peak: number;
  /** share of energy below 250 Hz, in the speech band (300-3400 Hz), and above it */
  low: number;
  speech: number;
  high: number;
  /** feedback test: highest heat reached while "hearing" this sound, and how often it passed for talking */
  selfHeat: number;
  selfDrive: number;
  activeShare: number;
  /** share of the microphone signal the canceller removed while the app was playing */
  removed: number;
  /** delay the canceller settled on, in frames */
  lag: number;
  /** heat just before the app started making sound (from the calm talk alone) */
  before: number;
}

export interface ProbeOptions {
  seconds?: number;
  /** how loudly the microphone hears the speakers (1 = as loud as they play) */
  micGain?: number;
  /** model a phone speaker that cannot reproduce bass */
  smallSpeaker?: boolean;
  /** subtract the app's own sound, as the app does */
  cancel?: boolean;
  sensitivity?: number;
  /** people start shouting halfway through the app's own sound */
  shout?: boolean;
  /** filled with one line per second of what the heat model saw */
  trace?: string[];
}

const SR = 48000;

async function render(state: SoundState, seconds: number, events: boolean): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.floor(seconds * SR), SR);
  const sound = new VolcanoSound({ context: ctx, volume: 1 });
  sound.update(state, 0);
  if (events) {
    if (state.erupt > 0.5) {
      sound.blast(0.3);
      for (let t = 1.5; t < seconds - 3; t += 3.7) sound.thunder(Math.sin(t) * 0.5, 0.9, t);
    } else {
      for (let t = 0.4; t < seconds - 0.5; t += 0.45 / (0.3 + state.heat)) {
        sound.bubble(Math.sin(t * 7) * 0.02, 0.006 + 0.008 * Math.abs(Math.sin(t * 3)), state.heat, t);
      }
      for (let t = 1; t < seconds - 2; t += 4.1) sound.tremor(0.8 * state.heat, t);
    }
  }
  return ctx.startRendering();
}

/** A calm talking voice, so the heat model has learned what normal speech is before the test. */
function voice(seconds: number, amp: number, f0base = 125, tilt = 1.7, gap = 0.38): AudioBuffer {
  const n = Math.floor(seconds * SR);
  const buf = new AudioBuffer({ length: n, numberOfChannels: 1, sampleRate: SR });
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const syl = (t * 3.3) % 1;
    const env = syl < gap ? 0 : Math.pow(Math.sin((Math.PI * (syl - gap)) / (1 - gap)), 0.6);
    const f0 = f0base * (1 + 0.06 * Math.sin(t * 5.1));
    let s = 0;
    for (let k = 1; k < 26; k++) {
      const fk = f0 * k;
      const formant =
        1 + 2.2 * Math.exp(-(((fk - 700) / 350) ** 2)) + 1.6 * Math.exp(-(((fk - 1900) / 500) ** 2));
      if (fk > 5200) break;
      s += (formant / Math.pow(k, tilt)) * Math.sin(2 * Math.PI * fk * t + k);
    }
    d[i] = s * amp * env + (Math.random() - 0.5) * 0.0012;
  }
  return buf;
}

export async function probeSound(state: SoundState, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const seconds = opts.seconds ?? 14;
  const out = await render(state, seconds, true);
  const n = out.length;
  const l = out.getChannelData(0);
  const r = out.getChannelData(1);
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const v = (l[i] + r[i]) * 0.5;
    sum += v * v;
    peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
  }
  const rms = Math.sqrt(sum / n);

  // ---- feedback test, through the same analysers, canceller and heat model the app uses ----
  const quiet = 6;
  const talk = 26;
  const total = quiet + talk + seconds;
  const ctx = new OfflineAudioContext(1, Math.floor(total * SR), SR);
  const makeAnalyser = (): AnalyserNode => {
    const a = ctx.createAnalyser();
    a.fftSize = 2048;
    a.smoothingTimeConstant = 0.3;
    a.minDecibels = -110;
    a.maxDecibels = -10;
    return a;
  };
  const micAn = makeAnalyser();
  const refAn = makeAnalyser();
  micAn.connect(ctx.destination);

  const hiss = new AudioBuffer({ length: SR, numberOfChannels: 1, sampleRate: SR });
  const hd = hiss.getChannelData(0);
  for (let i = 0; i < SR; i++) hd[i] = (Math.random() - 0.5) * 0.0012;
  const room = ctx.createBufferSource();
  room.buffer = hiss;
  room.loop = true;
  room.connect(micAn);
  room.start();

  const calm = ctx.createBufferSource();
  calm.buffer = voice(talk, 0.008);
  calm.connect(micAn);
  calm.start(quiet);

  if (opts.shout) {
    const sh = ctx.createBufferSource();
    sh.buffer = voice(seconds / 2, 0.11, 235, 0.85, 0.12);
    sh.connect(micAn);
    sh.start(quiet + talk + seconds / 2);
  }

  // what the app plays, and what the microphone hears of it: quieter or louder,
  // late, smeared by the room, and without bass on a small speaker
  const own = ctx.createBufferSource();
  own.buffer = out;
  own.connect(refAn);
  const g = ctx.createGain();
  g.gain.value = opts.micGain ?? 1.5;
  const delay = ctx.createDelay(1);
  delay.delayTime.value = 0.17;
  const echo = ctx.createDelay(1);
  echo.delayTime.value = 0.06;
  const echoGain = ctx.createGain();
  echoGain.gain.value = 0.35;
  let node: AudioNode = own;
  if (opts.smallSpeaker) {
    for (let k = 0; k < 2; k++) {
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 380;
      node.connect(hp);
      node = hp;
    }
  }
  node.connect(delay);
  delay.connect(g);
  delay.connect(echo).connect(echoGain).connect(g);
  g.connect(micAn);
  own.start(quiet + talk);

  const model = new HeatModel();
  model.sensitivity = opts.sensitivity ?? 0.5;
  const canceller = new EchoCanceller();
  canceller.diagnose = !!opts.trace;
  const time = new Float32Array(micAn.fftSize);
  const freq = new Float32Array(micAn.frequencyBinCount);
  const refFreq = new Float32Array(refAn.frequencyBinCount);
  const step = 1 / 30;
  const from = quiet + talk + (opts.shout ? seconds / 2 : 0);
  let selfHeat = 0;
  let before = 0;
  let selfDrive = 0;
  let active = 0;
  let frames = 0;
  let removed = 0;
  let low = 0;
  let speech = 0;
  let high = 0;
  const binHz = SR / 2 / freq.length;
  for (let t = step; t < total - step; t += step) {
    void ctx.suspend(t).then(() => {
      micAn.getFloatTimeDomainData(time);
      micAn.getFloatFrequencyData(freq);
      refAn.getFloatFrequencyData(refFreq);
      const playing = t > quiet + talk;
      if (opts.cancel) canceller.process(freq, SR, playing ? refFreq : null, SR, step);
      const f = extractFeatures(time, freq, SR, opts.cancel ? canceller.binGain : undefined);
      model.update(f, step);
      if (opts.trace && Math.abs((t % 1) - 0.5) < step / 2) {
        opts.trace.push(
          `t ${t.toFixed(0).padStart(3)} lvl ${f.levelDb.toFixed(0)} above ${model.aboveDb.toFixed(0)} ratio ${f.speechRatio.toFixed(2)} tilt ${f.tiltDb.toFixed(0)} removed ${canceller.echoShare.toFixed(2)} follows ${canceller.follows.toFixed(2)} lag ${canceller.lag} jumps ${canceller.jumps}\n      mic ${canceller.micFollows}\n      drive ${model.drive.toFixed(2)} heat ${model.heat.toFixed(2)}`,
        );
      }
      if (t < quiet + talk) before = model.heat;
      if (t > from + 0.3) {
        selfHeat = Math.max(selfHeat, model.heat);
        selfDrive = Math.max(selfDrive, model.drive);
        frames++;
        removed += canceller.echoShare;
        if (f.speechRatio > 0.32 && model.aboveDb > 9) active++;
        for (let i = 1; i < freq.length; i++) {
          const hz = i * binHz;
          const p = Math.pow(10, freq[i] / 10);
          if (hz < 250) low += p;
          else if (hz >= 300 && hz <= 3400) speech += p;
          else if (hz > 3400) high += p;
        }
      }
      void ctx.resume();
    });
  }
  await ctx.startRendering();
  const tot = low + speech + high || 1;
  return {
    rmsDb: 20 * Math.log10(rms + 1e-9),
    peak,
    low: low / tot,
    speech: speech / tot,
    high: high / tot,
    selfHeat,
    selfDrive,
    activeShare: frames ? active / frames : 0,
    removed: frames ? removed / frames : 0,
    lag: canceller.lag,
    before,
    trace: opts.trace,
  } as ProbeResult;
}
