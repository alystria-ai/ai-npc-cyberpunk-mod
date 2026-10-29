// The bridge's side of the media channel (docs/BOND_QUESTS.md 19.2 and 19.3): it owns one extra page of the hidden browser (served at /media, bridge/media-pcm-client.mjs), hands it
// the decoded sounds of story packs as packets, and tells it to play, stop, fade and duck them (bridge/media-engine.mjs does the playing).
//
// WHY A PAGE OF ITS OWN. The speech renderer (bridge/local-pcm-host.mjs) is one page per speaking turn with a game lease that expires after two seconds. A music bed that plays for
// minutes beside it would either have to share that page and that lease, or add work in front of the voice. A second page has its own AudioContext, no lease and no
// connection to the speech path, so the voice's latency and priority cannot change: the only thing the speech path does for the media channel is one cheap call at the first
// audible packet and one at the end (LocalPcmHost onSpeech), which this class turns into a ducking command off the speech path (setImmediate, nothing awaited).
//
// Nothing here runs on a timer. The page is opened when the first sound is wanted, a sound ends by the page's own `ended` event (posted through a binding the page factory sets up),
// and the idle release is the bridge's existing 500 ms settings poll calling releaseIfIdle (the page and its AudioContext are closed after `idleMs` with nothing playing).
//
// `createPage({onEvent})` -> a page with window.mediaPcm (bridge/realtime-host.mjs builds it). Tests give a fake page that runs the real engine on a fake audio context.
export const MEDIA_HOST = Object.freeze({rate: 48000, packetFrames: 96000, maxItems: 8, commandMs: 8000, loadMs: 20000});

const bounded = (task, ms, message) => {
  let timer;
  return Promise.race([Promise.resolve(task), new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), ms); timer.unref?.(); })]).finally(() => clearTimeout(timer));
};
const clamp = (value, low, high) => Math.min(high, Math.max(low, Number.isFinite(value) ? value : low));
// A 'copy' sound sits where the game says (the same -1 to 1 the speech lease carries), everything else is centred (bridge/media-mix.mjs panFor, which the page loads and the bridge does not).
export const panOf = (at, pan) => at === 'copy' && Number.isFinite(pan) ? clamp(pan, -1, 1) : 0;

/** Mono float samples as the little endian 16 bit base64 text the page decodes (media-engine.mjs base64ToFloat). */
export function packetToBase64(samples) {
  const bytes = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) bytes.writeInt16LE(Math.round(clamp(samples[i], -1, 1) * 32767), i * 2);
  return bytes.toString('base64');
}

export class MediaHost {
  constructor({createPage, now = Date.now, log = () => {}} = {}) {
    if (typeof createPage !== 'function') throw Error('A media host needs a page factory');
    Object.assign(this, {createPage, now, log});
    this.page = null; this.creating = null; this.closed = false; this.counter = 0;
    this.loaded = new Map();      // sound key -> frames, as the page keeps it
    this.loading = new Map();     // sound key -> the promise of its load
    this.items = new Map();       // 'pack/id' -> {pack, id, pageId, key, loop, duck, endsAt}
    this.byPage = new Map();      // the page's id of a sound -> 'pack/id'
    this.speakers = 0; this.holds = new Set(); this.duckSent = false;
    this.lastActivity = now();
  }

  // ---- the speech path's two calls: as cheap as can be ----
  /** A voice became audible (true) or ended (false). Counts, and only when a sound plays does it schedule the ducking command, off the caller's turn. */
  speech(on) {
    this.speakers = Math.max(0, this.speakers + (on ? 1 : -1));
    if (this.page && this.items.size) setImmediate(() => this.syncDuck());
  }

  get busy() { this.prune(); return this.items.size > 0 || this.loading.size > 0; }
  /** The packs that have sounds playing. */
  packs() { this.prune(); return [...new Set([...this.items.values()].map(item => item.pack))]; }
  isLoaded(key) { return this.loaded.has(key); }
  count() { return this.items.size; }

  // A one-shot whose end event never came (a page that lost its binding) is forgotten a little after its own length.
  prune() {
    const now = this.now();
    for (const [name, item] of this.items) if (item.endsAt !== null && now > item.endsAt + 3000) this.drop(name, item);
  }
  drop(name, item) { if (this.items.get(name) === item) this.items.delete(name); if (this.byPage.get(item.pageId) === name) this.byPage.delete(item.pageId); }

  wantDuck() { return this.speakers > 0 || this.holds.size > 0; }
  async syncDuck() {
    if (!this.page || this.closed) return;
    const want = this.wantDuck();
    if (this.duckSent === want) return;
    this.duckSent = want;
    try { await this.call('duck', {on: want}); } catch { this.duckSent = !want; }
  }

  // ---- the page ----
  async ensurePage() {
    if (this.closed) throw Error('The media host is closed');
    if (this.page) return this.page;
    this.creating ??= (async () => {
      const page = await bounded(this.createPage({onEvent: event => this.onEvent(event)}), MEDIA_HOST.loadMs, 'The media page did not open');
      if (this.closed) { await page.close?.({runBeforeUnload: false}).catch?.(() => {}); throw Error('The media host is closed'); }
      this.page = page; this.loaded.clear(); this.duckSent = false;
      page.on?.('close', () => { if (this.page === page) this.forget(); });
      return page;
    })().finally(() => { this.creating = null; });
    return this.creating;
  }
  forget() { this.page = null; this.loaded.clear(); this.loading.clear(); this.items.clear(); this.byPage.clear(); this.duckSent = false; }

