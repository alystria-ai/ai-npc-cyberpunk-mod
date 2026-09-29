import {createHash, randomUUID} from 'node:crypto';
import {mkdir, open, readFile, rename, unlink} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {normalizeMemoryText} from './convai-memory.mjs';

const SCHEMA = 'cyberpunk-quest-memory/v1';
const LIMITS = Object.freeze({fileBytes: 32 * 1024 * 1024, episodes: 50000, branches: 256, outbox: 100000});
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/.test(value);
const profile = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value);
const own = (value, key) => Object.hasOwn(value, key);
const clone = value => structuredClone(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : plain(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const branchKey = (campaignId, branchId) => digest([campaignId, branchId]);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);

export class QuestMemoryError extends Error {
  constructor(code) { super(`Quest memory: ${code}`); this.name = 'QuestMemoryError'; this.code = code; }
}
const fail = code => { throw new QuestMemoryError(code); };
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function checkedJson(value, limit = 32000) {
  let raw;
  try { raw = JSON.stringify(value); } catch { fail('INVALID_EVENT_DATA'); }
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > limit) fail('INVALID_EVENT_DATA');
  return JSON.parse(raw);
}
function profiles(value, {empty = false} = {}) {
  if (!Array.isArray(value) || value.length > 80 || (!empty && !value.length) || value.some(p => !profile(p))) fail('INVALID_AUDIENCE');
  return [...new Set(value)].sort();
}
function identityInput(value, userId) {
  if (!plain(value) || !(value.authoritative === true || value.status === 'verified')) fail('IDENTITY_UNVERIFIED');
  const campaignId = value.campaignId ?? value.playthroughId;
  if (value.campaignId && value.playthroughId && value.campaignId !== value.playthroughId) fail('IDENTITY_CONFLICT');
  if (!id(campaignId) || !id(value.branchId) || !id(value.checkpointId)) fail('INVALID_IDENTITY');
  if (value.userId !== undefined && value.userId !== userId) fail('USER_MISMATCH');
  if (value.parentBranchId !== undefined && !id(value.parentBranchId)) fail('INVALID_PARENT');
  if (value.forkCheckpointId !== undefined && !id(value.forkCheckpointId)) fail('INVALID_PARENT');
  if (!!value.parentBranchId !== !!value.forkCheckpointId) fail('INVALID_PARENT');
  if (value.forkLedgerSequence !== undefined && (!Number.isSafeInteger(value.forkLedgerSequence) || value.forkLedgerSequence < 0)) fail('INVALID_PARENT');
  if (value.resume === true && (!Number.isSafeInteger(value.ledgerSequence) || value.ledgerSequence < 0)) fail('INVALID_RESUME_CURSOR');
  if (value.currentPrefixProof && (!value.parentBranchId || value.forkLedgerSequence === undefined
      || value.restoredProof || value.resume === true)) fail('INVALID_CURRENT_PREFIX_PROOF');
  return {campaignId, branchId: value.branchId, checkpointId: value.checkpointId,
    ...(value.parentBranchId ? {parentBranchId: value.parentBranchId, forkCheckpointId: value.forkCheckpointId,
      forkLedgerSequence: value.forkLedgerSequence} : {}),
    ...(value.restoredProof ? {restoredProof: checkedJson(value.restoredProof, 2000)} : {}),
    ...(value.currentPrefixProof ? {currentPrefixProof: checkedJson(value.currentPrefixProof, 2000)} : {}),
    ...(value.resume === true ? {resume: true, ledgerSequence: value.ledgerSequence} : {})};
}
function sameIdentity(eventIdentity, active, userId) {
  const value = identityInput(eventIdentity, userId);
  return value.campaignId === active.campaignId && value.branchId === active.branchId && value.checkpointId === active.checkpointId;
}
function normalizeEvent(value, active, userId) {
  if (!plain(value) || !id(value.eventId) || !id(value.factId ?? value.topic)) fail('INVALID_EVENT');
  if (!sameIdentity(value.identity, active, userId)) fail('STALE_EVENT_IDENTITY');
  if (!['decision', 'shared-experience', 'player-statement', 'transport-activity'].includes(value.kind)
      || !['game-state', 'delivered-conversation', 'player-statement', 'transport-event'].includes(value.authority)
      || !['private', 'group-safe'].includes(value.visibility)) fail('INVALID_EVENT_AUTHORITY');
  if ((value.kind === 'decision') !== (value.authority === 'game-state')
      || (value.kind === 'player-statement') !== (value.authority === 'player-statement')
      || (value.kind === 'transport-activity') !== (value.authority === 'transport-event')
      || (value.kind === 'transport-activity' && value.eligibleForMemory === true)) fail('INVALID_EVENT_AUTHORITY');
  if (value.stable !== true) fail('UNSTABLE_EVENT');
  const text = normalizeMemoryText(value.text);
  if (!text || text.length > 3000) fail('INVALID_EVENT_TEXT');
  const knownBy = profiles(value.knownBy), witnessedBy = profiles(value.witnessedBy ?? [], {empty: true});
  const audience = profiles(value.audience ?? knownBy);
  if (witnessedBy.some(p => !knownBy.includes(p))) fail('WITNESS_NOT_IN_AUDIENCE');
  if (value.characterKey !== undefined && (!profile(value.characterKey) || !knownBy.includes(value.characterKey))) fail('INVALID_AUDIENCE');
  if (!Array.isArray(value.evidence) || !value.evidence.length || value.evidence.length > 32
      || value.evidence.some(row => !plain(row))) fail('MISSING_EVIDENCE');
  if (!plain(value.provenance)) fail('MISSING_PROVENANCE');
  const delivery = value.delivery ? checkedJson(value.delivery, 2000) : undefined;
  if (value.authority === 'delivered-conversation' && (!delivery || !id(delivery.requestId)
      || delivery.state !== 'played' || !witnessedBy.length)) fail('DELIVERY_NOT_CONFIRMED');
  const supersedes = value.supersedes ?? [];
  if (!Array.isArray(supersedes) || supersedes.length > 32 || supersedes.some(v => !id(v))) fail('INVALID_SUPERSESSION');
  // Snapshot/generation/timestamps are evidence, not dedupe identity. Copies of
  // the same canonical character must not duplicate a decision episode.
  return {eventId: value.eventId, factId: value.factId ?? value.topic,
    kind: value.kind, authority: value.authority, text, knownBy, witnessedBy, audience, visibility: value.visibility,
    eligibleForMemory: value.eligibleForMemory === true,
    outcome: value.outcome === undefined ? null : checkedJson(value.outcome, 2000),
    evidence: checkedJson(value.evidence), provenance: checkedJson(value.provenance),
    ...(delivery ? {delivery} : {}), supersedes: [...new Set(supersedes)].sort()};
}
const eventFingerprint = event => digest([event.factId, event.kind, event.authority, event.text, event.knownBy,
  event.witnessedBy, event.audience, event.visibility, event.eligibleForMemory, event.outcome, event.provenance, event.supersedes]);
