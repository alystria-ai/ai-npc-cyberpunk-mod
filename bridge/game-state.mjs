// The player's own state files in the CET mod folder's runtime/ (settings, phone chats, add-on settings, ...) and the durable copy
// the conversation service keeps of them outside the game folder, in <data>/game-state/ (docs/PACKAGING.md, "Mod Organizer 2: the
// player's state").
//
// Why: Mod Organizer 2 runs the game and every process it starts inside USVFS, which sends each NEW file created under the game folder
// to its Overwrite folder, and that file is gone at the next launch. The Lua side can only reach the mod folder, so a settings.json
// the Lua wrote (or one the service wrote there) did not survive a launch. The service's own folder (%LOCALAPPDATA%) is outside the
// virtual file system, so the copies there do.
//
//   restoreGameState   once, as the first thing the launcher does (start-service.mjs in app/launcher), before the game's Lua reads
//                      them: a state file that is missing or empty in runtime/ gets the durable copy written back in place; a real,
//                      non-empty file always wins and refreshes the copy. Then it publishes runtime/state-restore.json, which the Lua
//                      (mod/state-restore.lua) reads to know the restore is over.
//   GameStateSync      while the service runs: whenever the Lua saves one of these files, the bridge copies it (a stat of each file per
//                      poll, a copy only on a change, never anything per frame).
//
// Rules that keep a player's data safe:
//   * A restore only fills a missing or an empty file; it never overwrites a real, non-empty file, whatever the times say.
//   * An empty, missing or unreadable file never replaces a copy: only JSON that parses is copied.
//   * When a real file that is older than the copy takes its place (an old backup put back, a second install), the copy it replaces is
//     kept in game-state/older/ (one slot per file) instead of being thrown away.
//   * Copies are written to a temporary file and renamed, so a crash leaves the old copy or the new one.
// The copy carries the modification time of the file it came from; a file and its copy with the same size and time are in step and
// are not read.
import * as realFs from 'node:fs/promises';
import {dirname, join} from 'node:path';

// The `state` class of packaging/runtime-exchange.json (a test keeps the two lists equal) plus runtime/npc-names.json, which the Lua
// used to keep next to init.lua and now keeps beside the other state.
export const GAME_STATE_FILES = Object.freeze(['settings.json', 'settings.json.previous', 'phone-history.json', 'phone-history.json.previous',
  'memory-chat-resets.json', 'witness-receipts.json', 'decision-ledger.json', 'addon-settings.json', 'npc-names.json', 'immersive-invitations.json',
  'housemate-learned.json', 'housemates.json', 'favorites.json', 'eddies-ledger.json', 'ambush-state.json', 'saved-parties.json', 'outfit-rotation.json']);
export const GAME_STATE_FOLDER = 'game-state';
export const OLDER_FOLDER = 'older';
export const RESTORE_SIGNAL = 'state-restore.json';
const SAME_TIME_MS = 2;          // file times are compared to this many ms (a copy's time is set from the file's)
const NEWER_BY_MS = 2000;        // a copy this much newer than the real file is kept in older/ when the real file replaces it
const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

// The folder of the copies, for the data folder (the service's state directory).
export const gameStateFolder = stateDirectory => join(stateDirectory, GAME_STATE_FOLDER);

const statOrNull = async (fs, path) => { try { return await fs.stat(path); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; } };
const isFileWithBytes = info => !!info && info.isFile() && info.size > 0;
const sameTime = (a, b) => Math.abs(a.mtimeMs - b.mtimeMs) < SAME_TIME_MS;
const sleep = ms => new Promise(done => setTimeout(done, ms));

// A state file is JSON (an object); text that does not parse is never copied over a good copy and never restored.
export function usableState(bytes) {
  try {
    const value = JSON.parse(Buffer.from(bytes).toString('utf8').replace(/^﻿/, ''));
    return typeof value === 'object' && value !== null;
  } catch { return false; }
}

async function place(fs, path, bytes, mtime) {
  await fs.mkdir(dirname(path), {recursive: true});
  const temporary = `${path}.${process.pid}.tmp`;
  await fs.writeFile(temporary, bytes);
  try { await fs.rename(temporary, path); } catch (error) { await fs.rm(temporary, {force: true}).catch(() => {}); throw error; }
  if (mtime) await fs.utimes(path, mtime, mtime).catch(() => {});
}

// Writes into the file where it lies (an empty placeholder is modified, a missing file is created): the file the game's Lua sees
// is never swapped for another. A file the game holds open for a moment is tried again.
async function writeInPlace(fs, path, bytes, mtime) {
  await fs.mkdir(dirname(path), {recursive: true});
  for (let attempt = 0; ; attempt++) {
    try { await fs.writeFile(path, bytes); break; }
    catch (error) { if (attempt >= 3 || !RETRY_CODES.has(error.code)) throw error; await sleep(60); }
  }
  if (mtime) await fs.utimes(path, mtime, mtime).catch(() => {});
}

/**
 * Settles one state file against its copy. Returns 'restored', 'refreshed', 'kept' (refreshed, the replaced copy kept in older/),
 * or '' when nothing changed.
 */