  onEvent(event) {
    if (event?.type !== 'ended' || typeof event.id !== 'string') return;
    const name = this.byPage.get(event.id);
    if (name === undefined) return;
    this.byPage.delete(event.id);
    const item = this.items.get(name);
    if (item?.pageId === event.id) this.items.delete(name);
  }

  async call(method, argument) {
    const page = this.page;
    if (!page) throw Error('The media page is not open');
    this.lastActivity = this.now();
    return bounded(page.evaluate(({method, argument}) => window.mediaPcm.run(method, argument), {method, argument}), MEDIA_HOST.commandMs, 'The media page did not answer');
  }

  // ---- sounds ----
  /** Hands a decoded sound to the page once (packets of two seconds). A sound already there is not sent again. */
  async load({key, samples, rate = MEDIA_HOST.rate}) {
    await this.ensurePage();
    if (this.loaded.has(key)) return this.loaded.get(key);
    const running = this.loading.get(key);
    if (running) return running;
    const task = (async () => {
      await this.call('begin', {key, rate, frames: samples.length});
      for (let at = 0; at < samples.length; at += MEDIA_HOST.packetFrames) {
        await this.call('append', {key, offsetFrames: at, pcm: packetToBase64(samples.subarray(at, Math.min(samples.length, at + MEDIA_HOST.packetFrames)))});
      }
      const sealed = await this.call('seal', {key});
      for (const evicted of sealed?.evicted ?? []) this.loaded.delete(evicted);
      this.loaded.set(key, samples.length);
      return samples.length;
    })().finally(() => { this.loading.delete(key); });
    this.loading.set(key, task);
    return task;
  }

  /**
   * Plays a sound that is already loaded or loads it first (`samples` is only read when it is not). `wanted()` is asked once the sound is on the page: a stop that came while it
   * was being decoded or sent makes it return false and nothing sounds. Resolves {played: true} or {played: false}.
   */
  async play({pack, id, key, samples, rate, loop = false, volume = 1, fadeIn = 0, fadeOut = 0, duck = false, at = 'bed', pan = 0, wanted = () => true}) {
    const name = `${pack}/${id}`;
    if (!this.items.has(name) && this.items.size >= MEDIA_HOST.maxItems) throw Error('Too many sounds are playing');
    if (!this.loaded.has(key)) { if (!samples) throw Error('The sound is not loaded'); await this.load({key, samples, rate}); }
    await this.ensurePage();
    if (!wanted()) return {played: false};
    const old = this.items.get(name);
    if (old) { this.drop(name, old); void this.call('stop', {id: old.pageId, fadeOut: 0.1}).catch(() => {}); }
    const pageId = `m${++this.counter}`;
    const result = await this.call('play', {id: pageId, key, loop: loop === true, volume, fadeIn, fadeOut, pan: panOf(at, pan), duck: duck === true});
    const seconds = Number.isFinite(result?.duration) ? result.duration : null;
    const item = {pack, id, pageId, key, loop: loop === true, duck: duck === true, endsAt: seconds === null ? null : this.now() + seconds * 1000};
    this.items.set(name, item); this.byPage.set(pageId, name);
    await this.syncDuck();
    return {played: true, pageId};
  }

  /** Stops one sound of a pack, or all of them when `id` is absent (and lets go of the pack's duck hold). Returns how many were told to stop. */
  async stop({pack, id, fadeOut = 0.3}) {
    let stopped = 0;
    if (id === undefined) { this.holds.delete(pack); }
    for (const [name, item] of [...this.items]) {
      if (item.pack !== pack || (id !== undefined && item.id !== id)) continue;
      this.drop(name, item); stopped++;
      if (this.page) await this.call('stop', {id: item.pageId, fadeOut}).catch(error => this.log(`stop failed: ${error.message}`));
    }
    void this.syncDuck();
    return stopped;
  }

  async fade({pack, id, volume, pan, seconds}) {
    const item = this.items.get(`${pack}/${id}`);
    if (!item || !this.page) return false;
    return Boolean(await this.call('fade', {id: item.pageId, ...(volume !== undefined ? {volume} : {}), ...(pan !== undefined ? {pan} : {}), seconds}).catch(() => false));
  }

  /** A pack asks for the music to be lowered (a voice the bridge does not play). Held until it asks again with on false, or its sounds are stopped. */
  duckHold({pack, on}) {
    if (on) this.holds.add(pack); else this.holds.delete(pack);
    return this.syncDuck();
  }

  // ---- the page's life ----
  /** Closes the page when nothing has played for `idleMs` (the bridge's 500 ms due-check calls it). True when it was closed. */
  async releaseIfIdle({idleMs = 30000, now = this.now()} = {}) {
    if (!this.page || this.closed || this.busy || this.creating || now - this.lastActivity < idleMs) return false;
    await this.closePage();
    return true;
  }

  async closePage() {
    const page = this.page;
    this.forget();
    if (page) { try { await bounded(Promise.resolve().then(() => page.close({runBeforeUnload: false})), 2500, 'The media page did not close'); } catch (error) { this.log(error.message); } }
  }

  async close() {
    this.closed = true;
    await this.creating?.catch(() => {});
    await this.closePage();
  }
}
