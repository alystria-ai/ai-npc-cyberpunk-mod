import {createHash} from 'node:crypto';
import {parseWorldSnapshot, resolveKnowledge, validateKnowledgePack, warmKnowledgePack} from './world-knowledge.mjs';
import {parseJournal, withConversationKnowledge} from './quest-context.mjs';
import {isAmbientProfile} from './protocol.mjs';

const PROFILE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const TOKEN = /^[A-Za-z0-9_:-][A-Za-z0-9._:/@+#-]{0,159}$/;
// Residents and generic NPC archetypes (npc-*) share one predicate (bridge/protocol.mjs).
const AMBIENT = {has: isAmbientProfile};
const CHANNELS = new Set(['private', 'group', 'phone', 'microphone']);
const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => { throw Object.assign(new Error(`Player knowledge: ${code}`), {code}); };
const unavailable = reason => ({status: 'unavailable', reason, sendAllowed: false, remoteConfig: null});
const validToken = value => typeof value === 'string' && TOKEN.test(value)
  && !['__proto__', 'constructor', 'prototype'].includes(value);
const validGeneration = value => Number.isSafeInteger(value) && value >= 1;
const validEpoch = value => Number.isSafeInteger(value) && value >= 0;
const boundedId = value => typeof value === 'string' && value.length > 0 && value.length <= 256
  && !/[\u0000-\u0020\u007f]/u.test(value);
const validBinding = value => validToken(value?.worldToken) && validGeneration(value?.generation);
const sameBinding = (a, b) => validBinding(a) && validBinding(b)
  && a.worldToken === b.worldToken && a.generation === b.generation;

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) freeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

function routeFor(profileKey, scope = 'private', source) {
  if (typeof profileKey !== 'string' || !PROFILE.test(profileKey) || typeof scope !== 'string') fail('INVALID_ROUTE');
  const microphone = source === 'microphone' || scope === 'microphone' || scope.startsWith('microphone:');
  if (scope === 'microphone') scope = 'private';
  else if (scope.startsWith('microphone:')) scope = scope.slice(11);
  const channel = scope.startsWith('group:') ? 'group' : scope;
  const audience = channel === 'group' ? scope.slice(6).split(',') : [profileKey];
  if (!['private', 'group', 'phone'].includes(channel) || !audience.length || audience.length > 8
      || audience.some(key => typeof key !== 'string' || !PROFILE.test(key))
      || !audience.includes(profileKey) || new Set(audience).size !== audience.length) fail('INVALID_ROUTE');
  return freeze({profileKey, channel, audience: audience.sort(), transport: microphone ? 'microphone' : channel});
}

function inputRoute(input, requestedChannel) {
  if (requestedChannel !== undefined && !CHANNELS.has(requestedChannel)
      || input.channel !== undefined && !CHANNELS.has(input.channel)) fail('INVALID_ROUTE');
  const channel = input.group ? 'group' : input.channel ?? requestedChannel ?? 'private';
  const logicalChannel = channel === 'microphone' ? 'private' : channel;
  if (requestedChannel !== undefined && requestedChannel !== 'microphone' && requestedChannel !== logicalChannel) {
    fail('CHANNEL_MISMATCH');
  }
  if (input.group && input.channel === 'phone') fail('CHANNEL_MISMATCH');
  const scope = logicalChannel === 'group' && Array.isArray(input.group?.audience)
    ? `group:${input.group.audience.join(',')}` : logicalChannel;
  const source = input.source === 'microphone' || channel === 'microphone' || requestedChannel === 'microphone'
    ? 'microphone' : undefined;
  return routeFor(input.profileKey, scope, source);
}

function freshSnapshot(snapshot, binding, route, now) {
  const age = now - Date.parse(snapshot?.capturedAt);
  return snapshot?.status === 'ready' && sameBinding(snapshot, binding)
    && Number.isFinite(now) && Number.isFinite(age) && age >= -1000 && age <= 5000
    && snapshot.audience.channel === route.channel
    && JSON.stringify([...snapshot.audience.profileKeys].sort()) === JSON.stringify(route.audience);
}

