import {abortable} from './transport-pool.mjs';
import {PARTY_LIMIT} from './party-connections.mjs';

const token = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/.test(value);
const model = value => token(value) && value.length <= 160;
const profile = value => typeof value === 'string' && /^[a-z0-9-]{1,80}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const sameWorld = (left, right) => !!left && !!right
  && left.worldToken === right.worldToken && left.generation === right.generation;
const sameGuard = (left, right) => object(left) && object(right)
  && Object.keys(left).length === Object.keys(right).length
  && Object.keys(left).every(key => left[key] === right[key]);
const identity = row => JSON.stringify([row.id, row.revision, row.modelKey, row.profileKey ?? null]);
const ERRORS = Object.freeze({
  profile: 'This conversation profile is unavailable.',
  revision: 'This invitation changed. Invite the copy again.',
  memory: 'Memory preparation could not be verified. Choose a profile or cancel the invitation.',
  guard: 'The player memory changed. Invite the copy again.',
  voice: 'Voice preparation could not become ready. Cancel the invitation or choose another voice provider.',
  connection: 'The companion connection could not become ready. Choose a profile or cancel the invitation.',
  capacity: 'The party has no free conversation connection.'
});

export function parseCompanionInvitations(value, now = Date.now(), staleMs = 6500) {
  if (!object(value) || value.version !== 1 || !token(value.worldToken) || !integer(value.generation) || value.generation < 1
      || !integer(value.updated) || value.updated > now + 5000 || now - value.updated > staleMs
      || !Array.isArray(value.invitations) || value.invitations.length > PARTY_LIMIT) return null;
  const seen = new Set(), invitations = [];
  for (const row of value.invitations) {
    if (!object(row) || !token(row.id) || seen.has(row.id) || !integer(row.revision) || row.revision < 1
        || !model(row.modelKey) || !['preparing', 'spawned'].includes(row.phase)
        || (Object.hasOwn(row, 'profileKey') && !profile(row.profileKey))) return null;
    seen.add(row.id);
    invitations.push({id: row.id, revision: row.revision, modelKey: row.modelKey,
      ...(row.profileKey !== undefined ? {profileKey: row.profileKey} : {}), phase: row.phase});
  }
  return {version: 1, worldToken: value.worldToken, generation: value.generation, updated: value.updated, invitations};
}

