// Conversation profile selection only. This module reads reviewed native
// relationship receipts; it never changes quests, sends dialogue, provisions
// profiles, enables memory or copies one provider profile's memories to another.
import {parseGroup} from './group-context.mjs';

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
export const RELATIONSHIP_PROFILES = Object.freeze({
  'judy-alvarez': Object.freeze({kind: 'relationship', rule: 'core-arcs.judy.committed',
    all: Object.freeze(['sq030_11_romance', 'sq030_judy_lover', 'sq030_romance']), conflicts: Object.freeze(['sq030_friendship'])}),
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
  .flatMap(row => [...(row.all || [row.positive]), ...row.conflicts]))]);

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Preserve the existing ordinary mapping. Each additional ID has exactly one
 * internal provider key, while every visible/history/voice key stays canonical.
 * A missing variant file is a compatible ordinary-only installation. */
export function relationshipRegistry(ordinaryIds, variants = {}) {
  if (!plain(ordinaryIds) || Object.keys(ordinaryIds).length > 256
      || Object.entries(ordinaryIds).some(([profile, value]) => !key(profile) || !id(value))) fail('INVALID_ORDINARY_IDS');
  if (!plain(variants) || (Object.keys(variants).length && (variants.version !== 1 || !plain(variants.characters)))
      || Object.keys(variants).some(field => !['version', 'characters'].includes(field))) fail('INVALID_VARIANT_REGISTRY');
  const providerIds = {...ordinaryIds}, providerFamilies = Object.fromEntries(Object.keys(ordinaryIds).map(profile => [profile, profile]));
  const characters = {};
  for (const [profile, row] of Object.entries(variants.characters || {})) {
    if (!Object.hasOwn(RELATIONSHIP_PROFILES, profile) || !Object.hasOwn(ordinaryIds, profile) || !plain(row)
        || Object.keys(row).some(field => !['ordinaryCharacterId', 'romanticCharacterId'].includes(field))
        || (row.ordinaryCharacterId !== undefined && row.ordinaryCharacterId !== ordinaryIds[profile])
        || !id(row.romanticCharacterId)) fail('INVALID_VARIANT_PROFILE');
    const providerProfileKey = profile + '-romantic';
    if (Object.hasOwn(providerIds, providerProfileKey) || !key(providerProfileKey)) fail('VARIANT_KEY_COLLISION');
    providerIds[providerProfileKey] = row.romanticCharacterId;
    providerFamilies[providerProfileKey] = profile;
    characters[profile] = {ordinaryCharacterId: ordinaryIds[profile], romanticCharacterId: row.romanticCharacterId,
      romanticProviderKey: providerProfileKey};
  }
  if (new Set(Object.values(providerIds)).size !== Object.keys(providerIds).length) fail('DUPLICATE_PROVIDER_ID');
  return freeze({providerIds, providerFamilies, characters});
}

