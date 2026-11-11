import { extractFeatures, type AudioFeatures } from './heat';

/**
 * Always-on microphone. Audio never leaves this object: each frame is reduced
 * to three numbers and discarded. Nothing is recorded or sent anywhere.
 */
export class Mic {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private time: Float32Array<ArrayBuffer> = new Float32Array(0);
  private freq: Float32Array<ArrayBuffer> = new Float32Array(0);
  private restarting = false;
  private echo = false;
  onLost: (() => void) | null = null;
  /** called whenever the stream has been (re)opened */
  onOpen: (() => void) | null = null;

  get running(): boolean {
    return !!this.analyser && this.ctx?.state === 'running';
  }

  /**
   * While the app plays its own sound, the browser subtracts that sound from
   * the microphone signal so the volcano does not react to itself.
   */
  async setEchoCancellation(on: boolean): Promise<void> {
    if (on === this.echo) return;
    this.echo = on;
    if (this.stream) await this.recover();
  }

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser cannot open a microphone here. The page must be served over https.');
    }
    this.stop();
    // Gain and noise processing off on purpose: auto gain would flatten a shout to normal volume.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: this.echo,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
      video: false,
    });
    const Ctx: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    const src = this.ctx.createMediaStreamSource(this.stream);
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.3;
    analyser.minDecibels = -110;
    analyser.maxDecibels = -10;
    src.connect(analyser); // not connected to the speakers
    this.analyser = analyser;
    this.time = new Float32Array(analyser.fftSize);
    this.freq = new Float32Array(analyser.frequencyBinCount);
    if (this.ctx.state !== 'running') await this.ctx.resume();

    this.onOpen?.();
    const track = this.stream.getAudioTracks()[0];
    track?.addEventListener('ended', () => void this.recover());
  }

  /** Reopen the microphone: after a settings change, an unplug, or the OS taking it away. */
  private async recover(): Promise<void> {
    if (this.restarting) return;
    this.restarting = true;
    try {
      await this.start();
    } catch {
      this.stop();
      this.onLost?.();
    } finally {
      this.restarting = false;
    }
  }

  /** Call when the page becomes visible again; browsers suspend audio in the background. */
  async resume(): Promise<void> {
    if (this.ctx && this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch {
        /* resumed on the next user gesture */
      }
    }
  }

  read(): AudioFeatures | null {
    if (!this.analyser || !this.ctx || this.ctx.state !== 'running') return null;
    this.analyser.getFloatTimeDomainData(this.time);
    this.analyser.getFloatFrequencyData(this.freq);
    return extractFeatures(this.time, this.freq, this.ctx.sampleRate);
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.analyser = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}