/** Current-world routing only. PlayerMemory owns the one durable player ID and
 * reset epochs. No ledger, save identity, provider calls, or memory seeding occur
 * here. The parent owns request admission and begins actual conversations.
 */
export class PlayerKnowledge {
  #prepared = new WeakMap();

  constructor({playerMemory, pack, questCatalog = [], now = Date.now, isWorldCurrent, getBoundary, selectProfile} = {}) {
    if (!playerMemory || typeof playerMemory.route !== 'function' || typeof playerMemory.isCurrent !== 'function'
        || typeof now !== 'function' || isWorldCurrent !== undefined && typeof isWorldCurrent !== 'function'
        || getBoundary !== undefined && typeof getBoundary !== 'function'
        || !isWorldCurrent && !getBoundary || selectProfile !== undefined && typeof selectProfile !== 'function') fail('INVALID_CONFIGURATION');
    if (!validateKnowledgePack(pack).ok) fail('INVALID_REVIEWED_PACK');
    this.playerMemory = playerMemory; this.pack = freeze(clone(pack));
    // The frozen copy is immutable; prepare it once here rather than per turn.
    warmKnowledgePack(this.pack);
    this.questCatalog = freeze(clone(questCatalog)); this.now = now;
    this.isWorldCurrent = isWorldCurrent; this.getBoundary = getBoundary; this.selectProfile = selectProfile;
  }

