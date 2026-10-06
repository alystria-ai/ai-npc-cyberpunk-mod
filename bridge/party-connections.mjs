import {abortable, throwIfCancelled, transportKey} from './transport-pool.mjs';

export const PARTY_LIMIT = 8;
export const CONNECTION_LIMIT = PARTY_LIMIT + 3;
// Characters prepared ahead by "Auto-connect nearby characters" (bridge/nearby-warm.mjs).
export const NEARBY_LIMIT = 2;
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
  constructor({host, configFor, isKnown, onState = () => {}, now = Date.now, staleMs = 6500, canWarm = () => true}) {
    Object.assign(this, {host, configFor, isKnown, onState, now, staleMs, canWarm});
    this.profiles = []; this.updated = null; this.stale = true;
    this.invitations = []; this.retiring = new Map(); this.retirementDebt = new Map();
    this.entries = new Map(); this.composer = this.request = null; this.nearby = [];
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
    if (this.stale) { this.composer = this.request = null; this.nearby = []; }
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
  // Nearby world characters to keep a private connection ready for. They rank
  // below every party member, invitation and the composer/request target, and
  // take the optional group slots, so they can never evict anything protected.
  setNearby(profiles) {
    if (!Array.isArray(profiles) || profiles.some(profile => typeof profile !== 'string' || !/^[a-z0-9-]{1,80}$/.test(profile))) {
      throw Error('Invalid nearby profiles');
    }
    const next = [...new Set(profiles)].slice(0, NEARBY_LIMIT);
    if (JSON.stringify(next) === JSON.stringify(this.nearby)) return Promise.resolve();
    this.nearby = next; this.revision++;
    return this.reconcile();
  }
  setRequest(input, exactConfig) {
    // Ambient profiles cannot be warmed without their physical entity. An
    // admitted request may supply that exact already-validated route so normal
    // party reconciliation does not dispose its active page. Keep credentials
    // and route details private; diagnostics expose only the profile/scope.
    let config;
    if (input && exactConfig !== undefined) {
      if (!exactConfig || typeof exactConfig !== 'object' || !exactConfig.characterId || !exactConfig.scope) {
        throw Error('Invalid submitted connection route');
      }
      transportKey(exactConfig);
      config = Object.freeze(Object.fromEntries(['key', 'characterId', 'endUserId', 'scope', 'sessionId', 'ttsEnabled']
        .filter(key => Object.hasOwn(exactConfig, key)).map(key => [key, exactConfig[key]])));
    }
    this.request = input ? {scope: input.group ? 'group:' + [...input.group.audience].sort().join(',') : 'private',
      audience: input.group?.audience || [input.profileKey], profile: input.profileKey, ...(config ? {config} : {})} : null;
    this.composer = null; this.revision++;
    return this.reconcile();
  }
  setInvitations(profiles) {
    if (!Array.isArray(profiles) || profiles.length > PARTY_LIMIT
        || profiles.some(profile => typeof profile !== 'string' || !/^[a-z0-9-]{1,80}$/.test(profile))) {
      throw Error('Invalid invitation profiles');
    }
    const pending = [...new Set(profiles)];
    const party = this.stale ? [] : this.profiles.filter(this.isKnown);
    if (new Set([...party, ...pending]).size > PARTY_LIMIT) throw Error('Invitations exceed the party connection limit');
    this.invitations = pending; this.revision++;
    return this.reconcile();
  }
  plan() {
    if (this.paused) return [];
    const party = this.stale ? [] : this.profiles.filter(this.isKnown), focus = this.request || this.composer;
    const privateProfiles = [...new Set([...party, ...this.invitations.filter(this.isKnown)])].slice(0, PARTY_LIMIT);
    if (focus?.scope === 'private' && this.isKnown(focus.audience[0]) && !privateProfiles.includes(focus.audience[0])) {
      privateProfiles.push(focus.audience[0]);
    }
    const nearbyProfiles = this.stale ? [] : this.nearby.filter(profile => this.isKnown(profile) && !privateProfiles.includes(profile))
      .slice(0, Math.max(0, CONNECTION_LIMIT - privateProfiles.length));
    privateProfiles.push(...nearbyProfiles);
    const audience = focus?.scope.startsWith('group:') ? focus.audience.filter(this.isKnown) : party.slice(0, 3);
    const groupScope = focus?.scope.startsWith('group:') ? focus.scope : 'group:' + [...audience].sort().join(',');
    // A nearby non-party private target occupies one of the three optional
    // group slots while the eight party private connections remain protected.
    const minimumGroup = focus?.scope.startsWith('group:') ? 1 : 2;
    const groupProfiles = audience.length >= minimumGroup ? audience.slice(0, CONNECTION_LIMIT - privateProfiles.length) : [];
    const privateSpecs = privateProfiles.map(profile => ({profile, scope: 'private',
      role: party.includes(profile) ? 'party' : this.invitations.includes(profile) ? 'invitation'
        : nearbyProfiles.includes(profile) && focus?.audience[0] !== profile ? 'nearby' : 'target'}));
    const groupSpecs = groupProfiles.map(profile => ({profile, scope: groupScope, role: 'group'}));
    const specs = focus?.scope.startsWith('group:') ? [...groupSpecs, ...privateSpecs] : [...privateSpecs, ...groupSpecs];
    if (focus?.config && !specs.some(spec => spec.profile === focus.profile && spec.scope === focus.scope)) {
      // Eight party private pages remain protected. A physical ambient target
      // uses one optional slot, just like a nearby named private target.
      while (specs.length >= CONNECTION_LIMIT) {
        const optional = specs.findLastIndex(spec => spec.role === 'group');
        if (optional < 0) throw Error('No connection capacity for the submitted target');
        specs.splice(optional, 1);
      }
      specs.unshift({profile: focus.profile, scope: focus.scope, role: 'target', config: focus.config});
    }
    return specs;
  }
  configuration(spec) { return spec.config || this.configFor(spec.profile, spec.scope); }
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
      const prior = this.entries.get(identity);
      if (prior && transportKey(this.configuration(prior)) !== transportKey(this.configuration(spec))) {
        prior.controller?.abort(); this.entries.delete(identity); changed = true;
      }
      if (!this.entries.has(identity)) {
        this.entries.set(identity, {...spec, identity, state: 'waiting', failures: 0, attempts: 0, nextCheck: 0}); changed = true;
      } else if (this.entries.get(identity).role !== spec.role) {
        this.entries.get(identity).role = spec.role; changed = true;
      }
    }
    await this.host.retain(specs.map(spec => this.configuration(spec)), {protect: true});
    // With no remaining owner, retain has already closed this profile's pages.
    for (const profile of this.retirementDebt.keys()) if (!specs.some(spec => spec.profile === profile)) this.retirementDebt.delete(profile);
    if (changed) this.emit();
  }
  async maintain() {
    if (this.updated !== null && this.now() - this.updated > this.staleMs && !this.stale) {
      this.stale = true; this.composer = this.request = null; this.nearby = []; this.revision++; this.emit();
    }
    await this.reconcile();
    const now = this.now();
    // These probes send only a documented idle-timer reset. They cannot ask
    // the model to speak or enable an audio input track.
    for (const entry of this.entries.values()) if (entry.state === 'ready' && !this.needsRetirement(entry.profile)
        && now >= entry.nextCheck && !entry.checking) {
      entry.nextCheck = now + 15000; entry.checking = true;
      void this.host.readiness(this.configuration(entry), {keepAlive: true}).then(status => {
        if (this.entries.get(entry.identity) !== entry || status.busy) return;
        if (!status.present) { entry.state = 'waiting'; this.emit(); }
        else if (!status.ready) this.failed(entry);
      }).catch(() => { if (this.entries.get(entry.identity) === entry) this.failed(entry); })
        .finally(() => { entry.checking = false; });
    }
    // A cancelled/busy retirement may outlive its invitation. Complete that
    // exact disposal before maintenance can reuse any pre-enable connection.
    if (!this.paused && this.canWarm()) for (const [profile, debt] of this.retirementDebt) {
      if (!this.retiring.has(profile) && now >= debt.retryAt) void this.retireInvitation(profile).catch(() => {});
    }
    if (this.paused || now < this.nextStart || [...this.entries.values()].filter(entry => entry.state === 'connecting').length >= 2) return;
    const entry = this.plan().map(spec => this.entries.get(connectionKey(spec.profile, spec.scope)))
      .find(row => !this.retiring.has(row.profile) && !this.needsRetirement(row.profile)
        && (row.state === 'waiting' || (['retrying', 'cooldown'].includes(row.state) && now >= row.retryAt)));
    if (!entry) return;
    if (!this.canWarm()) return;
    this.startWarm(entry);
  }
  startWarm(entry) {
    if (entry.state === 'connecting' && entry.pending) return entry.pending;
    if (this.entries.get(entry.identity) !== entry || this.paused || this.retiring.has(entry.profile) || this.needsRetirement(entry.profile)
        || !this.canWarm() || this.now() < this.nextStart
        || (['retrying', 'cooldown'].includes(entry.state) && this.now() < entry.retryAt)
        || [...this.entries.values()].filter(row => row.state === 'connecting').length >= 2) return null;
    const now = this.now();
    this.nextStart = now + 500;
    entry.controller = new AbortController(); entry.state = 'connecting'; entry.startedAt = now; entry.attempts++;
    entry.timedOut = false;
    const timeout = setTimeout(() => { entry.timedOut = true; entry.controller.abort(); }, 25000);
    this.emit();
    let warming;
    try { warming = this.host.warm(this.configuration(entry), {signal: entry.controller.signal}); }
    catch (error) { warming = Promise.reject(error); }
    entry.pending = Promise.resolve(warming).then(timing => {
      if (this.entries.get(entry.identity) !== entry || entry.controller.signal.aborted) return;
      entry.state = 'ready'; entry.readyAt = this.now(); entry.warmMs = this.now() - entry.startedAt;
      entry.connectionMs = timing?.connectionMs; entry.failures = 0; entry.retryAt = null; entry.nextCheck = this.now() + 15000;
      this.emit();
    }).catch(error => {
      entry.error = error;
      if (this.entries.get(entry.identity) === entry && (!entry.controller.signal.aborted || entry.timedOut)) this.failed(entry);
    }).finally(() => clearTimeout(timeout));
    return entry.pending;
  }
  async invitationReadiness(profile) {
    if (this.retiring.has(profile) || this.needsRetirement(profile)) return {present: false, ready: false, retiring: true};
    const entry = this.entries.get(connectionKey(profile, 'private'));
    if (!entry) return {present: false, ready: false, busy: false};
    return this.host.readiness(this.configuration(entry), {keepAlive: true});
  }
  async warmInvitation(profile, {signal} = {}) {
    throwIfCancelled(signal);
    await this.reconcile();
    throwIfCancelled(signal);
    if (this.retiring.has(profile)) return {present: false, ready: false, gated: true};
    if (this.needsRetirement(profile)) {
      if (!this.canWarm() || this.now() < this.retirementDebt.get(profile).retryAt) return {present: false, ready: false, gated: true};
      await this.retireInvitation(profile, {signal});
      throwIfCancelled(signal);
    }
    const entry = this.entries.get(connectionKey(profile, 'private'));
    if (!entry) throw Error('The invitation has no retained private connection');
    const status = await this.invitationReadiness(profile);
    throwIfCancelled(signal);
    if (this.entries.get(entry.identity) !== entry) throw Object.assign(Error('The invitation connection was replaced'),
      {code: 'INVITATION_CONNECTION_REPLACED'});
    if (this.retiring.has(profile)) return {...status, ready: false, gated: true};
    if (status.present && status.ready && !status.busy) return status;
    if (status.busy) return status;
    if (entry.state === 'ready') { entry.state = 'waiting'; this.emit(); }
    if (!this.canWarm()) return {...status, ready: false, gated: true};
    // Both maintenance and explicit invitation preparation share this entry's
    // attempt. No second lease races the submitted turn or another copy.
    const pending = this.startWarm(entry);
    if (!pending) return {...status, ready: false, gated: true, retryAt: entry.retryAt};
    await abortable(pending, signal);
    throwIfCancelled(signal);
    if (this.entries.get(entry.identity) !== entry) throw Object.assign(Error('The invitation connection was replaced'),
      {code: 'INVITATION_CONNECTION_REPLACED'});
    if (entry.state !== 'ready') throw entry.error || Error('The companion connection did not become ready');
    return this.invitationReadiness(profile);
  }
  async retireInvitation(profile, {signal} = {}) {
    throwIfCancelled(signal);
    const existing = this.retiring.get(profile);
    if (existing) return abortable(existing, signal);
    const retiring = this.retireProfile(profile, signal);
    this.retiring.set(profile, retiring);
    try { return await retiring; }
    catch (error) {
      const debt = this.retirementDebt.get(profile);
      if (debt) debt.retryAt = this.now() + 500;
      throw error;
    }
    finally { if (this.retiring.get(profile) === retiring) this.retiring.delete(profile); }
  }
  async retireProfile(profile, signal) {
    // Enabling memory affects this character's existing scopes. Retire only
    // those transports; another companion's page and private lease stay owned.
    const retiring = [...this.entries.values()].filter(entry => entry.profile === profile)
      .map(entry => ({entry, config: this.configuration(entry)}));
    const debt = this.retirementDebt.get(profile) || {scopes: new Map(), retryAt: 0};
    this.retirementDebt.set(profile, debt);
    for (const target of retiring) if (!debt.scopes.has(transportKey(target.config))) debt.scopes.set(transportKey(target.config), target);
    // Fence old warm/readiness callbacks before waiting for their leases. The
    // profile dispatch gate remains held until every old scope is retired.
    for (const {entry} of retiring) {
      this.entries.set(entry.identity, {profile: entry.profile, scope: entry.scope, role: entry.role,
        ...(entry.config ? {config: entry.config} : {}), identity: entry.identity, state: 'waiting', failures: 0, attempts: 0, nextCheck: 0});
      entry.controller?.abort();
    }
    this.revision++; this.emit();
    for (const [key, {entry, config}] of debt.scopes) {
      if (entry.pending) await abortable(entry.pending, signal);
      throwIfCancelled(signal);
      if (this.retirementDebt.get(profile) !== debt) return;
      if (await this.host.refreshIdle(config) === false) {
        throw Error('The companion connection is busy');
      }
      throwIfCancelled(signal);
      if (this.retirementDebt.get(profile) === debt) debt.scopes.delete(key);
    }
    if (this.retirementDebt.get(profile) === debt) this.retirementDebt.delete(profile);
    this.revision++; await this.reconcile(); this.emit();
  }
  needsRetirement(profile) { return (this.retirementDebt.get(profile)?.scopes.size ?? 0) > 0; }
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
    entry.state = this.needsRetirement(entry.profile) ? 'waiting' : 'ready'; entry.failures = 0; entry.retryAt = null; entry.nextCheck = 0;
    entry.readyAt = this.now(); entry.connectionMs = timing?.connectionMs;
    this.emit();
  }
  async clear() {
    this.stale = true; this.profiles = []; this.invitations = []; this.composer = this.request = null; this.nearby = [];
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
      ...(entry.config ? {config: entry.config} : {}), state: 'waiting', failures: 0, attempts: 0, nextCheck: 0});
    entry.controller?.abort();
    this.revision++; await this.reconcile(); this.emit();
    return true;
  }
  diagnostic() {
    return {updated: this.now(), partyUpdated: this.updated, stale: this.stale, limit: CONNECTION_LIMIT,
      profiles: this.profiles, invitations: this.invitations, unconfigured: this.profiles.filter(profile => !this.isKnown(profile)),
      ready: [...this.entries.values()].filter(entry => entry.state === 'ready').length,
      connecting: [...this.entries.values()].filter(entry => entry.state === 'connecting').length,
      connections: [...this.entries.values()].map(({profile, scope, role, state, attempts, failures, startedAt, readyAt, warmMs, connectionMs, retryAt}) =>
        ({profile, scope, role, state, attempts, failures, startedAt, readyAt, warmMs, connectionMs, retryAt}))};
  }
}
