import {abortable} from './transport-pool.mjs';

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
  capacity: 'The party has no free conversation connection.',
  // Convai's sign-in backend refused or is limiting this installation (bridge/convai-credential.mjs), or its daily allowance is used up.
  signin: 'Convai sign-in is busy right now. Wait a few minutes, then invite again.',
  daily: 'The Convai daily limit is used up. Choose another provider in Settings, or invite again after it resets.'
});
// The game turns a failure into its own wording from this kind (mod/manager-party.lua); the English text above stays the
// fallback for a game that does not know a kind.
const ERROR_KIND = new Map(Object.entries(ERRORS).map(([kind, text]) => [text, kind]));
// Memory and voice preparations in flight at once. The party has no size limit; a larger burst of different
// characters queues here (state stays "memory") and starts as earlier ones finish, so the memory service
// and the voice worker never receive an unbounded stampede.
export const PREPARATION_LIMIT = 8;
// Preserve a bounded diagnostic reason, never arbitrary provider error text or
// identifiers. Otherwise a transient provider failure is indistinguishable from
// a broken local identity and cannot be diagnosed from the invitation log.
const PREPARATION_CODES = new Set(['CANCELLED', 'TIMEOUT', 'DISABLED', 'NOT_MOD_OWNED',
  'CHARACTER_MISMATCH', 'INVALID_RESPONSE', 'CONFIGURATION_DRIFT', 'HTTP_ERROR',
  'NETWORK_ERROR', 'RESPONSE_TOO_LARGE', 'ENABLE_UNVERIFIED', 'MEMORY_UNAVAILABLE',
  'STALE_TURN', 'MEMORY_CLEAR_PENDING', 'CLOSED', 'STORAGE_FAILURE', 'REGISTRY_CHANGED',
  'IDENTITY_CHANGED', 'INVITATION_CONNECTION_REPLACED', 'SIGNIN_RATE', 'SIGNIN_BUSY', 'SIGNIN_PAUSED', 'SIGNIN_DAILY',
  'SIGNIN_OUTDATED', 'SIGNIN_REFUSED', 'SIGNIN_UNREACHABLE', 'SIGNIN_OTHER', 'CAPACITY', 'GUARD', 'QUOTA_DAILY',
  'PREPARATION_FAILED']);
const AUTH_KINDS = new Set(['rate', 'busy', 'paused', 'daily', 'outdated', 'refused', 'unreachable']);
// A failed Convai sign-in (bridge/convai-credential.mjs unavailableError: "[convai-auth:<kind>]") or the daily allowance
// ("[convai-quota:daily]") reaches the connection lane as an error. Only the bounded kind is read, never the text.
export function preparationFailure(error) {
  const text = typeof error?.message === 'string' ? error.message : '';
  const auth = typeof error?.authKind === 'string' ? error.authKind : /\[convai-auth:(\w+)\]/.exec(text)?.[1];
  const quota = error?.name === 'TurnLimitError' ? error.kind : /\[convai-quota:(daily)\]/.exec(text)?.[1];
  if (auth === 'daily' || quota === 'daily') return {code: auth ? 'SIGNIN_DAILY' : 'QUOTA_DAILY', kind: 'daily'};
  if (auth) return {code: AUTH_KINDS.has(auth) ? 'SIGNIN_' + auth.toUpperCase() : 'SIGNIN_OTHER', kind: 'signin'};
  return {code: PREPARATION_CODES.has(error?.code) ? error.code : 'PREPARATION_FAILED', kind: null};
}

