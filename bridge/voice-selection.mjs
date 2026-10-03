import {PocketVoice, validatePocketConfig} from './pocket-voice.mjs';
import {createVoiceProfileRegistry} from './voice-profile-registry.mjs';
import {abortable, throwIfCancelled} from './transport-pool.mjs';

// Routing changes commit only at a conversation boundary. Model preparation
// can begin from a settings draft while that routing remains unchanged.
// Retiring CPU work completes through EOF before a replacement may start.
const provider = value => value === 'hybrid' ? 'pocket' : value;
export class VoiceSelection {
  constructor(config = {}, options = {}) {
    const supplied = Object.keys(config).length > 0;
    const validated = supplied ? validatePocketConfig(config) : null;
    this.registry = validated?.registry || createVoiceProfileRegistry({});
    this.config = Object.freeze({...validated, voices: Object.freeze({...this.registry.profiles,
      ...Object.fromEntries(Object.entries(this.registry.unavailable).map(([key, status]) => [key, Object.freeze({status})]))}),
      preparation: this.registry.preparation});
    this.options = options;
    this.factory = options.factory || ((settings, hooks) => new PocketVoice(settings, hooks));
    this.configured = !!validated && this.registry.keys.length > 0;
    this.provider = this.requestedProvider = 'pocket';
    this.retiring = Promise.resolve(); this.releasing = false;
    this.state = this.configured ? 'stopped' : 'disabled'; this.details = {};
    this.availability = new Set(this.registry.keys); this.verifiedAvailability = null;
    this.routeRevision = 0; this.routeChanges = new Set(); this.routingWaiters = new Set();
  }
  get profileKeys() { return this.registry.keys; }
  hasProfile(key) { return this.registry.has(key) && this.availability.has(key); }
  usesProfile(key) { return this.provider === 'pocket' && this.configured && this.hasProfile(key); }
  profileReady(key) { return this.usesProfile(key) && this.client?.profileReady(key) === true; }
  request(settings) {
    const chosen = provider(settings?.voiceProvider);
    if (['pocket', 'convai'].includes(chosen)) this.requestedProvider = chosen;
  }
  get pending() { return this.provider !== this.requestedProvider; }
  get availabilityPending() { return !!this.verifiedAvailability
    && (this.availability.size !== this.verifiedAvailability.size
      || [...this.availability].some(key => !this.verifiedAvailability.has(key))); }
  consumeRouteChanges() { const value = [...this.routeChanges].sort(); this.routeChanges.clear(); return value; }
  stageAvailability(client) {
    if (this.client !== client || this.closed || !client.loaded) return;
    this.verifiedAvailability = new Set(this.profileKeys.filter(key => client.hasProfile(key)));
  }
  routingSettled({signal} = {}) {
    throwIfCancelled(signal);
    if (this.closed) return Promise.reject(Error('Voice service is closed'));
    if (!this.pending && !this.availabilityPending) return Promise.resolve();
    let waiter;
    const pending = new Promise((resolve, reject) => { waiter = {resolve, reject}; this.routingWaiters.add(waiter); });
    return abortable(pending, signal).finally(() => this.routingWaiters.delete(waiter));
  }
  settleRouting() {
    if (this.pending || this.availabilityPending) return;
    for (const waiter of this.routingWaiters) waiter.resolve();
    this.routingWaiters.clear();
  }
  get wantsLocal() {
    // Provisional configured profiles keep initial warmup intact. Once an idle
    // commit proves every reference unavailable, residency serves no local
    // route; release it without creating an automatic replacement loop.
    return this.configured && this.availability.size > 0 && !this.closed && (this.provider === 'pocket'
      || this.requestedProvider === 'pocket' || this.preview?.provider === 'pocket');
  }
  setPreview(preview) {
    const chosen = provider(preview?.provider);
    const next = preview && ['pocket','convai'].includes(chosen) ? {provider:chosen} : null;
    const changed = this.preview?.provider !== next?.provider;
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
      requestedProvider: this.requestedProvider, pending: this.pending,
      configured: this.configured, bridgePid: process.pid,
      configuredProfiles: this.profileKeys,
      availabilityPending: this.availabilityPending, routeRevision: this.routeRevision,
      routedProfiles: this.provider === 'pocket' ? [...this.availability].sort() : [],
      previewActive: !!this.preview, previewProvider: this.preview?.provider,
      preparationOnly: this.provider === 'convai' && this.wantsLocal,
      updated: Date.now(), ...extra};
    try { Promise.resolve(this.options.onState?.(value)).catch(() => {}); } catch {}
  }
  applyWhenIdle(busy) {
    if (this.closed) return false;
    if (!this.pending && !this.availabilityPending) { this.settleRouting(); return false; }
    if (busy) { this.reconcile(); this.publish(); return false; }
    const previous = new Set(this.profileKeys.filter(key => this.usesProfile(key)));
    this.provider = this.requestedProvider;
    if (this.verifiedAvailability) this.availability = new Set(this.verifiedAvailability);
    const changedRoutes = this.profileKeys.filter(key => previous.has(key) !== this.usesProfile(key));
    if (changedRoutes.length) {
      this.routeRevision++;
      for (const key of changedRoutes) this.routeChanges.add(key);
    }
    this.reconcile();
    this.publish();
    this.settleRouting();
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
      if (value.state === 'ready') this.stageAvailability(client);
      this.details = value; this.publish(value.state);
    }});
    this.publish(this.releasing ? 'releasing' : 'loading');
    this.starting = this.retiring.then(async () => {
      if (this.client !== client || this.closed) return;
      await client.start();
      this.stageAvailability(client);
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
        this.details = {resident: false, device: 'cpu', gpuVramBytes: 0};
        this.publish(this.closed ? 'stopped' : 'remote');
      }
    });
    const completed = this.retiring;
    this.retiring.catch(() => this.publish('error', {detail: 'Could not release local voices. Restart the voice service.'}));
    return this.retiring;
  }
  async synthesizeStream(profile, text, options = {}) {
    if (!this.usesProfile(profile)) throw Error('This character uses its Convai voice');
    await abortable(this.start(), options.signal); throwIfCancelled(options.signal);
    const client = this.client;
    if (!client || !this.usesProfile(profile)) throw Error('Voice selection changed before synthesis');
    return client.synthesizeStream(profile, text, options);
  }
  async prepareProfile(profile, options = {}) {
    const remote = reason => ({provider: 'convai', ready: true, reason});
    for (;;) {
      throwIfCancelled(options.signal);
      if (this.closed) throw Error('Voice service is closed');
      await this.routingSettled(options);
      throwIfCancelled(options.signal);
      if (this.closed) throw Error('Voice service is closed');
      if (this.provider === 'convai') return remote('selected');
      if (!this.configured || !this.registry.has(profile)) return remote(this.registry.status(profile));
      try { await abortable(this.start(), options.signal); }
      catch (error) {
        throwIfCancelled(options.signal);
        if (!this.closed && this.provider === 'convai') return remote('selected');
        throw error;
      }
      throwIfCancelled(options.signal);
      // A ready worker can discover a vanished reference during an owned turn.
      // The flight waits for the normal idle commit; no polling loop is held.
      await this.routingSettled(options);
      if (this.closed) throw Error('Voice service is closed');
      if (this.provider === 'convai') return remote('selected');
      if (!this.hasProfile(profile)) return remote('unavailable');
      const client = this.client;
      if (!client?.loaded) continue;
      let receipt;
      try { receipt = await client.prepareProfile(profile, options); }
      catch (error) {
        throwIfCancelled(options.signal);
        if (!this.closed && this.provider === 'convai') return remote('selected');
        throw error;
      }
      throwIfCancelled(options.signal);
      await this.routingSettled(options);
      if (this.closed) throw Error('Voice service is closed');
      if (this.provider === 'convai') return remote('selected');
      if (this.client !== client) continue;
      if (!this.hasProfile(profile)) return remote('unavailable');
      return receipt;
    }
  }
  close() {
    if (this.closed) return this.retiring;
    this.closed = true; this.preview = null;
    for (const waiter of this.routingWaiters) waiter.reject(Error('Voice service is closed'));
    this.routingWaiters.clear();
    return this.retire();
  }
}
