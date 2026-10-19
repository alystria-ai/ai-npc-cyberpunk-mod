// The Pocket voice that speaks V's typed line while the companions use OmniVoice (docs/V_VOICE.md, "OmniVoice companions").
//
// OmniVoice has one GPU worker that does one job at a time and cannot cancel a render that has started. V's line rendered there takes
// longer than the companion's own text reply, so it was never audible in time (dropped), and it kept the GPU busy in front of the
// companion's own render. Pocket runs on the CPU (no VRAM), starts audio in about 0.2 s, and V's two voices are Pocket-tuned, so V
// speaks on a Pocket worker of its own while OmniVoice is the committed voice:
//   - It exists only while OmniVoice is the committed voice, the V setting is on and the clips exist. A cloud voice, the Pocket voice
//     itself (V then uses the chosen worker), the Convai cloud voice and a muted voice playback never load it.
//   - It loads in the background, after the OmniVoice worker is ready (never beside its load), in the Pocket worker's usual below
//     normal priority. A V line that finds it still loading is skipped; the reply never waits for it.
//   - It never waits for or blocks the companion: it is a separate process on the CPU. It holds the Pocket work folder's lock, so it
//     is released (and its exit confirmed) before any other Pocket worker starts, and it never starts while one is stopping.
//   - A failure leaves it off until the setting or the voice changes; V then stays silent (one log line), never falls back to OmniVoice.
export class VHelperVoice {
  /**
   * create   onState => client   a PocketVoice-like worker client (start, close, loaded, failure, hasProfile, prepareProfile, synthesizeStream)
   * wait     () => Promise       settles when no other Pocket worker is still stopping
   * onReady  () => void          the worker finished loading (once per load): V's voice is prepared now, not inside the first line
   */
  constructor({create, wait = () => Promise.resolve(), log = () => {}, onReady = () => {}} = {}) {
    Object.assign(this, {create, wait, log, onReady});
    this.client = null;
    this.generation = 0;
    this.failed = false;
    this.exit = Promise.resolve();
  }

  get loaded() { return !!this.client && this.client.loaded === true && !this.client.failure && !this.client.closing; }
  /** A worker exists (loading or loaded). */
  get running() { return !!this.client; }

  /** Starts loading in the background; does nothing while one exists or after a failure. Never throws. */
  start() {
    if (this.client || this.failed) return;
    const generation = ++this.generation;
    let client;
    try {
      client = this.client = this.create(value => {
        if (this.client === client && value?.state === 'error') queueMicrotask(() => this.broke(client, client?.failure?.message));
      });
    } catch (error) { this.client = null; this.failed = true; this.log(`V's helper voice could not be created (${String(error?.message ?? error).slice(0, 120)})`); return; }
    const exited = this.exit;
    Promise.resolve().then(() => Promise.all([exited, this.wait()])).then(() => {
      if (this.client !== client || this.generation !== generation) throw Object.assign(Error('V helper voice was released'), {released: true});
      return client.start();
    }).then(() => {
      if (this.client !== client) return;
      this.log('V\'s helper voice is ready (Pocket on the CPU, beside OmniVoice)');
      try { this.onReady(); } catch { /* a warm-up never affects the worker */ }
    }, error => { if (!error?.released) this.broke(client, error?.message); });
  }

  broke(client, message) {
    if (this.client !== client) return;
    this.failed = true;
    this.log(`V's helper voice failed (${String(message ?? 'unknown').slice(0, 120)}); typed lines stay silent until the voice or the setting changes`);
    void this.release({keepFailure: true});
  }

  /** Stops the worker; resolves when its exit is confirmed. Clears a failure, so the next start tries again. */
  release({keepFailure = false} = {}) {
    if (!keepFailure) this.failed = false;
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
