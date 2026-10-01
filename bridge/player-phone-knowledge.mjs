import {createHash} from 'node:crypto';
import {parsePlayerPhoneContext} from './phone-chat.mjs';
import {throwIfCancelled} from './transport-pool.mjs';

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const epoch = value => Number.isSafeInteger(value) && value >= 0;
const fail = code => { throw Object.assign(Error(`Player phone knowledge: ${code}`), {code}); };
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function playerPhoneGeneration(guard) {
  if (!plain(guard) || !epoch(guard.resetEpoch) || !epoch(guard.characterEpoch)) fail('INVALID_MEMORY_GUARD');
  return hash([guard.resetEpoch, guard.characterEpoch]);
}

function requestSnapshot(input, saveIdentity) {
  let value, fingerprint;
  try { value = structuredClone({input, saveIdentity}); fingerprint = hash(value); }
  catch { fail('INVALID_REQUEST'); }
  if (!plain(value.input) || typeof value.input.id !== 'string' || !/^[A-Za-z0-9-]{1,140}$/.test(value.input.id)
      || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(value.input.profileKey ?? '') || value.input.channel !== 'phone'
      || typeof value.input.contact !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(value.input.contact)
      || typeof value.input.text !== 'string' || !value.input.text.trim() || [...value.input.text].length > 1200
      || !plain(value.saveIdentity) || !same(value.input.saveIdentity, value.saveIdentity)) fail('INVALID_REQUEST');
  return {...freeze(value), fingerprint};
}

