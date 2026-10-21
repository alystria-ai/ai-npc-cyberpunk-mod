// Lip sync delay for audio that is heard later than Windows mixes it: a
// Bluetooth headset adds its link delay after the output mix, which no audio
// API reports. Settings > Voices "Lip sync delay (Bluetooth)" (runtime/settings.json
// audioDelay: 'auto' | 0 | 50 ... 250) holds the face and subtitle clock back by
// that many milliseconds for every voice. Auto: BLUETOOTH_DELAY_MS while the
// default output device is Bluetooth (bridge/audio-output-probe.ps1), else 0.
// The game's own dialogue has the same Bluetooth delay and does not correct it.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {asciiTempEnvironment} from './ascii-temp.mjs';

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
// per frame. A probe that was working and exits is restarted at most once per interval.
//
// PowerShell may be unusable on a player's PC (blocked or missing, disabled by the device owner, a group policy that refuses the
// script, constrained language mode). A run that ends without ever printing a device line (spawn error, non-zero exit, policy text,
// nothing within `firstOutputMs`) means the probe cannot work here: the watch gives up for the rest of this process, writes one log
// line, and the delay stays 0 (no compensation) unless it is set by hand. It is never retried and nothing reaches the player.
export class AudioOutputWatch {
  constructor({spawnFn = spawn, platform = process.platform, tempEnvironment = asciiTempEnvironment, intervalSeconds = 60, onChange = () => {},
    setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, firstOutputMs = 30000,
    log = message => console.error(`[CyberpunkConvai] ${message}`)} = {}) {
    Object.assign(this, {spawnFn, platform, tempEnvironment, intervalSeconds, onChange, setTimeoutFn, clearTimeoutFn, firstOutputMs, log});
    this.output = null; this.stopped = false; this.buffer = ''; this.unavailable = false; this.heard = false; this.watchdog = null;
  }

  // Add-Type (the probe compiles a small helper) cannot write under a TEMP that is not ASCII (bridge/ascii-temp.mjs): then, and only then, the
  // child gets an ASCII TEMP and TMP. An ASCII temporary folder adds no option at all.
  #tempOptions() {
    let temp; try { temp = this.tempEnvironment(); } catch { temp = {}; }
    return temp && Object.keys(temp).length ? {env: {...process.env, ...temp}} : {};
  }

  start() {
    if (this.platform !== 'win32' || this.stopped || this.unavailable || this.child || this.timer) return;
    let child;
    this.heard = false; this.buffer = '';
    try {
      child = this.spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', PROBE, '-Interval', String(this.intervalSeconds), '-ParentId', String(process.pid)], {windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], ...this.#tempOptions()});
    } catch (error) { this.giveUp(error?.code ?? 'spawn failed'); return; }
    this.child = child;
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', chunk => { if (this.child === child) this.read(chunk); });
    child.on?.('error', error => { if (this.child === child) this.giveUp(error?.code ?? 'spawn failed'); });
    child.on?.('exit', code => {
      if (this.child !== child) return;
      this.child = null; this.clearWatchdog();
      if (this.heard) this.retry(); else this.giveUp(`exit ${code ?? 'without a code'} before any output`);
    });
    // A probe that stays silent (a blocked compiler, a prompt) is ended; a cold start first compiles a small helper.
    this.watchdog = this.setTimeoutFn(() => {
      this.watchdog = null;
      if (this.child === child && !this.heard) this.giveUp('no output in time');
    }, this.firstOutputMs);
    this.watchdog?.unref?.();
  }

  clearWatchdog() { if (this.watchdog) this.clearTimeoutFn(this.watchdog); this.watchdog = null; }

  // The probe cannot work here: one log line for the process, then silence. The delay is 0 from then on.
  giveUp(reason) {
    if (this.unavailable) return;
    this.unavailable = true;
    this.suspend();
    this.log(`Lip sync delay: the audio output probe cannot run on this PC (${String(reason).slice(0, 80)}), so Auto assumes 0 ms.`);
    if (this.output?.bluetooth) { this.output = {available: false, bluetooth: false, name: ''}; this.onChange(this.output); }
  }

  retry() {
    if (this.stopped || this.unavailable || this.timer) return;
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
      this.heard = true; this.clearWatchdog();
      const output = value.available === true
        ? {available: true, bluetooth: value.bluetooth === true, name: String(value.name || '').slice(0, 200)}
        : {available: false, bluetooth: false, name: ''};
      const changed = !this.output || this.output.bluetooth !== output.bluetooth || this.output.name !== output.name;
      this.output = output;
      if (changed) this.onChange(output);
    }
  }

  // Ends the probe process but lets start() run it again (the delay is set by hand, or nothing is spoken). stop() is for good.
  suspend() {
    this.clearTimeoutFn(this.timer); this.timer = null; this.clearWatchdog();
    const child = this.child; this.child = null;
    try { child?.stdin?.end(); } catch {}
    try { child?.kill(); } catch {}
  }
  get running() { return !!this.child || !!this.timer; }

  stop() {
    this.stopped = true;
    this.suspend();
  }
}
