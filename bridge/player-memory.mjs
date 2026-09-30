import * as fs from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

/**
 * One local player's identity, independent of character, world, save and channel.
 *
 * open({path, characterIds, provider, quiesce, timeoutMs}) is LOCAL ONLY.
 * route(profileKey, {channel, audience}) and isCurrent(guard) are synchronous,
 * read-only operations. They neither contact a profile nor call the provider.
 * The router owns channel/world/session scope; only identity reset epochs live here.
 *
 * Await prepareCharacter({profileKey,guard,signal}) when the player invites a
 * character, before warming a connection or spawning. It verifies the mod-owned
 * profile's memory configuration without recording contact or creating memory.
 * Await beginConversation({profileKey, guard, source:'player', channel, requestId,
 * signal}) immediately before an admitted PLAYER send. Never call it on warm,
 * spawn, routing, unsolicited NPC dialogue or battle reactions. It durably records
 * the contacted character and reuses verified preparation or verifies on demand.
 * provider.enableMemory({profileKey,characterId,endUserId,signal}) must return
 * {enabled:true, changed:boolean} after ownership verification and readback.
 * A reconnectRequired receipt means old warmed sessions must be replaced BEFORE
 * warming/sending; this module does not open sessions. After all old transports
 * are disposed, acknowledgeConnectionRefresh({profileKey,guard}) consumes that
 * obligation. Cancellation cannot silently consume it. A later PLAYER send
 * reuses completed preparation without replacing its prepared connection.
 * No explicit memory seeding exists.
 *
 * Explicit clearCharacter({profileKey,actionId,signal}) / clearAll({actionId,signal})
 * preserve the UUID, durably advance epochs, and invoke quiesce before deletion.
 * quiesce({scope,profileKeys,characterIds,actionId,signal}) must return
 * {quiesced:true} only after old turns/pages/sessions and cached session IDs were
 * cancelled/closed/reset. It is NOT proof of a provider extraction flush.
 * provider.clearMemory(...) returns {accepted:true,providerEmptyObserved:boolean}.
 * 'succeeded' means only that empty provider readback was observed. It cannot
 * guarantee no delayed extraction appears later. An uncertain command blocks
 * affected new sends until a NEW explicit clear or recoverClear({actionId,signal})
 * observes empty via provider.inspectMemory(). Opening never resumes cloud work.
 * status({actionId}={}) returns profile keys/command states WITHOUT the UUID.
 *
 * Disk protocol: an immutable identity anchor + atomically replaced/fsynced
 * registry contain the SAME UUID. Missing/corrupt/disagreeing established files
 * fail closed; there is no backup restoration, migration or replacement identity.
 * One cooperating writer holds a process lock until close(). A definitely dead
 * process lock can be reclaimed; malformed/ambiguous/live locks cannot. Atomic
 * temp files are never recovery authorities. Directory fsync is used where the
 * OS supports it (Windows commonly does not). File fsync precedes rename.
 * Registry histories are bounded; exceeding a bound fails without dropping
 * uncertain intents/idempotency records. fsImpl is a fault-injection test seam.
 */

const VERSION = 1, MAX_BYTES = 2 * 1024 * 1024, MAX_CHARACTERS = 1024, MAX_ACTIONS = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const token = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const CHANNELS = new Set(['private', 'group', 'phone', 'microphone']);
const SAFE_CODES = new Set(['CANCELLED', 'TIMEOUT', 'DISABLED', 'NOT_MOD_OWNED', 'CHARACTER_MISMATCH',
  'INVALID_RESPONSE', 'CONFIGURATION_DRIFT', 'HTTP_ERROR', 'NETWORK_ERROR', 'RESPONSE_TOO_LARGE',
  'ENABLE_UNVERIFIED', 'CLEAR_UNVERIFIED', 'QUIESCE_FAILED', 'MEMORY_UNAVAILABLE', 'STALE_TURN',
  'MEMORY_CLEAR_PENDING', 'CLOSED', 'STORAGE_FAILURE', 'REGISTRY_CHANGED', 'IDENTITY_CHANGED']);
const CONSTRUCT = Symbol('PlayerMemory');

