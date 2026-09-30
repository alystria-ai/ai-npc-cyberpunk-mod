import {ResidentVoice, LOCAL_VOICE_KEYS, voiceSteps} from './resident-voice.mjs';
import {abortable, throwIfCancelled} from './transport-pool.mjs';

// Routing changes commit only at a conversation boundary. Model preparation
// can begin from a settings draft while that routing remains unchanged.
// Retiring CUDA work completes through EOF before a replacement may start.
export class VoiceSelection {
  constructor(config = {}, options = {}) {
    this.config = config; this.options = options;
    this.factory = options.factory || ((settings, hooks) => new ResidentVoice(settings, hooks));
    this.configured = config.provider === 'hybrid';
    this.provider = this.requestedProvider = 'hybrid';
    this.steps = this.requestedSteps = voiceSteps(config.steps);
    this.retiring = Promise.resolve(); this.releasing = false;
    this.state = this.configured ? 'stopped' : 'disabled'; this.details = {};
  }
  usesProfile(key) { return this.provider === 'hybrid' && this.configured && LOCAL_VOICE_KEYS.includes(key); }
  request(settings) {
    if (['hybrid', 'convai'].includes(settings?.voiceProvider)) this.requestedProvider = settings.voiceProvider;
    if ([16, 32].includes(settings?.omniSteps)) this.requestedSteps = settings.omniSteps;
  }
  get pending() { return this.provider !== this.requestedProvider || this.steps !== this.requestedSteps; }
  get wantsLocal() {
    return this.configured && !this.closed && (this.provider === 'hybrid'
      || this.requestedProvider === 'hybrid' || this.preview?.provider === 'hybrid');
  }
  setPreview(preview) {
    const next = preview && ['hybrid','convai'].includes(preview.provider) && [16,32].includes(preview.steps)
      ? {provider:preview.provider, steps:preview.steps} : null;
    const changed = this.preview?.provider !== next?.provider || this.preview?.steps !== next?.steps;
    this.preview = next;
    return changed;
  }
  prepare(preview) {
    if (this.closed) return;
    const changed = this.setPreview(preview);
    this.reconcile();
    if (changed) this.publish();
  }
  update(settings, preview, busy) {
    if (this.closed) return false;
    this.request(settings);
    const previewChanged = this.setPreview(preview);
    const applied = this.applyWhenIdle(busy);
    this.reconcile();
    if (previewChanged && !applied) this.publish();
    return applied;
  }
  reconcile() {
    if (this.wantsLocal) void this.start().catch(() => {});
    else if (this.client) this.retire();
  }
  publish(state = this.state, extra = {}) {
    this.state = state;
    const value = {...this.details, version: 1, state, provider: this.provider,
      requestedProvider: this.requestedProvider, pending: this.pending, steps: this.steps,
      requestedSteps: this.requestedSteps, configured: this.configured, bridgePid: process.pid,
      previewActive: !!this.preview, previewProvider: this.preview?.provider,
      preparationOnly: this.provider === 'convai' && this.wantsLocal,
      updated: Date.now(), ...extra};
    try { Promise.resolve(this.options.onState?.(value)).catch(() => {}); } catch {}
  }
  applyWhenIdle(busy) {
    if (!this.pending || this.closed) return false;
    if (busy) { this.reconcile(); this.publish(); return false; }
    this.provider = this.requestedProvider; this.steps = this.requestedSteps;
    this.client?.setSteps(this.steps);
    this.reconcile();
    this.publish();
    return true;
  }
  start() {
    if (this.closed) return Promise.reject(Error('Voice service is closed'));
    if (!this.wantsLocal) {
      this.publish(this.releasing ? 'releasing' : (this.provider === 'convai' ? 'remote' : 'disabled'));
      return Promise.resolve();
    }
    if (this.starting) return this.starting;
    let client;
    client = this.client = this.factory(this.config, {...this.options, onState: value => {
      if (this.client !== client || this.closed) return;
      this.details = value; this.publish(value.state);
    }});
    client.setSteps(this.provider === 'hybrid' ? this.steps
      : this.preview?.provider === 'hybrid' ? this.preview.steps : this.requestedSteps);
    this.publish(this.releasing ? 'releasing' : 'loading');
    this.starting = this.retiring.then(async () => {
      if (this.client !== client || this.closed) return;
      await client.start();
    });
    this.starting.catch(() => {});
    return this.starting;
  }
  retire() {
    const client = this.client;
    this.client = this.starting = null;
    if (!client) { this.publish(this.releasing ? 'releasing' : (this.closed ? 'stopped' : 'remote')); return this.retiring; }
    this.releasing = true;
    this.publish('releasing');
    // Signal EOF even during warmup. The worker owns its bounded physical
    // cleanup; waiting for readiness first could prevent shutdown forever.
    // An unconfirmed prior exit must continue blocking any replacement.
    const retirement = this.retiring.then(() => client.close());
    this.retiring = retirement.then(() => {
      if (this.retiring !== completed) return;
      this.releasing = false;
      if (!this.client) {
        this.details = {resident: false, cudaAllocatedMiB: 0, cudaReservedMiB: 0};
        this.publish(this.closed ? 'stopped' : 'remote');
      }
    });
    const completed = this.retiring;
    this.retiring.catch(() => this.publish('error', {detail: 'Could not release local voices. Restart the voice service.'}));
    return this.retiring;
  }
  async synthesize(profile, text, options = {}) {
    if (!this.usesProfile(profile)) throw Error('This character uses its Convai voice');
    await abortable(this.start(), options.signal); throwIfCancelled(options.signal);
    const client = this.client;
    if (!client || !this.usesProfile(profile)) throw Error('Voice selection changed before synthesis');
    return client.synthesize(profile, text, {...options, steps: options.steps ?? this.steps});
  }
  close() {
    if (this.closed) return this.retiring;
    this.closed = true; this.preview = null;
    return this.retire();
  }
}