  #boundary() {
    if (!this.getBoundary) return null;
    try {
      const value = this.getBoundary();
      return validBinding(value) ? freeze({worldToken: value.worldToken, generation: value.generation}) : null;
    } catch { return null; }
  }

  #binding({worldToken, generation} = {}, snapshot) {
    if (worldToken !== undefined && !validToken(worldToken)
        || generation !== undefined && !validGeneration(generation)) fail('INVALID_WORLD_BINDING');
    const candidates = [this.#boundary(), snapshot].filter(validBinding);
    if (worldToken !== undefined && generation !== undefined) return freeze({worldToken, generation});
    const candidate = candidates.find(value => (worldToken === undefined || value.worldToken === worldToken)
      && (generation === undefined || value.generation === generation));
    return freeze({worldToken: worldToken ?? candidate?.worldToken, generation: generation ?? candidate?.generation});
  }

  #ownerCurrent(binding) {
    return validBinding(binding) && (!this.getBoundary || sameBinding(binding, this.#boundary()));
  }

  #liveSync(binding) {
    if (!this.#ownerCurrent(binding)) return false;
    try {
      const result = this.isWorldCurrent ? this.isWorldCurrent(binding) : true;
      // A warm request must never wait or perform speculative provider work.
      // Async world guards can still be used by prepare/current.
      if (result && typeof result.then === 'function') result.catch?.(() => {});
      return result === true && this.#ownerCurrent(binding);
    } catch { return false; }
  }

  async #live(binding) {
    if (!this.#ownerCurrent(binding)) return false;
    try {
      return (this.isWorldCurrent ? await this.isWorldCurrent(binding) === true : true)
        && this.#ownerCurrent(binding);
    } catch { return false; }
  }

  #memoryCurrent(guard) {
    try { return !!guard && this.playerMemory.isCurrent(guard) === true; } catch { return false; }
  }

  #selectedRoute(route, binding) {
    if (!this.selectProfile) return {route};
    try {
      const selection = this.selectProfile(route.profileKey, binding);
      if (selection?.status !== 'ready') return {route, reason: 'relationship-profile-unavailable'};
      if (selection.profileKey !== route.profileKey || !PROFILE.test(selection.providerProfileKey ?? '')
          || !boundedId(selection.characterId) || !['ordinary', 'romantic'].includes(selection.variant)
          || selection.providerProfileKey !== route.profileKey + (selection.variant === 'romantic' ? '-romantic' : '')
            + (selection.multilingual === true ? '-multilingual' : '')) {
        return {route, reason: 'invalid-relationship-profile'};
      }
      return freeze({route: {...route, providerProfileKey: selection.providerProfileKey,
        relationshipVariant: selection.variant}, relationship: clone(selection)});
    } catch { return {route, reason: 'relationship-profile-unavailable'}; }
  }

  #memoryRoute(route) {
    try {
      const value = this.playerMemory.route(route.providerProfileKey ?? route.profileKey, {channel: route.channel, audience: route.audience});
      const guard = value?.guard;
      if (!boundedId(value?.endUserId) || !guard || guard.endUserId !== value.endUserId
          || !boundedId(guard.characterId) || !validEpoch(guard.resetEpoch) || !validEpoch(guard.characterEpoch)) {
        return {reason: 'invalid-player-route'};
      }
      return freeze({endUserId: value.endUserId, guard: clone(guard)});
    } catch (cause) {
      return {reason: cause?.code === 'MEMORY_CLEAR_PENDING' ? 'memory-clear-pending'
        : cause?.code === 'UNKNOWN_CHARACTER' ? 'unknown-character' : 'player-route-unavailable'};
    }
  }

  #configuration(route, binding, memory, entity, ready, relationship) {
    const ambient = AMBIENT.has(route.profileKey);
    const entityReady = !ambient || typeof entity === 'string' && /^\d+ULL$/.test(entity);
    const available = ready && entityReady && this.#memoryCurrent(memory?.guard)
      && (!relationship || memory.guard.characterId === relationship.characterId);
    const base = route.channel === 'group' ? `group:${hash(route.audience).slice(0, 16)}` : route.channel;
    // Input modality is not another conversation. F7/F9 must reuse the exact
    // private/group page retained at invitation/composer time; a microphone-only
    // namespace is absent from that plan and gets evicted during recording.
    // Keep route.transport for admission provenance, while preserving every
    // player, world, reset, character, audience and ambient-entity boundary.
    const partition = available ? [binding.worldToken, binding.generation, memory.endUserId, memory.guard.characterId,
      memory.guard.resetEpoch, memory.guard.characterEpoch, route.profileKey, route.channel, route.audience,
      route.channel, ambient ? entity : null] : null;
    return freeze({status: available ? 'ready' : 'unavailable', sendAllowed: available, route,
      ...(relationship ? {relationship} : {}),
      // Ambient profiles keep Convai long-term memory off: admission records the Forget target only.
      ...(ambient ? {providerMemory: 'session-only'} : {}),
      scope: available ? `${base}:world:${hash(partition).slice(0, 24)}` : null,
      sessionKey: available ? hash(partition) : null,
      remoteConfig: available ? {endUserId: memory.endUserId} : null, guard: available ? memory.guard : null,
      identified: available, localEligible: available, worldToken: binding.worldToken, generation: binding.generation,
      memoryReason: available ? 'player-conversation-only' : !entityReady ? 'ambient-entity-unavailable'
        : memory?.reason ?? (ready ? 'stale-player-route' : 'current-world-unavailable')});
  }

  /** Read-only warm configuration. The caller supplies or exposes a fresh world
   * heartbeat. Missing world bindings or unmapped ambient entities skip warm.
   */
  configFor(profileKey, scope = 'private', {entity, worldToken, generation, source} = {}) {
    let route = routeFor(profileKey, scope, source);
    const binding = this.#binding({worldToken, generation});
    if (!this.#liveSync(binding) || AMBIENT.has(profileKey) && !(typeof entity === 'string' && /^\d+ULL$/.test(entity))) return null;
    const selected = this.#selectedRoute(route, binding);
    if (selected.reason) return null;
    route = selected.route;
    const memory = this.#memoryRoute(route);
    const configuration = this.#configuration(route, binding, memory, entity, this.#liveSync(binding), selected.relationship);
    return configuration.sendAllowed ? configuration : null;
  }

  async prepare(input, options = {}) {
    // Capture request, options, world boundary and reset guard before any await.
    // Shared group inputs and provider resets cannot rebind an admitted turn.
    const frozen = clone(input), settings = clone(options);
    let route = inputRoute(frozen, settings.channel);
    const snapshot = parseWorldSnapshot(frozen.worldKnowledge);
    const binding = this.#binding(settings, snapshot);
    const selected = this.#selectedRoute(route, binding);
    route = selected.route;
    frozen.channel = route.channel;
    frozen.worldKnowledge = snapshot;
    if (frozen.journal !== undefined) frozen.journal = parseJournal(frozen.journal);
    freeze(frozen);
    const memory = selected.reason ? {reason: selected.reason}
      : validBinding(binding) ? this.#memoryRoute(route) : {reason: 'current-world-unavailable'};
    const live = await this.#live(binding);
    const configuration = this.#configuration(route, binding, memory, frozen.entity, live, selected.relationship);
    const capturedAt = this.now();
    const captureCurrent = configuration.sendAllowed && freshSnapshot(snapshot, binding, route, capturedAt);
    let knowledgeContext = '';
    if (captureCurrent) {
      // Old native identity fields never qualify archive events. Only the
      // resolver's current-context string is consumed by this coordinator.
      const projection = resolveKnowledge({pack: this.pack, snapshot: {...snapshot, identity: {status: 'unknown'}},
        profileKey: route.profileKey, query: frozen.text, maxChars: 8000});
      if (projection.diagnostics.status === 'ready') knowledgeContext = projection.context;
    }
    // The tracked journal is bounded request data captured by Lua at admission;
    // parent raw-input ownership and this world guard establish its provenance.
    // Broader facts/history have their own publication leases and audience gate.
    const attached = withConversationKnowledge(frozen, {knowledgeContext,
      generation: captureCurrent ? binding.generation : undefined,
      worldToken: captureCurrent ? binding.worldToken : undefined, questCatalog: this.questCatalog, now: capturedAt});
    const prepared = freeze({...configuration, input: attached});
    this.#prepared.set(prepared, {binding, guard: memory.guard ?? null,
      admitted: configuration.sendAllowed, cancelled: false, submitted: false});
    return prepared;
  }

  // Final publication runs on this event loop. Recheck local reset fences and
  // the current world without an await immediately before the file commit.
  currentSync(prepared) {
    const state = this.#prepared.get(prepared);
    return !!state && state.admitted && !state.cancelled
      && this.#memoryCurrent(state.guard) && this.#liveSync(state.binding);
  }

  async current(prepared) {
    const state = this.#prepared.get(prepared);
    if (!state || !state.admitted || state.cancelled || !this.#memoryCurrent(state.guard)) return false;
    const live = await this.#live(state.binding);
    return live && !state.cancelled && this.#memoryCurrent(state.guard);
  }

  /** Compatibility guard only; parent calls PlayerMemory.beginConversation at
   * the actual player send. No quest or transcript is persisted here.
   */
  async submitted(prepared) {
    const state = this.#prepared.get(prepared);
    if (!state || state.submitted) fail('DUPLICATE_OR_INVALID_SUBMISSION');
    state.submitted = true;
    if (!await this.current(prepared)) fail('STALE_WORLD');
    return {status: 'ready', sendAllowed: true, guard: prepared.guard, remoteConfig: prepared.remoteConfig};
  }

  async activity(prepared, kind) {
    const state = this.#prepared.get(prepared);
    if (!state || !['generated-reply', 'delivered-reply', 'cancelled-turn'].includes(kind)) return unavailable('invalid-activity');
    if (kind === 'cancelled-turn') {
      state.cancelled = true;
      return {status: 'cancelled', kind, sendAllowed: false, remoteConfig: null};
    }
    if (!await this.current(prepared)) return unavailable('stale-world');
    return {status: 'current', kind, sendAllowed: true, guard: prepared.guard, remoteConfig: prepared.remoteConfig};
  }
}
