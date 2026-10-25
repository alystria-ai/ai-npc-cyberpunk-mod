// Conversation style selection only. This module reads reviewed native
// relationship receipts and decides, per character and turn, whether the delivery is affectionate
// ("romantic") or ordinary; it never changes quests, sends dialogue, provisions profiles or enables memory.
// Every character has ONE Convai profile (plus its Multilingual twin while that setting is on), so the choice only
// decides whether bridge/romance-context.mjs adds its block to the turn's dynamic context. It never changes the provider ID.
import {parseGroup} from './group-context.mjs';
import {MULTILINGUAL_SUFFIX, twinMarkerKey, twinProviderKey} from './multilingual.mjs';

const plain = value => !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const key = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value)
  && !['__proto__', 'constructor', 'prototype'].includes(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/.test(value);
const worldKey = value => typeof value === 'string' && /^[A-Za-z0-9_:-][A-Za-z0-9._:/@+#-]{0,159}$/.test(value);
const binding = value => worldKey(value?.worldToken) && Number.isSafeInteger(value?.generation) && value.generation >= 1;
const sameWorld = (a, b) => binding(a) && binding(b)
  && a.worldToken === b.worldToken && a.generation === b.generation;
const fail = code => { throw Object.assign(Error('Relationship routing: ' + code), {code}); };
const MODES = new Set(['auto', 'on', 'off']);
// The game versions the eleven receipt facts were checked on (docs/GAME_VERSIONS.md): the same quest data in 2.31 and 2.5. The Lua side
// (mod/relationship-state.lua) writes the canonical name, '2.5' for CD Projekt's 2.50. Any other patch is unsupported on purpose.
export const RELATIONSHIP_GAME_VERSIONS = Object.freeze(['2.31', '2.5']);
export const RELATIONSHIP_PROFILES = Object.freeze({
  // The hut quest writes sq030_judy_lover only on the scene's romance exit, which
  // itself requires the morning commitment (sq030_11_romance). sq030_romance is
  // written later, once V has also picked up their clothes, so requiring it left
  // a player-paced window where the game already treats V as Judy's partner but
  // Auto still chose the ordinary profile. Both are still captured (the Lua
  // allowlist must match this one exactly) but only the lover fact decides.
  'judy-alvarez': Object.freeze({kind: 'relationship', rule: 'core-arcs.judy.committed',
    all: Object.freeze(['sq030_judy_lover']), observed: Object.freeze(['sq030_11_romance', 'sq030_romance']),
    conflicts: Object.freeze(['sq030_friendship'])}),
  'panam-palmer': Object.freeze({kind: 'relationship', rule: 'aldecaldos.native.panam-basilisk-intimacy',
    all: Object.freeze(['sq027_panzer_sex', 'sq027_panam_lover']), conflicts: Object.freeze([])}),
  'river-ward': Object.freeze({kind: 'relationship', rule: 'jr-native.river-relationship-committed',
    all: Object.freeze(['sq029_river_lover', 'sq029_done']), conflicts: Object.freeze([])}),
  'kerry-eurodyne': Object.freeze({kind: 'relationship', rule: 'silverhand.beach-committed',
    positive: 'sq028_kerry_relationship', conflicts: Object.freeze(['sq028_kerry_dislike'])}),
  'meredith-stout': Object.freeze({kind: 'casual-intimacy', rule: 'ahe-native.stout-encounter',
    positive: 'q003_stout_sex_done', conflicts: Object.freeze([])}),
});
export const RELATIONSHIP_FACTS = Object.freeze([...new Set(Object.values(RELATIONSHIP_PROFILES)
  .flatMap(row => [...(row.all || [row.positive]), ...(row.observed || []), ...row.conflicts]))]);

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** The provider IDs of every character: the ordinary mapping, plus each multilingual twin (from bridge/multilingual.mjs,
 * `twins` = {providerKey: twinId}) as provider key "<providerKey>-multilingual" in the same family, so memory guards, Forget and
 * history treat it like the original's sibling. A missing twin map is a compatible English-only installation.
 * Each character has exactly one ordinary ID. The old alternate affectionate profiles (runtime/relationship-profiles.json,
 * provider keys "<key>-romantic") are retired: that file is no longer read. */
export function relationshipRegistry(ordinaryIds, twins = {}, packTwins = []) {
  if (!plain(ordinaryIds) || Object.keys(ordinaryIds).length > 256
      || Object.entries(ordinaryIds).some(([profile, value]) => !key(profile) || !id(value))) fail('INVALID_ORDINARY_IDS');
  const providerIds = {...ordinaryIds}, providerFamilies = Object.fromEntries(Object.keys(ordinaryIds).map(profile => [profile, profile]));
  if (!plain(twins) || Object.keys(twins).length > 512) fail('INVALID_MULTILINGUAL_REGISTRY');
  const multilingual = {}, markerKeys = {};
  for (const [providerKey, twinId] of Object.entries(twins)) {
    if (!Object.hasOwn(providerIds, providerKey) || providerKey.endsWith(MULTILINGUAL_SUFFIX) || !id(twinId)) fail('INVALID_MULTILINGUAL_PROFILE');
    const twinKey = twinProviderKey(providerKey);
    if (Object.hasOwn(providerIds, twinKey) || Object.hasOwn(twins, twinKey) || !key(twinKey)) fail('MULTILINGUAL_KEY_COLLISION');
    multilingual[providerKey] = twinKey; markerKeys[twinKey] = twinMarkerKey(providerKey);
  }
  for (const [providerKey, twinKey] of Object.entries(multilingual)) {
    providerIds[twinKey] = twins[providerKey]; providerFamilies[twinKey] = providerFamilies[providerKey];
  }
  // A content pack's Convai twin (add-on API 1.1, bridge/addon-content.mjs convaiTwins): the character made from the pack's text, as provider key "<profileKey>-<pack id>" in the
  // same family (memory guards, Forget and history treat it like a sibling). Whether a turn uses it is decided per turn (packTwin of selectRelationshipProfile). The list was already
  // checked for collisions; one that still collides is left out here rather than stopping the bridge.
  const packKeys = {}, taken = new Set(Object.values(providerIds));
  for (const twin of Array.isArray(packTwins) ? packTwins : []) {
    if (!twin || !Object.hasOwn(ordinaryIds, twin.profileKey) || !key(twin.key) || !id(twin.characterId) || Object.hasOwn(providerIds, twin.key)
        || taken.has(twin.characterId) || twin.key.endsWith(MULTILINGUAL_SUFFIX)) continue;
    providerIds[twin.key] = twin.characterId; providerFamilies[twin.key] = providerFamilies[twin.profileKey];
    markerKeys[twin.key] = `${twin.profileKey}:${twin.packId}`;
    taken.add(twin.characterId); packKeys[twin.key] = twin.profileKey;
  }
  if (new Set(Object.values(providerIds)).size !== Object.keys(providerIds).length) fail('DUPLICATE_PROVIDER_ID');
  return freeze({providerIds, providerFamilies, multilingual, markerKeys, packKeys});
}

export function parseRelationshipState(raw) {
  let value;
  try {
    if (typeof raw === 'string') { if (Buffer.byteLength(raw, 'utf8') > 16384) return null; value = JSON.parse(raw); }
    else { if (!plain(raw) || Buffer.byteLength(JSON.stringify(raw), 'utf8') > 16384) return null; value = structuredClone(raw); }
  } catch { return null; }
  if (!plain(value) || value.version !== 1 || value.status !== 'ready' || !RELATIONSHIP_GAME_VERSIONS.includes(value.gameVersion)
      || !binding(value) || !Number.isSafeInteger(value.capturedAt) || value.capturedAt < 0 || !plain(value.facts)
      || Object.keys(value.facts).some(fact => !RELATIONSHIP_FACTS.includes(fact))) return null;
  const facts = {};
  for (const [fact, row] of Object.entries(value.facts)) {
    if (!plain(row)) return null;
    if (row.status === 'unknown') { facts[fact] = {status: 'unknown'}; continue; }
    if (row.status !== 'known' || row.present !== true || !Number.isInteger(row.value)
        || row.value < -2147483648 || row.value > 2147483647 || row.sourceId !== 'native-quests-system'
        || !Array.isArray(row.evidenceRefs) || !row.evidenceRefs.length || row.evidenceRefs.length > 16
        || row.evidenceRefs.some(ref => typeof ref !== 'string' || !worldKey(ref))) return null;
    facts[fact] = {status: 'known', value: row.value, present: true, sourceId: row.sourceId, evidenceRefs: [...row.evidenceRefs]};
  }
  return freeze({version: 1, status: 'ready', gameVersion: value.gameVersion,
    worldToken: value.worldToken, generation: value.generation, capturedAt: value.capturedAt, facts});
}

export function relationshipModes(value) {
  if (value !== undefined && (!plain(value) || Object.keys(value).some(profile => !Object.hasOwn(RELATIONSHIP_PROFILES, profile)))) return null;
  const modes = {};
  for (const profile of Object.keys(RELATIONSHIP_PROFILES)) {
    const mode = value?.[profile] ?? 'auto';
    if (!MODES.has(mode)) return null;
    modes[profile] = mode;
  }
  return Object.freeze(modes);
}

const known = (snapshot, name) => snapshot?.facts?.[name]?.status === 'known'
  && snapshot.facts[name].present === true ? snapshot.facts[name].value : undefined;
function confirmed(profile, snapshot) {
  const row = RELATIONSHIP_PROFILES[profile];
  if (row.conflicts.some(fact => (known(snapshot, fact) ?? 0) >= 1)) return false;
  return row.all ? row.all.every(fact => known(snapshot, fact) === 1) : (known(snapshot, row.positive) ?? 0) >= 1;
}
const fresh = (snapshot, boundary, now) => snapshot?.status === 'ready' && sameWorld(snapshot, boundary)
  && now - snapshot.capturedAt >= -1000 && now - snapshot.capturedAt <= 5000;

export function selectRelationshipProfile({profileKey, mode = 'auto', snapshot, boundary, now = Date.now(), registry,
  multilingual = false, packTwin = null} = {}) {
  if (!key(profileKey) || !MODES.has(mode) || !registry || !Object.hasOwn(registry.providerIds, profileKey)
      || !Number.isSafeInteger(now)) fail('INVALID_SELECTION');
  const rule = RELATIONSHIP_PROFILES[profileKey];
  // Only the five relationship characters read save facts; every other character skips the parse.
  const observed = !rule || snapshot == null ? null : parseRelationshipState(snapshot);
  const current = !!rule && fresh(observed, boundary, now);
  // The style is the whole decision: it never changes the provider ID. On is affectionate delivery; Off is ordinary delivery;
  // Auto is affectionate only when a fresh capture of this world confirms the relationship. Without a fresh capture Auto is
  // ordinary for this turn (the conversation is never blocked on it), and the next turn follows the capture once it arrives.
  const romantic = !!rule && (mode === 'on' || mode === 'auto' && current && confirmed(profileKey, observed));
  // A turn in another language: the twin of the profile. A profile without a usable twin keeps its original (English-only) profile.
  const twinKey = multilingual === true ? registry.multilingual?.[profileKey] : undefined;
  // A content pack's twin (English only): used when the pack is on and the turn does not go to the multilingual twin, which answers in the player's language.
  const packKey = !twinKey && typeof packTwin === 'string' && registry.packKeys?.[packTwin] === profileKey ? packTwin : undefined;
  const providerProfileKey = twinKey ?? packKey ?? profileKey;
  // Style and history are separate. On is never evidence, and Off does not erase a real event. Capture only this speaker's
  // current-save receipt with the admitted selection; group prompts never receive other partners' facts.
  const saveRelationship = current && confirmed(profileKey, observed)
    ? {status: 'confirmed', evidenceRule: rule.rule} : null;
  return freeze({status: 'ready', profileKey, providerProfileKey, characterId: registry.providerIds[providerProfileKey],
    style: romantic ? 'romantic' : 'ordinary', kind: rule?.kind ?? 'ordinary', mode, multilingual: !!twinKey, ...(packKey ? {pack: true} : {}),
    reason: !rule ? 'unsupported' : mode === 'on' ? 'explicit-on' : mode === 'off' ? 'explicit-off'
      : romantic ? 'verified-current-save' : current ? 'auto-unconfirmed' : 'relationship-state-unavailable',
    ...(romantic && mode === 'auto' ? {evidenceRule: rule.rule} : {}),
    ...(saveRelationship ? {saveRelationship} : {}),
    ...(binding(boundary) ? {worldToken: boundary.worldToken, generation: boundary.generation} : {})});
}

/** Settings and native updates commit only at an idle turn boundary. A prepared
 * turn owns its frozen selection; a settings change never alters its style or redirects its send. */
export class RelationshipRouting {
  constructor({ordinaryIds, multilingual, packTwins = [], packTwinFor = null, now = Date.now} = {}) {
    this.registry = relationshipRegistry(ordinaryIds, multilingual, packTwins);
    this.packTwinFor = typeof packTwinFor === 'function' ? packTwinFor : null;   // profileKey => the provider key of the content pack twin to use now, or null (a map lookup)
    this.providerIds = this.registry.providerIds; this.providerFamilies = this.registry.providerFamilies;
    // Provider key -> the key in its ownership marker (only twins differ).
    this.markerKeys = this.registry.markerKeys;
    this.now = now; this.modes = relationshipModes(); this.snapshot = null; this.revision = 0;
    this.pending = null; this.changes = new Set(); this.fingerprints = new Map();
    // Every character whose provider can change: those with a twin. A style change (Auto/On/Off, a save fact) never changes
    // the provider, so it needs no connection retirement.
    this.routedProfiles = [...new Set([...Object.keys(this.registry.multilingual), ...Object.values(this.registry.packKeys)].map(providerKey => this.providerFamilies[providerKey]))];
  }
  update(settings, rawSnapshot, {boundary, busy = false} = {}) {
    const modes = settings === undefined ? this.pending?.modes ?? this.modes : relationshipModes(settings?.relationshipModes);
    if (!modes) return false;
    // An empty file is the shipped placeholder (nothing published yet): the same as a missing one.
    const snapshot = rawSnapshot === undefined || rawSnapshot === '' ? this.pending?.snapshot ?? this.snapshot : parseRelationshipState(rawSnapshot);
    this.pending = {modes, snapshot};
    if (busy) return false;
    this.modes = modes; this.snapshot = snapshot; this.pending = null;
    let changed = false;
    for (const profileKey of this.routedProfiles) {
      const selected = this.select(profileKey, boundary);
      const signature = JSON.stringify([selected.status, selected.providerProfileKey ?? null]);
      const previous = this.fingerprints.get(profileKey);
      this.fingerprints.set(profileKey, signature);
      if (previous !== undefined && previous !== signature) { this.changes.add(profileKey); changed = true; }
    }
    if (changed) this.revision++;
    return changed;
  }
  /** `multilingual`: this turn goes to the character's multilingual twin (when it has a usable one). It is decided per turn, from the message (bridge/multilingual.mjs wantsTwin), so no connection is retired when the language changes. */
  select(profileKey, boundary, {multilingual = false} = {}) {
    // Fresh heartbeats during a long voice/microphone/group turn keep its
    // already committed choice usable. New decisions/modes remain pending;
    // a different world can never extend the old evidence's lease.
    const retained = this.pending && sameWorld(this.snapshot, this.pending.snapshot)
      && fresh(this.pending.snapshot, boundary, this.now())
      ? {...this.snapshot, capturedAt: this.pending.snapshot.capturedAt} : this.snapshot;
    return selectRelationshipProfile({profileKey, mode: this.modes[profileKey] ?? 'auto', snapshot: retained,
      boundary, now: this.now(), registry: this.registry, multilingual: multilingual === true, packTwin: this.#packTwin(profileKey)});
  }
  #packTwin(profileKey) {
    try { return this.packTwinFor?.(profileKey) ?? null; } catch { return null; }
  }
  consumeRouteChanges() { const keys = [...this.changes]; this.changes.clear(); return keys; }
  /** What the next admitted turn of each supported character would use. Names
   * and reasons only: no provider IDs, dialogue or native values. */
  describe(boundary) {
    const rows = [];
    for (const profileKey of Object.keys(RELATIONSHIP_PROFILES)) {
      if (!Object.hasOwn(this.providerIds, profileKey)) continue;
      let selected;
      try { selected = this.select(profileKey, boundary); } catch { selected = {status: 'unavailable', reason: 'invalid-selection'}; }
      rows.push({profileKey, mode: this.modes[profileKey] ?? 'auto', status: selected.status,
        style: selected.style ?? null, multilingual: selected.multilingual === true, reason: selected.reason ?? null,
        confirmedInSave: selected.saveRelationship?.status === 'confirmed'});
    }
    return rows;
  }
  providerKeyForGuard(profileKey, guard) {
    if (!key(profileKey) || !id(guard?.characterId)) fail('INVALID_MEMORY_GUARD');
    const providerKey = Object.keys(this.providerIds).find(candidate => this.providerIds[candidate] === guard.characterId
      && this.providerFamilies[candidate] === profileKey);
    if (!providerKey) fail('CHARACTER_MISMATCH');
    return providerKey;
  }
  guardSelected(profileKey, guard, boundary) {
    try {
      const selected = this.select(profileKey, boundary);
      // A guard taken on the character's twin (a turn in another language) is as current as one taken on the original.
      const twin = this.registry.multilingual?.[profileKey];
      return selected.status === 'ready' && (selected.characterId === guard?.characterId
        || twin !== undefined && this.registry.providerIds[twin] === guard?.characterId);
    } catch { return false; }
  }
  /** Canonical invitation interface; all later preparation uses the captured
   * ID's key, never a setting that may have changed while awaiting the provider. */
  invitationMemory(memory, getBoundary, localOnly = () => false) {
    const captured = options => ({...options, profileKey: this.providerKeyForGuard(options.profileKey, options.guard)});
    return {
      route: (profileKey, options) => {
        const selected = this.select(profileKey, getBoundary());
        if (selected.status !== 'ready') fail('RELATIONSHIP_NOT_READY');
        return memory.route(selected.providerProfileKey, options);
      },
      // A non-Convai text provider (Local AI, Mistral, Custom) never touches Convai's REST API: Local never goes to the cloud.
      prepareCharacter: options => memory.prepareCharacter({...captured(options), localOnly: localOnly() === true}),
      connectionRefreshRequired: options => memory.connectionRefreshRequired(captured(options)),
      acknowledgeConnectionRefresh: options => memory.acknowledgeConnectionRefresh(captured(options)),
      isCurrent: guard => memory.isCurrent(guard),
    };
  }
}

/** True when `selection` belongs to the exact admitted group of two or three distinct speakers in the same world. */
export function groupAdmitted(selection, options) {
  const group = parseGroup(options?.group), audience = options?.audience;
  return !!group && Array.isArray(audience) && audience.length >= 2 && audience.length <= 3
    && audience.every(profile => key(profile)) && new Set(audience).size === audience.length
    && audience.includes(selection?.profileKey)
    && JSON.stringify([...group.audience].sort()) === JSON.stringify([...audience].sort())
    && sameWorld(selection, options);
}

/** Only call at an idle admission boundary. A completed request's exact config
 * is otherwise retained by PartyConnections and can keep warming the old ID
 * even after its visible character switched profiles. */
export async function retireRelationshipConnections(connections, profiles) {
  if (profiles.includes(connections.request?.profile)) await connections.setRequest(null);
  await connections.reconfigure(profiles);
}
