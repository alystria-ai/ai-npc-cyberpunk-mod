// Settings > Voices > Microphone (docs/VOICE_INPUT.md, "Choosing the microphone"): the list of audio inputs the settings page offers, and the player's choice.
//
// The choice is an ordinary saved setting (`micDevice` in runtime/settings.json, the label of the input, '' for the Windows default); the file is kept on this PC outside the
// game folder like every other setting. This module answers one question: which inputs are there. The only code that can tell is the hidden browser's capture page
// (bridge/local-stt-capture.mjs): Chromium's labels are the names the choice is matched against when the device is opened.
//
//   runtime/microphone-devices-command.json   the settings page asks: {version: 1, id, action: 'list', issuedAt}
//   runtime/microphone-devices.json           the answer: {version: 1, updated, id, state: 'idle' | 'listing' | 'ok' | 'failed', inputs: [label], loopback: [label], current: label | null}
// `loopback` is the part of `inputs` whose name looks like a loopback or virtual device (bridge/mic-match.mjs): the settings row marks them. Never used to pick or refuse an input.
//
// The page asks when the settings open (never per frame, at most once in a few seconds). Nothing here runs on the way to a recording: the poll is one read of a small file
// that is unchanged almost always, and the listing happens only for a command.
import {readFile} from 'node:fs/promises';
import {looksLikeLoopback} from './mic-match.mjs';

export const MIC_DEVICES_COMMAND = 'microphone-devices-command.json';
export const MIC_DEVICES_STATE = 'microphone-devices.json';
// A label the settings can hold: the game stores it as a string of at most this many bytes (mod/manager.lua).
export const MAX_LABEL_BYTES = 240;
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const LIST_TIMEOUT_MS = 8000;

/** A device label as the settings may hold it: a string without control characters of at most MAX_LABEL_BYTES bytes, else ''. */
export function cleanDeviceLabel(value) {
  if (typeof value !== 'string') return '';
  const label = value.trim();
  if (!label || /[\u0000-\u001f\u007f]/.test(label) || Buffer.byteLength(label, 'utf8') > MAX_LABEL_BYTES) return '';
  return label;
}

/** The player's choice from the parsed runtime/settings.json: the label of the input, or '' for the Windows default. */
export function settingMicDevice(settings) { return cleanDeviceLabel(settings?.micDevice); }

export function parseListCommand(raw, now = Date.now()) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 4096) return null;
  let value; try { value = JSON.parse(raw); } catch { return null; }
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || !COMMAND_ID.test(value.id ?? '')
      || value.action !== 'list' || !Number.isSafeInteger(value.issuedAt) || value.issuedAt < 0 || value.issuedAt > now + 5000) return null;
  return {id: value.id};
}

/**
 * The choice and the list.
 *   capture   a LocalSttCapture (listDevices(), lastInput)
 *   publish   async (document) -> writes runtime/microphone-devices.json
 *   releaseIdle  optional () => void, called a while after a listing so the capture page opened for it is let go when nothing records
 */
export class MicDevicesControl {
  constructor({capture, commandPath, publish, read = file => readFile(file, 'utf8'), now = Date.now, log = () => {}, releaseIdle = null, releaseAfterMs = 20_000,
      setTimer = setTimeout, clearTimer = clearTimeout, timeoutMs = LIST_TIMEOUT_MS} = {}) {
    if (!capture || typeof capture.listDevices !== 'function' || typeof commandPath !== 'string' || typeof publish !== 'function') throw Error('Invalid microphone devices configuration');
    Object.assign(this, {capture, commandPath, publish, read, now, log, releaseIdle, releaseAfterMs, setTimer, clearTimer, timeoutMs});
    this.observed = ''; this.busy = false; this.latestId = null; this.inputs = []; this.current = null; this.state = 'idle'; this.id = null;
    this.timer = null; this.writing = Promise.resolve();
  }
  /** Ignore a command left from an earlier session, then publish the first (empty) state. */
  async open() {
    this.observed = await this.read(this.commandPath).catch(() => '');
    await this.publishState();
    return this;
  }
  document() {
    return {version: 1, updated: this.now(), id: this.id, state: this.state, inputs: this.inputs, loopback: this.inputs.filter(looksLikeLoopback), current: this.current};
  }
  publishState() {
    this.writing = this.writing.catch(() => {}).then(() => this.publish(this.document()));
    return this.writing;
  }
  async poll() {
    const raw = await this.read(this.commandPath).catch(() => '');
    if (raw === this.observed) return;
    this.observed = raw;
    const command = parseListCommand(raw, this.now());
    if (!command) return;
    this.latestId = command.id;
    if (this.busy) return;   // the running listing answers the newest id when it ends
    this.busy = true;
    try { await this.#list(); } finally { this.busy = false; }
  }
  async #list() {
    this.id = this.latestId; this.state = 'listing';
    await this.publishState().catch(() => {});
    let outcome;
    try {
      let timer;
      const timeout = new Promise((_, no) => { timer = this.setTimer(() => no(Error('listing timed out')), this.timeoutMs); });
      try { outcome = await Promise.race([this.capture.listDevices(), timeout]); } finally { this.clearTimer(timer); }
    } catch (error) {
      this.state = 'failed'; this.id = this.latestId;
      this.log(`Listing the inputs failed: ${String(error?.message ?? error).slice(0, 120)}`);
      await this.publishState().catch(() => {});
      this.#later();
      return;
    }
    const seen = new Set(), inputs = [];
    for (const label of Array.isArray(outcome?.inputs) ? outcome.inputs : []) {
      const clean = cleanDeviceLabel(label);
      if (clean && !seen.has(clean)) { seen.add(clean); inputs.push(clean); }
    }
    this.inputs = inputs.slice(0, 32);
    this.current = cleanDeviceLabel(outcome?.current) || null;
    this.state = 'ok'; this.id = this.latestId;
    this.log(`${this.inputs.length} audio input${this.inputs.length === 1 ? '' : 's'} listed`);
    await this.publishState().catch(() => {});
    this.#later();
  }
  // The capture page opened for a listing is let go a while after the last one when nothing records (the hidden browser itself follows its own idle release).
  #later() {
    if (typeof this.releaseIdle !== 'function') return;
    this.clearTimer(this.timer);
    this.timer = this.setTimer(() => { this.timer = null; try { this.releaseIdle(); } catch { /* never breaks */ } }, this.releaseAfterMs);
    this.timer?.unref?.();
  }
  close() { this.clearTimer(this.timer); this.timer = null; }
  /**
   * What the setup check and the support report say about the microphone (labels only, never an id): null before any input has been opened or chosen.
   *   chosen   the player's choice ('' for the Windows default)   device  the input the latest recording opened   missing  the chosen input was not found
   *   loopback the input in use (the latest open, else the chosen one) looks like a loopback or virtual input that may carry the PC's sound
   */
  summary(chosen) {
    const last = this.capture.lastInput;
    const wanted = cleanDeviceLabel(chosen);
    if (!last && !wanted) return null;
    const device = cleanDeviceLabel(last?.device) || null;
    return {chosen: wanted || null, device, missing: !!(wanted && last?.missing && last.requested === wanted), loopback: looksLikeLoopback(device ?? wanted)};
  }
}