export class PlayerMemoryError extends Error {
  constructor(code, {writeUncertain = false} = {}) {
    super(`Player memory operation failed: ${code}`);
    this.name = 'PlayerMemoryError';
    Object.assign(this, {code, writeUncertain: writeUncertain === true});
  }
}
const fail = code => { throw new PlayerMemoryError(code); };
const codeFor = error => SAFE_CODES.has(error?.code) ? error.code : 'MEMORY_UNAVAILABLE';
const increment = value => {
  if (!integer(value) || value === Number.MAX_SAFE_INTEGER) fail('EPOCH_EXHAUSTED');
  return value + 1;
};
function exact(value, keys) {
  return object(value) && Object.keys(value).every(key => keys.includes(key))
    && keys.every(key => Object.hasOwn(value, key));
}
function validateRegistry(value, anchor) {
  if (!exact(value, ['version', 'endUserId', 'revision', 'resetEpoch', 'characters', 'actions'])
      || value.version !== VERSION || !UUID.test(value.endUserId) || value.endUserId !== anchor
      || !integer(value.revision) || !integer(value.resetEpoch) || !object(value.characters)
      || Object.keys(value.characters).length > MAX_CHARACTERS || !Array.isArray(value.actions)
      || value.actions.length > MAX_ACTIONS) fail('CORRUPT_REGISTRY');
  for (const [id, row] of Object.entries(value.characters)) {
    if (!token(id) || !exact(row, ['profileKey', 'characterEpoch', 'contacted'])
        || !token(row.profileKey) || !integer(row.characterEpoch) || typeof row.contacted !== 'boolean') fail('CORRUPT_REGISTRY');
  }
  const seen = new Set();
  for (const action of value.actions) {
    if (!exact(action, ['id', 'scope', 'profileKey', 'state', 'message', 'uncertain', 'quiesced', 'targets'])
        || !token(action.id) || seen.has(action.id) || !['character', 'all'].includes(action.scope)
        || !(action.scope === 'all' ? action.profileKey === null : token(action.profileKey))
        || !['pending', 'succeeded', 'failed'].includes(action.state)
        || !MESSAGE_VALUES.has(action.message) || typeof action.uncertain !== 'boolean'
        || typeof action.quiesced !== 'boolean' || !Array.isArray(action.targets)
        || action.targets.length > MAX_CHARACTERS) fail('CORRUPT_REGISTRY');
    seen.add(action.id);
    const targets = new Set();
    for (const row of action.targets) {
      if (!exact(row, ['characterId', 'profileKey', 'state', 'uncertain', 'mayHaveReachedProvider', 'providerEmptyObserved'])
          || !token(row.characterId) || targets.has(row.characterId) || !token(row.profileKey)
          || value.characters[row.characterId]?.contacted !== true
          || !['pending', 'succeeded', 'failed'].includes(row.state) || typeof row.uncertain !== 'boolean'
          || typeof row.mayHaveReachedProvider !== 'boolean' || typeof row.providerEmptyObserved !== 'boolean'
          || (row.state === 'succeeded' && !row.providerEmptyObserved)) fail('CORRUPT_REGISTRY');
      targets.add(row.characterId);
    }
    if (action.state === 'succeeded' && (!action.quiesced || action.targets.some(row => row.state !== 'succeeded'))) fail('CORRUPT_REGISTRY');
    if (action.scope === 'character' && action.targets.length > 1) fail('CORRUPT_REGISTRY');
  }
  return value;
}
const MESSAGES = Object.freeze({
  pending: 'Forgetting memories is in progress.',
  succeeded: 'The provider currently reports no saved memories.',
  empty: 'No contacted characters have saved memories to clear.',
  failed: 'Memories could not be cleared. Try an explicit clear again.',
  uncertain: 'Clearing was not confirmed. An explicit recovery or clear is required.',
  quiesce: 'Old conversations could not be closed. Memories were not cleared.'
});
const MESSAGE_VALUES = new Set(Object.values(MESSAGES));

async function readOptional(files, path, limit = MAX_BYTES) {
  try {
    const stat = await files.stat(path);
    if (!stat.isFile() || stat.size > limit) fail('CORRUPT_REGISTRY');
    return await files.readFile(path, 'utf8');
  } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}
