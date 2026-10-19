import {NEARBY_LIMIT, PARTNER_LIMIT, SPAWNED_LIMIT} from './party-connections.mjs';

// "Auto-connect nearby characters": the game publishes up to two characters (a
// profile key each) that the player is looking at or standing near, in
// runtime/nearby-connections.json. This opens their private conversation
// connection (PartyConnections.setNearby) and prepares their local voice, so
// the first reply does not wait for either. It never sends a message, never
// records a contact and never touches memory: it is a warm-up, exactly like the
// composer hint. The list is the game's decision; a list that stops being
// refreshed (a paused or closed game) counts as empty and releases everything.
// The same document lists the conversation partners (`partners`, up to two): world characters V just talked to,
// kept warm outside the two slots (PartyConnections.setPartners). Their private connection is the one the
// conversation opened (same profile and scope), so keeping a partner never opens a second one.

export function parseNearby(value, {isKnown = () => true, now = Date.now(), staleMs = 8000} = {}) {
  if (!value || !Number.isSafeInteger(value.updated) || value.updated < 0 || value.updated > now + 5000
      || now - value.updated > staleMs || !Array.isArray(value.profiles) || value.profiles.length > NEARBY_LIMIT
      || value.profiles.some(profile => typeof profile !== 'string' || !/^[a-z0-9-]{1,80}$/.test(profile))) return [];
  return [...new Set(value.profiles)].filter(isKnown);
}

// The partners of a fresh document ([] for an older document without the field, or an invalid one).
export function parsePartners(value, {isKnown = () => true, now = Date.now(), staleMs = 8000} = {}) {
  if (!value || !Number.isSafeInteger(value.updated) || value.updated < 0 || value.updated > now + 5000
      || now - value.updated > staleMs || !Array.isArray(value.partners) || value.partners.length > PARTNER_LIMIT
      || value.partners.some(profile => typeof profile !== 'string' || !/^[a-z0-9-]{1,80}$/.test(profile))) return [];
  return [...new Set(value.partners)].filter(isKnown);
}

// The spawned roster characters of a fresh document (`spawned`, up to SPAWNED_LIMIT: characters another mod or a spawner created,
// with a named profile, mod/auto-connect.lua). [] for an older document without the field, or an invalid one.
export function parseSpawned(value, {isKnown = () => true, now = Date.now(), staleMs = 8000} = {}) {
  if (!value || !Number.isSafeInteger(value.updated) || value.updated < 0 || value.updated > now + 5000
      || now - value.updated > staleMs || !Array.isArray(value.spawned) || value.spawned.length > SPAWNED_LIMIT
      || value.spawned.some(profile => typeof profile !== 'string' || !/^[a-z0-9-]{1,80}$/.test(profile))) return [];
  return [...new Set(value.spawned)].filter(isKnown);
}

// The physical entity of each listed ambient character (`entities`: {profile: "<hash>ULL"}). A generic resident or
// archetype has no route without it; a named character never needs one. {} for an older document or a stale one.
export function parseEntities(value, {now = Date.now(), staleMs = 8000} = {}) {
  if (!value || !Number.isSafeInteger(value.updated) || value.updated < 0 || value.updated > now + 5000
      || now - value.updated > staleMs || !value.entities || typeof value.entities !== 'object' || Array.isArray(value.entities)) return {};
  return Object.fromEntries(Object.entries(value.entities).filter(([profile, entity]) => /^[a-z0-9-]{1,80}$/.test(profile)
    && typeof entity === 'string' && /^\d{1,24}ULL$/.test(entity)).slice(0, 8));
}

