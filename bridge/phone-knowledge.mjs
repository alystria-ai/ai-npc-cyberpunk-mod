import {createHash} from 'node:crypto';
import {parsePhoneBinding} from './phone-chat.mjs';
import {throwIfCancelled} from './transport-pool.mjs';

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = code => { throw Object.assign(Error(`Phone knowledge: ${code}`), {code}); };

function requestSnapshot(input, saveIdentity) {
  let value, encoded;
  try { value = structuredClone({input, saveIdentity}); encoded = JSON.stringify(value); }
  catch { fail('INVALID_REQUEST'); }
  if (!plain(value.input) || typeof value.input.id !== 'string' || !value.input.id || value.input.id.length > 140
      || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(value.input.profileKey ?? '') || value.input.channel !== 'phone'
      || typeof value.input.text !== 'string' || !value.input.text.trim() || [...value.input.text].length > 1200
      || !plain(value.saveIdentity) || !same(value.input.saveIdentity, value.saveIdentity)) fail('INVALID_REQUEST');
  return {...value, fingerprint: createHash('sha256').update(encoded).digest('hex')};
}

function boundary(value) {
  if (!plain(value) || typeof value.worldToken !== 'string' || !value.worldToken || value.worldToken.length > 200
      || !Number.isSafeInteger(value.generation) || value.generation < 1) fail('WORLD_UNAVAILABLE');
  return {worldToken: value.worldToken, generation: value.generation};
}

function sameOwner(owner, binding) {
  return (owner?.userId ?? owner?.localUserId) === binding.localUserId
    && (owner?.campaignId ?? owner?.playthroughId) === binding.campaignId && owner?.branchId === binding.branchId;
}

/** Select one route before PhoneChat chooses a provider session. The opaque
 * prepared request is then consumed once by the reply hook, never reconstructed
 * from later native state. Anonymous routes expose no identified ledger ID. */
export class PhoneKnowledge {
  #pending = new Map();
  constructor({router, service, getBoundary, now = Date.now, maxPending = 8, maxAgeMs = 30000} = {}) {
    if (typeof router?.prepare !== 'function' || typeof router?.current !== 'function'
        || !service || typeof getBoundary !== 'function' || typeof now !== 'function'
        || !Number.isInteger(maxPending) || maxPending < 1 || maxPending > 64
        || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || maxAgeMs > 120000) fail('INVALID_CONFIGURATION');
    Object.assign(this, {router, service, getBoundary, now, maxPending, maxAgeMs});
  }
  #remove(entry) {
    if (this.#pending.get(entry.input.id) === entry) this.#pending.delete(entry.input.id);
    entry.signal?.removeEventListener('abort', entry.onAbort);
  }
  #prune() {
    for (const entry of this.#pending.values()) {
      if (entry.signal?.aborted || this.now() - entry.createdAt >= this.maxAgeMs) this.#remove(entry);
    }
  }
  #check(entry) {
    throwIfCancelled(entry.signal);
    if (this.#pending.get(entry.input.id) !== entry || this.now() - entry.createdAt >= this.maxAgeMs) fail('REQUEST_EXPIRED');
    if (!same(entry.boundary, boundary(this.getBoundary()))) fail('WORLD_CHANGED');
  }
  async #current(entry) {
    this.#check(entry);
    if (!await this.router.current(entry.prepared)) fail('WORLD_CHANGED');
    this.#check(entry);
  }
  async prepareContext({input, saveIdentity, signal} = {}) {
    throwIfCancelled(signal);
    const request = requestSnapshot(input, saveIdentity), currentBoundary = boundary(this.getBoundary());
    this.#prune();
    if (this.#pending.has(request.input.id)) fail('REQUEST_ALREADY_PREPARED');
    while (this.#pending.size >= this.maxPending) this.#remove(this.#pending.values().next().value);
    const entry = {...request, signal, boundary: currentBoundary, createdAt: this.now()};
    entry.onAbort = () => this.#remove(entry);
    this.#pending.set(entry.input.id, entry);
    signal?.addEventListener('abort', entry.onAbort, {once: true});
    try {
      entry.prepared = await this.router.prepare(entry.input, {channel: 'phone', ...currentBoundary});
      await this.#current(entry);
      let context = {status: 'unavailable', reason: 'anonymous-route'};
      if (entry.prepared.identified) {
        const binding = parsePhoneBinding(entry.saveIdentity), owner = this.service.saveIdentity;
        if (binding.status !== 'available' || owner?.status !== 'verified' || owner.authoritative !== true
            || !sameOwner(owner, binding) || owner.activationId !== binding.activationId
            || owner.worldGeneration !== binding.generation) fail('MEMORY_ROUTE_CHANGED');
        context = await this.service.ledger.contextFor({characterKey: entry.input.profileKey,
          channel: 'phone', audience: [entry.input.profileKey]});
        if (context?.status !== 'available' || !sameOwner(context.identity, binding)
            || context.characterKey !== entry.input.profileKey || context.channel !== 'phone'
            || context.endUserId !== entry.prepared.remoteConfig?.endUserId) fail('MEMORY_ROUTE_CHANGED');
      }
      await this.#current(entry);
      entry.ready = true;
      return structuredClone(context);
    } catch (error) { this.#remove(entry); throw error; }
  }
  async preparedFor({input, saveIdentity, signal} = {}) {
    throwIfCancelled(signal);
    const request = requestSnapshot(input, saveIdentity);
    this.#prune();
    const entry = this.#pending.get(request.input.id);
    if (!entry?.ready || entry.claimed || entry.fingerprint !== request.fingerprint || entry.signal !== signal) fail('REQUEST_NOT_PREPARED');
    entry.claimed = true;
    try { await this.#current(entry); this.#check(entry); }
    catch (error) { this.#remove(entry); throw error; }
    this.#remove(entry);
    return entry.prepared;
  }
  clear() { for (const entry of this.#pending.values()) this.#remove(entry); }
}
