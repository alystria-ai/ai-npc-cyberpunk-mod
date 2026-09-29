// Sessions belong to one user/campaign/branch and provider-memory generation.
// Unknown identities may use this loaded world only, never a legacy cloud ID.
import {createHash} from 'node:crypto';
import {parseJournal, conversationContext} from './quest-context.mjs';
import {parseBattle} from './battle-context.mjs';
import {parseWorldSnapshot} from './world-knowledge.mjs';
import {parseJournalHistory} from './journal-history.mjs';

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const token = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const nativeID = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const integer = (value, min = 0) => Number.isInteger(value) && value >= min && value <= 2147483647;
const clone = value => JSON.parse(JSON.stringify(value));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sessionID = value => typeof value === 'string' && value.length > 0 && value.length < 300 && value !== '-1';

export function parsePhoneBinding(value) {
  const unknown = {version: 1, status: 'unavailable', authoritative: false};
  if (integer(value?.generation, 1)) unknown.generation = value.generation;
  if (!plain(value) || value.version !== 1 || value.status !== 'available' || value.authoritative !== true
      || !['native-live', 'native-restored'].includes(value.confidence) || !token(value.localUserId)
      || !nativeID(value.campaignId) || !nativeID(value.branchId) || !nativeID(value.activationId)
      || !integer(value.branchEpoch, 1) || !integer(value.ledgerSequence) || !integer(value.generation, 1)) return unknown;
  return {version: 1, status: 'available', authoritative: true, confidence: value.confidence,
    localUserId: value.localUserId, campaignId: value.campaignId, branchId: value.branchId,
    branchEpoch: value.branchEpoch, ledgerSequence: value.ledgerSequence,
    generation: value.generation, activationId: value.activationId};
}
export function phoneScope(binding) {
  return binding.status === 'available'
    ? `phone-v1:${binding.localUserId}:${binding.campaignId}:${binding.branchId}` : null;
}
export function phoneBindingKey(value) {
  const binding = parsePhoneBinding(value), scope = phoneScope(binding);
  return scope ? `${scope}:${binding.branchEpoch}:${binding.generation}:${binding.activationId}`
    : `session:${binding.generation || 0}`;
}

export function parsePhoneState(raw) {
  let state;
  try { state = JSON.parse(raw); } catch { return null; }
  if (![1, 2].includes(state?.version) || typeof state.world !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(state.world)
      || !Number.isFinite(state.updated) || typeof state.active !== 'boolean') return null;
  const saveIdentity = parsePhoneBinding(state.version === 2 ? state.saveIdentity : undefined);
  const result = {version: state.version, world: state.world, updated: state.updated, active: state.active, saveIdentity};
  if (!state.request) return result;
  const {id, contact, text} = state.request;
  if (typeof id !== 'string' || !id.startsWith(state.world + '-') || id.length > 140
      || typeof contact !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(contact)
      || typeof text !== 'string' || !text.trim() || [...text].length > 1200) return null;
  const requestBinding = parsePhoneBinding(state.version === 2 ? state.request.saveIdentity : undefined);
  if (phoneBindingKey(requestBinding) !== phoneBindingKey(saveIdentity)) return null;
  const journal = parseJournal(state.request.journal), battle = parseBattle(state.request.battle);
  const worldKnowledge = state.request.worldKnowledge === undefined ? undefined : parseWorldSnapshot(state.request.worldKnowledge);
  const journalHistory = state.request.journalHistory === undefined ? undefined : parseJournalHistory(state.request.journalHistory);
  result.request = {id, contact, text: text.trim(), saveIdentity: requestBinding,
    ...(journal ? {journal} : {}), ...(battle ? {battle} : {}), ...(worldKnowledge ? {worldKnowledge} : {}),
    ...(journalHistory ? {journalHistory} : {})};
  return result;
}

function sessionStore(value) {
  if (plain(value) && value.version === 2 && plain(value.scoped)) return clone(value);
  // No player or branch can be reconstructed from a legacy character ID.
  return {version: 2, scoped: {}, legacy: plain(value) && Object.keys(value).length ? clone(value) : null};
}

