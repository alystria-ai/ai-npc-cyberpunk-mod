// Settings > Voices > Custom voices > Remote OmniVoice (docs/REMOTE_OMNIVOICE.md): the saved server address and the settings page's commands.
//
// The on/off switch is an ordinary setting (`remoteOmni` in runtime/settings.json). This module keeps the address:
//   - saved in the bridge's state folder as one small file, `player-remote-omnivoice.txt` (a line `address=192.168.1.20:8765`), also fine to write by hand; never in the game
//     folder. The address is the player's own network and is never put in a log, a report or the voice state file (the page shows it from runtime/remote-omni-state.json,
//     which only the game reads);
//   - entered from the clipboard by the settings page (Paste address; the game writes runtime/remote-omni-command.json, the bridge reads the clipboard), checked for its shape
//     (bridge/omni-remote.mjs parseServerAddress) and then saved; removed by Remove address;
//   - tested by the Test button: three small questions to the server, answered with whether it is reachable, how long an answer takes, its version and its card.
//     It is the only request this module makes and only when the player presses the button; it runs in the background, so the settings poll never waits for it.
import {readFile, rename, rm, writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {readClipboardText} from './convai-key.mjs';
import {parseServerAddress} from './omni-remote.mjs';
import {probeOmniServer} from './remote-voice.mjs';

export const REMOTE_FILE = 'player-remote-omnivoice.txt';
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
export const COMMANDS = Object.freeze(['paste-address', 'clear-address', 'test']);

async function writeText(path, text) {
  const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  try { await writeFile(temporary, text, 'utf8'); await rename(temporary, path); }
  catch (error) { await rm(temporary, {force: true}).catch(() => {}); throw error; }
}

/** The saved address: read at start and again for a Test, so a file edited by hand counts. */
export class RemoteOmniAddress {
  constructor({path, read = file => readFile(file, 'utf8'), write = writeText, remove = file => rm(file, {force: true}), log = () => {}} = {}) {
    if (typeof path !== 'string') throw Error('Invalid remote OmniVoice configuration');
    Object.assign(this, {path, read, write, remove, log});
    this.parsed = null; this.listeners = new Set();
  }
  async load() {
    let text = '';
    try { text = String(await this.read(this.path)).slice(0, 4096); } catch { text = ''; }
    const line = text.replace(/^﻿/, '').split(/\r?\n/).map(row => row.trim()).find(row => /^address\s*=/i.test(row));
    const parsed = line ? parseServerAddress(line.replace(/^address\s*=\s*/i, '')) : null;
    const next = parsed?.host ? parsed : null;
    if ((next?.origin ?? null) !== (this.parsed?.origin ?? null)) { this.parsed = next; this.#changed(); }
    return this;
  }
  /** {host, port, origin} or null. */
  get endpoint() { return this.parsed; }
  /** "192.168.1.20:8765" or null (what the page shows; a name is shown as typed). */
  get text() { return this.parsed ? `${this.parsed.host}:${this.parsed.port}` : null; }
  async set(parsed) {
    await this.write(this.path, `address=${parsed.host}:${parsed.port}\n`);
    this.parsed = {host: parsed.host, port: parsed.port, origin: parsed.origin};
    this.#changed();
  }
  async clear() { await this.remove(this.path); if (this.parsed) { this.parsed = null; this.#changed(); } }
  onChange(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  #changed() { for (const listener of this.listeners) { try { listener(); } catch { /* an observer never breaks the address */ } } }
}

export function parseRemoteCommand(raw, now = Date.now()) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 4096) return null;
  let value; try { value = JSON.parse(raw); } catch { return null; }
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || !COMMAND_ID.test(value.id ?? '')
      || !COMMANDS.includes(value.action) || !Number.isSafeInteger(value.issuedAt) || value.issuedAt < 0 || value.issuedAt > now + 5000) return null;
  return {id: value.id, action: value.action};
}

/** File IPC for the settings page: reads runtime/remote-omni-command.json, answers in runtime/remote-omni-state.json. */
export class RemoteOmniControl {
  constructor({address, commandPath, publish, readClipboard = readClipboardText, probe = probeOmniServer, read = file => readFile(file, 'utf8'), now = Date.now, log = () => {}} = {}) {
    if (!address || typeof commandPath !== 'string' || typeof publish !== 'function') throw Error('Invalid remote OmniVoice configuration');
    Object.assign(this, {address, commandPath, publish, readClipboard, probe, read, now, log});
    this.observed = ''; this.result = null; this.testResult = null; this.busy = false; this.testing = false; this.writing = Promise.resolve();
    address.onChange(() => { this.testResult = null; void this.publishStatus().catch(() => {}); });
  }
  /** Ignore a command left from an earlier session, then publish the first status. */
  async open() {
    this.observed = await this.read(this.commandPath).catch(() => '');
    await this.publishStatus();
    return this;
  }
  status() {
    return {version: 1, updated: this.now(), set: !!this.address.endpoint, address: this.address.text,
      ...(this.result ? {result: this.result} : {}), ...(this.testResult ? {test: this.testResult} : {})};
  }
  publishStatus() {
    this.writing = this.writing.catch(() => {}).then(() => this.publish(this.status()));
    return this.writing;
  }
  async poll() {
    if (this.busy) return;
    const raw = await this.read(this.commandPath).catch(() => '');
    if (raw === this.observed) return;
    this.observed = raw;
    const command = parseRemoteCommand(raw, this.now());
    if (!command) return;
    this.busy = true;
    try {
      if (command.action === 'test') { await this.#startTest(command); return; }
      this.result = {id: command.id, state: 'checking'};
      await this.publishStatus();
      this.result = {id: command.id, ...await this.#run(command)};
    } catch { this.result = {id: command.id, state: 'failed'}; }
    finally { this.busy = false; }
    await this.publishStatus();
  }
  /** One command that changes the saved address: {state: 'saved' | 'cleared' | 'invalid' | 'unreadable', reason?}. */
  async #run({action}) {
    this.testResult = null;
    if (action === 'clear-address') { await this.address.clear(); return {state: 'cleared'}; }
    let text;
    try { text = await this.readClipboard(); } catch { return {state: 'unreadable'}; }
    const parsed = parseServerAddress(String(text ?? '').split(/\r?\n/)[0]);
    if (!parsed.host) return {state: 'invalid', reason: parsed.reason};
    await this.address.set(parsed);
    return {state: 'saved'};
  }
  async #startTest(command) {
    // A press while a test runs sends no second request; the running test answers to the latest press.
    this.testId = command.id;
    this.testResult = {id: command.id, state: 'testing'};
    await this.publishStatus();
    if (this.testing) return;
    this.testing = true;
    void (async () => {
      let outcome;
      try {
        await this.address.load().catch(() => {});
        const endpoint = this.address.endpoint;
        outcome = endpoint ? await this.probe(endpoint) : {state: 'failed', code: 'no-address'};
      } catch { outcome = {state: 'failed', code: 'unreachable'}; }
      this.testResult = {id: this.testId, ...outcome};
      this.log(`Test: ${outcome.state}${outcome.code ? ` (${outcome.code})` : ''}${Number.isFinite(outcome.ms) ? `, ${outcome.ms} ms` : ''}`);
      this.testing = false;
      await this.publishStatus().catch(() => {});
    })();
  }
}