// Tickets own spawn permission; a profile lane owns shared memory/connection
// preparation. No invitation records contact or sends a conversation turn.
export class CompanionInvitations {
  constructor({memory, connections, currentWorld, isKnown, isCurrentGuard = guard => memory.isCurrent(guard),
    prepareVoice = async () => ({provider: 'convai', ready: true}),
    voiceCurrent = () => true, routeCurrent = () => true,
    publish = async () => {}, now = Date.now, staleMs = 6500, bridgePid = process.pid}) {
    Object.assign(this, {memory, connections, currentWorld, isKnown, isCurrentGuard, prepareVoice, voiceCurrent, routeCurrent, publish, now, staleMs, bridgePid});
    this.rows = new Map(); this.lanes = new Map(); this.retired = new Map();
    this.owner = this.request = null; this.epoch = this.version = 0; this.stopped = false;
    this.reservations = []; this.retention = Promise.resolve(); this.publication = null; this.lastClear = null;
  }
  world() {
    try {
      const value = this.currentWorld();
      return object(value) && token(value.worldToken) && integer(value.generation) && value.generation >= 1
        ? {worldToken: value.worldToken, generation: value.generation} : null;
    } catch { return null; }
  }
  touch() { this.version++; this.publication?.abort(); }
  fresh() {
    return !this.stopped && !!this.request && this.now() - this.request.updated <= this.staleMs
      && sameWorld(this.owner, this.world());
  }
  current(lane) {
    try {
      return this.fresh() && this.lanes.get(lane.profileKey) === lane && lane.epoch === this.epoch
        && !lane.controller.signal.aborted && sameWorld(lane.owner, this.owner)
        && [...this.rows.values()].some(row => row.lane === lane) && this.isCurrentGuard(lane.guard) === true;
    } catch { return false; }
  }
  retireRow(row) {
    const previous = this.retired.get(row.id);
    this.retired.set(row.id, {revision: Math.max(previous?.revision ?? 0, row.revision), updated: this.now()});
  }
  invalidate(reason) {
    if (this.rows.size || this.lanes.size || this.request) {
      for (const row of this.rows.values()) this.retireRow(row);
      for (const lane of this.lanes.values()) lane.controller.abort();
      this.rows.clear(); this.lanes.clear(); this.request = null; this.epoch++; this.touch();
    }
    this.lastClear = reason;
    return this.syncReservations();
  }
  ingest(value) {
    if (this.stopped) return null;
    const parsed = parseCompanionInvitations(value, this.now(), this.staleMs), world = this.world();
    if (!parsed || !sameWorld(parsed, world)) {
      // The game's Windows file replacement can expose a brief missing or
      // partial frame. A valid current lease remains authoritative until its
      // heartbeat expires; a lost world revokes it immediately.
      if (!this.fresh()) void this.invalidate(world ? 'invalid-request' : 'world-unavailable').catch(() => {});
      return null;
    }
    if (sameWorld(this.owner, parsed) && this.request && parsed.updated < this.request.updated) return null;
    if (!sameWorld(this.owner, parsed)) {
      void this.invalidate('world-changed').catch(() => {});
      this.retired.clear(); this.owner = {worldToken: parsed.worldToken, generation: parsed.generation};
    }
    this.request = parsed;
    // Expired tombstones cannot refer to a still-valid old IPC request. Keep
    // observed retired IDs fenced while a producer continues to repeat them.
    for (const [id, row] of this.retired) if (this.now() - row.updated > this.staleMs) this.retired.delete(id);
    const next = new Map(), pending = [];
    for (const input of parsed.invitations) {
      const previous = this.rows.get(input.id), retired = this.retired.get(input.id);
      if (previous && identity(previous) === identity(input)) {
        previous.phase = previous.phase === 'spawned' ? 'spawned' : input.phase;
        next.set(input.id, previous); continue;
      }
      if (previous) this.retireRow(previous);
      const fence = this.retired.get(input.id) || retired;
      const row = {...input, startedAt: this.now(), state: input.profileKey ? 'memory' : 'ready'};
      if (fence && input.revision <= fence.revision) {
        fence.updated = this.now(); row.state = 'error'; row.error = ERRORS.revision;
      } else if (input.profileKey && !this.isKnown(input.profileKey)) {
        row.state = 'error'; row.error = ERRORS.profile;
      } else if (input.profileKey) pending.push(row);
      else row.readyAt = this.now();
      next.set(row.id, row);
    }
    for (const previous of this.rows.values()) if (!next.has(previous.id)) this.retireRow(previous);
    this.rows = next;
    for (const [key, lane] of this.lanes) if (![...next.values()].some(row => row.lane === lane)) {
      // A new copy may reuse the same live lane after the old copy's revision
      // changed; attach it before deciding whether the shared lane is unused.
      const replacements = pending.filter(row => row.profileKey === key);
      if (replacements.length && this.currentGuard(lane)) {
        for (const row of replacements) row.lane = lane;
      } else { lane.controller.abort(); this.lanes.delete(key); }
    }
    const launching = new Set();
    for (const row of pending) {
      if (row.lane) continue;
      let lane = this.lanes.get(row.profileKey);
      if (lane && !this.currentGuard(lane)) { lane.controller.abort(); this.lanes.delete(row.profileKey); lane = null; }
      if (!lane) {
        try {
          const {guard} = this.memory.route(row.profileKey, {channel: 'private'});
          if (this.isCurrentGuard(guard) !== true) throw Error('Stale preparation guard');
          lane = {profileKey: row.profileKey, owner: {...this.owner}, epoch: this.epoch, guard,
            controller: new AbortController(), state: 'memory', startedAt: this.now(), prepared: false, nextWarm: 0};
          this.lanes.set(row.profileKey, lane); launching.add(lane);
        } catch { row.state = 'error'; row.error = ERRORS.memory; continue; }
      }
      row.lane = lane;
    }
    this.touch();
    void this.syncReservations().catch(() => {});
    for (const lane of launching) this.prepare(lane);
    return this.snapshot();
  }
  currentGuard(lane) {
    try { return lane.epoch === this.epoch && !lane.controller.signal.aborted
      && sameWorld(lane.owner, this.owner) && this.isCurrentGuard(lane.guard) === true; }
    catch { return false; }
  }
  voiceValid(lane) {
    try { return !!lane.voiceReceipt && this.voiceCurrent(lane.profileKey, lane.voiceReceipt) === true; }
    catch { return false; }
  }
  waitingToSpawn(lane) {
    return [...this.rows.values()].some(row => row.lane === lane && row.phase === 'preparing');
  }
  routeValid(lane) {
    try { return this.routeCurrent(lane.profileKey, lane.guard) === true; } catch { return false; }
  }
  refreshRoute(lane) {
    if (!this.current(lane) || !this.waitingToSpawn(lane) || lane.state === 'error' || this.routeValid(lane)) return false;
    let guard;
    try {
      guard = this.memory.route(lane.profileKey, {channel: 'private'}).guard;
      if (!this.isCurrentGuard(guard) || !this.routeCurrent(lane.profileKey, guard)) return false;
    } catch { return false; } // A missing fresh native snapshot waits; it does not grant spawn.
    const next = {profileKey: lane.profileKey, owner: {...lane.owner}, epoch: lane.epoch, guard,
      controller: new AbortController(), state: 'memory', startedAt: this.now(), prepared: false, nextWarm: 0};
    // The ticket/revision stays the same. Every late completion retains the
    // aborted old lane object and cannot publish readiness for this replacement.
    lane.controller.abort(); this.lanes.set(lane.profileKey, next);
    for (const row of this.rows.values()) if (row.lane === lane) row.lane = next;
    this.touch(); void this.syncReservations().catch(() => {}); this.prepare(next);
    return true;
  }
  refreshVoice(lane) {
    if (!this.current(lane) || lane.preparing || lane.state === 'error') return;
    lane.prepared = false; lane.voiceReceipt = null; lane.state = 'memory'; this.touch();
    void this.syncReservations().catch(() => {});
    this.prepare(lane);
  }
  fail(lane, error) {
    if (this.lanes.get(lane.profileKey) !== lane || lane.controller.signal.aborted) return;
    lane.state = 'error'; lane.error = error; lane.controller.abort(); this.touch();
    void this.syncReservations().catch(() => {});
  }
  syncReservations() {
    const desired = [...this.lanes.values()].filter(lane => lane.prepared && lane.state !== 'error' && this.current(lane))
      .map(lane => lane.profileKey);
    if (JSON.stringify(desired) === JSON.stringify(this.reservations)) return this.retention;
    this.reservations = desired;
    let result;
    try { result = this.connections.setInvitations(desired); }
    catch (error) { result = Promise.reject(error); }
    const captured = [...this.lanes.values()].filter(lane => desired.includes(lane.profileKey));
    this.retention = Promise.resolve(result);
    void this.retention.catch(() => {
      for (const lane of captured) if (this.current(lane)) this.fail(lane, ERRORS.capacity);
    });
    return this.retention;
  }
  prepare(lane) {
    lane.stage = 'memory';
    lane.preparing = (async () => {
      try {
        const prepared = await this.memory.prepareCharacter({profileKey: lane.profileKey,
          guard: lane.guard, signal: lane.controller.signal});
        if (!this.current(lane)) return;
        if (this.waitingToSpawn(lane) && !this.routeValid(lane)) { this.refreshRoute(lane); return; }
        if (prepared?.memoryEnabled !== true || !sameGuard(prepared.guard, lane.guard)) throw Error('Unverified preparation');
        lane.memoryReadyAt = this.now(); lane.memoryMs = this.now() - lane.startedAt;
        // The model and exact speaker conditioning must finish before a world
        // copy can spawn. Copies of one profile share this cancellable flight.
        // Preparing a voice never creates a dialogue turn or records contact.
        lane.stage = 'voice';
        const voice = await abortable(this.prepareVoice(lane.profileKey,
          {signal: lane.controller.signal, guard: lane.guard}), lane.controller.signal);
        if (!this.current(lane)) return;
        if (this.waitingToSpawn(lane) && !this.routeValid(lane)) { this.refreshRoute(lane); return; }
        if (voice?.ready !== true || !['convai', 'omnivoice'].includes(voice.provider)
            || (voice.provider === 'omnivoice' && voice.profile !== lane.profileKey)) throw Error('Unverified voice preparation');
        lane.voiceReadyAt = this.now(); lane.voiceMs = this.now() - lane.memoryReadyAt;
        lane.voiceProvider = voice.provider; lane.voiceReceipt = Object.freeze({...voice}); lane.stage = 'connection';
        // A cancelled shared enable can finish after its original caller has
        // gone away. The memory owner keeps that retirement obligation until
        // a current caller proves disposal. Re-read it here: another caller
        // may already have retired the old scopes after this receipt issued.
        if (this.memory.connectionRefreshRequired({profileKey: lane.profileKey, guard: lane.guard})
            || this.connections.needsRetirement(lane.profileKey)) {
          await this.connections.retireInvitation(lane.profileKey, {signal: lane.controller.signal});
          if (!this.current(lane)) return;
          await this.memory.acknowledgeConnectionRefresh({profileKey: lane.profileKey, guard: lane.guard});
          if (!this.current(lane)) return;
        }
        lane.prepared = true; lane.state = 'connecting'; this.touch();
        await abortable(this.syncReservations(), lane.controller.signal);
        if (this.current(lane)) this.warm(lane);
      } catch {
        if (this.current(lane)) this.fail(lane, lane.stage === 'voice' ? ERRORS.voice
          : lane.stage === 'connection' || lane.prepared ? ERRORS.connection : ERRORS.memory);
      } finally { lane.preparing = null; }
    })();
  }
  warm(lane) {
    if (!this.current(lane) || !lane.prepared || lane.state === 'error' || lane.warming || lane.probing
        || this.now() < lane.nextWarm) return;
    lane.nextWarm = this.now() + 500;
    lane.warming = (async () => {
      try {
        const status = await this.connections.warmInvitation(lane.profileKey, {signal: lane.controller.signal});
        if (!this.current(lane)) return;
        if (this.waitingToSpawn(lane) && !this.routeValid(lane)) { this.refreshRoute(lane); return; }
        this.acceptReadiness(lane, status);
      } catch (error) {
        if (this.current(lane)) {
          if (error?.code === 'INVITATION_CONNECTION_REPLACED' || !this.voiceValid(lane)) {
            lane.state = 'connecting'; this.touch();
            if (!this.voiceValid(lane) && this.waitingToSpawn(lane)) this.refreshVoice(lane);
          } else this.fail(lane, ERRORS.connection);
        }
      }
      finally { lane.warming = null; }
    })();
  }
  acceptReadiness(lane, status) {
    const ready = status?.present === true && status.ready === true && !status.busy
      && (!this.waitingToSpawn(lane) || this.routeValid(lane));
    const state = ready ? 'ready' : 'connecting';
    if (state !== lane.state) { lane.state = state; this.touch(); }
    if (ready) {
      lane.readyAt ??= this.now(); lane.warmMs ??= this.now() - (lane.voiceReadyAt ?? lane.memoryReadyAt);
      lane.verifiedAt = this.now();
    }
  }
  async probe(lane) {
    if (!this.current(lane)) return;
    if (this.waitingToSpawn(lane) && !this.routeValid(lane)) { this.refreshRoute(lane); return; }
    // A fresh-state gap may have suspended preparation after a completed
    // memory/voice await. Resume its verified/cached work once the same selected
    // route returns; otherwise that lane would remain in "memory" forever.
    if (this.waitingToSpawn(lane) && lane.state === 'memory' && !lane.preparing && !lane.prepared) {
      this.prepare(lane); return;
    }
    if (!['ready', 'connecting'].includes(lane.state)) return;
    // A pending ticket is a promise about preparation before world appearance.
    // Already-spawned copies use bounded lazy reconditioning at speech time;
    // eagerly restoring every evicted active voice would thrash the LRU.
    if (this.waitingToSpawn(lane) && lane.voiceReceipt && !this.voiceValid(lane)) {
      this.refreshVoice(lane); return;
    }
    if (lane.state !== 'ready') return;
    const pending = (async () => {
      try {
        const status = await this.connections.invitationReadiness(lane.profileKey);
        if (this.current(lane)) this.acceptReadiness(lane, status);
      } catch { if (this.current(lane)) { lane.state = 'connecting'; this.touch(); } }
    })();
    lane.probing = pending;
    try { await pending; } finally { if (lane.probing === pending) lane.probing = null; }
  }
  async poll() {
    if (!this.fresh()) {
      await this.invalidate(this.stopped ? 'service-stopped' : 'world-or-request-expired').catch(() => {});
    } else {
      for (const lane of this.lanes.values()) if (!this.currentGuard(lane) && lane.state !== 'error') this.fail(lane, ERRORS.guard);
      // Probe existing ready pages. Memory verification and connection startup
      // remain background flights, so a paused menu receives progress promptly.
      await Promise.all([...this.lanes.values()].map(lane => this.probe(lane)));
      for (const lane of this.lanes.values()) if (lane.state === 'connecting' && !lane.preparing) this.warm(lane);
    }
    const value = this.snapshot();
    await this.publishSnapshot(value);
    return value;
  }
  snapshot() {
    const world = this.stopped ? null : this.world(), visible = this.fresh();
    return {version: 1, worldToken: world?.worldToken ?? null, generation: world?.generation ?? null,
      updated: this.now(), bridgePid: this.bridgePid,
      invitations: visible ? [...this.rows.values()].map(row => {
        const lane = row.lane;
        let state = lane?.state ?? row.state, error = lane?.error ?? row.error;
        if (lane && !this.currentGuard(lane) && state !== 'error') { state = 'error'; error = ERRORS.guard; }
        if (lane && row.phase === 'preparing' && state === 'ready'
            && (!this.voiceValid(lane) || !this.routeValid(lane))) state = 'connecting';
        return {id: row.id, revision: row.revision, modelKey: row.modelKey,
          ...(row.profileKey !== undefined ? {profileKey: row.profileKey} : {}), state,
          ...(state === 'error' ? {error} : {})};
      }) : []};
  }
  publishSnapshot(value) {
    this.publication?.abort();
    const controller = new AbortController(), version = this.version;
    this.publication = controller;
    const current = () => !controller.signal.aborted && this.version === version
      && JSON.stringify(this.snapshot().invitations) === JSON.stringify(value.invitations)
      && (value.worldToken === null ? (this.stopped || this.world() === null)
        : sameWorld(value, this.world()));
    return this.publish(value, {signal: controller.signal, isCurrent: current, isCurrentSync: current});
  }
  async clear(reason = 'cleared') {
    if (reason === 'service-stopped') this.stopped = true;
    await this.invalidate(reason).catch(() => {});
    const value = this.snapshot();
    await this.publishSnapshot(value);
    return value;
  }
  diagnostic() {
    return {updated: this.now(), lastClear: this.lastClear, stopped: this.stopped, reservations: this.reservations.length,
      invitations: [...this.rows.values()].map(row => {
        const lane = row.lane;
        return {id: row.id, revision: row.revision, state: this.snapshot().invitations.find(value => value.id === row.id)?.state ?? 'error',
          startedAt: row.startedAt, memoryReadyAt: lane?.memoryReadyAt, memoryMs: lane?.memoryMs,
          voiceReadyAt: lane?.voiceReadyAt, voiceMs: lane?.voiceMs, voiceProvider: lane?.voiceProvider,
          readyAt: lane?.readyAt ?? row.readyAt, warmMs: lane?.warmMs};
      })};
  }
}
