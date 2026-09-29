export const PARTY_LIMIT = 8;
export const CONNECTION_LIMIT = PARTY_LIMIT + 3;
export const connectionKey = (profile, scope) => JSON.stringify([profile, scope]);

export function parsePartyConnections(value, now = Date.now()) {
  if (!value || !Number.isSafeInteger(value.updated) || value.updated < 0 || value.updated > now + 5000
      || !Array.isArray(value.profiles) || value.profiles.length > PARTY_LIMIT
      || value.profiles.some(profile => typeof profile !== 'string' || !/^[a-z0-9-]{1,80}$/.test(profile))) return null;
  return {updated: value.updated, profiles: [...new Set(value.profiles)]};
}

// Membership owns private connections. A composer/request may replace the
// three group connections, but can never evict a present companion's private
// connection. Setup follows Dawnwalker's two-at-once, staggered lifecycle.
export class PartyConnections {
  constructor({host, configFor, isKnown, onState = () => {}, now = Date.now, staleMs = 6500}) {
    Object.assign(this, {host, configFor, isKnown, onState, now, staleMs});
    this.profiles = []; this.updated = null; this.stale = true;
    this.entries = new Map(); this.composer = this.request = null;
    this.nextStart = 0; this.reconciling = null; this.revision = 0; this.paused = false;
  }
  emit() { void Promise.resolve(this.onState(this.diagnostic())).catch(() => {}); }
  ingest(value) {
    const snapshot = parsePartyConnections(value, this.now());
    if (!snapshot || (this.updated !== null && snapshot.updated < this.updated)) return null;
    const removed = this.profiles.filter(profile => !snapshot.profiles.includes(profile));
    const changed = JSON.stringify(this.profiles) !== JSON.stringify(snapshot.profiles) || this.stale;
    this.profiles = snapshot.profiles; this.updated = snapshot.updated;
    this.stale = this.now() - snapshot.updated > this.staleMs;
    if (this.stale) this.composer = this.request = null;
    for (const field of ['composer', 'request']) {
      if (this[field]?.audience.some(profile => removed.includes(profile))) this[field] = null;
    }
    if (changed) { this.revision++; this.emit(); }
    return {removed, changed, stale: this.stale};
  }
  setComposer(hint) {
    this.composer = hint ? {scope: hint.scope, audience: [...hint.audience]} : null;
    this.request = null; this.revision++;
    return this.reconcile();
  }
  setRequest(input) {
    this.request = input ? {scope: input.group ? 'group:' + [...input.group.audience].sort().join(',') : 'private',
      audience: input.group?.audience || [input.profileKey]} : null;
    this.composer = null; this.revision++;
    return this.reconcile();
  }
  plan() {
    if (this.paused) return [];
    const party = this.stale ? [] : this.profiles.filter(this.isKnown), focus = this.request || this.composer;
    const privateProfiles = [...party];
    if (focus?.scope === 'private' && this.isKnown(focus.audience[0]) && !privateProfiles.includes(focus.audience[0])) {
      privateProfiles.push(focus.audience[0]);
    }
    const audience = focus?.scope.startsWith('group:') ? focus.audience.filter(this.isKnown) : party.slice(0, 3);
    const groupScope = focus?.scope.startsWith('group:') ? focus.scope : 'group:' + [...audience].sort().join(',');
    // A nearby non-party private target occupies one of the three optional
    // group slots while the eight party private connections remain protected.
    const minimumGroup = focus?.scope.startsWith('group:') ? 1 : 2;
    const groupProfiles = audience.length >= minimumGroup ? audience.slice(0, CONNECTION_LIMIT - privateProfiles.length) : [];
    const privateSpecs = privateProfiles.map(profile => ({profile, scope: 'private', role: party.includes(profile) ? 'party' : 'target'}));
    const groupSpecs = groupProfiles.map(profile => ({profile, scope: groupScope, role: 'group'}));
    return focus?.scope.startsWith('group:') ? [...groupSpecs, ...privateSpecs] : [...privateSpecs, ...groupSpecs];
  }
  async reconcile() {
    if (this.reconciling) { await this.reconciling; return this.reconcile(); }
    this.reconciling = this.applyPlan();
    try { await this.reconciling; } finally { this.reconciling = null; }
  }
  async applyPlan() {
    const specs = this.plan(), desired = new Set(specs.map(spec => connectionKey(spec.profile, spec.scope)));
    let changed = false;
    for (const [identity, entry] of this.entries) if (!desired.has(identity)) {
      entry.controller?.abort(); this.entries.delete(identity); changed = true;
    }
    for (const spec of specs) {
      const identity = connectionKey(spec.profile, spec.scope);
      if (!this.entries.has(identity)) {
        this.entries.set(identity, {...spec, identity, state: 'waiting', failures: 0, attempts: 0, nextCheck: 0}); changed = true;
      }
    }
    await this.host.retain(specs.map(spec => this.configFor(spec.profile, spec.scope)), {protect: true});
    if (changed) this.emit();
  }
  async maintain() {
    if (this.updated !== null && this.now() - this.updated > this.staleMs && !this.stale) {
      this.stale = true; this.composer = this.request = null; this.revision++; this.emit();
    }
    await this.reconcile();
    const now = this.now();
    // These probes send only a documented idle-timer reset. They cannot ask
    // the model to speak or enable an audio input track.
    for (const entry of this.entries.values()) if (entry.state === 'ready' && now >= entry.nextCheck && !entry.checking) {
      entry.nextCheck = now + 15000; entry.checking = true;
      void this.host.readiness(this.configFor(entry.profile, entry.scope), {keepAlive: true}).then(status => {
        if (this.entries.get(entry.identity) !== entry || status.busy) return;
        if (!status.present) { entry.state = 'waiting'; this.emit(); }
        else if (!status.ready) this.failed(entry);
      }).catch(() => { if (this.entries.get(entry.identity) === entry) this.failed(entry); })
        .finally(() => { entry.checking = false; });
    }
    if (this.paused || now < this.nextStart || [...this.entries.values()].filter(entry => entry.state === 'connecting').length >= 2) return;
    const entry = this.plan().map(spec => this.entries.get(connectionKey(spec.profile, spec.scope)))
      .find(row => row.state === 'waiting' || (['retrying', 'cooldown'].includes(row.state) && now >= row.retryAt));
    if (!entry) return;
    this.nextStart = now + 500;
    entry.controller = new AbortController(); entry.state = 'connecting'; entry.startedAt = now; entry.attempts++;
    entry.timedOut = false;
    const timeout = setTimeout(() => { entry.timedOut = true; entry.controller.abort(); }, 25000);
    this.emit();
    entry.pending = this.host.warm(this.configFor(entry.profile, entry.scope), {signal: entry.controller.signal}).then(timing => {
      if (this.entries.get(entry.identity) !== entry || entry.controller.signal.aborted) return;
      entry.state = 'ready'; entry.readyAt = this.now(); entry.warmMs = this.now() - entry.startedAt;
      entry.connectionMs = timing.connectionMs; entry.failures = 0; entry.retryAt = null; entry.nextCheck = this.now() + 15000;
      this.emit();
    }).catch(() => {
      if (this.entries.get(entry.identity) === entry && (!entry.controller.signal.aborted || entry.timedOut)) this.failed(entry);
    }).finally(() => clearTimeout(timeout));
  }
  failed(entry) {
    entry.failures++;
    entry.state = entry.failures >= 3 ? 'cooldown' : 'retrying';
    entry.retryAt = this.now() + (entry.failures >= 3 ? 300000 : 30000 * entry.failures);
    this.emit();
  }
  used(input, timing) {
    const scope = input.group ? 'group:' + [...input.group.audience].sort().join(',') : 'private';
    const entry = this.entries.get(connectionKey(input.profileKey, scope));
    if (!entry) return;
    entry.state = 'ready'; entry.failures = 0; entry.retryAt = null; entry.nextCheck = 0;
    entry.readyAt = this.now(); entry.connectionMs = timing?.connectionMs;
    this.emit();
  }
  async clear() {
    this.stale = true; this.profiles = []; this.composer = this.request = null;
    await this.reconcile(); this.emit();
  }
  async reconfigure(profiles) {
    // Preserve committed Convai sessions, but reconnect the changed TTS routes.
    // Replace entries so a late completion cannot mark an old warmup ready.
    for (const [identity, entry] of this.entries) if (profiles.includes(entry.profile)) {
      entry.controller?.abort(); this.entries.delete(identity);
    }
    this.revision++; await this.reconcile(); this.emit();
  }
  async refreshScope(profile, scope) {
    // Called after host.refreshIdle succeeds. Replacing the object prevents an
    // old warm/readiness callback from marking the renewed scope ready.
    const identity = connectionKey(profile, scope), entry = this.entries.get(identity);
    if (!entry) return false;
    this.entries.set(identity, {profile, scope, role: entry.role, identity,
      state: 'waiting', failures: 0, attempts: 0, nextCheck: 0});
    entry.controller?.abort();
    this.revision++; await this.reconcile(); this.emit();
    return true;
  }
  diagnostic() {
    return {updated: this.now(), partyUpdated: this.updated, stale: this.stale, limit: CONNECTION_LIMIT,
      profiles: this.profiles, unconfigured: this.profiles.filter(profile => !this.isKnown(profile)),
      ready: [...this.entries.values()].filter(entry => entry.state === 'ready').length,
      connecting: [...this.entries.values()].filter(entry => entry.state === 'connecting').length,
      connections: [...this.entries.values()].map(({profile, scope, role, state, attempts, failures, startedAt, readyAt, warmMs, connectionMs, retryAt}) =>
        ({profile, scope, role, state, attempts, failures, startedAt, readyAt, warmMs, connectionMs, retryAt}))};
  }
}