export function parseRelationshipState(raw) {
  let value;
  try {
    if (typeof raw === 'string') { if (Buffer.byteLength(raw, 'utf8') > 16384) return null; value = JSON.parse(raw); }
    else { if (!plain(raw) || Buffer.byteLength(JSON.stringify(raw), 'utf8') > 16384) return null; value = structuredClone(raw); }
  } catch { return null; }
  if (!plain(value) || value.version !== 1 || value.status !== 'ready' || value.gameVersion !== '2.31'
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

export function selectRelationshipProfile({profileKey, mode = 'auto', snapshot, boundary, now = Date.now(), registry} = {}) {
  if (!key(profileKey) || !MODES.has(mode) || !registry || !Object.hasOwn(registry.providerIds, profileKey)
      || !Number.isSafeInteger(now)) fail('INVALID_SELECTION');
  const rule = RELATIONSHIP_PROFILES[profileKey], configured = registry.characters[profileKey];
  const observed = snapshot == null ? null : parseRelationshipState(snapshot);
  // Ordinary-only installs continue operating while the optional profile bundle
  // is prepared. Explicit On still fails visibly instead of ignoring the choice.
  if (rule && mode === 'on' && !configured) return freeze({status: 'unavailable', profileKey, reason: 'romantic-profile-unavailable'});
  if (rule && configured && mode === 'auto' && !fresh(observed, boundary, now)) {
    return freeze({status: 'unavailable', profileKey, reason: 'relationship-state-unavailable'});
  }
  const romantic = !!rule && !!configured && (mode === 'on' || mode === 'auto' && confirmed(profileKey, observed));
  const providerProfileKey = romantic ? configured.romanticProviderKey : profileKey;
  // History and delivery are separate. On is never evidence, and Off does not
  // erase a real event. Capture only this speaker's current-save receipt with
  // the admitted selection; group prompts never receive other partners' facts.
  const saveRelationship = rule && fresh(observed, boundary, now) && confirmed(profileKey, observed)
    ? {status: 'confirmed', evidenceRule: rule.rule} : null;
  return freeze({status: 'ready', profileKey, providerProfileKey, characterId: registry.providerIds[providerProfileKey],
    variant: romantic ? 'romantic' : 'ordinary', kind: rule?.kind ?? 'ordinary', mode,
    reason: !rule ? 'unsupported' : mode === 'on' ? 'explicit-on' : mode === 'off' ? 'explicit-off'
      : !configured ? 'ordinary-only-install' : romantic ? 'verified-current-save' : 'auto-unconfirmed',
    ...(romantic && mode === 'auto' ? {evidenceRule: rule.rule} : {}),
    ...(saveRelationship ? {saveRelationship} : {}),
    ...(binding(boundary) ? {worldToken: boundary.worldToken, generation: boundary.generation} : {})});
}

/** Settings and native updates commit only at an idle turn boundary. A prepared
 * turn owns its frozen selection; a settings change never redirects its send. */
export class RelationshipRouting {
  constructor({ordinaryIds, variants, now = Date.now} = {}) {
    this.registry = relationshipRegistry(ordinaryIds, variants);
    this.providerIds = this.registry.providerIds; this.providerFamilies = this.registry.providerFamilies;
    this.now = now; this.modes = relationshipModes(); this.snapshot = null; this.revision = 0;
    this.pending = null; this.changes = new Set(); this.fingerprints = new Map();
  }
  update(settings, rawSnapshot, {boundary, busy = false} = {}) {
    const modes = settings === undefined ? this.pending?.modes ?? this.modes : relationshipModes(settings?.relationshipModes);
    if (!modes) return false;
    const snapshot = rawSnapshot === undefined ? this.pending?.snapshot ?? this.snapshot : parseRelationshipState(rawSnapshot);
    this.pending = {modes, snapshot};
    if (busy) return false;
    this.modes = modes; this.snapshot = snapshot; this.pending = null;
    let changed = false;
    for (const profileKey of Object.keys(RELATIONSHIP_PROFILES)) {
      if (!Object.hasOwn(this.providerIds, profileKey)) continue;
      const selected = this.select(profileKey, boundary);
      const signature = JSON.stringify([selected.status, selected.providerProfileKey ?? null]);
      const previous = this.fingerprints.get(profileKey);
      this.fingerprints.set(profileKey, signature);
      if (previous !== undefined && previous !== signature) { this.changes.add(profileKey); changed = true; }
    }
    if (changed) this.revision++;
    return changed;
  }
  select(profileKey, boundary) {
    // Fresh heartbeats during a long voice/microphone/group turn keep its
    // already committed choice usable. New decisions/modes remain pending;
    // a different world can never extend the old evidence's lease.
    const retained = this.pending && sameWorld(this.snapshot, this.pending.snapshot)
      && fresh(this.pending.snapshot, boundary, this.now())
      ? {...this.snapshot, capturedAt: this.pending.snapshot.capturedAt} : this.snapshot;
    return selectRelationshipProfile({profileKey, mode: this.modes[profileKey] ?? 'auto', snapshot: retained,
      boundary, now: this.now(), registry: this.registry});
  }
  consumeRouteChanges() { const keys = [...this.changes]; this.changes.clear(); return keys; }
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
      return selected.status === 'ready' && selected.characterId === guard?.characterId;
    } catch { return false; }
  }
  /** Canonical invitation interface; all later preparation uses the captured
   * ID's key, never a setting that may have changed while awaiting the provider. */
  invitationMemory(memory, getBoundary) {
    const captured = options => ({...options, profileKey: this.providerKeyForGuard(options.profileKey, options.guard)});
    return {
      route: (profileKey, options) => {
        const selected = this.select(profileKey, getBoundary());
        if (selected.status !== 'ready') fail('RELATIONSHIP_NOT_READY');
        return memory.route(selected.providerProfileKey, options);
      },
      prepareCharacter: options => memory.prepareCharacter(captured(options)),
      connectionRefreshRequired: options => memory.connectionRefreshRequired(captured(options)),
      acknowledgeConnectionRefresh: options => memory.acknowledgeConnectionRefresh(captured(options)),
      isCurrent: guard => memory.isCurrent(guard),
    };
  }
}

