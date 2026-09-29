import {ResidentVoice, LOCAL_VOICE_KEYS, voiceSteps} from './resident-voice.mjs';
import {throwIfCancelled} from './transport-pool.mjs';

// Provider changes commit only at a conversation boundary. Retiring CUDA work
// completes through EOF before another resident worker may start.
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
  publish(state = this.state, extra = {}) {
    this.state = state;
    const value = {...this.details, version: 1, state, provider: this.provider,
      requestedProvider: this.requestedProvider, pending: this.pending, steps: this.steps,
      requestedSteps: this.requestedSteps, configured: this.configured, bridgePid: process.pid,
      updated: Date.now(), ...extra};
    try { Promise.resolve(this.options.onState?.(value)).catch(() => {}); } catch {}
  }
  applyWhenIdle(busy) {
    if (!this.pending || this.closed) return false;
    if (busy) { this.publish(); return false; }
    const changedProvider = this.provider !== this.requestedProvider;
    this.provider = this.requestedProvider; this.steps = this.requestedSteps;
    if (changedProvider && this.provider === 'convai') this.retire();
    else if (changedProvider) void this.start().catch(() => {});
    else this.client?.setSteps(this.steps);
    this.publish();
    return true;
  }
  start() {
    if (this.closed) return Promise.reject(Error('Voice service is closed'));
    if (this.provider === 'convai' || !this.configured) {
      this.publish(this.releasing ? 'releasing' : (this.provider === 'convai' ? 'remote' : 'disabled'));
      return Promise.resolve();
    }
    if (this.starting) return this.starting;
    let client;
    client = this.client = this.factory(this.config, {...this.options, onState: value => {
      if (this.client !== client || this.closed) return;
      this.details = value; this.publish(value.state);
    }});
    client.setSteps(this.steps);
    this.publish(this.releasing ? 'releasing' : 'loading');
    this.starting = this.retiring.then(async () => {
      if (this.client !== client || this.closed) return;
      await client.start();
    });
    this.starting.catch(() => {});
    return this.starting;
  }
  retire() {
    const client = this.client, starting = this.starting;
    this.client = this.starting = null;
    if (!client) { this.publish(this.releasing ? 'releasing' : (this.closed ? 'stopped' : 'remote')); return this.retiring; }
    this.releasing = true;
    this.publish('releasing');
    // An initialization already inside CUDA is also allowed to finish safely.
    const retirement = Promise.allSettled([this.retiring, starting]).then(() => client.close());
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
    await this.start(); throwIfCancelled(options.signal);
    const client = this.client;
    if (!client || !this.usesProfile(profile)) throw Error('Voice selection changed before synthesis');
    return client.synthesize(profile, text, {...options, steps: options.steps ?? this.steps});
  }
  close() {
    if (this.closed) return this.retiring;
    this.closed = true;
    return this.retire();
  }
}