function boundary(value) {
  if (!plain(value) || typeof value.worldToken !== 'string'
      || !/^[A-Za-z0-9_:-][A-Za-z0-9._:/@+#-]{0,199}$/.test(value.worldToken)
      || !Number.isSafeInteger(value.generation) || value.generation < 1) fail('WORLD_UNAVAILABLE');
  return Object.freeze({worldToken: value.worldToken, generation: value.generation});
}

function routeContext(prepared, entry) {
  const route = prepared?.route, input = prepared?.input, guard = prepared?.guard;
  if (!plain(prepared) || prepared.status !== 'ready' || prepared.sendAllowed !== true || prepared.identified !== true
      || !plain(route) || route.profileKey !== entry.input.profileKey || route.channel !== 'phone'
      || !Array.isArray(route.audience) || route.audience.length !== 1 || route.audience[0] !== entry.input.profileKey
      || !plain(input) || input.id !== entry.input.id || input.contact !== entry.input.contact
      || input.profileKey !== entry.input.profileKey || input.channel !== 'phone' || input.text !== entry.input.text
      || !same(input.saveIdentity, entry.saveIdentity) || !plain(guard)
      || prepared.remoteConfig?.endUserId !== guard.endUserId || typeof guard.characterId !== 'string'
      || !guard.characterId || guard.characterId.length > 256
      || prepared.worldToken !== entry.boundary.worldToken || prepared.generation !== entry.boundary.generation) {
    fail('MEMORY_ROUTE_CHANGED');
  }
  const context = parsePlayerPhoneContext({status: 'player', endUserId: prepared.remoteConfig.endUserId,
    characterId: guard.characterId, scope: prepared.scope, sessionKey: prepared.sessionKey,
    remoteGeneration: playerPhoneGeneration(guard)});
  if (!context) fail('MEMORY_ROUTE_CHANGED');
  return context;
}

/** Select the player's exact phone route before session lookup. Native save
 * identity is only frozen request data; the fresh world boundary and reset
 * guard prove the route. Preparing and warming never enable or write memory. */
export class PlayerPhoneKnowledge {
  #pending = new Map();
  #live = new Set();
  #contexts = new WeakMap();
  constructor({router, getBoundary, now = Date.now, maxPending = 8, maxAgeMs = 30000} = {}) {
    if (typeof router?.prepare !== 'function' || typeof router?.current !== 'function'
        || (getBoundary !== undefined && typeof getBoundary !== 'function')
        || (getBoundary === undefined && typeof router.getBoundary !== 'function') || typeof now !== 'function'
        || !Number.isInteger(maxPending) || maxPending < 1 || maxPending > 64
        || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || maxAgeMs > 120000) fail('INVALID_CONFIGURATION');
    Object.assign(this, {router, getBoundary: getBoundary || (() => router.getBoundary()), now, maxPending, maxAgeMs});
  }
  #remove(entry) {
    if (this.#pending.get(entry.input.id) === entry) this.#pending.delete(entry.input.id);
    this.#live.delete(entry); entry.invalidated = true;
    entry.signal?.removeEventListener('abort', entry.onAbort);
  }
  #prune() {
    for (const entry of this.#live) {
      if (entry.signal?.aborted || (!entry.claimed && this.now() - entry.createdAt >= this.maxAgeMs)) this.#remove(entry);
    }
  }
  #check(entry, pending = false) {
    throwIfCancelled(entry.signal);
    if (entry.invalidated || !this.#live.has(entry)
        || (pending && (this.#pending.get(entry.input.id) !== entry || this.now() - entry.createdAt >= this.maxAgeMs))) {
      fail('REQUEST_EXPIRED');
    }
    let current;
    try { current = boundary(this.getBoundary()); } catch { fail('WORLD_CHANGED'); }
    if (!same(entry.boundary, current)) fail('WORLD_CHANGED');
  }
  async #current(entry, pending = false) {
    this.#check(entry, pending);
    if (!await this.router.current(entry.prepared)) fail('MEMORY_ROUTE_CHANGED');
    this.#check(entry, pending);
  }
  async prepareContext({input, saveIdentity, signal} = {}) {
    throwIfCancelled(signal);
    const request = requestSnapshot(input, saveIdentity), currentBoundary = boundary(this.getBoundary());
    if (request.saveIdentity.generation !== undefined && request.saveIdentity.generation !== currentBoundary.generation) fail('WORLD_CHANGED');
    this.#prune();
    if ([...this.#live].some(entry => entry.input.id === request.input.id)) fail('REQUEST_ALREADY_PREPARED');
    while (this.#live.size >= this.maxPending) this.#remove(this.#live.values().next().value);
    const entry = {...request, signal, boundary: currentBoundary, createdAt: this.now(), claimed: false};
    entry.onAbort = () => this.#remove(entry);
    this.#pending.set(entry.input.id, entry); this.#live.add(entry);
    signal?.addEventListener('abort', entry.onAbort, {once: true});
    try {
      entry.prepared = await this.router.prepare(entry.input, {channel: 'phone', ...currentBoundary});
      await this.#current(entry, true);
      entry.context = routeContext(entry.prepared, entry);
      await this.#current(entry, true);
      entry.ready = true; this.#contexts.set(entry.context, entry);
      return entry.context;
    } catch (error) { this.#remove(entry); throw error; }
  }
  async preparedFor(options = {}) {
    const {input, saveIdentity, signal} = options;
    throwIfCancelled(signal);
    const request = requestSnapshot(input, saveIdentity);
    this.#prune();
    const entry = this.#pending.get(request.input.id);
    if (!entry?.ready || entry.claimed || entry.fingerprint !== request.fingerprint || entry.signal !== signal
        || ['characterId', 'endUserId', 'scope', 'sessionKey', 'remoteGeneration'].some(key => key in options && options[key] !== entry.context[key])) {
      fail('REQUEST_NOT_PREPARED');
    }
    entry.claimed = true;
    try {
      await this.#current(entry, true);
      routeContext(entry.prepared, entry);
      this.#check(entry, true);
      this.#pending.delete(entry.input.id);
      return entry.prepared;
    } catch (error) { this.#remove(entry); throw error; }
  }
  currentSync(context) {
    const entry = this.#contexts.get(context);
    if (!entry) return false;
    try {
      this.#check(entry, !entry.claimed);
      return this.router.currentSync?.(entry.prepared) === true;
    } catch { return false; }
  }
  async current(context) {
    const entry = this.#contexts.get(context);
    if (!entry) return false;
    try { await this.#current(entry, !entry.claimed); return true; }
    catch { this.#remove(entry); return false; }
  }
  clear() { for (const entry of this.#live) this.#remove(entry); }
}
