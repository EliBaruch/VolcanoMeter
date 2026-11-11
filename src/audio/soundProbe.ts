// Test-only helper, loaded on demand: renders the volcano's sound offline and
// answers two questions. Does each state sound the way it should (level,
// spectrum, no clipping)? And if the microphone heard the speakers with no echo
// cancellation at all, would the volcano heat itself up?

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
function calmVoice(seconds: number, amp: number): AudioBuffer {
  const n = Math.floor(seconds * SR);
  const buf = new AudioBuffer({ length: n, numberOfChannels: 1, sampleRate: SR });
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const syl = (t * 3.3) % 1;
    const env = syl < 0.38 ? 0 : Math.pow(Math.sin((Math.PI * (syl - 0.38)) / 0.62), 0.6);
    const f0 = 125 * (1 + 0.06 * Math.sin(t * 5.1));
    let s = 0;
    for (let k = 1; k < 26; k++) {
      const fk = f0 * k;
      const formant =
        1 + 2.2 * Math.exp(-(((fk - 700) / 350) ** 2)) + 1.6 * Math.exp(-(((fk - 1900) / 500) ** 2));
      s += (formant / Math.pow(k, 1.7)) * Math.sin(2 * Math.PI * fk * t + k);
    }
    d[i] = s * amp * env + (Math.random() - 0.5) * 0.0012;
  }
  return buf;
}

/**
 * @param micGain      how loudly the microphone hears the speakers (1 = as loud as they play)
 * @param smallSpeaker true to model a phone speaker that cannot reproduce bass
 */
export async function probeSound(
  state: SoundState,
  seconds = 12,
  events = true,
  micGain = 1.5,
  smallSpeaker = false,
): Promise<ProbeResult> {
  const out = await render(state, seconds, events);
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

  // ---- feedback test, through the same analyser and heat model the microphone uses ----
  const quiet = 6;
  const talk = 14;
  const total = quiet + talk + seconds;
  const ctx = new OfflineAudioContext(1, Math.floor(total * SR), SR);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.3;
  analyser.minDecibels = -110;
  analyser.maxDecibels = -10;
  analyser.connect(ctx.destination);

  const hiss = new AudioBuffer({ length: SR, numberOfChannels: 1, sampleRate: SR });
  const hd = hiss.getChannelData(0);
  for (let i = 0; i < SR; i++) hd[i] = (Math.random() - 0.5) * 0.0012;
  const room = ctx.createBufferSource();
  room.buffer = hiss;
  room.loop = true;
  room.connect(analyser);
  room.start();

  const voice = ctx.createBufferSource();
  voice.buffer = calmVoice(talk, 0.008);
  voice.connect(analyser);
  voice.start(quiet);

  // the speakers, heard by the microphone with no echo cancellation at all
  const own = ctx.createBufferSource();
  own.buffer = out;
  const g = ctx.createGain();
  g.gain.value = micGain;
  if (smallSpeaker) {
    const hp1 = ctx.createBiquadFilter();
    hp1.type = 'highpass';
    hp1.frequency.value = 380;
    const hp2 = ctx.createBiquadFilter();
    hp2.type = 'highpass';
    hp2.frequency.value = 380;
    own.connect(hp1).connect(hp2).connect(g).connect(analyser);
  } else {
    own.connect(g).connect(analyser);
  }
  own.start(quiet + talk);

  const model = new HeatModel();
  const time = new Float32Array(analyser.fftSize);
  const freq = new Float32Array(analyser.frequencyBinCount);
  const step = 1 / 30;
  let selfHeat = 0;
  let selfDrive = 0;
  let active = 0;
  let frames = 0;
  let low = 0;
  let speech = 0;
  let high = 0;
  const binHz = SR / 2 / freq.length;
  for (let t = step; t < total - step; t += step) {
    void ctx.suspend(t).then(() => {
      analyser.getFloatTimeDomainData(time);
      analyser.getFloatFrequencyData(freq);
      const f = extractFeatures(time, freq, SR);
      model.update(f, step);
      if (t > quiet + talk + 0.5) {
        selfHeat = Math.max(selfHeat, model.heat);
        selfDrive = Math.max(selfDrive, model.drive);
        frames++;
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
  };
}