function groupAudience(value) {
  const result = profiles(value);
  if (result.length > 8) fail('INVALID_AUDIENCE');
  return result;
}
// Historical endUserId fields below are LOCAL scope keys. They must never be
// sent to Convai. The bounded provider registry supplies a separate stable UUID.
const namespace = (state, branch, channel, audience) => 'cp2077-' + digest([1, state.userId, state.remoteGeneration,
  branch.campaignId, branch.branchId, channel === 'group' ? ['group', groupAudience(audience)] : 'private']);
const shareable = (event, audience) => event.visibility === 'group-safe' && audience.every(key => event.audience.includes(key));

function encode(state) {
  return JSON.stringify({schema: SCHEMA, checksum: digest(state), data: state});
}
function validateState(state) {
  if (!plain(state) || state.version !== 1 || !uuid(state.userId) || !uuid(state.remoteGeneration)
      || !Number.isSafeInteger(state.revision) || state.revision < 0
      || !plain(state.branches) || !plain(state.events) || !plain(state.outbox)) fail('CORRUPT_LEDGER');
  if (Object.keys(state.branches).length > LIMITS.branches || Object.keys(state.events).length > LIMITS.episodes
      || Object.keys(state.outbox).length > LIMITS.outbox) fail('LEDGER_LIMIT');
  for (const [key, branch] of Object.entries(state.branches)) {
    if (!id(branch.campaignId) || !id(branch.branchId) || key !== branchKey(branch.campaignId, branch.branchId)
        || !Number.isSafeInteger(branch.inheritedCount) || branch.inheritedCount < 0 || branch.inheritedCount > branch.events?.length
        || !Array.isArray(branch.events) || !Array.isArray(branch.checkpoints)
        || !Array.isArray(branch.groups) || branch.groups.some(group => !Array.isArray(group) || group.length < 1 || group.length > 8 || group.some(p => !profile(p)))
        || !branch.checkpoints.length || new Set(branch.events).size !== branch.events.length) fail('CORRUPT_LEDGER');
    let previous = -1;
    for (const point of branch.checkpoints) {
      if (!id(point.id) || !Number.isInteger(point.index) || point.index < previous || point.index > branch.events.length
          || typeof point.verified !== 'boolean') fail('CORRUPT_LEDGER');
      previous = point.index;
    }
    if (new Set(branch.checkpoints.map(c => c.id)).size !== branch.checkpoints.length) fail('CORRUPT_LEDGER');
    for (const event of branch.events) if (!own(state.events, event)) fail('CORRUPT_LEDGER');
  }
  for (const [eventId, event] of Object.entries(state.events)) {
    if (event.id !== eventId || !id(event.eventId) || typeof event.text !== 'string' || !event.text
        || !Array.isArray(event.knownBy) || event.knownBy.some(p => !profile(p))
        || !Array.isArray(event.audience) || event.audience.some(p => !profile(p))
        || !['private', 'group-safe'].includes(event.visibility)) fail('CORRUPT_LEDGER');
  }
  for (const [entryId, entry] of Object.entries(state.outbox)) {
    if (entry.id !== entryId || !own(state.branches, entry.branchKey) || !own(state.events, entry.episodeId)
        || !profile(entry.characterKey) || !id(entry.endUserId)
        || (entry.restEndUserId !== undefined && !uuid(entry.restEndUserId))
        || !['pending', 'in-flight', 'uncertain', 'acknowledged', 'failed', 'retired'].includes(entry.state)) fail('CORRUPT_LEDGER');
  }
  return state;
}
function decode(raw) {
  try {
    const envelope = JSON.parse(raw);
    if (envelope.schema !== SCHEMA || envelope.checksum !== digest(envelope.data)) fail('CORRUPT_LEDGER');
    return validateState(envelope.data);
  } catch (error) { if (error instanceof QuestMemoryError) throw error; fail('CORRUPT_LEDGER'); }
}
async function atomicWrite(path, raw) {
  const temp = path + '.tmp-' + randomUUID();
  let handle;
  try {
    handle = await open(temp, 'wx'); await handle.writeFile(raw, 'utf8'); await handle.sync(); await handle.close(); handle = null;
    for (let attempt = 0; ; attempt++) {
      try { await rename(temp, path); break; }
      catch (error) {
        if (attempt >= 3 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        await new Promise(done => setTimeout(done, 20));
      }
    }
  } finally { await handle?.close().catch(() => {}); await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function readOptional(path) {
  try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function acquireLock(path) {
  const lockPath = path + '.lock', token = JSON.stringify({pid: process.pid, nonce: randomUUID()});
  try {
    const file = await open(lockPath, 'wx');
    try { await file.writeFile(token); await file.sync(); } finally { await file.close(); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Serialize dead-owner recovery too. Without a second exclusive guard,
    // two reclaimers could both read a stale lock and delete a new owner's
    // replacement between the compare and unlink operations.
    const guardPath = lockPath + '.reclaim';
    let guard;
    try { guard = await open(guardPath, 'wx'); }
    catch (guardError) { if (guardError.code === 'EEXIST') fail('LOCK_RECOVERY_BUSY'); throw guardError; }
    try {
      await guard.writeFile(token); await guard.sync();
      // Do not guess from age: a suspended live writer still owns it.
      let old;
      try { old = JSON.parse(await readFile(lockPath, 'utf8')); } catch { fail('LOCK_UNVERIFIED'); }
      if (!Number.isInteger(old.pid) || old.pid < 1) fail('LOCK_UNVERIFIED');
      try { process.kill(old.pid, 0); fail('LEDGER_LOCKED'); }
      catch (status) { if (status.code !== 'ESRCH') throw status; }
      if (await readFile(lockPath, 'utf8') !== JSON.stringify(old)) fail('LOCK_CHANGED');
      await unlink(lockPath);
      // A normal exclusive opener may win this race; that remains a lock
      // failure. Do not recursively reclaim its replacement.
      let replacement;
      try { replacement = await open(lockPath, 'wx'); }
      catch (replacementError) { if (replacementError.code === 'EEXIST') fail('LEDGER_LOCKED'); throw replacementError; }
      try { await replacement.writeFile(token); await replacement.sync(); } finally { await replacement.close(); }
    } finally { await guard.close(); await unlink(guardPath); }
  }
  return async () => { if (await readOptional(lockPath) === token) await unlink(lockPath); };
}
function emptyState() {
  return {version: 1, userId: randomUUID(), remoteGeneration: randomUUID(), revision: 0,
    branches: {}, events: {}, outbox: {}};
}
function visibleEvents(state, branch, end = branch.events.length) {
  const rows = branch.events.slice(0, end).map(key => state.events[key]);
  const superseded = new Set(rows.flatMap(row => row.supersedes));
  return rows.filter(row => !superseded.has(row.eventId) && !superseded.has(row.id));
}
const sealedPoint = branch => branch.checkpoints.filter(point => point.verified).at(-1);
const sequence = branch => branch.events.length - branch.inheritedCount;
const factRuntimeId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value) && value !== '0'.repeat(32);
const positiveInt32 = value => Number.isInteger(value) && value >= 1 && value <= 2147483647;
function currentPrefixIndex(branch, proof, expectedSequence) {
  if (!plain(proof) || proof.kind !== 'native-facts-current-prefix' || proof.source !== 'quest-facts-v1'
      || proof.campaignId !== branch.campaignId || proof.branchId !== branch.branchId
      || !factRuntimeId(proof.runtimeId)
      || !Number.isSafeInteger(proof.branchEpoch) || proof.branchEpoch < 1 || proof.branchEpoch > 2147483647
      || !Number.isSafeInteger(proof.ledgerSequence) || proof.ledgerSequence < 0
      || proof.ledgerSequence !== expectedSequence || proof.ledgerSequence > sequence(branch)
      || !Number.isSafeInteger(proof.commitGeneration) || proof.commitGeneration < 1 || proof.commitGeneration > 1073741823
      || !Number.isSafeInteger(proof.factHead) || proof.factHead < 2 || proof.factHead > 2147483647
      || Math.floor(proof.factHead / 2) !== proof.commitGeneration) fail('INVALID_CURRENT_PREFIX_PROOF');
  return branch.inheritedCount + proof.ledgerSequence;
}
function factsRestoredProof(branch, proof) {
  return proof.version === 1 && proof.kind === 'native-facts-restored' && proof.factSchema === 1
    && proof.source === 'PlayerSystem.OnGameRestored' && proof.campaignId === branch.campaignId
    && factRuntimeId(proof.runtimeId) && positiveInt32(proof.branchEpoch) && positiveInt32(proof.loadGeneration)
    && Number.isInteger(proof.commitGeneration) && proof.commitGeneration >= 1 && proof.commitGeneration <= 1073741823
    && [0,1].includes(proof.bank) && proof.factHead === 2 * proof.commitGeneration + proof.bank
    && proof.checkpointId === `${proof.branchId}:${proof.commitGeneration}:${proof.ledgerSequence}`;
}
function recordRestoredProof(branch, proof) {
  const originalNativeProof = plain(proof) && proof.kind === 'native-on-restored'
    && proof.source === undefined && proof.factSchema === undefined && proof.commitGeneration === undefined;
  if (!plain(proof) || !(originalNativeProof || factsRestoredProof(branch, proof)) || proof.branchId !== branch.branchId
      || !id(proof.checkpointId) || !Number.isSafeInteger(proof.ledgerSequence) || proof.ledgerSequence < 0
      || proof.ledgerSequence > sequence(branch)) fail('CHECKPOINT_NOT_PROVEN');
  const index = branch.inheritedCount + proof.ledgerSequence;
  const existing = branch.checkpoints.find(point => point.id === proof.checkpointId);
  if (existing && existing.index !== index) fail('CHECKPOINT_IMMUTABLE');
  if (existing) { existing.verified = true; existing.proof = clone(proof); }
  else {
    branch.checkpoints.push({id: proof.checkpointId, index, verified: true, proof: clone(proof)});
    branch.checkpoints.sort((a, b) => a.index - b.index);
  }
  return existing ?? branch.checkpoints.find(point => point.id === proof.checkpointId);
}
function enqueueSealed(state, branch, key, now) {
  const checkpoint = sealedPoint(branch), end = checkpoint?.index ?? 0;
  for (const event of visibleEvents(state, branch, end)) {
    if (!event.eligibleForMemory) continue;
    for (const characterKey of event.knownBy) {
      const scopes = [{channel: 'private'}];
      for (const audience of branch.groups) if (audience.includes(characterKey) && shareable(event, audience)) scopes.push({channel: 'group', audience});
      for (const {channel, audience} of scopes) {
        const endUserId = namespace(state, branch, channel, audience), entryId = digest([endUserId, characterKey, event.id]);
        if (own(state.outbox, entryId)) continue;
        if (Object.keys(state.outbox).length >= LIMITS.outbox) fail('OUTBOX_LIMIT');
        state.outbox[entryId] = {id: entryId, branchKey: key, episodeId: event.id, characterKey, channel, endUserId,
          ...(audience ? {audience} : {}),
          checkpointId: checkpoint.id, state: 'pending', attempts: 0, createdAt: now};
      }
    }
  }
  // Supersession does not delete a remote record. Already submitted records
  // retain their receipt for a later explicit correction policy.
  const active = new Set(visibleEvents(state, branch).map(row => row.id));
  for (const entry of Object.values(state.outbox)) {
    if (entry.branchKey === key && !active.has(entry.episodeId) && ['pending', 'failed'].includes(entry.state)) entry.state = 'retired';
  }
}

export class QuestMemoryLedger {
  static async load({path, now = Date.now} = {}) {
    if (typeof path !== 'string' || !path || typeof now !== 'function') fail('INVALID_CONFIGURATION');
    path = resolve(path); await mkdir(dirname(path), {recursive: true});
    const unlock = await acquireLock(path);
    try {
      const primary = await readOptional(path), backup = await readOptional(path + '.bak');
      let state, recovered = false;
      if (primary !== null) {
        if (Buffer.byteLength(primary) > LIMITS.fileBytes) fail('LEDGER_LIMIT');
        try { state = decode(primary); } catch { recovered = true; }
      }
      if (!state && backup !== null) {
        if (Buffer.byteLength(backup) > LIMITS.fileBytes) fail('LEDGER_LIMIT');
        state = decode(backup); recovered = true;
      }
      if (!state && primary !== null) fail('RECOVERY_UNAVAILABLE');
      state ??= emptyState();
      let changed = primary === null;
      if (recovered) {
        // An older backup cannot prove that no newer remote memories exist.
        // Preserve the local user and rotate every remote namespace instead.
        state.remoteGeneration = randomUUID();
        for (const entry of Object.values(state.outbox)) entry.state = 'retired';
        state.recoveredAt = now(); changed = true;
      }
      for (const entry of Object.values(state.outbox)) if (entry.state === 'in-flight') {
        entry.state = 'uncertain'; entry.failure = 'process-interrupted'; changed = true;
      }
      const ledger = new QuestMemoryLedger(path, state, unlock, now);
      ledger._persisted = !recovered && primary !== null ? primary : undefined;
      ledger.recovered = recovered;
      if (changed) { state.revision++; await ledger._persist(state, {preserveBackup: recovered}); }
      return ledger;
    } catch (error) { await unlock(); throw error; }
  }
  constructor(path, state, unlock, now) {
    Object.assign(this, {path, _state: state, _unlock: unlock, now});
    this._chain = Promise.resolve(); this._epoch = 0; this._active = null; this._closed = false;
  }
  get userId() { return this._state.userId; }
  get identity() {
    if (!this._active) return null;
    const branch = this._state.branches[this._active.key];
    return {...this._active, status: 'verified', userId: this.userId, playthroughId: branch.campaignId,
      ledgerSequence: sequence(branch), remoteGeneration: this._state.remoteGeneration,
      endUserId: namespace(this._state, branch, 'private'), epoch: this._epoch};
  }
  _enqueue(work) {
    const result = this._chain.then(() => { if (this._closed) fail('CLOSED'); return work(); });
    this._chain = result.catch(() => {}); return result;
  }
  async _persist(state, {preserveBackup = false} = {}) {
    const raw = encode(state);
    if (Buffer.byteLength(raw) > LIMITS.fileBytes) fail('LEDGER_LIMIT');
    if (!preserveBackup && this._persisted) await atomicWrite(this.path + '.bak', this._persisted);
    await atomicWrite(this.path, raw); this._persisted = raw;
  }
  _transaction(mutate, expectedEpoch) {
    return this._enqueue(async () => {
      if (expectedEpoch !== undefined && (!this._active || expectedEpoch !== this._epoch)) fail('STALE_LEASE');
      const state = clone(this._state), outcome = mutate(state);
      if (outcome.changed !== false) {
        state.revision++; validateState(state); await this._persist(state); this._state = state;
      }
      if (outcome.binding !== undefined) { this._active = outcome.binding; this._epoch++; }
      return typeof outcome.result === 'function' ? outcome.result() : clone(outcome.result);
    });
  }
  bindIdentity(value) {
    const input = identityInput(value, this.userId), key = branchKey(input.campaignId, input.branchId);
    return this._transaction(state => {
      let branch = own(state.branches, key) ? state.branches[key] : null;
      if (branch && input.currentPrefixProof) fail('CURRENT_PREFIX_REQUIRES_NEW_BRANCH');
      if (!branch) {
        if (input.resume) fail('RESUME_BRANCH_NOT_FOUND');
        if (Object.keys(state.branches).length >= LIMITS.branches) fail('BRANCH_LIMIT');
        let inherited = [], parent = null, inheritedProof, inheritedVerified = false;
        if (input.parentBranchId) {
          const parentKey = branchKey(input.campaignId, input.parentBranchId), source = state.branches[parentKey];
          if (!source) fail('PARENT_NOT_FOUND');
          if (input.currentPrefixProof) {
            const end = currentPrefixIndex(source, input.currentPrefixProof, input.forkLedgerSequence);
            inherited = source.events.slice(0, end);
            parent = {branchKey: parentKey, checkpointId: input.forkCheckpointId,
              kind: 'native-facts-current-prefix', ledgerSequence: input.forkLedgerSequence};
            inheritedProof = clone(input.currentPrefixProof);
            // A current tuple identifies a local prefix, never proves a save.
            // Keep the source's genuine old checkpoints without transferring
            // their seal to this unknown-origin child's inherited records.
          } else {
            if (input.restoredProof) recordRestoredProof(source, input.restoredProof);
            const checkpoint = source.checkpoints.find(c => c.id === input.forkCheckpointId);
            if (!checkpoint?.verified) fail('CHECKPOINT_NOT_PROVEN');
            if (input.forkLedgerSequence !== undefined && checkpoint.index !== source.inheritedCount + input.forkLedgerSequence) fail('IDENTITY_CONFLICT');
            inherited = source.events.slice(0, checkpoint.index); parent = {branchKey: parentKey, checkpointId: checkpoint.id};
            inheritedProof = clone(checkpoint.proof ?? {kind: 'inherited-restored-prefix', parent});
            inheritedVerified = true;
          }
        }
        branch = state.branches[key] = {campaignId: input.campaignId, branchId: input.branchId, parent,
          inheritedCount: inherited.length, events: inherited, groups: [],
          checkpoints: [{id: input.checkpointId, index: inherited.length, verified: inheritedVerified,
            ...(inheritedProof ? {proof: inheritedProof} : {})}], createdAt: this.now()};
        if (!parent && input.restoredProof) recordRestoredProof(branch, input.restoredProof);
      } else {
        if (input.restoredProof) recordRestoredProof(branch, input.restoredProof);
        const checkpoint = branch.checkpoints.find(c => c.id === input.checkpointId);
        if (!checkpoint && !input.resume) fail('CHECKPOINT_NOT_FOUND');
        if (input.resume) {
          if (input.ledgerSequence !== sequence(branch)) fail('RESUME_CURSOR_MISMATCH');
        } else if (checkpoint.index !== branch.events.length) fail('BRANCH_REQUIRED');
        if (input.parentBranchId && (branch.parent?.branchKey !== branchKey(input.campaignId, input.parentBranchId)
            || branch.parent?.checkpointId !== input.forkCheckpointId)) fail('IDENTITY_CONFLICT');
      }
      enqueueSealed(state, branch, key, this.now());
      return {binding: {key, campaignId: input.campaignId, branchId: input.branchId, checkpointId: input.checkpointId},
        result: () => this.identity};
    });
  }
  unbind() {
    return this._transaction(() => ({changed: false, binding: null, result: null}));
  }
  branchInfo({campaignId, playthroughId, branchId} = {}) {
    campaignId ??= playthroughId;
    if (!id(campaignId) || !id(branchId)) fail('INVALID_IDENTITY');
    const branch = this._state.branches[branchKey(campaignId, branchId)];
    if (!branch) return null;
    return {campaignId, playthroughId: campaignId, branchId, ledgerSequence: sequence(branch),
      inheritedCount: branch.inheritedCount, parent: clone(branch.parent),
      checkpoints: branch.checkpoints.map(point => ({checkpointId: point.id,
        ledgerSequence: point.index - branch.inheritedCount, verified: point.verified}))};
  }
  inspectBranch(campaignId, branchId) { return this.branchInfo({campaignId, branchId}); }
  receiptFor({campaignId, playthroughId, branchId, eventId, event} = {}) {
    campaignId ??= playthroughId;
    if (!id(campaignId) || !id(branchId) || !id(eventId)) fail('INVALID_RECEIPT_QUERY');
    const branch = this._state.branches[branchKey(campaignId, branchId)];
    if (!branch) return null;
    const index = branch.events.findIndex(key => this._state.events[key].eventId === eventId);
    if (index < 0) return null;
    const stored = this._state.events[branch.events[index]];
    let payloadMatches;
    if (event !== undefined) {
      if (event.eventId !== eventId) fail('INVALID_RECEIPT_QUERY');
      const normalized = normalizeEvent(event, {campaignId, branchId,
        checkpointId: stored.origin.checkpointId}, this.userId);
      // Recovery needs the exact normalized append intent, including evidence;
      // ordinary episode dedupe intentionally ignores capture evidence.
      payloadMatches = digest(normalized) === digest(Object.fromEntries(
        Object.keys(normalized).map(key => [key, stored[key]])));
    }
    return {eventId, episodeId: stored.id, campaignId, branchId,
      ledgerSequence: index + 1 - branch.inheritedCount, inherited: index < branch.inheritedCount,
      isTail: index === branch.events.length - 1, fingerprint: stored.fingerprint,
      ...(payloadMatches !== undefined ? {payloadMatches} : {})};
  }
  readEvent({campaignId, playthroughId, branchId, eventId} = {}) {
    campaignId ??= playthroughId;
    const receipt = this.receiptFor({campaignId, branchId, eventId});
    return receipt ? {receipt, event: clone(this._state.events[receipt.episodeId])} : null;
  }
  recordActivity({activityId, requestId, characterKey, kind, identity, metadata = {}} = {}) {
    if (!id(activityId) || !id(requestId) || !profile(characterKey)
        || !['submitted-input', 'generated-reply', 'delivered-reply', 'cancelled-turn'].includes(kind)) {
      return Promise.reject(new QuestMemoryError('INVALID_ACTIVITY'));
    }
    return this.observe({eventId: activityId, factId: requestId, kind: 'transport-activity', authority: 'transport-event',
      text: `Conversation activity: ${kind}.`, stable: true, eligibleForMemory: false, knownBy: [characterKey],
      witnessedBy: [], visibility: 'private', identity, outcome: kind,
      provenance: {producer: 'conversation-transport', requestId, activityKind: kind},
      evidence: [{metadata: checkedJson(metadata, 4000)}]});
  }
  registerGroup(audience) {
    audience = groupAudience(audience);
    const epoch = this._epoch;
    return this._transaction(state => {
      const branch = state.branches[this._active.key];
      if (!branch.groups.some(group => JSON.stringify(group) === JSON.stringify(audience))) {
        if (branch.groups.length >= 64) fail('GROUP_LIMIT');
        branch.groups.push(audience);
      }
      enqueueSealed(state, branch, this._active.key, this.now());
      return {result: {audience, endUserId: namespace(state, branch, 'group', audience)}};
    }, epoch);
  }
  observe(value) {
    if (!this._active) return Promise.reject(new QuestMemoryError('IDENTITY_UNBOUND'));
    const active = clone(this._active), epoch = this._epoch;
    let event;
    try { event = normalizeEvent(value, active, this.userId); } catch (error) { return Promise.reject(error); }
    const fingerprint = eventFingerprint(event);
    return this._transaction(state => {
      const branch = state.branches[active.key];
      for (const existingId of branch.events) {
        const existing = state.events[existingId];
        if (existing.eventId === event.eventId && existing.fingerprint !== fingerprint) fail('EVENT_ID_CONFLICT');
        if (existing.fingerprint === fingerprint) return {changed: false, result: {episodeId: existing.id, duplicate: true,
          ledgerSequence: sequence(branch), checkpointed: branch.events.indexOf(existingId) < (sealedPoint(branch)?.index ?? 0)}};
      }
      if (Object.keys(state.events).length >= LIMITS.episodes) fail('EPISODE_LIMIT');
      const episodeId = digest([active.key, fingerprint]);
      state.events[episodeId] = {...event, id: episodeId, fingerprint, observedAt: this.now(),
        origin: {campaignId: active.campaignId, branchId: active.branchId, checkpointId: active.checkpointId}};
      branch.events.push(episodeId);
      return {result: {episodeId, duplicate: false, checkpointed: false, ledgerSequence: sequence(branch)}};
    }, epoch);
  }
  checkpoint(proof) {
    if (!this._active) return Promise.reject(new QuestMemoryError('IDENTITY_UNBOUND'));
    const active = clone(this._active), epoch = this._epoch;
    return this._transaction(state => {
      const branch = state.branches[active.key], point = recordRestoredProof(branch, proof);
      if (point.index !== branch.events.length) fail('BRANCH_REQUIRED');
      enqueueSealed(state, branch, active.key, this.now());
      return {binding: {...active, checkpointId: point.id}, result: () => this.identity};
    }, epoch);
  }
  contextFor({characterKey, channel = 'private', audience, limit = 32, maxChars = 12000} = {}) {
    if (!profile(characterKey) || !['private', 'phone', 'group'].includes(channel)
        || !Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(maxChars) || maxChars < 1 || maxChars > 50000) fail('INVALID_CONTEXT_QUERY');
    if (channel === 'group') {
      audience = groupAudience(audience);
      if (!audience.includes(characterKey)) fail('SPEAKER_NOT_IN_AUDIENCE');
    }
    if (!this._active) return {status: 'unavailable', episodes: []};
    const branch = this._state.branches[this._active.key], sealed = sealedPoint(branch)?.index ?? 0;
    const candidates = visibleEvents(this._state, branch).filter(event => event.kind !== 'transport-activity' && event.knownBy.includes(characterKey)
      && (channel !== 'group' || shareable(event, audience)));
    const episodes = []; let size = 0;
    for (const event of candidates.reverse()) {
      if (episodes.length >= limit) break;
      if (size + event.text.length > maxChars) continue;
      size += event.text.length;
      episodes.push({episodeId: event.id, eventId: event.eventId, factId: event.factId, text: event.text,
        authority: event.authority, witnessed: event.witnessedBy.includes(characterKey), visibility: event.visibility,
        checkpointed: branch.events.indexOf(event.id) < sealed, provenance: clone(event.provenance), evidence: clone(event.evidence)});
    }
    return {status: 'available', identity: this.identity, endUserId: namespace(this._state, branch, channel, audience),
      characterKey, channel, revision: this._state.revision, episodes: episodes.reverse()};
  }
  archiveFor({characterKey, characterId, restEndUserId, channel = 'private', audience, limit = 32, maxChars = 12000} = {}) {
    if (!uuid(restEndUserId) || (characterId !== undefined && !id(characterId))) fail('INVALID_ARCHIVE_QUERY');
    const context = this.contextFor({characterKey, channel, audience, limit, maxChars});
    if (context.status !== 'available') return {status: 'unavailable', episodes: []};
    // The local restored prefix and audience decide what may be recalled.
    // Never list the stable provider bucket and treat its whole contents as
    // current history: it can retain records from abandoned future branches.
    const episodes = context.episodes.filter(event => event.checkpointed).map(event => {
      const receipts = [], seen = new Set();
      for (const entry of Object.values(this._state.outbox)) {
        if (entry.state !== 'acknowledged' || entry.episodeId !== event.episodeId
            || entry.characterKey !== characterKey || entry.restEndUserId !== restEndUserId
            || (characterId !== undefined && entry.characterId !== characterId)) continue;
        for (const receipt of entry.receipts ?? []) {
          // Add may return a paraphrase. Keep it as an accounting receipt but
          // do not inject provider-added facts or a merged future narrative.
          if (normalizeMemoryText(receipt.text) !== normalizeMemoryText(event.text)) continue;
          const key = JSON.stringify([entry.characterId, receipt.memoryId]);
          if (seen.has(key)) continue; seen.add(key);
          receipts.push({characterId: entry.characterId, memoryId: receipt.memoryId});
        }
      }
      return {...event, receipts};
    }).filter(event => event.receipts.length);
    return {status: 'available', identity: context.identity, localScopeId: context.endUserId,
      restEndUserId, characterKey, channel, episodes};
  }
  pending({limit = 32, includeUncertain = false, onlyUncertain = false, afterId} = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 256) fail('INVALID_LIMIT');
    if (typeof onlyUncertain !== 'boolean' || (onlyUncertain && !includeUncertain)
        || (afterId !== undefined && !id(afterId))) fail('INVALID_PENDING_QUERY');
    if (!this._active) return [];
    const key = this._active.key, branch = this._state.branches[key];
    const visible = new Set(visibleEvents(this._state, branch).map(row => row.id));
    const entries = Object.values(this._state.outbox).filter(entry => entry.branchKey === key && visible.has(entry.episodeId)
      && entry.endUserId === namespace(this._state, branch, entry.channel, entry.audience)
      && ((!onlyUncertain && entry.state === 'pending') || (includeUncertain && entry.state === 'uncertain')));
    // A worker may continue past an unresolved entry without mutating it or
    // assuming that an absent remote result makes it safe to resubmit.
    const start = afterId ? entries.findIndex(entry => entry.id === afterId) + 1 : 0;
    return [...entries.slice(start), ...entries.slice(0, start)].slice(0, limit)
      .map(entry => ({...clone(entry), text: this._state.events[entry.episodeId].text}));
  }
  claim(entryId, {characterId, restEndUserId} = {}) {
    if (!id(characterId)) return Promise.reject(new QuestMemoryError('INVALID_CHARACTER_ID'));
    if (restEndUserId !== undefined && !uuid(restEndUserId)) return Promise.reject(new QuestMemoryError('INVALID_REST_USER_ID'));
    const epoch = this._epoch, activeKey = this._active?.key;
    return this._transaction(state => {
      const entry = state.outbox[entryId], branch = state.branches[activeKey];
      if (!entry || !branch || entry.branchKey !== activeKey || entry.state !== 'pending'
          || entry.endUserId !== namespace(state, branch, entry.channel, entry.audience)
          || !visibleEvents(state, branch).some(event => event.id === entry.episodeId)) fail('ENTRY_NOT_PENDING');
      entry.state = 'in-flight'; entry.attempts++; entry.characterId = characterId;
      // Keep the remote destination on the original attempt, independently of
      // branch identity. A late receipt can never be redirected to a new slot.
      if (restEndUserId !== undefined) entry.restEndUserId = restEndUserId;
      else delete entry.restEndUserId;
      entry.attemptId = randomUUID(); entry.submittedAt = this.now();
      return {result: {...entry, text: state.events[entry.episodeId].text, epoch}};
    }, epoch);
  }
  acknowledge(lease, {characterId, endUserId, memories} = {}) {
    return this._settle(lease, (entry, state) => {
      if (characterId !== entry.characterId || endUserId !== (entry.restEndUserId ?? entry.endUserId) || !Array.isArray(memories) || !memories.length
          || memories.length > 256 || memories.some(row => !id(row.id) || typeof row.memory !== 'string')) fail('INVALID_RECEIPT');
      // A direct successful add response may contain a provider paraphrase.
      // Keep its IDs without assuming a 1:1 input/output mapping.
      entry.state = 'acknowledged'; entry.acknowledgedAt = this.now();
      entry.receipts = memories.map(row => ({memoryId: row.id, text: row.memory.slice(0, 12000)}));
      delete entry.failure;
      return {state: entry.state, active: entry.branchKey === this._active?.key
        && entry.endUserId === namespace(state, state.branches[entry.branchKey], entry.channel, entry.audience)};
    });
  }
  fail(lease, {ambiguous = true, code = 'operation-failed'} = {}) {
    if (typeof code !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(code)) return Promise.reject(new QuestMemoryError('INVALID_FAILURE'));
    return this._settle(lease, entry => {
      entry.state = ambiguous ? 'uncertain' : 'failed'; entry.failure = code; entry.failedAt = this.now();
      return {state: entry.state};
    });
  }
  _settle(lease, change) {
    return this._transaction(state => {
      const entry = lease && state.outbox[lease.id];
      if (!entry || !['in-flight', 'uncertain'].includes(entry.state) || entry.attemptId !== lease.attemptId
          || entry.endUserId !== lease.endUserId || entry.restEndUserId !== lease.restEndUserId
          || entry.characterId !== lease.characterId) fail('STALE_REMOTE_RECEIPT');
      return {result: change(entry, state)};
    });
  }
  reconcile(entryId, {characterId, endUserId, memories, complete = false} = {}) {
    return this._transaction(state => {
      const entry = state.outbox[entryId];
      if (!entry || entry.state !== 'uncertain' || entry.characterId !== characterId || (entry.restEndUserId ?? entry.endUserId) !== endUserId
          || !Array.isArray(memories) || memories.length > 100000) fail('INVALID_RECONCILIATION');
      const expected = normalizeMemoryText(state.events[entry.episodeId].text);
      const matches = memories.filter(row => id(row?.id) && normalizeMemoryText(row.memory) === expected);
      entry.lastReconciledAt = this.now(); entry.lastScanComplete = complete === true;
      if (matches.length) {
        entry.state = 'acknowledged'; entry.acknowledgedAt = this.now();
        entry.receipts = matches.map(row => ({memoryId: row.id, text: row.memory})); delete entry.failure;
      }
      // Even a complete empty scan does not prove a timed-out write cannot
      // still commit later. Absence never automatically makes it retryable.
      return {result: {state: entry.state, matched: matches.length, retryAllowed: false}};
    });
  }
  retryRejected(entryId) {
    const epoch = this._epoch;
    return this._transaction(state => {
      const entry = state.outbox[entryId];
      if (!entry || entry.state !== 'failed' || entry.branchKey !== this._active.key || entry.attempts >= 3) fail('RETRY_NOT_ALLOWED');
      entry.state = 'pending'; delete entry.attemptId;
      return {result: {state: entry.state}};
    }, epoch);
  }
  status() {
    const counts = {};
    for (const entry of Object.values(this._state.outbox)) counts[entry.state] = (counts[entry.state] ?? 0) + 1;
    return {version: 1, userId: this.userId, bound: !!this._active, identity: this.identity,
      revision: this._state.revision, recovered: this.recovered, branches: Object.keys(this._state.branches).length,
      episodes: Object.keys(this._state.events).length, outbox: counts, remoteExecution: 'not-owned-by-ledger'};
  }
  async close() {
    await this._chain;
    if (this._closed) return;
    this._closed = true; this._active = null; this._epoch++;
    await this._unlock();
  }
}
