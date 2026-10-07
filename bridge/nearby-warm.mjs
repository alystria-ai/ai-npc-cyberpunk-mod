import {NEARBY_LIMIT, PARTNER_LIMIT} from './party-connections.mjs';

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

export class NearbyWarm {
  // connections: PartyConnections. prepareVoice(profile, {signal}): prepares the
  // local voice. canPrepare(): false while a turn, the microphone or a voice
  // change owns the voice service. onError(error): diagnostics only.
  constructor({connections, prepareVoice, canPrepare = () => true, isKnown = () => true, now = Date.now,
      staleMs = 8000, retryMs = 30000, onError = () => {}}) {
    Object.assign(this, {connections, prepareVoice, canPrepare, isKnown, now, staleMs, retryMs, onError});
    this.profiles = []; this.partners = [];
    this.voices = new Map();   // profile -> {state: 'preparing' | 'ready' | 'failed', controller, retryAt}
  }
  // Apply the published document (its raw text, or '' when absent).
  async apply(raw) {
    let value;
    try { value = JSON.parse(raw); } catch {}
    const options = {isKnown: this.isKnown, now: this.now(), staleMs: this.staleMs};
    const partners = parsePartners(value, options);
    const profiles = parseNearby(value, options).filter(profile => !partners.includes(profile));
    this.profiles = profiles; this.partners = partners;
    for (const [profile, voice] of this.voices) if (!profiles.includes(profile) && !partners.includes(profile)) {
      voice.controller?.abort(); this.voices.delete(profile);
    }
    // Idempotent: PartyConnections ignores an unchanged list, and re-applies it
    // after the party connection state was cleared and became fresh again.
    try { await this.connections.setPartners?.(partners); } catch (error) { this.onError(error); }
    try { await this.connections.setNearby(profiles); } catch (error) { this.onError(error); }
    this.prepareVoices();
  }
  prepareVoices() {
    if ([...this.voices.values()].some(voice => voice.state === 'preparing')) return;
    // Partners first: V is with them now.
    for (const profile of [...this.partners, ...this.profiles]) {
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
    this.voices.clear(); this.profiles = []; this.partners = [];
    try { await this.connections.setPartners?.([]); } catch (error) { this.onError(error); }
    try { await this.connections.setNearby([]); } catch (error) { this.onError(error); }
  }
  diagnostic() {
    return {profiles: [...this.profiles], partners: [...this.partners], voices: Object.fromEntries([...this.voices].map(([profile, voice]) => [profile, voice.state]))};
  }
}