export class PhoneChat {
  constructor({contacts, ids, reply, publish, now = Date.now, sessions = {}, saveSessions = async () => {}, contextFor}) {
    this.contacts = new Map(contacts.filter(c => c.key && ids[c.key]).map(c => [c.contact, {profile: c.key, id: ids[c.key]}]));
    Object.assign(this, {reply, publish, now, saveSessions, contextFor});
    this.store = sessionStore(sessions); this.transientSessions = new Map(); this.seen = new Set();
    this.world = null; this.binding = null; this.writes = Promise.resolve(); this.sessionWrites = Promise.resolve();
  }
  emit(active, value) {
    this.writes = this.writes.catch(() => {}).then(() => {
      if (this.active === active && !active.controller.signal.aborted) return this.publish(value);
    });
    return this.writes;
  }
  async accept(value) {
    const state = value && parsePhoneState(JSON.stringify(value));
    if (!state) {
      if (this.now() > this.expires) this.close();
      return;
    }
    const binding = phoneBindingKey(state.saveIdentity), changed = state.world !== this.world || binding !== this.binding;
    this.expires = state.updated + 15000;
    if (changed || !state.active || !state.request || this.now() - state.updated > 15000 || state.updated > this.now() + 1000) {
      this.close();
      if (changed) { this.seen.clear(); this.transientSessions.clear(); }
      this.world = state.world; this.binding = binding;
    }
    if (!state.active || this.now() - state.updated > 15000 || state.updated > this.now() + 1000
        || !state.request || this.seen.has(state.request.id)) return;
    const input = state.request, identity = {world: state.world, binding, id: input.id, contact: input.contact};
    this.seen.add(input.id);
    while (this.seen.size > 256) this.seen.delete(this.seen.values().next().value);
    // The adapter keeps one outgoing request until its acknowledgement. A newer
    // request supersedes an abandoned one without allowing late publication.
    this.close();
    const active = {controller: new AbortController(), input}; this.active = active;
    const current = () => this.active === active && !active.controller.signal.aborted
      && this.world === state.world && this.binding === binding;
    const contact = this.contacts.get(input.contact);
    if (!contact) {
      await this.emit(active, {...identity, state: 'error', error: 'Conversation is unavailable for this contact.'});
      if (this.active === active) this.active = null;
      return;
    }
    await this.emit(active, {...identity, state: 'sending'});
    if (!current()) return;
    // Do not block the file poll while HTTP runs: unload/close must cancel it.
    active.work = (async () => {
      try {
        const scope = phoneScope(input.saveIdentity);
        const requestInput = {...input, profileKey: contact.profile, channel: 'phone'};
        if (requestInput.worldKnowledge?.status === 'ready') {
          const snapshot = requestInput.worldKnowledge, owner = snapshot.identity;
          if (snapshot.generation !== input.saveIdentity.generation || snapshot.audience.channel !== 'phone'
              || snapshot.audience.profileKeys.length !== 1 || snapshot.audience.profileKeys[0] !== contact.profile
              || (owner.status === 'verified' && (!scope || owner.userId !== input.saveIdentity.localUserId
                || owner.playthroughId !== input.saveIdentity.campaignId || owner.branchId !== input.saveIdentity.branchId))) {
            requestInput.worldKnowledge = {version: 1, status: 'unavailable', reason: 'phone-binding-mismatch'};
          }
        }
        const capture = this.contextFor ? await this.contextFor({characterKey: contact.profile, profileKey: contact.profile,
          channel: 'phone', input: clone(requestInput), saveIdentity: clone(input.saveIdentity), signal: active.controller.signal}) : null;
        if (!current()) return;
        let endUserId, remoteGeneration = 'anonymous';
        if (capture?.status === 'available') {
          const owner = capture.identity;
          if (!scope || !owner || (owner.userId ?? owner.localUserId) !== input.saveIdentity.localUserId
              || (owner.campaignId ?? owner.playthroughId) !== input.saveIdentity.campaignId
              || owner.branchId !== input.saveIdentity.branchId || !token(owner.remoteGeneration)
              || !token(capture.endUserId)) throw Error('Stale memory binding');
          endUserId = capture.endUserId; remoteGeneration = owner.remoteGeneration;
        }
        const sessionKey = digest([scope || state.world, contact.profile, contact.id, 'phone', remoteGeneration, endUserId || null]);
        const saved = scope ? this.store.scoped[sessionKey] : this.transientSessions.get(sessionKey);
        const sessionId = saved?.scope === scope && saved?.profileKey === contact.profile && saved?.characterId === contact.id
          && saved?.remoteGeneration === remoteGeneration && saved?.endUserId === endUserId && sessionID(saved?.sessionId)
          ? saved.sessionId : '-1';
        const context = conversationContext(requestInput);
        const result = await this.reply({characterId: contact.id, profileKey: contact.profile, sessionId,
          input: requestInput, saveIdentity: clone(input.saveIdentity), context, ...(endUserId ? {endUserId} : {}),
          text: context ? context + '\n\nV messages: ' + input.text : input.text,
          voice: false, signal: active.controller.signal});
        if (!current()) return;
        if (typeof result?.text !== 'string' || !result.text.trim() || result.text.length > 6000 || !sessionID(result.sessionID)) {
          throw Error('Invalid reply');
        }
        const record = {scope, profileKey: contact.profile, characterId: contact.id, channel: 'phone', remoteGeneration,
          ...(endUserId ? {endUserId} : {}), sessionId: result.sessionID};
        if (scope) {
          this.store.scoped[sessionKey] = record;
          const snapshot = clone(this.store);
          this.sessionWrites = this.sessionWrites.catch(() => {}).then(() => current() ? this.saveSessions(snapshot) : undefined);
          await this.sessionWrites.catch(() => {});
        } else this.transientSessions.set(sessionKey, record);
        if (current()) await this.emit(active, {...identity, state: 'reply', text: result.text});
      } catch {
        if (current()) await this.emit(active, {...identity, state: 'error',
          error: 'Message could not be delivered. Please try again.'});
      } finally { if (this.active === active) this.active = null; }
    })().catch(() => {}); // file errors are recovered by the adapter's timeout
  }
  close() { this.active?.controller.abort(); this.active = null; }
}