async function settle(fs, name, runtime, durable, log) {
  const real = join(runtime, name), copy = join(durable, name);
  const [r, c] = await Promise.all([statOrNull(fs, real), statOrNull(fs, copy)]);
  const realHas = isFileWithBytes(r), copyHas = isFileWithBytes(c);
  if (realHas) {
    // The real file wins. Keep the copy current; nothing is read while the two are in step.
    if (copyHas && r.size === c.size && sameTime(r, c)) return '';
    const bytes = await fs.readFile(real);
    if (!usableState(bytes)) { log(`${name} is not readable JSON; the copy is left as it is.`); return ''; }
    let kept = false;
    if (copyHas) {
      const old = await fs.readFile(copy);
      if (old.equals(bytes)) { await fs.utimes(copy, r.mtime, r.mtime).catch(() => {}); return ''; }
      if (c.mtimeMs > r.mtimeMs + NEWER_BY_MS && usableState(old)) { await place(fs, join(durable, OLDER_FOLDER, name), old, c.mtime); kept = true; }
    }
    await place(fs, copy, bytes, r.mtime);
    return kept ? 'kept' : 'refreshed';
  }
  if (!copyHas) return '';
  const bytes = await fs.readFile(copy);
  if (!usableState(bytes)) { log(`The copy of ${name} is not readable JSON and was not restored.`); return ''; }
  await writeInPlace(fs, real, bytes, c.mtime);
  return 'restored';
}

/**
 * The start-up restore. Never throws: a problem with one file is logged and the others are still settled. Returns
 * {restored, refreshed, kept, errors} (file names, and the number of files that failed).
 */
export async function restoreGameState({runtime, durable, names = GAME_STATE_FILES, fs = realFs, log = () => {}} = {}) {
  const result = {restored: [], refreshed: [], kept: [], errors: 0};
  for (const name of names) {
    try {
      const outcome = await settle(fs, name, runtime, durable, log);
      if (outcome === 'restored') result.restored.push(name);
      else if (outcome === 'refreshed') result.refreshed.push(name);
      else if (outcome === 'kept') { result.refreshed.push(name); result.kept.push(name); }
    } catch (error) {
      result.errors++;
      log(`Could not settle ${name} (${error?.code || error?.message || error}).`);
    }
  }
  const parts = [result.restored.length && `${result.restored.length} restored (${result.restored.join(', ')})`,
    result.refreshed.length && `${result.refreshed.length} copied`, result.kept.length && `${result.kept.length} older copy kept`,
    result.errors && `${result.errors} failed`].filter(Boolean);
  if (parts.length) log(`Player state in runtime/: ${parts.join(', ')}.`);
  return result;
}

/**
 * Tells the game's Lua the restore is over (mod/state-restore.lua): runtime/state-restore.json, written in place after every
 * restore. `written` is the time, in ms; the Lua ignores a signal that is older than its own game session.
 */
export async function publishRestoreSignal({runtime, result, fs = realFs, now = () => Date.now(), log = () => {}} = {}) {
  const text = JSON.stringify({version: 1, state: 'done', written: now(), restored: result?.restored ?? [],
    refreshed: result?.refreshed ?? [], errors: result?.errors ?? 0});
  try { await writeInPlace(fs, join(runtime, RESTORE_SIGNAL), Buffer.from(text)); return true; }
  catch (error) { log(`Could not publish ${RESTORE_SIGNAL} (${error?.code || error?.message || error}).`); return false; }
}

/** Keeps the copies current while the service runs. */
export class GameStateSync {
  constructor({runtime, durable, names = GAME_STATE_FILES, fs = realFs, log = () => {}} = {}) {
    Object.assign(this, {runtime, durable, names, fs, log});
    this.seen = new Map();     // name -> 'size:mtimeMs' of the version already handled
    this.failed = new Set();   // names whose last failure was logged
    this.active = null;
    this.queued = false;
  }

  /** For watchFiles (bridge/file-wake.mjs): every state file's change runs a poll a few ms later. */
  watchHandlers() { return Object.fromEntries(this.names.map(name => [name, () => this.poll()])); }

  /** One pass over the files (a stat each). A call during a pass makes the pass run once more. */
  poll() {
    if (this.active) { this.queued = true; return this.active; }
    this.active = (async () => {
      do {
        this.queued = false;
        for (const name of this.names) {
          try { await this.check(name); this.failed.delete(name); }
          catch (error) {
            if (!this.failed.has(name)) { this.failed.add(name); this.log(`Could not copy ${name} (${error?.code || error?.message || error}); trying again.`); }
          }
        }
      } while (this.queued);
    })().finally(() => { this.active = null; });
    return this.active;
  }

  /** A last pass, awaited (the service is closing). */
  flush() { return this.poll(); }

  async check(name) {
    const {fs, runtime, durable} = this;
    const real = join(runtime, name), copy = join(durable, name);
    const info = await statOrNull(fs, real);
    if (!info || !info.isFile()) {
      // A backup that was taken away after a good save is no longer wanted in the copies; a main file that is gone is kept (never propagate a loss).
      if (name.endsWith('.previous') && this.seen.has(name)) { this.seen.delete(name); await fs.rm(copy, {force: true}); }
      return;
    }
    if (info.size === 0) return;
    const signature = `${info.size}:${info.mtimeMs}`;
    if (this.seen.get(name) === signature) return;
    if (!this.seen.has(name)) {
      // First look since the service started: settled like the launcher's pass (a copy in step with the file needs nothing and nothing
      // is read; an older file replacing a newer copy keeps that copy in older/). Only a real, non-empty file gets here, so this never
      // fills a file in: only the launcher's pass does, before the game runs (while it runs a file can be absent for a moment, because
      // the Lua's own save moves the old one aside before the new one is moved in, and a file put there would make that save fail).
      await settle(fs, name, runtime, durable, this.log);
      this.seen.set(name, signature);
      return;
    }
    const bytes = await fs.readFile(real);
    const after = await statOrNull(fs, real);
    if (!after || after.size !== info.size || after.mtimeMs !== info.mtimeMs) return;   // written while it was read: the next poll sees the finished file
    if (!usableState(bytes)) { this.seen.set(name, signature); return; }                 // cut short or not JSON: the copy stays
    await place(fs, copy, bytes, info.mtime);
    this.seen.set(name, signature);
  }
}