// Original portrayal guidance distilled from the reviewed roster and alternate
// profile styles. These are delivery cues, not canonical dialogue or memories.
const GROUP_DELIVERY = Object.freeze({
  'judy-alvarez': 'Keep Judy\'s affection understated: a dry little tease, a practical offer, or one honest admission. Preserve her independence and avoid a public confession in every reply.',
  'panam-palmer': 'Use Panam\'s direct, playful warmth and practical teamwork. Keep her agency and loyalties; a spirited tease need not become possessiveness or a competition.',
  'river-ward': 'Use River\'s plainspoken warmth, a small dry joke or an ordinary kindness. Remain grounded; concern does not give him authority over V or the other companions.',
  'kerry-eurodyne': 'Use Kerry\'s irreverent wit with a brief candid softening. Avoid a celebrity press statement, a generic romantic speech or turning the exchange into a rivalry.',
  'meredith-stout': 'Keep Meredith\'s manner controlled, terse and knowing. Her confirmed encounter permits casual familiarity, never a claim that she is V\'s committed partner.',
});

function groupRelationshipContext(selection, options) {
  const rule = RELATIONSHIP_PROFILES[selection.profileKey], group = parseGroup(options?.group);
  const audience = options?.audience;
  if (!group || !Array.isArray(audience) || audience.length < 2 || audience.length > 3
      || audience.some(profile => !key(profile)) || new Set(audience).size !== audience.length
      || !audience.includes(selection.profileKey)
      || JSON.stringify([...group.audience].sort()) !== JSON.stringify([...audience].sort())
      || !sameWorld(selection, options) || selection.saveRelationship?.status !== 'confirmed'
      || selection.saveRelationship.evidenceRule !== rule.rule) return '';
  const history = rule.kind === 'casual-intimacy'
    ? 'The current save confirms your own casual intimate encounter with V, without establishing a continuing romance. You may acknowledge casual familiarity when relevant.'
    : 'The current save confirms your own relationship with V. Treat this as the verified commitment history, not proof of later status or future promises. You may acknowledge that relationship naturally when relevant in this present group; no extra disclosure step is required for acknowledging your own commitment.';
  return 'Current group relationship guidance: ' + history + ' '
    + (selection.variant === 'ordinary'
      ? 'Keep the selected ordinary delivery; this receipt supplies factual acknowledgement, not a switch to the affectionate profile. '
      : GROUP_DELIVERY[selection.profileKey] + ' ')
    + 'Respond to another present speaker\'s actually heard words with a brief character-specific reaction or banter when it fits. '
    + 'This receipt belongs only to you. It does not tell you another companion\'s private relationship history, establish that they already know yours, or establish exclusivity, jealousy or consent. '
    + 'Keep intimate scene details and earlier private conversations out of the group. Do not invent a shared scene or assume a group invitation proves a relationship. '
    + 'Do not force a romantic topic into an unrelated reply. Preserve the current round\'s speaker order.';
}

export function relationshipContext(selection, channel = 'private', options) {
  if (selection?.status !== 'ready' || !Object.hasOwn(RELATIONSHIP_PROFILES, selection.profileKey)) return '';
  const ordinary = 'Use your ordinary conversation style. Do not assume a romance from friendliness, a party invitation, or earlier recalled reports; only the current save facts establish shared events.';
  const group = channel === 'group' ? groupRelationshipContext(selection, options) : '';
  if (selection.variant === 'ordinary') return [ordinary, group].filter(Boolean).join(' ');
  const why = selection.reason === 'explicit-on'
    ? 'The player explicitly selected your affectionate conversation profile. This conversation preference does not establish that any game quest, kiss or intimate scene occurred.'
    : 'The current save confirms your reviewed relationship or intimate-history receipt; discuss only the actually supplied details, without inventing further shared events.';
  const boundary = selection.kind === 'casual-intimacy'
    ? 'For Meredith this is casual familiarity: do not claim an ongoing romance, exclusivity, devotion or a promise of another encounter.'
    : 'Use character-specific affection naturally; do not make every reply romantic or treat affection as consent to a new intimate act.';
  const privacy = channel === 'group'
    ? group
      ? 'Keep private intimate details and private conversations out of group dialogue unless explicit current-audience disclosure is supplied.'
      : 'Keep private relationship history and private conversations out of group dialogue unless explicit current-audience disclosure is supplied.' : '';
  return [why, boundary, privacy, group].filter(Boolean).join(' ');
}

/** Only call at an idle admission boundary. A completed request's exact config
 * is otherwise retained by PartyConnections and can keep warming the old ID
 * even after its visible character switched profiles. */
export async function retireRelationshipConnections(connections, profiles) {
  if (profiles.includes(connections.request?.profile)) await connections.setRequest(null);
  await connections.reconfigure(profiles);
}
