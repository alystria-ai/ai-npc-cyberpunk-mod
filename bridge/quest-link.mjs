// The bridge's end of the quest files (docs/QUEST_PRIMITIVES.md section 4): what the game saw comes in through runtime/quest-events.json, the stage the game should
// execute goes out through runtime/quest-play.json. The quest itself (stages, gap, choices, timers, endings) is the pack runner (bridge/bond-pack-runner.mjs).
//   poll()    read the events file text, hand every event not seen before to the runner (a session id and a sequence number keep a rewrite from being counted twice)
//   sync()    write the play file when the runner's play revision moved (a compare of two numbers when it did not)
//   active()  whether a quest or an ending's closing rows is waiting on the game, so the 500 ms poll (bridge/quest-poller.mjs) runs only then
// Nothing here runs by itself and nothing is read when no quest is active.
const MAX_FILE = 64 * 1024;
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);

export class QuestLink {
  constructor({packs, readEvents, writePlay, now = Date.now, log = () => {}} = {}) {
    Object.assign(this, {packs, readEvents, writePlay, now, log});
    this.seen = new Map();          // session id -> the highest event seq handled
    this.written = -1;              // the play revision last written
    this.chain = Promise.resolve();
  }

  active() { try { return this.packs.questActive() === true; } catch { return false; } }

  /** Handles the events file. Returns how many events were new. Never throws. */
  async poll() {
    let text = '';
    try { text = await this.readEvents(); } catch { return 0; }
    if (typeof text !== 'string' || text === '' || text.length > MAX_FILE) return 0;
    let value;
    try { value = JSON.parse(text); } catch { return 0; }   // the game writes in place: a half-written read is read again on the next poll
    if (!plain(value) || value.version !== 1 || typeof value.session !== 'string' || value.session.length > 40 || !Array.isArray(value.events)) return 0;
    const top = this.seen.get(value.session) ?? -1;
    let fresh = 0, newest = top;
    const events = value.events.filter(event => plain(event) && Number.isSafeInteger(event.seq) && event.seq > top && typeof event.name === 'string' && typeof event.pack === 'string')
      .sort((a, b) => a.seq - b.seq).slice(0, 32);
    for (const event of events) {
      newest = Math.max(newest, event.seq);
      try {
        this.packs.noteEvent({pack: event.pack, serial: event.serial, name: event.name, at: Number.isSafeInteger(event.at) && event.at >= 0 ? event.at : undefined});
        fresh++;
      } catch (error) { this.log(`event ${String(event.name).slice(0, 40)} failed: ${String(error?.message ?? error).slice(0, 100)}`); }
    }
    if (newest > top) {
      if (this.seen.size > 8 && !this.seen.has(value.session)) this.seen.delete(this.seen.keys().next().value);
      this.seen.set(value.session, newest);
    }
    return fresh;
  }

  /** Writes the play file if its revision moved since the last write. Returns whether it wrote. Never throws. */
  sync() {
    let revision;
    try { revision = this.packs.playRevision(); } catch { return Promise.resolve(false); }
    if (revision === this.written) return this.chain.then(() => false);
    this.written = revision;
    let body;
    try { body = JSON.stringify(this.packs.playState()); } catch (error) { this.log(`play state failed: ${String(error?.message ?? error).slice(0, 100)}`); return Promise.resolve(false); }
    this.chain = this.chain.then(() => this.writePlay(body)).then(() => true, error => { this.written = -1; this.log(`play file not written: ${String(error?.message ?? error).slice(0, 100)}`); return false; });
    return this.chain;
  }
}
