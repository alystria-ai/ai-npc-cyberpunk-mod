import {readFile} from 'node:fs/promises';
import {ChatMemoryResets} from './chat-memory-resets.mjs';
import {isDiskFull} from './runtime-files.mjs';

const PROFILE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const COMMAND = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function parseMemoryCommand(raw, now = Date.now()) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 8192) return null;
  let value; try { value = JSON.parse(raw); } catch { return null; }
  if (!plain(value) || value.version !== 1 || !COMMAND.test(value.id ?? '')
      || value.action !== 'clear' || !['character', 'all'].includes(value.scope)
      || !Number.isSafeInteger(value.issuedAt) || value.issuedAt < 0
      || value.issuedAt > now + 5000
      || (value.scope === 'character' && !PROFILE.test(value.profileKey ?? ''))
      || (value.scope === 'all' && value.profileKey !== undefined)) return null;
  return {version: 1, id: value.id, action: 'clear', scope: value.scope,
    ...(value.scope === 'character' ? {profileKey: value.profileKey} : {}), issuedAt: value.issuedAt};
}

const commandIdentity = value => ({id: value.id, scope: value.scope,
  ...(value.profileKey ? {profileKey: value.profileKey} : {})});
const sameCommand = (a, b) => a?.id === b?.id && a?.scope === b?.scope
  && (a?.scope === 'all' ? a?.profileKey == null && b?.profileKey == null : a?.profileKey === b?.profileKey);

/** File IPC for deliberate MCM forget actions. Opening and heartbeats never
 * repeat a provider deletion. Only a newly observed confirmed command dispatches.
 * The durable memory owner decides idempotency and uncertainty recovery. */
export class PlayerMemoryControl {
  static async open(options) {
    const control = new PlayerMemoryControl(options);
    if (options.chatResetPath) control.chatResets = await ChatMemoryResets.open({path: options.chatResetPath,
      status: control.memory.status(), profileFamilies:options.chatResetFamilies, now: control.now,
      resetEpochFor:typeof control.memory.phoneResetEpochs==='function' ? profile=>control.memory.phoneResetEpochs(profile) : undefined});
    control.observed = await control.read(control.commandPath).catch(() => '');
    const previous = control.normalizeCommand(parseMemoryCommand(control.observed, control.now()));
    if (previous) {
      const saved = control.memory.status({actionId: previous.id}).command;
      control.selected = sameCommand(saved, previous) ? {...saved}
        : {...commandIdentity(previous), state: 'failed',
          message: 'This request was not run. Open the menu and confirm again.'};
    }
    // The first status write is best effort: on a full disk it fails (ENOSPC) and a throw here ended the bridge before it had started (error report
    // e1a42aa8799b2b8f, 0.3.3, 0.8 GiB free on C:). The 500 ms poll writes the status again once there is room.
    await control.publishStatus().catch(error => { if (!isDiskFull(error)) throw error; });
    return control;
  }
  constructor({memory, commandPath, publish, now = Date.now, chatResets, chatResetFamilies = {},
    read = path => readFile(path, 'utf8')} = {}) {
    if (typeof memory?.status !== 'function' || typeof memory?.clearCharacter !== 'function'
        || typeof memory?.clearAll !== 'function' || typeof commandPath !== 'string'
        || typeof publish !== 'function' || typeof now !== 'function' || typeof read !== 'function') {
      throw Error('Invalid player memory control configuration');
    }
    Object.assign(this, {memory, commandPath, publish, now, read, chatResets});
    if (!plain(chatResetFamilies) || Object.entries(chatResetFamilies).some(([key,value])=>!PROFILE.test(key)||!PROFILE.test(value))) {
      throw Error('Invalid memory control families');
    }
    this.profileFamilies = new Map(Object.entries(chatResetFamilies));
    this.controller = new AbortController(); this.selected = null;
    this.polling = false; this.closed = false; this.work = null; this.writing = Promise.resolve();
  }
  normalizeCommand(command) {
    return command?.scope === 'character' && this.profileFamilies.has(command.profileKey)
      ? {...command, profileKey:this.profileFamilies.get(command.profileKey)} : command;
  }
  publishStatus() {
    this.writing = this.writing.catch(() => {}).then(async () => {
      const status = this.memory.status({actionId: this.selected?.id});
      let command = sameCommand(status.command, this.selected) ? status.command : this.selected;
      if (command?.scope === 'all') { command={...command}; delete command.profileKey; }
      // Receipts contain only canonical character/action keys. The transcript
      // remains Lua-owned; queued old replies are cancelled by memory guards.
      let chatHistory = this.chatResets ? 'ready' : undefined;
      try { await this.chatResets?.sync(status); } catch { chatHistory = 'unavailable'; }
      return this.publish({version: 1, updated: this.now(),
        state: !this.closed && status.available === true ? 'ready' : 'unavailable',
        talkedToCount: status.talkedToCount,
        characters: status.characters,
        ...(chatHistory ? {chatHistory} : {}),
        ...(command ? {command} : {})});
    });
    return this.writing;
  }
  async poll() {
    if (this.polling || this.closed) return;
    this.polling = true;
    try {
      const raw = await this.read(this.commandPath).catch(() => '');
      if (raw !== this.observed) {
        this.observed = raw;
        const command = this.normalizeCommand(parseMemoryCommand(raw, this.now()));
        if (command) {
          const saved = this.memory.status({actionId: command.id}).command;
          if (sameCommand(saved, command)) this.selected = {...saved};
          else if (saved?.id === command.id) {
            this.selected = {...commandIdentity(command), state: 'failed', message: 'Invalid memory request.'};
          } else if (this.work) {
            this.selected = {...commandIdentity(command), state: 'failed',
              message: 'A memory clear is already in progress. Please wait.'};
          } else if (this.now() - command.issuedAt > 120000) {
            this.selected = {...commandIdentity(command), state: 'failed',
              message: 'This request expired. Open the menu and confirm again.'};
          } else {
            this.selected = {...commandIdentity(command), state: 'pending', message: 'Clearing memories…'};
            const options = {actionId: command.id, signal: this.controller.signal,
              ...(command.profileKey ? {profileKey: command.profileKey} : {})};
            this.work = Promise.resolve().then(async () => {
              // A failed local intent write prevents cloud dispatch. Once a
              // clear was accepted, reconciliation can retry only its LOCAL
              // cleanup receipt; it never repeats the provider deletion.
              await this.chatResets?.start(command);
              if (this.closed || this.controller.signal.aborted) throw Error('Memory control is closed');
              return command.scope === 'all' ? this.memory.clearAll(options) : this.memory.clearCharacter(options);
            }).then(result => {
              if (sameCommand(this.selected, command)) this.selected = {...commandIdentity(command), ...result};
            }).catch(() => {
              if (sameCommand(this.selected, command)) this.selected = {...commandIdentity(command), state: 'failed',
                message: 'Memories could not be cleared. Confirm again to retry.'};
            }).finally(async () => {
              try { await this.chatResets?.sync(this.memory.status(), {finished: command}); } catch {}
              this.work = null; void this.publishStatus().catch(() => {});
            });
          }
        }
      }
      await this.publishStatus();
    } finally { this.polling = false; }
  }
  async close() {
    if (this.closed) return;
    this.closed = true; this.controller.abort();
    await this.work?.catch(() => {});
    // The last status write is best effort: at the game's exit Windows can still refuse the rename for a moment (EPERM; two reports of 27 Oct 2026), and a throw here ended the
    // bridge's shutdown before the player's memory was closed (bridge/convai-bridge.mjs shutdown).
    await this.publishStatus().catch(() => {});
  }
}
