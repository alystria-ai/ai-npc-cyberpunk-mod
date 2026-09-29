import {open} from 'node:fs/promises';
import {normalizeMemoryText} from './convai-memory.mjs';

const MAX_QUALIFICATION_BYTES = 128 * 1024;
const token = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const PROVIDER_POLICY = 'explicit-rest-anonymous-live-v1';
const profile = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value);
const ambient = new Set(['resident-male', 'resident-female']);
const copy = value => structuredClone(value);
const codeOf = error => typeof error?.code === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(error.code) ? error.code : 'SYNC_OPERATION_FAILED';
const failed = code => Object.assign(new Error(`Quest memory synchronization: ${code}`), {code});

function untilAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(failed('CANCELLED'));
  return new Promise((resolve, reject) => {
    const cancel = () => reject(failed('CANCELLED'));
    signal.addEventListener('abort', cancel, {once: true});
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}
function checkSignal(signal) { if (signal.aborted) throw failed('CANCELLED'); }

function validateQualification(value) {
  const checks = value?.checks;
  const required = ['separateProfileFields', 'memoryEnabledReadback', 'registeredUsersViaConnect',
    'newUsersEmpty', 'userAAddListGet', 'userBAddListGet', 'distinctUserLists'];
  if (value?.version !== 1 || value.completed !== true || value.cleanup?.profileAbsent !== true
      || required.some(name => checks?.[name] !== true)
      || !token(value.model) || checks.modelReadback !== value.model
      || ['A', 'B'].some(user => value.registration?.[user]?.identityEchoVerified !== true
        || value.registration?.[user]?.closed !== true || value.cleanup?.[user]?.recordsEmpty !== true)
      || ['crossUserGetA', 'crossUserGetB'].some(name => checks[name]?.denied !== true
        || ![403, 404].includes(checks[name]?.status))) throw failed('PROVIDER_NOT_QUALIFIED');
  const anonymous = value.anonymousLiveQualification;
  if (anonymous?.version !== 1 || anonymous.completed !== true || !token(anonymous.sourceRunId)
      || anonymous.model !== value.model || anonymous.usersReused !== true || anonymous.newEndUserIds !== 0
      || anonymous.mode !== 'memory-disabled-explicit-rest-v1' || anonymous.liveCharacterMemoryEnabled !== false
      || anonymous.explicitRestWithMemoryDisabled !== true
      || ['anonymousEchoNull','anonymousClosed','registrationEchoVerified','explicitRestVerified','profileAbsent']
        .some(field => anonymous[field] !== true)) throw failed('ANONYMOUS_MEMORY_POLICY_NOT_QUALIFIED');
  return {model: value.model, runId: token(value.runId) ? value.runId : null};
}

export async function readMemoryQualification(path) {
  if (typeof path !== 'string' || !path) throw failed('PROVIDER_QUALIFICATION_MISSING');
  let file;
  try {
    file = await open(path, 'r');
    const bytes = Buffer.alloc(MAX_QUALIFICATION_BYTES + 1); let size = 0;
    while (size < bytes.length) {
      const result = await file.read(bytes, size, bytes.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > MAX_QUALIFICATION_BYTES) throw failed('PROVIDER_QUALIFICATION_TOO_LARGE');
    return validateQualification(JSON.parse(bytes.subarray(0, size).toString('utf8').replace(/^\uFEFF/, '')));
  } catch (error) {
    if (error.code?.startsWith('PROVIDER_') || error.code === 'ANONYMOUS_MEMORY_POLICY_NOT_QUALIFIED') throw error;
    throw failed('PROVIDER_QUALIFICATION_UNAVAILABLE');
  } finally { await file?.close(); }
}

function entryScope(entry) {
  if (!entry || !token(entry.id) || !token(entry.endUserId) || !profile(entry.characterKey)
      || ambient.has(entry.characterKey) || !['pending', 'uncertain'].includes(entry.state)
      || !['private', 'group'].includes(entry.channel) || typeof entry.text !== 'string'
      || !normalizeMemoryText(entry.text) || entry.text.length > 3000 || !entry.guard) throw failed('INVALID_OUTBOX_ENTRY');
  if (entry.providerPolicy !== PROVIDER_POLICY || !uuid(entry.restEndUserId)) throw failed('REST_IDENTITY_NOT_BOUNDED');
  const audience = entry.channel === 'group' ? entry.audience : [entry.characterKey];
  if (!Array.isArray(audience) || audience.length < 1 || audience.length > 8
      || audience.some(key => !profile(key) || ambient.has(key)) || !audience.includes(entry.characterKey)
      || new Set(audience).size !== audience.length) throw failed('INVALID_OUTBOX_AUDIENCE');
  return {profileKey: entry.characterKey, channel: entry.channel, audience: [...audience].sort(),
    localScopeId: entry.endUserId, endUserId: entry.restEndUserId,
    providerPolicy: PROVIDER_POLICY, guard: copy(entry.guard)};
}

/**
 * Optional explicit projection worker. Does not own native cursors, create
 * episodes, enable character memory, schedule timers between pumps or retry
 * uncertain writes. Callbacks are injected so production remains off by default.
 */
export class QuestMemorySync {
  constructor({service, adapter, providerQualificationPath, resolveCharacter, registerScope,
    enabled = false, nativeQualified = false, maxEntries = 4, maxDurationMs = 15000,
    maxScanPages = 4, maxReadbackAgeMs = 5 * 60 * 1000, now = Date.now} = {}) {
    if (!service || ['guard', 'current', 'pendingCloud', 'sessionIdentity', 'isCurrent'].some(key => typeof service[key] !== 'function')
        || typeof now !== 'function' || !Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 16
        || !Number.isInteger(maxDurationMs) || maxDurationMs < 10 || maxDurationMs > 60000
        || !Number.isInteger(maxScanPages) || maxScanPages < 1 || maxScanPages > 20
        || !Number.isInteger(maxReadbackAgeMs) || maxReadbackAgeMs < 1000 || maxReadbackAgeMs > 24 * 60 * 60 * 1000) {
      throw failed('INVALID_CONFIGURATION');
    }
    Object.assign(this, {service, adapter, providerQualificationPath, resolveCharacter, registerScope,
      enabled: enabled === true, nativeQualified: nativeQualified === true,
      maxEntries, maxDurationMs, maxScanPages, maxReadbackAgeMs, now});
    this.closed = false; this.controller = null; this.running = null; this.last = null;
    this.pendingAfterId = undefined; this.uncertainAfterId = undefined; this.nextQueue = 'pending';
  }
  setPolicy({enabled = this.enabled, nativeQualified = this.nativeQualified} = {}) {
    this.enabled = enabled === true; this.nativeQualified = nativeQualified === true;
    if (!this.enabled || !this.nativeQualified) this.cancel();
  }
  cancel() { this.controller?.abort(); }
  _gate() {
    if (this.closed) return 'CLOSED';
    if (!this.enabled) return 'DISABLED';
    if (!this.nativeQualified) return 'NATIVE_NOT_QUALIFIED';
    if (this.service.cloudQualified !== true) return 'SERVICE_CLOUD_DISABLED';
    if (this.adapter?.enabled !== true) return 'ADAPTER_DISABLED';
    if (['add', 'scan', 'get'].some(name => typeof this.adapter[name] !== 'function')
        || typeof this.resolveCharacter !== 'function' || typeof this.registerScope !== 'function') return 'CALLBACKS_UNAVAILABLE';
    if (!this.service.guard() || !this.service.ledger) return 'NATIVE_IDENTITY_UNAVAILABLE';
    return null;
  }
  async _current(scope, signal) {
    checkSignal(signal);
    const gate = this._gate(); if (gate) throw failed(gate);
    if (!await untilAbort(this.service.current(scope.guard), signal)) throw failed('STALE_SCOPE');
    checkSignal(signal);
    const current = this.service.sessionIdentity(scope.profileKey, scope.channel, scope.audience);
    if (!current || current.localScopeId !== scope.localScopeId || current.restEndUserId !== scope.endUserId
        || current.providerPolicy !== PROVIDER_POLICY || !this.service.isCurrent(scope.guard)) throw failed('STALE_SCOPE');
  }
  _character(value, scope, qualification) {
    const verifiedAt = typeof value?.verifiedAt === 'number' ? value.verifiedAt : Date.parse(value?.verifiedAt);
    const age = this.now() - verifiedAt;
    if (!value || value.profileKey !== scope.profileKey || !token(value.characterId)
        || value.verified !== true || value.owned !== true || value.source !== 'convai-character-get'
        || value.memoryEnabled !== false || value.model !== qualification.model
        || !Number.isFinite(age) || age < -1000 || age > this.maxReadbackAgeMs) throw failed('CHARACTER_NOT_VERIFIED');
    return {characterId: value.characterId, profileKey: value.profileKey, model: value.model};
  }
  async _register(character, scope, signal, registered) {
    const key = JSON.stringify([character.characterId, scope.endUserId]);
    if (registered.has(key)) return;
    await this._current(scope, signal);
    const result = await untilAbort(Promise.resolve().then(() => this.registerScope({
      ...copy(scope), characterId: character.characterId, signal})), signal);
    checkSignal(signal);
    if (result?.ready !== true || result.registration?.verified !== true
        || result.registration.characterId !== character.characterId
        || result.registration.endUserId !== scope.endUserId) throw failed('REGISTRATION_NOT_VERIFIED');
    await this._current(scope, signal); registered.add(key);
  }
  async _reconcile(entry, character, scope, signal) {
    if (!token(entry.characterId) || entry.characterId !== character.characterId) throw failed('CHARACTER_BINDING_CHANGED');
    if (entry.restEndUserId !== scope.endUserId) throw failed('REST_IDENTITY_BINDING_CHANGED');
    await this._current(scope, signal);
    const scan = await untilAbort(this.adapter.scan({characterId: character.characterId,
      endUserId: scope.endUserId, maxPages: this.maxScanPages, signal}), signal);
    if (scan?.characterId !== character.characterId || scan.endUserId !== scope.endUserId
        || !Array.isArray(scan.memories) || scan.memories.length > this.maxScanPages * 100
        || typeof scan.complete !== 'boolean') throw failed('INVALID_RECONCILIATION_SCOPE');
    const expected = normalizeMemoryText(entry.text), matches = scan.memories.filter(row => token(row?.id)
      && normalizeMemoryText(row.memory) === expected).slice(0, 4);
    const verified = [];
    for (const match of matches) {
      await this._current(scope, signal);
      const actual = await untilAbort(this.adapter.get({characterId: character.characterId,
        endUserId: scope.endUserId, memoryId: match.id, signal}), signal);
      if (actual?.id !== match.id || normalizeMemoryText(actual.memory) !== expected) throw failed('RECONCILIATION_RECORD_MISMATCH');
      verified.push({id: actual.id, memory: actual.memory});
      break; // One exact positive receipt is sufficient; no duplicate insertion.
    }
    // A read may finish just as a save loads. Reconciliation still applies
    // solely to this old entry/pair; it cannot enqueue or acknowledge a child.
    const result = await this.service.ledger.reconcile(entry.id, {characterId: character.characterId,
      endUserId: scope.endUserId, memories: verified, complete: scan.complete});
    return {state: result.state, matched: result.matched,
      obsolete: !this.service.isCurrent(scope.guard), retryAllowed: false};
  }
  async _write(entry, character, scope, signal) {
    await this._current(scope, signal);
    const lease = await this.service.ledger.claim(entry.id, {characterId: character.characterId, restEndUserId: scope.endUserId});
    let dispatched = false;
    try {
      await this._current(scope, signal);
      // No asynchronous gap between the final current check and invocation.
      checkSignal(signal); dispatched = true;
      const receipt = await untilAbort(this.adapter.add({characterId: character.characterId,
        endUserId: scope.endUserId, memories: [lease.text], signal}), signal);
      // Always preserve an accepted receipt against its original lease, even
      // when a branch changed after POST. Never replace it with a fresh guard.
      const settled = await this.service.ledger.acknowledge(lease, {characterId: character.characterId,
        endUserId: scope.endUserId, memories: receipt.memories});
      return {state: settled.state, obsolete: !settled.active || !this.service.isCurrent(scope.guard)};
    } catch (error) {
      const ambiguous = dispatched && error.writeUncertain !== false;
      await this.service.ledger.fail(lease, {ambiguous, code: codeOf(error)});
      return {state: ambiguous ? 'uncertain' : 'failed', reason: codeOf(error),
        obsolete: !this.service.isCurrent(scope.guard)};
    }
  }
  async _pump(signal) {
    const started = this.now();
    const result = {status: 'idle', processed: 0, acknowledged: 0, uncertain: 0,
      reconciled: 0, skipped: 0, failed: 0, obsolete: 0, reasons: [], model: null, touchedScopes: []};
    const reason = code => { if (!result.reasons.includes(code)) result.reasons.push(code); };
    try {
      const gate = this._gate(); if (gate) { result.status = 'disabled'; reason(gate); return result; }
      const qualification = await untilAbort(readMemoryQualification(this.providerQualificationPath), signal);
      result.model = qualification.model;
      const registered = new Set();
      // Alternate new projections and uncertain reads. Cursor rotation also
      // keeps an unmapped profile or permanent 404 from blocking later work.
      const queues = {
        pending: this.service.pendingCloud({limit:this.maxEntries,afterId:this.pendingAfterId}),
        uncertain: this.service.pendingCloud({limit:this.maxEntries,includeUncertain:true,
          onlyUncertain:true,afterId:this.uncertainAfterId})
      };
      const entries = []; let next = this.nextQueue;
      while (entries.length < this.maxEntries && (queues.pending.length || queues.uncertain.length)) {
        const queue = queues[next].length ? next : next === 'pending' ? 'uncertain' : 'pending';
        entries.push(copy(queues[queue].shift())); next = queue === 'pending' ? 'uncertain' : 'pending';
      }
      for (const entry of entries) {
        checkSignal(signal); const gate = this._gate(); if (gate) throw failed(gate);
        if (entry.state === 'uncertain') this.uncertainAfterId = entry.id;
        else this.pendingAfterId = entry.id;
        this.nextQueue = entry.state === 'uncertain' ? 'pending' : 'uncertain';
        result.processed++;
        try {
          const scope = entryScope(entry);
          await this._current(scope, signal);
          const character = this._character(await untilAbort(Promise.resolve().then(() =>
            this.resolveCharacter(scope.profileKey, {signal})), signal), scope, qualification);
          await this._current(scope, signal);
          await this._register(character, scope, signal, registered);
          const outcome = entry.state === 'uncertain'
            ? await this._reconcile(entry, character, scope, signal)
            : await this._write(entry, character, scope, signal);
          if (outcome.state === 'acknowledged') {
            result.acknowledged++; if (entry.state === 'uncertain') result.reconciled++;
            if (!result.touchedScopes.some(row => row.characterId === character.characterId && row.endUserId === scope.endUserId)) {
              result.touchedScopes.push({...copy(scope),characterId:character.characterId,obsolete:outcome.obsolete});
            }
          }
          else if (outcome.state === 'uncertain') result.uncertain++;
          else result.failed++;
          if (outcome.obsolete) result.obsolete++;
          if (outcome.reason) reason(outcome.reason);
        } catch (error) {
          result.skipped++; reason(codeOf(error));
          if (signal.aborted || !this.service.isCurrent(entry.guard)) break;
        }
      }
      result.status = signal.aborted ? 'cancelled' : result.processed ? 'complete' : 'idle';
    } catch (error) {
      result.status = signal.aborted ? 'cancelled' : 'blocked'; reason(codeOf(error));
    } finally { result.durationMs = Math.max(0, this.now() - started); }
    return result;
  }
  pump({signal} = {}) {
    if (this.running) return Promise.resolve({status: 'busy', processed: 0});
    const controller = new AbortController(); this.controller = controller;
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), this.maxDurationMs);
    this.running = this._pump(combined).then(result => { this.last = copy(result); return result; }).finally(() => {
      clearTimeout(timer); this.running = null; this.controller = null;
    });
    return this.running;
  }
  status() { return {enabled: this.enabled, nativeQualified: this.nativeQualified, running: !!this.running,
    closed: this.closed, last: this.last ? copy(this.last) : null}; }
  async close() { this.closed = true; this.cancel(); await this.running; }
}
