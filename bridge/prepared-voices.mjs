// Prepared voices on disk ("Keep prepared voices"): how much space the saved voice setups use, and clearing them.
//
// Pocket saves each companion's prepared voice state as <voice>-<24 hex>.safetensors in <Pocket work directory>/prepared-voices
// (bridge/pocket_voice_runtime.py, PreparedVoiceStore); a write in progress is the same name plus ".tmp". The files are a pure
// function of the voice reference and the model, so deleting them only means each voice is prepared again (about a second) the
// next time it speaks. Nothing else is ever touched here: not the voice references, not the models, not a file that does not
// have exactly that name, not a folder, not a link.
//
// The settings page asks over the usual command file (runtime/prepared-voices-command.json, as with the keys and memory) and
// reads runtime/prepared-voices-state.json. The measurement is one directory listing, made only when the page asks (it opens the
// Settings page or confirms a clear), never on a timer.
import {lstat, readdir, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {atomicFile} from './guarded-file.mjs';

export const PREPARED_VOICES_FOLDER = 'prepared-voices';
// The exact name the worker writes: <voice key>-<first 24 hex of the identity>.safetensors, or that plus .tmp while it is written.
export const PREPARED_VOICE_FILE = /^[A-Za-z0-9._-]+-[0-9a-f]{24}\.safetensors(?:\.tmp)?$/;
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;

export const preparedVoicesFolder = pocketConfig => {
  const work = pocketConfig?.runtime?.workDirectory;
  return typeof work === 'string' && work ? join(work, PREPARED_VOICES_FOLDER) : null;
};

/** The prepared voice files of a folder (regular files with the worker's exact name), with their sizes. A missing folder holds none. */
export async function listPreparedVoices(folder) {
  let entries;
  try { entries = await readdir(folder, {withFileTypes: true}); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !PREPARED_VOICE_FILE.test(entry.name)) continue;
    const path = join(folder, entry.name);
    try { const stat = await lstat(path); if (stat.isFile()) files.push({name: entry.name, path, bytes: stat.size}); } catch { /* gone since the listing */ }
  }
  return files;
}

export const measurePreparedVoices = async folder => {
  const files = await listPreparedVoices(folder);
  return {files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0)};
};

/** Deletes the prepared voice files and nothing else; reports what was removed. A file that cannot be deleted is left and not counted. */
export async function clearPreparedVoices(folder) {
  let files = 0, bytes = 0;
  for (const file of await listPreparedVoices(folder)) {
    try { await rm(file.path, {force: false}); files++; bytes += file.bytes; } catch { /* in use or already gone: it is prepared again anyway */ }
  }
  return {files, bytes};
}

export function parsePreparedVoicesCommand(raw, now = Date.now()) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 4096) return null;
  let value; try { value = JSON.parse(raw); } catch { return null; }
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || !COMMAND_ID.test(value.id ?? '')
      || !['measure', 'clear'].includes(value.action) || !Number.isSafeInteger(value.issuedAt) || value.issuedAt < 0
      || value.issuedAt > now + 5000) return null;
  return {id: value.id, action: value.action};
}

/** File IPC for the Settings rows "Prepared voices on disk" and "Clear prepared voices". */
export class PreparedVoicesControl {
  /** folder: a function returning the prepared-voices folder (null when the voice setup names none). */
  constructor({folder, commandPath, statePath, now = Date.now, read = path => readFile(path, 'utf8'), write = atomicFile} = {}) {
    if (typeof folder !== 'function' || typeof commandPath !== 'string' || typeof statePath !== 'string') throw Error('Invalid prepared voices configuration');
    Object.assign(this, {folder, commandPath, statePath, now, read, write});
    this.observed = ''; this.busy = false; this.last = {state: 'unavailable'};
  }
  /** Ignores a command left from an earlier session. No measurement: the first one is made when the page asks. */
  async open() { this.observed = await this.read(this.commandPath).catch(() => ''); return this; }
  publish(value) { return this.write(this.statePath, JSON.stringify({version: 1, updated: this.now(), ...value})).catch(() => false); }
  async poll() {
    if (this.busy) return;
    const raw = await this.read(this.commandPath).catch(() => '');
    if (raw === this.observed) return;
    this.observed = raw;
    const command = parsePreparedVoicesCommand(raw, this.now());
    if (!command) return;
    this.busy = true;
    try {
      const folder = this.folder();
      if (!folder) { this.last = {state: 'unavailable', result: {id: command.id, state: 'failed'}}; return; }
      await this.publish({...this.last, state: 'working', result: {id: command.id, state: 'working'}});
      let result;
      if (command.action === 'clear') {
        const removed = await clearPreparedVoices(folder);
        result = {id: command.id, state: 'cleared', files: removed.files, bytes: removed.bytes};
      } else result = {id: command.id, state: 'measured'};
      const left = await measurePreparedVoices(folder);
      this.last = {state: 'ready', ...left, result};
    } catch { this.last = {...this.last, state: this.last.state === 'ready' ? 'ready' : 'unavailable', result: {id: command.id, state: 'failed'}}; }
    finally { this.busy = false; await this.publish(this.last); }
  }
}