export function parseCompanionInvitations(value, now = Date.now(), staleMs = 6500) {
  if (!object(value) || value.version !== 1 || !token(value.worldToken) || !integer(value.generation) || value.generation < 1
      || !integer(value.updated) || value.updated > now + 5000 || now - value.updated > staleMs
      || !Array.isArray(value.invitations)) return null;
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
    publish = async () => {}, now = Date.now, staleMs = 6500, bridgePid = process.pid,
    // textProvider(): the conversation provider the player has chosen is not Convai (Mistral, Local AI, Custom). It is read when a preparation
    // starts, so a provider switched in Settings applies to the very next invitation even while the switch itself waits for an idle
    // boundary. Such an invitation needs no Convai memory and no Convai token. connectionWanted(): false while a provider switch is
    // still pending, when a connection opened now would be on the provider about to be left; the invitation then needs none.
    // provider(): the chosen provider's name, for the log line only. log(line): one line for each failed preparation.
    textProvider = () => false, connectionWanted = () => true, provider = () => 'convai', log = () => {}}) {
    Object.assign(this, {memory, connections, currentWorld, isKnown, isCurrentGuard, prepareVoice, voiceCurrent, routeCurrent, publish, now, staleMs, bridgePid,
      textProvider, connectionWanted, provider, log});
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
  flag(read) { try { return read() === true; } catch { return false; } }
  // The provider facts a lane was prepared for; a change while the invitation still waits to spawn prepares it again.
  routeFacts() {
    const text = this.flag(this.textProvider);
    return {text, connectionless: !this.flag(this.connectionWanted)};
  }
  routeChanged(lane) {
    const facts = this.routeFacts();
    return facts.text !== lane.textRoute || facts.connectionless !== lane.connectionless;
  }
  // One bounded line per failed preparation: the character key (a validated token), the lane, the code and the provider name.
  report(lane, code) {
    try {
      const provider = String(this.provider());
      this.log(`Invitation preparation failed: character=${lane.profileKey} lane=${lane.stage} code=${code} provider=${/^[a-z]{1,16}$/.test(provider) ? provider : 'unknown'}`);
    } catch { /* a log line never fails an invitation */ }
  }
  fail(lane, error, code = lane.errorCode ?? 'PREPARATION_FAILED') {
    if (this.lanes.get(lane.profileKey) !== lane || lane.controller.signal.aborted) return;
    lane.errorCode = code; this.report(lane, code);
    lane.state = 'error'; lane.error = error; lane.controller.abort(); this.touch();
    void this.syncReservations().catch(() => {});
  }
  syncReservations() {
    const desired = [...this.lanes.values()].filter(lane => lane.prepared && !lane.connectionless && lane.state !== 'error' && this.current(lane))
      .map(lane => lane.profileKey);
    if (JSON.stringify(desired) === JSON.stringify(this.reservations)) return this.retention;
    this.reservations = desired;
    let result;
    try { result = this.connections.setInvitations(desired); }
    catch (error) { result = Promise.reject(error); }
    const captured = [...this.lanes.values()].filter(lane => desired.includes(lane.profileKey));
    this.retention = Promise.resolve(result);
    void this.retention.catch(() => {
      for (const lane of captured) if (this.current(lane)) this.fail(lane, ERRORS.capacity, 'CAPACITY');
    });
    return this.retention;
  }
  preparingCount() { return [...this.lanes.values()].filter(lane => lane.preparing).length; }
  startQueued() {
    for (const lane of this.lanes.values()) if (lane.queued) {
      if (!this.current(lane)) { lane.queued = false; continue; }
      if (this.preparingCount() >= PREPARATION_LIMIT) return;
      this.prepare(lane);
    }
  }
  prepare(lane) {
    if (lane.preparing) return;
    if (this.preparingCount() >= PREPARATION_LIMIT) { lane.queued = true; return; }
    lane.queued = false; lane.stage = 'memory';
    // The route this preparation is for. The memory facade reads the same provider at its call, right after this line.
    const facts = this.routeFacts(); lane.textRoute = facts.text; lane.connectionless = facts.connectionless;
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
        // 'convai' (the Convai voice, chosen) and 'text' (a chosen local voice that cannot run: replies are written) are receipts of a character that no
        // local worker speaks; neither names a profile.
        if (voice?.ready !== true || !['convai','text','pocket','omni'].includes(voice.provider)
            || (voice.provider !== 'convai' && voice.provider !== 'text' && voice.profile !== lane.profileKey)) throw Error('Unverified voice preparation');
        lane.voiceReadyAt = this.now(); lane.voiceMs = this.now() - lane.memoryReadyAt;
        lane.voiceProvider = voice.provider; lane.voiceReceipt = Object.freeze({...voice}); lane.stage = 'connection';
        // A cancelled shared enable can finish after its original caller has
        // gone away. The memory owner keeps that retirement obligation until
        // a current caller proves disposal. Re-read it here: another caller
        // may already have retired the old scopes after this receipt issued.
        // A text provider has no Convai pages to retire and no Convai memory to acknowledge (nothing is marked verified for it).
        if (!lane.textRoute && (this.memory.connectionRefreshRequired({profileKey: lane.profileKey, guard: lane.guard})
            || this.connections.needsRetirement(lane.profileKey))) {
          await this.connections.retireInvitation(lane.profileKey, {signal: lane.controller.signal});
          if (!this.current(lane)) return;
          await this.memory.acknowledgeConnectionRefresh({profileKey: lane.profileKey, guard: lane.guard});
          if (!this.current(lane)) return;
        }
        lane.prepared = true;
        if (lane.connectionless) {
          // Nothing to open: a provider switch is pending (or the chosen provider is a text one), so no Convai token is asked for.
          lane.state = 'ready'; lane.readyAt ??= this.now(); lane.warmMs ??= this.now() - (lane.voiceReadyAt ?? lane.memoryReadyAt);
          lane.verifiedAt = this.now(); this.touch();
          void this.syncReservations().catch(() => {});
          return;
        }
        lane.state = 'connecting'; this.touch();
        await abortable(this.syncReservations(), lane.controller.signal);
        if (this.current(lane)) this.warm(lane);
      } catch (error) {
        if (this.current(lane)) {
          // The provider changed while this preparation ran: it ran for the old one, so it runs again for the new one (once).
          if (this.routeChanged(lane) && !lane.reran) { lane.rerun = lane.reran = true; return; }
          const {code, kind} = preparationFailure(error);
          if (lane.stage === 'voice') this.fail(lane, ERRORS.voice, code);
          else if (kind) this.fail(lane, ERRORS[kind], code);
          else this.fail(lane, lane.stage === 'connection' || lane.prepared ? ERRORS.connection : ERRORS.memory, code);
        }
      } finally {
        lane.preparing = null;
        if (lane.rerun) { lane.rerun = false; if (this.current(lane)) this.prepare(lane); }
        this.startQueued();
      }
    })();
  }
  warm(lane) {
    if (!this.current(lane) || !lane.prepared || lane.connectionless || lane.state === 'error' || lane.warming || lane.probing
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
          } else {
            const {code, kind} = preparationFailure(error);
            lane.stage = 'connection';
            this.fail(lane, kind ? ERRORS[kind] : ERRORS.connection, code);
          }
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
    // The chosen provider changed since this lane was prepared and the copy has not spawned: prepare it for the new one.
    if (lane.prepared && !lane.preparing && this.waitingToSpawn(lane) && this.routeChanged(lane)) { this.refreshVoice(lane); return; }
    if (lane.connectionless) return;
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
        // While a profile invitation is in the memory state, `stage` says what it is waiting for: its turn in the queue,
        // the memory service or the voice model. The game shows it in the preparing notice; it grants nothing.
        const stage = state === 'memory' && lane ? (lane.queued ? 'queued' : lane.stage) : undefined;
        return {id: row.id, revision: row.revision, modelKey: row.modelKey,
          ...(row.profileKey !== undefined ? {profileKey: row.profileKey} : {}), state,
          ...(stage ? {stage} : {}),
          ...(state === 'error' ? {error, ...(ERROR_KIND.has(error) ? {errorKind: ERROR_KIND.get(error)} : {}),
            ...(lane?.errorCode ? {errorCode: lane.errorCode, errorStage: lane.stage} : {})} : {})};
      }) : []};
  }
  // The game-facing state file can be briefly locked by a reader on Windows. A failed write
  // keeps the previous file, reports false, and never rejects: the poll loop must go on
  // (it also drives the other bridge work) and the next poll writes the fresh snapshot.
  async publishSnapshot(value) {
    try { return await this.writeSnapshot(value); }
    catch (error) { this.publishFailures = (this.publishFailures ?? 0) + 1; this.lastPublishError = error?.code ?? 'WRITE_FAILED'; return false; }
  }
  writeSnapshot(value) {
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
    return {updated: this.now(), lastClear: this.lastClear, stopped: this.stopped,
      publishFailures: this.publishFailures ?? 0, lastPublishError: this.lastPublishError, reservations: this.reservations.length,
      invitations: [...this.rows.values()].map(row => {
        const lane = row.lane;
        return {id: row.id, revision: row.revision, state: this.snapshot().invitations.find(value => value.id === row.id)?.state ?? 'error',
          startedAt: row.startedAt, memoryReadyAt: lane?.memoryReadyAt, memoryMs: lane?.memoryMs,
          voiceReadyAt: lane?.voiceReadyAt, voiceMs: lane?.voiceMs, voiceProvider: lane?.voiceProvider,
          errorCode: lane?.errorCode, errorStage: lane?.errorCode ? lane.stage : undefined,
          readyAt: lane?.readyAt ?? row.readyAt, warmMs: lane?.warmMs};
      })};
  }
}