export class NearbyWarm {
  // connections: PartyConnections. prepareVoice(profile, {signal}): prepares the
  // local voice. canPrepare(): false while a turn, the microphone or a voice
  // change owns the voice service. onError(error): diagnostics only.
  // routeFor(profile, entity): the exact route of an ambient character's entity, or null (a named profile, no world).
  // gpuVoice(): true while preparing a voice costs GPU time (OmniVoice). A character that is only near or looked at is then NOT
  // prepared: V walks past many of them and each preparation is 1 to 3 s of the card with nobody speaking. Their voice is prepared
  // the moment V starts to talk to one (the bridge's composer, talk key and turn start), which overlaps typing or speaking. Partners
  // and spawned characters (V is with them) keep their ahead-of-time preparation.
  constructor({connections, prepareVoice, canPrepare = () => true, isKnown = () => true, routeFor = () => null, now = Date.now,
      staleMs = 8000, retryMs = 30000, gpuVoice = () => false, onError = () => {}}) {
    Object.assign(this, {connections, prepareVoice, canPrepare, isKnown, routeFor, now, staleMs, retryMs, gpuVoice, onError});
    this.profiles = []; this.partners = []; this.spawned = [];
    this.last = null;          // the last document that parsed
    this.voices = new Map();   // profile -> {state: 'preparing' | 'ready' | 'failed', controller, retryAt}
  }
  // Apply the published document (its raw text, or '' when absent).
  async apply(raw) {
    let value;
    try { value = JSON.parse(raw); } catch {}
    // The game writes the file in place (mod/auto-connect.lua): a read that lands between the open and the write sees '' or a cut-off
    // document. That is no change, not "nobody is near" (which would close every connection and abort every voice preparation for one
    // poll). The last document stands, and its own `updated` still ages it out after staleMs, so a game that really stops publishing
    // (closed, paused, file gone) releases everything.
    if (value && typeof value === 'object') this.last = value;
    else value = this.last;
    const options = {isKnown: this.isKnown, now: this.now(), staleMs: this.staleMs};
    const partners = parsePartners(value, options);
    const profiles = parseNearby(value, options).filter(profile => !partners.includes(profile));
    // A talked-to character is a partner, not also a spawned one; a profile in both lists is one connection anyway.
    const spawned = parseSpawned(value, options).filter(profile => !partners.includes(profile));
    this.profiles = profiles; this.partners = partners; this.spawned = spawned;
    for (const [profile, voice] of this.voices) if (!profiles.includes(profile) && !partners.includes(profile) && !spawned.includes(profile)) {
      voice.controller?.abort(); this.voices.delete(profile);
    }
    // Idempotent: PartyConnections ignores an unchanged list, and re-applies it
    // after the party connection state was cleared and became fresh again.
    const entities = parseEntities(value, options), routes = {};
    for (const profile of [...partners, ...profiles]) if (entities[profile]) {
      try { const route = this.routeFor(profile, entities[profile]); if (route) routes[profile] = route; }
      catch (error) { this.onError(error); }
    }
    if (typeof this.connections.setAmbient === 'function') {
      // One plan change for the three lists: a profile that moves between roles (a spawned character V talked to is a partner,
      // a released partner is spawned again) keeps its open connection instead of being closed and opened again.
      try { await this.connections.setAmbient({partners, spawned, nearby: profiles, routes}); } catch (error) { this.onError(error); }
    } else {
      try { await this.connections.setPartners?.(partners, routes); } catch (error) { this.onError(error); }
      try { await this.connections.setSpawned?.(spawned); } catch (error) { this.onError(error); }
      try { await this.connections.setNearby(profiles, routes); } catch (error) { this.onError(error); }
    }
    this.prepareVoices();
  }
  prepareVoices() {
    if ([...this.voices.values()].some(voice => voice.state === 'preparing')) return;
    // Partners first: V is with them now. Characters merely near are left out while a voice costs GPU time (see the constructor).
    let gpu = false;
    try { gpu = this.gpuVoice() === true; } catch { gpu = false; }
    for (const profile of [...this.partners, ...this.spawned, ...(gpu ? [] : this.profiles)]) {
      const voice = this.voices.get(profile);
      if (voice && (voice.state !== 'failed' || this.now() < voice.retryAt)) continue;
      if (!this.canPrepare()) return;
      const controller = new AbortController(), entry = {state: 'preparing', controller};
      this.voices.set(profile, entry);
      let preparing;
      try { preparing = Promise.resolve(this.prepareVoice(profile, {signal: controller.signal})); }
      catch (error) { preparing = Promise.reject(error); }
      preparing.then(() => { if (this.voices.get(profile) === entry) entry.state = 'ready'; })
        .catch(error => {
          if (this.voices.get(profile) !== entry || controller.signal.aborted) return;
          entry.state = 'failed'; entry.retryAt = this.now() + this.retryMs; this.onError(error);
        });
      return;   // one voice at a time
    }
  }
  // Release everything now (bridge shutdown or a lost game).
  async release() {
    for (const voice of this.voices.values()) voice.controller?.abort();
    this.voices.clear(); this.profiles = []; this.partners = []; this.spawned = []; this.last = null;
    if (typeof this.connections.setAmbient === 'function') {
      try { await this.connections.setAmbient({}); } catch (error) { this.onError(error); }
      return;
    }
    try { await this.connections.setPartners?.([]); } catch (error) { this.onError(error); }
    try { await this.connections.setSpawned?.([]); } catch (error) { this.onError(error); }
    try { await this.connections.setNearby([]); } catch (error) { this.onError(error); }
  }
  diagnostic() {
    return {profiles: [...this.profiles], partners: [...this.partners], spawned: [...this.spawned], voices: Object.fromEntries([...this.voices].map(([profile, voice]) => [profile, voice.state]))};
  }
}
