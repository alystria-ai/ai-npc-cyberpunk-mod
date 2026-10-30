// The game's requests for a story pack's music and sound effects, read and carried out (docs/BOND_QUESTS.md 19.2 and 19.3). The game rewrites runtime/media-command.json in place
// (the shape is in bridge/media-request.mjs); this class notices a new write, parses it strictly, resolves every file inside the running pack, decodes it
// (bridge/prepared-audio.mjs) and gives it to the media host (bridge/media-host.mjs).
//
// WHY A FILE OF ITS OWN AND NOT THE REQUEST FILE. The game's request file holds one request at a time and a running talk turn belongs to the exact bytes of the request that started
// it (bridge/request-ownership.mjs): a media request written over it would cancel the reply that is being heard, and a request read by the main loop aborts the active turn. Music
// has to start and stop while people talk, so it has its own small file, read here.
//
// NO TIMER. maybePoll() is called from the bridge's existing 50 ms loop and does nothing unless a quest is running or a sound is playing (`wanted`), and then at most every 200 ms,
// with one stat of the file: it is read only when its identity changed. Nothing is read when no story pack is running.
import {readPreparedFile} from './prepared-voice.mjs';
import {parseMediaCommandFile, packIsLive, resolveMediaFile} from './media-request.mjs';

export const MEDIA_LINK = Object.freeze({intervalMs: 200, musicSeconds: 300, sfxSeconds: 30, rate: 48000});

/**
 * path: runtime/media-command.json.  bondPacks: the BondPacks (packs, entries, closing, packFolder, exists).  audio: createPreparedAudio's decoder.
 * host(): Promise<MediaHost> (starts the hidden browser when needed).  peek(): the MediaHost if the browser has one, else null (a stop never starts anything).
 * wanted(): is anything worth looking at (a quest runs, a sound plays).  fs: {stat, readFile}.
 */
export class MediaLink {
  constructor({path, bondPacks, audio, host, peek, wanted = () => true, fs, now = Date.now, log = () => {}, readFile = readPreparedFile} = {}) {
    Object.assign(this, {path, bondPacks, audio, host, peek, wanted, now, log, readFile});
    this.fs = fs;
    this.identity = null; this.session = null; this.seq = -1; this.last = 0; this.polling = false; this.chain = Promise.resolve();
    this.epochs = new Map(); this.logged = new Set();
  }

  /** Notes the file as it is at start without carrying it out (a file left by an earlier run must not replay). */
  async open() {
    const info = await this.fs.stat(this.path).catch(() => null);
    this.identity = info ? `${info.mtimeMs}:${info.size}` : null;
    return this;
  }

  /** Called from the loop: cheap gates first, one poll at a time, never awaited, never throws. */
  maybePoll() {
    if (this.polling) return false;
    const at = this.now();
    if (at - this.last < MEDIA_LINK.intervalMs) return false;
    let wanted = false;
    try { wanted = this.wanted() === true; } catch { wanted = false; }
    if (!wanted) return false;
    this.last = at; this.polling = true;
    this.poll().catch(error => this.log(`poll failed: ${error?.message ?? error}`)).finally(() => { this.polling = false; });
    return true;
  }

  async poll() {
    const info = await this.fs.stat(this.path).catch(() => null);
    if (!info) return 0;
    const identity = `${info.mtimeMs}:${info.size}`;
    if (identity === this.identity) return 0;
    const raw = await this.fs.readFile(this.path, 'utf8').catch(() => null);
    if (raw === null) return 0;
    const file = parseMediaCommandFile(raw);
    // A write in progress does not parse: its identity is not remembered, so the finished file is read on the next look.
    if (!file) return 0;
    this.identity = identity;
    if (file.session === this.session && file.seq <= this.seq) return 0;
    this.session = file.session; this.seq = file.seq;
    if (file.rejected) this.once(`file-${file.session}-${file.seq}`, `${file.rejected} command(s) of request ${file.seq} were not valid and were left out`);
    for (const command of file.commands) this.handle(command);
    return file.commands.length;
  }

  once(key, message) {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    if (this.logged.size > 256) this.logged.delete(this.logged.values().next().value);
    this.log(message);
  }
  fail(command, message) { this.once(`${command.pack}/${command.file ?? command.id ?? ''}|${command.op}`, `ERROR pack=${command.pack} ${command.op} ${command.file ?? command.id ?? ''}: ${message}`); }

  // Stops, fades and ducks act at once (a stop must not wait behind a slow decode); plays and loads are carried out one after the other, in the order they arrived.
  epoch(pack, id) { return `${this.epochs.get(pack) ?? 0}.${id === undefined ? 0 : this.epochs.get(`${pack}/${id}`) ?? 0}`; }
  bump(pack, id) { const key = id === undefined ? pack : `${pack}/${id}`; this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1); }

  handle(command) {
    if (command.op === 'play' || command.op === 'load') {
      const ticket = this.epoch(command.pack, command.id);
      const wanted = () => this.epoch(command.pack, command.id) === ticket;
      this.chain = this.chain.then(() => this.carryOut(command, wanted)).catch(error => this.fail(command, error?.message ?? 'failed'));
      return;
    }
    if (command.op === 'stop') this.bump(command.pack, command.id);
    void this.quick(command).catch(error => this.fail(command, error?.message ?? 'failed'));
  }

  async quick(command) {
    const host = this.peek();
    if (!host) return;
    if (command.op === 'stop') await host.stop(command);
    else if (command.op === 'fade') await host.fade(command);
    else if (command.op === 'duck') await host.duckHold(command);
  }

  async carryOut(command, wanted) {
    const found = resolveMediaFile(this.bondPacks, command.pack, command.file);
    if (!found) { this.fail(command, 'the pack is not running, does not name this file in a stage, or the file is not in its folder'); return; }
    const host = await this.host();
    if (!wanted()) return;
    const seconds = found.kind === 'music' ? MEDIA_LINK.musicSeconds : MEDIA_LINK.sfxSeconds;
    let samples;
    if (!host.isLoaded(found.key)) {
      try { samples = await this.audio.decode(await this.readFile(found.path), {rate: MEDIA_LINK.rate, maxSeconds: seconds}); }
      catch (error) { this.fail(command, `${error.message}, the sound is skipped`); return; }
      if (!wanted()) return;
    }
    if (command.op === 'load') { await host.load({key: found.key, samples, rate: MEDIA_LINK.rate}); return; }
    await host.play({pack: command.pack, id: command.id, key: found.key, samples, rate: MEDIA_LINK.rate, loop: command.loop, volume: command.volume, fadeIn: command.fadeIn,
      fadeOut: command.fadeOut, duck: command.duck, at: command.at, pan: command.pan, wanted});
  }

  /** Stops the sounds of a pack that is no longer running (the quest ended, the setting went off). Called from the bridge's 500 ms due-check; never throws. */
  async reconcile() {
    const host = this.peek();
    if (!host) return 0;
    let stopped = 0;
    for (const pack of host.packs()) {
      if (packIsLive(this.bondPacks, pack)) continue;
      this.bump(pack);
      stopped += await host.stop({pack, fadeOut: 2}).catch(() => 0);
    }
    return stopped;
  }
}