async function syncDirectory(files, directory) {
  let handle;
  try { handle = await files.open(directory, 'r'); await handle.sync(); }
  catch (error) {
    if (!['EPERM', 'EACCES', 'EISDIR', 'EINVAL', 'ENOTSUP'].includes(error?.code)) throw error;
  } finally { await handle?.close(); }
}
async function atomicWrite(files, path, raw) {
  if (Buffer.byteLength(raw) > MAX_BYTES) fail('REGISTRY_LIMIT');
  const temp = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await files.open(temp, 'wx', 0o600);
    await handle.writeFile(raw, 'utf8'); await handle.sync(); await handle.close(); handle = null;
    await files.rename(temp, path);
    await syncDirectory(files, dirname(path));
  } finally {
    await handle?.close().catch(() => {});
    await files.unlink(temp).catch(error => { if (error?.code !== 'ENOENT') throw error; });
  }
}
async function acquireLock(files, path) {
  const raw = JSON.stringify({version: VERSION, pid: process.pid, token: randomUUID()}) + '\n';
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle;
    try {
      handle = await files.open(path, 'wx', 0o600);
      await handle.writeFile(raw, 'utf8'); await handle.sync(); await handle.close();
      return raw;
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error?.code !== 'EEXIST') throw error;
      const current = await readOptional(files, path, 1024);
      let lock; try { lock = JSON.parse(current); } catch { fail('LOCK_UNCERTAIN'); }
      if (!exact(lock, ['version', 'pid', 'token']) || lock.version !== VERSION
          || !Number.isSafeInteger(lock.pid) || lock.pid < 1 || !UUID.test(lock.token)) fail('LOCK_UNCERTAIN');
      try { process.kill(lock.pid, 0); fail('REGISTRY_LOCKED'); }
      catch (probe) { if (probe?.code !== 'ESRCH') throw new PlayerMemoryError('REGISTRY_LOCKED'); }
      // Reclaimers need their own exclusive claim. A read-then-unlink alone can
      // otherwise delete a NEW owner's lock between two stale reclaim attempts.
      let claim;
      try {
        claim = await files.open(path + '.reclaim', 'wx', 0o600);
        await claim.writeFile(raw, 'utf8'); await claim.sync();
        if (await readOptional(files, path, 1024) !== current) fail('REGISTRY_LOCKED');
        await files.unlink(path);
      } catch (reclaim) {
        if (reclaim?.code === 'EEXIST') fail('REGISTRY_LOCKED');
        throw reclaim;
      } finally {
        if (claim) { await claim.close(); await files.unlink(path + '.reclaim'); }
      }
    }
  }
  fail('REGISTRY_LOCKED');
}
async function releaseLock(files, path, raw) {
  if (await readOptional(files, path, 1024) === raw) await files.unlink(path);
}
function normalizeIds(characterIds) {
  const entries = characterIds instanceof Map ? [...characterIds] : object(characterIds) ? Object.entries(characterIds) : [];
  if (entries.length > MAX_CHARACTERS || (characterIds !== undefined && !(characterIds instanceof Map) && !object(characterIds))) fail('INVALID_CONFIGURATION');
  const ids = new Map();
  for (const [key, id] of entries) {
    if (!token(key) || !token(id)) fail('INVALID_CONFIGURATION');
    ids.set(key, id);
  }
  return ids;
}
function commandView(action) {
  if (!action) return null;
  return Object.freeze({id: action.id, scope: action.scope, profileKey: action.profileKey,
    state: action.state, message: action.message, uncertain: action.uncertain,
    providerEmptyObserved: action.targets.length > 0 && action.targets.every(row => row.providerEmptyObserved)});
}

export class PlayerMemory {
  #files; #path; #anchorPath; #lockPath; #lockRaw; #anchorRaw; #diskRaw; #state; #ids;
  #provider; #quiesce; #timeoutMs; #mutation = Promise.resolve(); #closed = false; #fault = null;
  #enables = new Map(); #verified = new Set(); #enableReceipts = new Map(); #enableUnknown = new Set(); #activeClears = new Map();
  #reconnectPending = new Set();
  #controllers = new Set(); #fences = new Set();

