import type { Phase } from '../sim/volcanoState';

const LABELS: Record<Phase, string> = {
  dormant: 'Calm',
  stirring: 'Simmering',
  rising: 'Heated',
  critical: 'Critical',
  erupting: 'Eruption',
  cooling: 'Cooling off',
};

export interface Settings {
  sensitivity: number; // 0..1
  lowPower: boolean;
}

const STORE_KEY = 'volcanometer.settings.v1';

export function loadSettings(): Settings {
  const s: Settings = { sensitivity: 0.5, lowPower: false };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const o = JSON.parse(raw) as Partial<Settings>;
      if (typeof o.sensitivity === 'number' && o.sensitivity >= 0 && o.sensitivity <= 1) s.sensitivity = o.sensitivity;
      if (typeof o.lowPower === 'boolean') s.lowPower = o.lowPower;
    }
  } catch {
    /* private mode or corrupt value: defaults are fine */
  }
  return s;
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing element #${id}`);
  return e as T;
}

export type MicState = 'off' | 'on' | 'demo' | 'error';

export interface HudHandlers {
  onStart(): void;
  onDemo(): void;
  onMicToggle(): void;
  onRecalibrate(): void;
  onSensitivity(v: number): void;
  onLowPower(on: boolean): void;
  onManual(v: number): void;
}

/** DOM overlay: start screen, status gauge, settings drawer. */
export class Hud {
  private intro = el('intro');
  private introError = el('introError');
  private startBtn = el<HTMLButtonElement>('startBtn');
  private status = el('status');
  private phaseLabel = el('phaseLabel');
  private gauge = el('gauge');
  private gaugeFill = el('gaugeFill');
  private micPill = el('micPill');
  private micText = el('micText');
  private drawer = el('drawer');
  private settingsBtn = el<HTMLButtonElement>('settingsBtn');
  private manualField = el('manualField');
  private manual = el<HTMLInputElement>('manual');
  private manualOut = el('manualOut');
  private roomHint = el('roomHint');
  private levelFill = el('levelFill');
  private micToggle = el<HTMLButtonElement>('micToggle');
  private lastPhase: Phase | null = null;
  private lastGauge = -1;
  private idleTimer = 0;
  private started = false;

  constructor(settings: Settings, h: HudHandlers) {
    const sens = el<HTMLInputElement>('sensitivity');
    const sensOut = el('sensitivityOut');
    sens.value = String(Math.round(settings.sensitivity * 100));
    sensOut.textContent = sens.value;
    sens.addEventListener('input', () => {
      sensOut.textContent = sens.value;
      settings.sensitivity = Number(sens.value) / 100;
      saveSettings(settings);
      h.onSensitivity(settings.sensitivity);
    });

    const low = el<HTMLInputElement>('lowPower');
    low.checked = settings.lowPower;
    low.addEventListener('change', () => {
      settings.lowPower = low.checked;
      saveSettings(settings);
      h.onLowPower(low.checked);
    });

    this.manual.addEventListener('input', () => {
      this.manualOut.textContent = this.manual.value;
      h.onManual(Number(this.manual.value) / 100);
    });

    this.startBtn.addEventListener('click', () => h.onStart());
    el('demoBtn').addEventListener('click', () => h.onDemo());
    this.micToggle.addEventListener('click', () => h.onMicToggle());
    el('recalibrate').addEventListener('click', () => {
      h.onRecalibrate();
      this.roomHint.textContent = 'Relearning. Stay quiet for a few seconds.';
    });

    this.settingsBtn.addEventListener('click', () => this.toggleDrawer());
    el('closeDrawer').addEventListener('click', () => this.toggleDrawer(false));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.toggleDrawer(false);
    });
    document.addEventListener('pointerdown', (e) => {
      if (this.drawer.hidden) return;
      const t = e.target as Node;
      if (!this.drawer.contains(t) && !this.settingsBtn.contains(t)) this.toggleDrawer(false);
    });

    const fs = el<HTMLButtonElement>('fullscreen');
    if (!document.documentElement.requestFullscreen) fs.hidden = true;
    fs.addEventListener('click', () => {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen().catch(() => undefined);
    });
    document.addEventListener('fullscreenchange', () => {
      fs.textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
    });

    // hide the chrome when nobody is interacting
    const wake = (): void => {
      document.body.classList.remove('idle');
      window.clearTimeout(this.idleTimer);
      this.idleTimer = window.setTimeout(() => {
        if (this.started && this.drawer.hidden) document.body.classList.add('idle');
      }, 4500);
    };
    for (const ev of ['pointermove', 'pointerdown', 'keydown', 'touchstart']) {
      window.addEventListener(ev, wake, { passive: true });
    }
  }

  private toggleDrawer(open?: boolean): void {
    const show = open ?? this.drawer.hidden;
    this.drawer.hidden = !show;
    this.settingsBtn.setAttribute('aria-expanded', String(show));
    if (show) document.body.classList.remove('idle');
  }

  setBusy(busy: boolean): void {
    this.startBtn.disabled = busy;
    this.startBtn.textContent = busy ? 'Waiting for the microphone' : 'Start listening';
  }

  showIntroError(msg: string): void {
    this.introError.textContent = msg;
    this.introError.hidden = false;
  }

  /** Leave the start screen. */
  enter(): void {
    this.started = true;
    this.intro.classList.add('gone');
    this.status.hidden = false;
    this.introError.hidden = true;
    window.dispatchEvent(new Event('pointermove'));
  }

  setMic(state: MicState, text: string): void {
    this.micPill.dataset.state = state;
    this.micText.textContent = text;
    this.micPill.title = text;
    this.micToggle.textContent = state === 'on' ? 'Stop listening' : 'Start listening';
    this.manualField.hidden = state === 'on';
    if (state !== 'on') this.roomHint.textContent = 'Start listening to measure the room.';
  }

  setManual(v: number): void {
    this.manual.value = String(Math.round(v * 100));
    this.manualOut.textContent = this.manual.value;
  }

  /** Called a few times a second. */
  update(phase: Phase, heat: number, aboveDb: number | null): void {
    if (phase !== this.lastPhase) {
      this.lastPhase = phase;
      this.phaseLabel.textContent = LABELS[phase];
      this.status.dataset.phase = phase;
    }
    const g = Math.round(heat * 100);
    if (g !== this.lastGauge) {
      this.lastGauge = g;
      this.gaugeFill.style.transform = `scaleX(${heat.toFixed(3)})`;
      this.gauge.setAttribute('aria-valuenow', String(g));
    }
    if (!this.drawer.hidden && aboveDb !== null) {
      const v = Math.min(1, Math.max(0, aboveDb / 50));
      this.levelFill.style.transform = `scaleX(${v.toFixed(3)})`;
      this.roomHint.textContent =
        aboveDb < 6 ? 'Quiet. The volcano is resting.' : `${Math.round(aboveDb)} dB above the quiet room.`;
    }
  }
}
