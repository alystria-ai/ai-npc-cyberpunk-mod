// Phone messages have no world entity, audio, gaze or group-turn ownership.
// Resolve the contact on the server; never accept an arbitrary character ID.
import {parseJournal, journalContext} from './quest-context.mjs';

export function parsePhoneState(raw) {
  let state;
  try { state = JSON.parse(raw); } catch { return null; }
  if (state?.version !== 1 || typeof state.world !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(state.world)
      || !Number.isFinite(state.updated) || typeof state.active !== 'boolean') return null;
  if (!state.request) return {version: 1, world: state.world, updated: state.updated, active: state.active};
  const {id, contact, text} = state.request;
  if (typeof id !== 'string' || !id.startsWith(state.world + '-') || id.length > 140
      || typeof contact !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(contact)
      || typeof text !== 'string' || !text.trim() || [...text].length > 1200) return null;
  const journal = parseJournal(state.request.journal);
  return {...state, request: {id, contact, text: text.trim(), ...(journal ? {journal} : {})}};
}

export class PhoneChat {
  constructor({contacts, ids, reply, publish, now = Date.now, sessions = {}, saveSessions = async () => {}}) {
    this.contacts = new Map(contacts.filter(c => c.key && ids[c.key]).map(c => [c.contact, {profile: c.key, id: ids[c.key]}]));
    this.reply = reply; this.publish = publish; this.now = now;
    const known = new Set(Object.values(ids));
    this.sessions = new Map(Object.entries(sessions).filter(([id, session]) => known.has(id) && typeof session === 'string' && session.length < 300));
    this.saveSessions = saveSessions; this.seen = new Set(); this.world = null;
    this.writes = Promise.resolve();
  }
  emit(active, value) {
    this.writes = this.writes.catch(() => {}).then(() => {
      if (this.active === active && !active.controller.signal.aborted) return this.publish(value);
    });
    return this.writes;
  }
  async accept(state) {
    if (!state) {
      if (this.now() > this.expires) this.close();
      return;
    }
    this.expires = state.updated + 15000;
    if (state.world !== this.world || !state.active || !state.request || this.now() - state.updated > 15000) {
      this.active?.controller.abort(); this.active = null;
      if (state.world !== this.world) this.seen.clear();
      this.world = state.world;
    }
    if (!state.active || this.now() - state.updated > 15000 || !state.request || this.seen.has(state.request.id)) return;
    const input = state.request, identity = {world: state.world, id: input.id, contact: input.contact};
    this.seen.add(input.id);
    while (this.seen.size > 256) this.seen.delete(this.seen.values().next().value);
    // The adapter keeps one outgoing request until its acknowledgement. A newer
    // request supersedes an abandoned one without allowing late publication.
    this.active?.controller.abort();
    const active = {controller: new AbortController(), input}; this.active = active;
    const current = () => this.active === active && !active.controller.signal.aborted;
    const contact = this.contacts.get(input.contact);
    if (!contact) {
      await this.emit(active, {...identity, state: 'error', error: 'Conversation is unavailable for this contact.'});
      this.active = null; return;
    }
    await this.emit(active, {...identity, state: 'sending'});
    // Do not block the file poll while HTTP runs: unload/close must cancel it.
    active.work = (async () => {
      try {
        const context = journalContext(input.journal);
        const result = await this.reply({characterId: contact.id, sessionId: this.sessions.get(contact.id) || '-1',
          text: context ? context + '\n\nV messages: ' + input.text : input.text,
          voice: false, signal: active.controller.signal});
        if (!current()) return;
        this.sessions.set(contact.id, result.sessionID);
        await this.saveSessions(Object.fromEntries(this.sessions)).catch(() => {});
        await this.emit(active, {...identity, state: 'reply', text: result.text});
      } catch {
        if (current()) await this.emit(active, {...identity, state: 'error',
          error: 'Message could not be delivered. Please try again.'});
      } finally { if (this.active === active) this.active = null; }
    })().catch(() => {}); // file errors are recovered by the adapter's timeout
  }
  close() { this.active?.controller.abort(); this.active = null; }
}