  static async open({path, characterIds, provider, quiesce, timeoutMs = 15000, fsImpl = fs} = {}) {
    if (typeof path !== 'string' || !path.trim() || !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60000
        || (provider !== undefined && !object(provider)) || (quiesce !== undefined && typeof quiesce !== 'function')) fail('INVALID_CONFIGURATION');
    const ids = normalizeIds(characterIds), absolute = resolve(path), anchorPath = absolute + '.identity', lockPath = absolute + '.lock';
    let lockRaw;
    try {
      await fsImpl.mkdir(dirname(absolute), {recursive: true});
      lockRaw = await acquireLock(fsImpl, lockPath);
      let [anchorRaw, diskRaw] = await Promise.all([readOptional(fsImpl, anchorPath, 1024), readOptional(fsImpl, absolute)]);
      let state;
      if (anchorRaw === null && diskRaw === null) {
        const endUserId = randomUUID();
        anchorRaw = JSON.stringify({version: VERSION, endUserId}) + '\n';
        state = {version: VERSION, endUserId, revision: 0, resetEpoch: 0, characters: {}, actions: []};
        diskRaw = JSON.stringify(state) + '\n';
        await atomicWrite(fsImpl, anchorPath, anchorRaw);
        await atomicWrite(fsImpl, absolute, diskRaw);
      } else {
        if (anchorRaw === null || diskRaw === null) fail('MISSING_ESTABLISHED_REGISTRY');
        let anchor;
        try { anchor = JSON.parse(anchorRaw); state = JSON.parse(diskRaw); } catch { fail('CORRUPT_REGISTRY'); }
        if (!exact(anchor, ['version', 'endUserId']) || anchor.version !== VERSION || !UUID.test(anchor.endUserId)) fail('CORRUPT_IDENTITY');
        validateRegistry(state, anchor.endUserId);
        // Resolve interrupted local commands without doing remote recovery. The
        // persisted dispatch flag determines uncertainty; it never authorizes a
        // second deletion. Already observed per-target successes are retained.
        if (state.actions.some(action => action.state === 'pending')) {
          for (const action of state.actions.filter(action => action.state === 'pending')) {
            for (const target of action.targets.filter(target => target.state === 'pending')) {
              target.state = 'failed'; target.uncertain ||= target.mayHaveReachedProvider;
            }
            action.uncertain = action.targets.some(target => target.uncertain);
            action.state = action.quiesced && action.targets.every(target => target.state === 'succeeded') ? 'succeeded' : 'failed';
            action.message = action.uncertain ? MESSAGES.uncertain : action.state === 'failed' ? MESSAGES.failed
              : action.targets.length ? MESSAGES.succeeded : MESSAGES.empty;
          }
          state.revision = increment(state.revision);
          validateRegistry(state, anchor.endUserId);
          diskRaw = JSON.stringify(state) + '\n';
          await atomicWrite(fsImpl, absolute, diskRaw);
        }
      }
      return new PlayerMemory(CONSTRUCT, {files: fsImpl, path: absolute, anchorPath, lockPath, lockRaw,
        anchorRaw, diskRaw, state, ids, provider, quiesce, timeoutMs});
    } catch (error) {
      if (lockRaw) await releaseLock(fsImpl, lockPath, lockRaw).catch(() => {});
      if (error instanceof PlayerMemoryError) throw error;
      throw new PlayerMemoryError('STORAGE_FAILURE');
    }
  }
  constructor(secret, options) {
    if (secret !== CONSTRUCT) fail('USE_OPEN');
    this.#files = options.files; this.#path = options.path; this.#anchorPath = options.anchorPath;
    this.#lockPath = options.lockPath; this.#lockRaw = options.lockRaw; this.#anchorRaw = options.anchorRaw;
    this.#diskRaw = options.diskRaw; this.#state = options.state; this.#ids = options.ids;
    this.#provider = options.provider; this.#quiesce = options.quiesce; this.#timeoutMs = options.timeoutMs;
  }
  #ready() { if (this.#closed) fail('CLOSED'); if (this.#fault) fail(this.#fault); }
  #id(profileKey) {
    if (!token(profileKey) || !this.#ids.has(profileKey)) fail('UNKNOWN_CHARACTER');
    return this.#ids.get(profileKey);
  }
  #blocked(id) {
    if (this.#fences.has(id)) return true;
    // A newer explicitly successful clear/recovery supersedes older uncertainty.
    for (let index = this.#state.actions.length - 1; index >= 0; index--) {
      const target = this.#state.actions[index].targets.find(row => row.characterId === id);
      if (target?.state === 'succeeded' && target.providerEmptyObserved) return false;
      if (target && (this.#state.actions[index].state === 'pending' || target.uncertain)) return true;
    }
    return false;
  }
  route(profileKey, {channel = 'private'} = {}) {
    this.#ready();
    if (!CHANNELS.has(channel)) fail('INVALID_CHANNEL');
    const characterId = this.#id(profileKey);
    if (this.#blocked(characterId)) fail('MEMORY_CLEAR_PENDING');
    const guard = Object.freeze({endUserId: this.#state.endUserId, characterId,
      resetEpoch: this.#state.resetEpoch, characterEpoch: this.#state.characters[characterId]?.characterEpoch ?? 0});
    return Object.freeze({endUserId: this.#state.endUserId, guard});
  }
  isCurrent(guard) {
    return !this.#closed && !this.#fault && object(guard) && guard.endUserId === this.#state.endUserId
      && [...this.#ids.values()].includes(guard.characterId) && !this.#blocked(guard.characterId)
      && guard.resetEpoch === this.#state.resetEpoch
      && guard.characterEpoch === (this.#state.characters[guard.characterId]?.characterEpoch ?? 0);
  }
  async #verifyStorage() {
    this.#ready();
    try {
      const [disk, anchor] = await Promise.all([readOptional(this.#files, this.#path), readOptional(this.#files, this.#anchorPath, 1024)]);
      if (disk !== this.#diskRaw) fail('REGISTRY_CHANGED');
      if (anchor !== this.#anchorRaw) fail('IDENTITY_CHANGED');
    } catch (error) {
      this.#fault = ['REGISTRY_CHANGED', 'IDENTITY_CHANGED'].includes(error?.code) ? error.code : 'STORAGE_FAILURE';
      for (const controller of this.#controllers) controller.abort();
      throw new PlayerMemoryError(this.#fault);
    }
  }
  #persist(change) {
    const writing = this.#mutation.then(async () => {
      this.#ready();
      try {
        await this.#verifyStorage();
        const next = structuredClone(this.#state);
        change(next);
        next.revision = increment(next.revision);
        validateRegistry(next, this.#state.endUserId);
        const raw = JSON.stringify(next) + '\n';
        await atomicWrite(this.#files, this.#path, raw);
        this.#state = next; this.#diskRaw = raw;
      } catch (error) {
        // Exhaustion/validation errors do not mean disk lost durability.
        if (['REGISTRY_LIMIT', 'ACTION_LIMIT', 'CHARACTER_LIMIT', 'EPOCH_EXHAUSTED', 'STALE_TURN', 'CANCELLED'].includes(error?.code)) throw error;
        this.#fault = ['REGISTRY_CHANGED', 'IDENTITY_CHANGED'].includes(error?.code) ? error.code : 'STORAGE_FAILURE';
        for (const controller of this.#controllers) controller.abort();
        throw new PlayerMemoryError(this.#fault);
      }
    });
    this.#mutation = writing.catch(() => {});
    return writing;
  }
  async #bounded(operation, {signal, controller = new AbortController(), write = false} = {}) {
    if (signal?.aborted || controller.signal.aborted) throw new PlayerMemoryError('CANCELLED');
    this.#ready();
    this.#controllers.add(controller);
    const timeout = new AbortController();
    const combined = AbortSignal.any([controller.signal, timeout.signal, ...(signal ? [signal] : [])]);
    const timer = setTimeout(() => timeout.abort(), this.#timeoutMs);
    let abort, dispatched = false;
    try {
      const cancelled = new Promise((_, reject) => {
        abort = () => reject(new PlayerMemoryError(timeout.signal.aborted ? 'TIMEOUT' : 'CANCELLED', {writeUncertain: write && dispatched}));
        combined.addEventListener('abort', abort, {once: true});
      });
      const result = await Promise.race([cancelled, Promise.resolve().then(() => {
        if (combined.aborted) throw new PlayerMemoryError('CANCELLED');
        dispatched = true; return operation(combined);
      })]);
      if (combined.aborted) throw new PlayerMemoryError(timeout.signal.aborted ? 'TIMEOUT' : 'CANCELLED', {writeUncertain: write && dispatched});
      return result;
    } catch (error) {
      if (error instanceof PlayerMemoryError) throw error;
      throw new PlayerMemoryError(codeFor(error), {writeUncertain: error?.writeUncertain === true || (write && dispatched && error?.writeUncertain !== false)});
    } finally {
      clearTimeout(timer); combined.removeEventListener('abort', abort); this.#controllers.delete(controller);
    }
  }
  async #checkStorage() {
    const checking = this.#mutation.then(() => this.#verifyStorage());
    this.#mutation = checking.catch(() => {});
    await checking;
  }
  async #ensureEnabled({profileKey, characterId, admitted, verifiedAtAdmission, signal}) {
    if (!this.isCurrent(admitted) || signal?.aborted) fail('STALE_TURN');
    let changed = false;
    if (!this.#verified.has(characterId)) {
      let flight = this.#enables.get(characterId);
      if (!flight) {
        const controller = new AbortController();
        flight = {controller, promise: null};
        flight.promise = this.#bounded(combined => this.#provider.enableMemory({profileKey, characterId,
          endUserId: this.#state.endUserId, signal: combined}), {controller, write: true}).then(receipt => {
          if (receipt?.enabled !== true || typeof receipt.changed !== 'boolean') throw new PlayerMemoryError('ENABLE_UNVERIFIED', {writeUncertain: true});
          if (!this.isCurrent(admitted)) throw new PlayerMemoryError('STALE_TURN');
          this.#enableReceipts.set(characterId, {changed: receipt.changed});
          if (receipt.changed || this.#enableUnknown.has(characterId)) this.#reconnectPending.add(characterId);
          this.#verified.add(characterId); this.#enableUnknown.delete(characterId);
          return receipt;
        }).catch(error => { this.#enableUnknown.add(characterId); throw error; })
          .finally(() => { if (this.#enables.get(characterId) === flight) this.#enables.delete(characterId); });
        this.#enables.set(characterId, flight);
      }
      // A caller's cancellation doesn't cancel another caller's shared enable.
      // Each wait is bounded independently; clear/close abort the shared flight.
      const receipt = await this.#bounded(() => flight.promise, {signal});
      changed = receipt.changed;
    } else if (!verifiedAtAdmission) {
      // Another concurrent preparation/admission can finish verification during
      // this caller's storage check/write. Its pre-enable warmth still needs the
      // first-wave receipt. Callers admitted after preparation reuse the cache.
      const receipt = this.#enableReceipts.get(characterId);
      changed = receipt?.changed === true;
    }
    if (signal?.aborted || !this.isCurrent(admitted)) fail('STALE_TURN');
    // The shared enable may finish after every waiting invitation was cancelled.
    // Keep this obligation until the transport owner explicitly confirms disposal.
    return {changed, reconnectRequired: this.#reconnectPending.has(characterId)};
  }
  connectionRefreshRequired({profileKey, guard} = {}) {
    this.#ready();
    const characterId = this.#id(profileKey);
    if (!guard || guard.characterId !== characterId || !this.isCurrent(guard)) fail('STALE_TURN');
    return this.#reconnectPending.has(characterId);
  }
  acknowledgeConnectionRefresh({profileKey, guard} = {}) {
    const required = this.connectionRefreshRequired({profileKey, guard});
    if (!this.#verified.has(guard.characterId)) fail('ENABLE_UNVERIFIED');
    this.#reconnectPending.delete(guard.characterId);
    return required;
  }
  async prepareCharacter({profileKey, guard, signal} = {}) {
    this.#ready();
    const characterId = this.#id(profileKey), admitted = guard ?? this.route(profileKey).guard;
    const verifiedAtAdmission = this.#verified.has(characterId);
    if (admitted.characterId !== characterId || !this.isCurrent(admitted)) fail('STALE_TURN');
    if (signal?.aborted) fail('CANCELLED');
    if (typeof this.#provider?.enableMemory !== 'function') fail('MEMORY_UNAVAILABLE');
    // Every invitation checks the exact durable identity/registry, including
    // cached and never-contacted profiles. Preparation performs no disk writes.
    await this.#checkStorage();
    const {changed, reconnectRequired} = await this.#ensureEnabled({profileKey, characterId, admitted,
      verifiedAtAdmission, signal});
    if (signal?.aborted || !this.isCurrent(admitted)) fail('STALE_TURN');
    return Object.freeze({...this.route(profileKey), memoryEnabled: true,
      memoryEnabledNow: changed, changed, reconnectRequired});
  }
  async beginConversation({profileKey, guard, source = 'player', channel = 'private', requestId, signal} = {}) {
    this.#ready();
    if (source !== 'player') fail('PLAYER_SEND_REQUIRED');
    if (!CHANNELS.has(channel)) fail('INVALID_CHANNEL');
    if (requestId !== undefined && !(token(requestId) || integer(requestId))) fail('INVALID_REQUEST_ID');
    const characterId = this.#id(profileKey), admitted = guard ?? this.route(profileKey, {channel}).guard;
    const verifiedAtAdmission = this.#verified.has(characterId);
    if (admitted.characterId !== characterId || !this.isCurrent(admitted)) fail('STALE_TURN');
    if (signal?.aborted) fail('CANCELLED');
    if (typeof this.#provider?.enableMemory !== 'function') fail('MEMORY_UNAVAILABLE');
    // Established contacts often need no mutation or cloud call. They still
    // cannot bypass local identity/registry integrity checks on actual sends.
    if (this.#state.characters[characterId]?.contacted) await this.#checkStorage();
    if (!this.#state.characters[characterId]?.contacted) await this.#persist(next => {
      if (!this.isCurrent(admitted) || signal?.aborted) fail('STALE_TURN');
      if (!Object.hasOwn(next.characters, characterId) && Object.keys(next.characters).length >= MAX_CHARACTERS) fail('CHARACTER_LIMIT');
      if (!next.characters[characterId]?.contacted) next.characters[characterId] = {
        profileKey, characterEpoch: next.characters[characterId]?.characterEpoch ?? 0, contacted: true};
    });
    const {changed, reconnectRequired} = await this.#ensureEnabled({profileKey, characterId, admitted,
      verifiedAtAdmission, signal});
    if (signal?.aborted || !this.isCurrent(admitted)) fail('STALE_TURN');
    return Object.freeze({...this.route(profileKey, {channel}), memoryEnabled: true, memoryEnabledNow: changed, reconnectRequired});
  }
  #action(id) { return this.#state.actions.find(row => row.id === id); }
  status({actionId} = {}) {
    const characters = Object.entries(this.#state.characters).filter(([, row]) => row.contacted)
      .map(([id, row]) => Object.freeze({profileKey: row.profileKey, blocked: this.#blocked(id)}));
    const action = actionId === undefined ? this.#state.actions.at(-1) : this.#action(actionId);
    return Object.freeze({available: !this.#closed && !this.#fault, talkedToCount: characters.length,
      characters: Object.freeze(characters), command: commandView(action),
      actions: Object.freeze(this.#state.actions.map(commandView))});
  }
  clearCharacter({profileKey, actionId, signal} = {}) {
    this.#ready();
    return this.#clear({scope: 'character', profileKey, characterId: this.#id(profileKey), actionId, signal});
  }
  clearAll({actionId, signal} = {}) {
    this.#ready(); return this.#clear({scope: 'all', profileKey: null, actionId, signal});
  }
  #clear({scope, profileKey, characterId, actionId, signal}) {
    if (!token(actionId)) fail('INVALID_ACTION_ID');
    const prior = this.#action(actionId);
    if (prior && (prior.scope !== scope || prior.profileKey !== profileKey)) fail('ACTION_CONFLICT');
    const active = this.#activeClears.get(actionId);
    if (active && (active.scope !== scope || active.profileKey !== profileKey)) fail('ACTION_CONFLICT');
    if (active) return active.promise;
    if (prior) return Promise.resolve(commandView(prior));
    if (signal?.aborted) return Promise.reject(new PlayerMemoryError('CANCELLED'));
    if (this.#state.actions.length >= MAX_ACTIONS) fail('ACTION_LIMIT');
    if ((scope === 'all' && this.#activeClears.size > 0)
        || [...this.#activeClears.values()].some(active => active.scope === 'all')) fail('CLEAR_IN_PROGRESS');
    const targets = Object.entries(this.#state.characters).filter(([id, row]) => row.contacted && (scope === 'all' || id === characterId))
      .map(([id, row]) => ({characterId: id, profileKey: row.profileKey, state: 'pending', uncertain: false,
        mayHaveReachedProvider: false, providerEmptyObserved: false}));
    const fenced = scope === 'all' ? new Set([...this.#ids.values(), ...Object.keys(this.#state.characters)]) : new Set([characterId]);
    if ([...fenced].some(id => this.#fences.has(id))) fail('CLEAR_IN_PROGRESS');
    for (const id of fenced) {
      this.#fences.add(id); this.#verified.delete(id); this.#enableReceipts.delete(id); this.#enables.get(id)?.controller.abort();
      this.#reconnectPending.delete(id);
    }
    const running = this.#runClear({scope, profileKey, characterId, actionId, targets, fenced, signal});
    this.#activeClears.set(actionId, {scope, profileKey, promise: running});
    running.finally(() => this.#activeClears.delete(actionId)).catch(() => {});
    return running;
  }
  async #runClear({scope, profileKey, characterId, actionId, targets, fenced, signal}) {
    try {
      await this.#persist(next => {
        if (scope === 'all') next.resetEpoch = increment(next.resetEpoch);
        else {
          if (!Object.hasOwn(next.characters, characterId) && Object.keys(next.characters).length >= MAX_CHARACTERS) fail('CHARACTER_LIMIT');
          const row = next.characters[characterId] ?? {profileKey, characterEpoch: 0, contacted: false};
          row.characterEpoch = increment(row.characterEpoch); next.characters[characterId] = row;
        }
        next.actions.push({id: actionId, scope, profileKey, state: 'pending', message: MESSAGES.pending,
          uncertain: false, quiesced: false, targets});
      });
      try {
        if (typeof this.#quiesce !== 'function') fail('QUIESCE_FAILED');
        const receipt = await this.#bounded(combined => this.#quiesce({scope, profileKeys: scope === 'character' ? [profileKey] : targets.map(row => row.profileKey),
          characterIds: [...fenced], actionId, signal: combined}), {signal});
        if (receipt?.quiesced !== true) fail('QUIESCE_FAILED');
        await this.#persist(next => { next.actions.find(row => row.id === actionId).quiesced = true; });
      } catch (error) {
        await this.#persist(next => {
          const action = next.actions.find(row => row.id === actionId);
          action.state = 'failed'; action.message = MESSAGES.quiesce;
          action.targets.forEach(row => { row.state = 'failed'; row.uncertain = false; });
        });
        return commandView(this.#action(actionId));
      }
      for (const target of targets) {
        if (signal?.aborted) {
          await this.#targetResult(actionId, target.characterId, {state: 'failed', uncertain: false});
          continue;
        }
        await this.#persist(next => {
          const row = next.actions.find(action => action.id === actionId).targets.find(row => row.characterId === target.characterId);
          row.mayHaveReachedProvider = true; row.uncertain = true;
        });
        try {
          if (typeof this.#provider?.clearMemory !== 'function') fail('MEMORY_UNAVAILABLE');
          const receipt = await this.#bounded(combined => this.#provider.clearMemory({profileKey: target.profileKey,
            characterId: target.characterId, endUserId: this.#state.endUserId, signal: combined}), {signal, write: true});
          if (receipt?.accepted !== true || typeof receipt.providerEmptyObserved !== 'boolean') throw new PlayerMemoryError('CLEAR_UNVERIFIED', {writeUncertain: true});
          await this.#targetResult(actionId, target.characterId, {state: receipt.providerEmptyObserved ? 'succeeded' : 'failed',
            uncertain: !receipt.providerEmptyObserved, providerEmptyObserved: receipt.providerEmptyObserved});
        } catch (error) {
          await this.#targetResult(actionId, target.characterId, {state: 'failed', uncertain: error?.writeUncertain !== false});
        }
      }
      await this.#persist(next => this.#finishAction(next.actions.find(row => row.id === actionId)));
      return commandView(this.#action(actionId));
    } finally { for (const id of fenced) this.#fences.delete(id); }
  }
  #targetResult(actionId, characterId, result) {
    return this.#persist(next => Object.assign(next.actions.find(action => action.id === actionId)
      .targets.find(row => row.characterId === characterId), result));
  }
  #finishAction(action) {
    action.uncertain = action.targets.some(row => row.uncertain);
    action.state = action.quiesced && action.targets.every(row => row.state === 'succeeded') ? 'succeeded' : 'failed';
    action.message = action.uncertain ? MESSAGES.uncertain : action.state === 'failed' ? MESSAGES.failed
      : action.targets.length ? MESSAGES.succeeded : MESSAGES.empty;
  }
  recoverClear({actionId, signal} = {}) {
    this.#ready();
    if (!token(actionId)) fail('INVALID_ACTION_ID');
    const action = this.#action(actionId);
    if (!action) fail('UNKNOWN_ACTION');
    if (this.#activeClears.has(actionId)) fail('CLEAR_IN_PROGRESS');
    if (action.state === 'succeeded') return Promise.resolve(commandView(action));
    if (signal?.aborted) fail('CANCELLED');
    if (typeof this.#provider?.inspectMemory !== 'function') fail('MEMORY_UNAVAILABLE');
    const fenced = action.scope === 'all' ? new Set([...this.#ids.values(), ...Object.keys(this.#state.characters)])
      : new Set(action.targets.map(row => row.characterId));
    if ((action.scope === 'all' && this.#activeClears.size > 0)
        || [...this.#activeClears.values()].some(active => active.scope === 'all')
        || [...fenced].some(id => this.#fences.has(id))) fail('CLEAR_IN_PROGRESS');
    for (const id of fenced) {
      this.#fences.add(id); this.#verified.delete(id); this.#enableReceipts.delete(id); this.#enables.get(id)?.controller.abort();
    }
    const running = this.#runRecovery({actionId, fenced, signal});
    this.#activeClears.set(actionId, {scope: action.scope, profileKey: action.profileKey, promise: running});
    running.finally(() => this.#activeClears.delete(actionId)).catch(() => {});
    return running;
  }
  async #runRecovery({actionId, fenced, signal}) {
    try {
      await this.#persist(next => {
        const action = next.actions.find(row => row.id === actionId);
        if (action.scope === 'all') next.resetEpoch = increment(next.resetEpoch);
        else for (const id of fenced) next.characters[id].characterEpoch = increment(next.characters[id].characterEpoch);
        action.state = 'pending'; action.message = MESSAGES.pending;
      });
      const action = this.#action(actionId);
      // Recovery re-quiesces but sends no deletion. A crash may have preceded the
      // original quiesce callback; an empty read cannot justify resuming dirty pages.
      try {
        if (typeof this.#quiesce !== 'function') fail('QUIESCE_FAILED');
        const receipt = await this.#bounded(combined => this.#quiesce({scope: action.scope,
          profileKeys: action.targets.map(row => row.profileKey), characterIds: [...fenced], actionId, signal: combined}), {signal});
        if (receipt?.quiesced !== true) fail('QUIESCE_FAILED');
      } catch {
        await this.#persist(next => { const current = next.actions.find(row => row.id === actionId);
          current.quiesced = false; this.#finishAction(current); current.message = current.uncertain ? MESSAGES.uncertain : MESSAGES.quiesce; });
        return commandView(this.#action(actionId));
      }
      for (const target of action.targets.filter(row => row.state !== 'succeeded')) {
        try {
          const result = await this.#bounded(combined => this.#provider.inspectMemory({profileKey: target.profileKey,
            characterId: target.characterId, endUserId: this.#state.endUserId, signal: combined}), {signal});
          if (typeof result?.providerEmptyObserved !== 'boolean') fail('CLEAR_UNVERIFIED');
          await this.#targetResult(actionId, target.characterId, {state: result.providerEmptyObserved ? 'succeeded' : 'failed',
            uncertain: !result.providerEmptyObserved, providerEmptyObserved: result.providerEmptyObserved});
        } catch { await this.#targetResult(actionId, target.characterId, {state: 'failed', uncertain: true}); }
      }
      await this.#persist(next => { const current = next.actions.find(row => row.id === actionId); current.quiesced = true; this.#finishAction(current); });
      return commandView(this.#action(actionId));
    } finally { for (const id of fenced) this.#fences.delete(id); }
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#controllers) controller.abort();
    await this.#mutation;
    await releaseLock(this.#files, this.#lockPath, this.#lockRaw).catch(() => { throw new PlayerMemoryError('STORAGE_FAILURE'); });
  }
}
