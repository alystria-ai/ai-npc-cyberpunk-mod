// Lip sync delay for audio that is heard later than Windows mixes it: a
// Bluetooth headset adds its link delay after the output mix, which no audio
// API reports. Settings > Voices "Lip sync delay (Bluetooth)" (runtime/settings.json
// audioDelay: 'auto' | 0 | 50 ... 250) holds the face and subtitle clock back by
// that many milliseconds for every voice. Auto: BLUETOOTH_DELAY_MS while the
// default output device is Bluetooth (bridge/audio-output-probe.ps1), else 0.
// The game's own dialogue has the same Bluetooth delay and does not correct it.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const AUDIO_DELAY_CHOICES = Object.freeze(['auto', 0, 50, 100, 150, 200, 250]);
// Typical SBC/AAC earbuds measure roughly 150-250 ms; aptX Low Latency and LE
// Audio are lower. 150 is the conservative middle: too little leaves the mouth
// slightly early (as vanilla does), too much would put it behind the voice.
export const BLUETOOTH_DELAY_MS = 150;
export const MAX_DELAY_MS = 500;

const PROBE = fileURLToPath(new URL('./audio-output-probe.ps1', import.meta.url));

export function settingDelay(settings) {
  const value = settings?.audioDelay;
  return AUDIO_DELAY_CHOICES.includes(value) ? value : 'auto';
}

export function resolveDelayMs(setting, output) {
  if (setting === 'auto') return output?.bluetooth === true ? BLUETOOTH_DELAY_MS : 0;
  return Number.isInteger(setting) ? Math.max(0, Math.min(MAX_DELAY_MS, setting)) : 0;
}

// Process-wide value read by every renderer (convai-continuous-speech.mjs).
let current = 0;
export const audioDelayMs = () => current;
export function setAudioDelayMs(value) {
  const next = Number.isFinite(value) ? Math.max(0, Math.min(MAX_DELAY_MS, Math.round(value))) : 0;
  const changed = next !== current; current = next; return changed;
}

// One hidden, below-normal PowerShell process that prints the default output
// device as one JSON line at start and every `intervalSeconds`; nothing runs
// per frame. A probe that exits is restarted at most once per interval.
export class AudioOutputWatch {
  constructor({spawnFn = spawn, platform = process.platform, intervalSeconds = 60, onChange = () => {},
    setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout} = {}) {
    Object.assign(this, {spawnFn, platform, intervalSeconds, onChange, setTimeoutFn, clearTimeoutFn});
    this.output = null; this.stopped = false; this.buffer = '';
  }

  start() {
    if (this.platform !== 'win32' || this.stopped || this.child || this.timer) return;
    let child;
    try {
      child = this.spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', PROBE, '-Interval', String(this.intervalSeconds), '-ParentId', String(process.pid)], {windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']});
    } catch { this.retry(); return; }
    this.child = child;
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', chunk => this.read(chunk));
    child.on?.('error', () => {});
    child.on?.('exit', () => { if (this.child === child) { this.child = null; this.retry(); } });
  }

  retry() {
    if (this.stopped || this.timer) return;
    this.timer = this.setTimeoutFn(() => { this.timer = null; this.start(); }, this.intervalSeconds * 1000);
    this.timer?.unref?.();
  }

  read(chunk) {
    this.buffer = (this.buffer + chunk).slice(-8192);
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim(); this.buffer = this.buffer.slice(newline + 1);
      let value; try { value = JSON.parse(line); } catch { continue; }
      if (!value || typeof value !== 'object') continue;
      const output = value.available === true
        ? {available: true, bluetooth: value.bluetooth === true, name: String(value.name || '').slice(0, 200)}
        : {available: false, bluetooth: false, name: ''};
      const changed = !this.output || this.output.bluetooth !== output.bluetooth || this.output.name !== output.name;
      this.output = output;
      if (changed) this.onChange(output);
    }
  }

  stop() {
    this.stopped = true; this.clearTimeoutFn(this.timer); this.timer = null;
    const child = this.child; this.child = null;
    try { child?.stdin?.end(); } catch {}
    try { child?.kill(); } catch {}
  }
}
