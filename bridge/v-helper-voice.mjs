// The Pocket voice that speaks V's typed line while the companions use OmniVoice (docs/V_VOICE.md, "OmniVoice companions").
//
// OmniVoice has one GPU worker that does one job at a time and cannot cancel a render that has started. With V's engine on Pocket (the
// default), V's line rendered there would take longer than the companion's own text reply, so it would never be audible in time
// (dropped), and it would keep the GPU busy in front of the companion's own render. Pocket runs on the CPU (no VRAM), starts audio in
// about 0.2 s, and V's two voices are Pocket-tuned, so V speaks on a Pocket worker of its own while OmniVoice is the committed voice.
// (Since 2026-10-21 the player can instead choose OmniVoice for V: bridge/v-voice.mjs engine 'omni', waited for, no worker of this
// kind then: VVoice.wantsPocket is false and this class is never started for it.)
//   - It exists only while OmniVoice is the committed voice, the V setting is on and the clips exist. A cloud voice, the Pocket voice
//     itself (V then uses the chosen worker), the Convai cloud voice and a muted voice playback never load it.
//   - It loads in the background, after the OmniVoice worker is ready (never beside its load), in the Pocket worker's usual below
//     normal priority. A V line that finds it still loading is skipped; the reply never waits for it.
//   - It never waits for or blocks the companion: it is a separate process on the CPU. It holds the Pocket work folder's lock, so it
//     is released (and its exit confirmed) before any other Pocket worker starts, and it never starts while one is stopping.
//   - A failure leaves it off (V stays silent, one log line each, never falls back to OmniVoice) and it is loaded again after 45 s, then
//     3 min, then 10 min, with no reply in flight, like the companions' Pocket voice; after the fourth failure it stays off until the
//     setting or the voice changes. Windows blocking a file of the voice is not retried (restarting changes nothing). Before 0.2.4 a single
//     failure (two reports: a PCM chunk over the packet limit, a cancelled line the starved worker could not stop) ended V's voice for the
//     whole session.
export const V_HELPER_RETRY_DELAYS_MS = Object.freeze([45_000, 180_000, 600_000]);
export const V_HELPER_HEALTHY_MS = 600_000;

export class VHelperVoice {
  /**
   * create   onState => client   a PocketVoice-like worker client (start, close, loaded, failure, hasProfile, prepareProfile, synthesizeStream)
   * wait     () => Promise       settles when no other Pocket worker is still stopping
   * onReady  () => void          the worker finished loading (once per load): V's voice is prepared now, not inside the first line
   */
  constructor({create, wait = () => Promise.resolve(), log = () => {}, onReady = () => {}, onFailure = () => {},
    clock = Date.now, retryDelays = V_HELPER_RETRY_DELAYS_MS, noRetry = () => false, busy = () => false} = {}) {
    Object.assign(this, {create, wait, log, onReady, onFailure, clock, retryDelays, noRetry, busy});
    this.retry = null;     // {failures, nextAt} while a failed helper is waiting for its next load
    this.client = null;
    this.generation = 0;
    this.failed = false;
    this.failure = null;   // why it failed (a few words), while it has: the setup check and the error report name it
    this.exit = Promise.resolve();
  }

  get loaded() { return !!this.client && this.client.loaded === true && !this.client.failure && !this.client.closing; }
  /** A worker exists (loading or loaded). */
  get running() { return !!this.client; }

  /** Starts loading in the background; does nothing while one exists or after a failure. Never throws. */
  start() {
    if (this.client) return;
    if (this.failed) {
      // Due-checked where routing already looks at the helper (the 500 ms poll, each V line): no timer. Waits for a moment with no reply in
      // flight, so the load never competes with a reply's own work.
      if (!this.retry || this.clock() < this.retry.nextAt || this.busy()) return;
      this.log(`loading again (retry ${this.retry.failures})`);
      this.failed = false; this.failure = null;
    }
    const generation = ++this.generation;
    let client;
    try {
      client = this.client = this.create(value => {
        if (this.client === client && value?.state === 'error') queueMicrotask(() => this.broke(client, client?.failure?.message));
      });
    } catch (error) { this.client = null; this.failed = true; this.failure = String(error?.message ?? error).slice(0, 200); this.log(`V's helper voice could not be created (${String(error?.message ?? error).slice(0, 120)})`); return; }
    const exited = this.exit;
    Promise.resolve().then(() => Promise.all([exited, this.wait()])).then(() => {
      if (this.client !== client || this.generation !== generation) throw Object.assign(Error('V helper voice was released'), {released: true});
      return client.start();
    }).then(() => {
      if (this.client !== client) return;
      this.readyAt = this.clock();
      this.log('V\'s helper voice is ready (Pocket on the CPU, beside OmniVoice)');
      try { this.onReady(); } catch { /* a warm-up never affects the worker */ }
    }, error => { if (!error?.released) this.broke(client, error?.message); });
  }

  broke(client, message) {
    if (this.client !== client) return;
    this.failed = true;
    this.failure = String(message ?? 'unknown').slice(0, 200);
    // A helper that ran well for ten minutes before it broke is a new fault, not another try at the same one: the count starts over.
    if (this.retry && this.readyAt && this.clock() - this.readyAt >= V_HELPER_HEALTHY_MS) this.retry = null;
    this.readyAt = null;
    const failures = (this.retry?.failures ?? 0) + 1, delay = this.retryDelays[failures - 1];
    let next = '';
    if (this.noRetry(this.failure)) { this.retry = null; next = 'Windows blocked a file of the voice, so it is not tried again until the voice or the setting changes'; }
    else if (delay === undefined) { this.retry = null; next = `giving up after ${failures} failed attempts; typed lines stay silent until the voice or the setting changes`; }
    else { this.retry = {failures, nextAt: this.clock() + delay}; next = `trying again in ${Math.round(delay / 1000)} s`; }
    this.log(`V's helper voice failed (${this.failure}); ${next}`);
    try { this.onFailure(this.failure); } catch { /* a report never affects the voice */ }
    void this.release({keepFailure: true});
  }

  /** Stops the worker; resolves when its exit is confirmed. Clears a failure (and the retries used), so the next start tries again. */
  release({keepFailure = false} = {}) {
    if (!keepFailure) { this.failed = false; this.failure = null; this.retry = null; }
    const client = this.client;
    if (!client) return this.exit;
    this.client = null;
    this.generation++;
    const closing = Promise.resolve().then(() => client.close()).catch(() => {});
    this.exit = Promise.all([this.exit, closing]).then(() => {});
    return this.exit;
  }

  /** Can the loaded worker speak this V voice? */
  ready(key) { return this.loaded && this.client.hasProfile(key) === true; }

  /** Prepares V's voice (a saved setup makes it nearly free). Resolves quietly when there is no loaded worker. */
  async prepare(key, {signal} = {}) {
    if (!this.ready(key)) return {ready: false};
    return this.client.prepareProfile(key, {signal});
  }

  /** Streams V's line as Pocket packets. A worker that is not loaded is an error: V is skipped, nothing waits for a load. */
  stream(key, text, options = {}) {
    if (!this.ready(key)) return Promise.reject(Error('V\'s helper voice is not loaded'));
    return this.client.synthesizeStream(key, text, options);
  }
}
