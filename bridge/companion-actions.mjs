// One native offer authorizes one semantic proposal. Coordinates, actor IDs and
// vehicle IDs always come from the game snapshot, never from model arguments.
export const CHAUFFEUR_ACTION = 'Drive To Waypoint';
export const CHAUFFEUR_OFFER_TTL_MS = 90000;
export const CHAUFFEUR_DELIVERY_TTL_MS = 5000;
const LATE_ACTION_MS = 8000;
const entityId = value => typeof value === 'string' && value.length <= 32 && /^\d+ULL$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
  && !/[\u0000-\u001f\u007f]/.test(value);
const profile = value => string(value, 80) && /^[a-z0-9-]+$/.test(value);
const token = value => typeof value === 'string' && /^drive-[a-zA-Z0-9_-]{16,80}$/.test(value);
const seats = new Set(['seat_front_right', 'seat_back_left', 'seat_back_right']);
const keys = (value, expected) => Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));

export function parseChauffeurOffer(value) {
  if (!object(value) || value.available !== true || !object(value.actor) || !object(value.car)
      || !object(value.waypoint) || !object(value.waypoint.position)) return null;
  const {actor, car, waypoint, passengerSeat} = value;
  if (!keys(value, ['available', 'actor', 'car', 'waypoint', 'passengerSeat'])
      || !keys(actor, ['serial', 'id', 'key']) || !keys(car, ['id', 'record', 'name'])
      || !keys(waypoint, ['id', 'name', 'position']) || !keys(waypoint.position, ['x', 'y', 'z'])
      || !Number.isSafeInteger(actor.serial) || actor.serial < 1 || !entityId(actor.id) || !profile(actor.key)
      || !entityId(car.id) || !string(car.record, 256) || !string(car.name, 160)
      || !string(waypoint.id, 160) || !string(waypoint.name, 160) || !seats.has(passengerSeat)
      || ['x', 'y', 'z'].some(key => !Number.isFinite(waypoint.position[key]) || Math.abs(waypoint.position[key]) > 1e7)) return null;
  return {available: true, actor: {serial: actor.serial, id: actor.id, key: actor.key},
    car: {id: car.id, record: car.record, name: car.name}, waypoint: {id: waypoint.id,
      name: waypoint.name, position: {x: waypoint.position.x, y: waypoint.position.y, z: waypoint.position.z}}, passengerSeat};
}

// Host-side ownership survives completed text/audio for a bounded late event.
// A new input, cancellation, world/reset change or expired offer revokes it.
export class CompanionActions {
  constructor({publish, createToken, now = Date.now}) {
    Object.assign(this, {publish, createToken, now}); this.revision = 0; this.pending = null;
  }
  revoke() {
    const revision = ++this.revision; this.pending = null;
    // Invalidate an unconsumed file too. An already running native journey has
    // its own cancellation policy and is not undone by this empty mailbox.
    // admit() can establish its replacement while this clear is writing; that
    // pending owner fences the final rename even within this same revision.
    return Promise.resolve(this.publish({version: 1, action: 'none', updatedAt: this.now()},
      {isCurrentSync: () => this.revision === revision && this.pending === null})).catch(() => false);
  }
  admit(prepared, {source, isCurrent, isCurrentSync, signal} = {}) {
    void this.revoke();
    const input = prepared?.input, offer = parseChauffeurOffer(input?.chauffeurOffer);
    if (!offer || !['private-text', 'private-voice'].includes(source) || prepared?.route?.channel !== 'private'
        || !prepared.sendAllowed || !prepared.identified || !prepared.remoteConfig?.endUserId
        || input.group || input.reaction || input.channel !== 'private'
        || (source === 'private-voice') !== (prepared.route.transport === 'microphone')
        || offer.actor.id !== input.entity || offer.actor.key !== input.profileKey
        || !string(input.requestId, 100) || !/^\d+-\d+-\d+ULL$/.test(input.requestId)
        || !Number.isSafeInteger(input.generation) || input.generation < 0
        || !input.requestId.endsWith(`-${input.generation}-${input.entity}`)
        || !string(prepared.worldToken, 160) || !Number.isSafeInteger(prepared.generation) || prepared.generation < 1
        || typeof isCurrent !== 'function' || typeof isCurrentSync !== 'function'
        || signal?.aborted || isCurrentSync() !== true) return null;
    const actionId = this.createToken();
    if (!token(actionId)) throw Error('Invalid companion action token');
    const issuedAt = this.now();
    const packet = {version: 1, action: 'drive-to-waypoint', actionId, requestId: input.requestId,
      generation: input.generation, entity: input.entity, profileKey: input.profileKey,
      worldToken: prepared.worldToken, worldGeneration: prepared.generation, source,
      createdAt: issuedAt, expiresAt: issuedAt + CHAUFFEUR_OFFER_TTL_MS, offer};
    this.pending = {input, packet, isCurrent, isCurrentSync, signal, accepted: false};
    return this.configFor(input);
  }
  current(pending) {
    return this.pending === pending && !pending.signal?.aborted && this.now() < pending.packet.expiresAt
      && pending.isCurrentSync() === true;
  }
  configFor(input) {
    const pending = this.pending;
    if (!pending || pending.input !== input || !this.current(pending) || pending.accepted) return undefined;
    return {version: 1, token: pending.packet.actionId, source: pending.packet.source, expiresAt: pending.packet.expiresAt};
  }
  async deliver(message) {
    const pending = this.pending;
    if (!object(message) || Object.keys(message).length !== 2 || message.version !== 1 || !token(message.token)
        || !pending || pending.accepted || message.token !== pending.packet.actionId || !this.current(pending)) return false;
    // Reserve before awaiting file/world checks so duplicate callbacks cannot
    // race each other into two native publications.
    pending.accepted = true;
    const current = async () => this.current(pending) && await pending.isCurrent() && this.current(pending);
    if (!await current()) return false;
    const createdAt = this.now(), packet = {...pending.packet, createdAt,
      expiresAt: Math.min(pending.packet.expiresAt, createdAt + CHAUFFEUR_DELIVERY_TTL_MS)};
    return this.publish(packet, {signal: pending.signal, isCurrent: current,
      isCurrentSync: () => this.current(pending)});
  }
}

// Browser-side proposals retain their unique target after audio/text returns;
// they never borrow the next turn. The source participant is checked by the
// realtime client before this strictly bounded parser is called.
export class CompanionActionWindow {
  constructor({now = Date.now} = {}) { this.now = now; this.pending = null; }
  clear() { this.pending = null; }
  open(offer) {
    this.clear();
    if (!object(offer) || offer.version !== 1 || !token(offer.token)
        || !['private-text', 'private-voice'].includes(offer.source) || !Number.isSafeInteger(offer.expiresAt)
        || offer.expiresAt <= this.now() || offer.expiresAt - this.now() > CHAUFFEUR_OFFER_TTL_MS) return false;
    this.pending = {...offer}; return true;
  }
  current() {
    if (this.pending && this.now() >= this.pending.expiresAt) this.clear();
    return this.pending;
  }
  observeOwner(data) {
    const pending = this.current();
    if (!pending || pending.responseId || !string(data?.response_id, 256)) return;
    pending.responseId = data.response_id;
  }
  terminal(data) {
    const pending = this.current();
    if (pending?.responseId && data?.response_id === pending.responseId) this.clear();
  }
  finish() {
    const pending = this.current();
    if (pending) pending.expiresAt = Math.min(pending.expiresAt, this.now() + LATE_ACTION_MS);
  }
  accept(data) {
    const pending = this.current();
    if (!pending || !object(data) || !Array.isArray(data.actions) || data.actions.length !== 1) return null;
    const action = data.actions[0];
    if (!object(action) || Object.keys(action).length !== 2 || action.name !== CHAUFFEUR_ACTION
        || action.target !== pending.token) return null;
    this.clear();
    return {version: 1, token: pending.token};
  }
}

// Version-pinned @convai/web-sdk 1.7.0 adapter. Its updateContext helper drops
// action_config. Reproduce its publishMessage LiveKit envelope through the
// public room transport, preserving reliable ordering before user submission.
// Service contract: client-to-server-messages#context-update (semantic lists).
// This is one silent context update, never an extra utterance or reconnect.
export async function publishCompanionActionContext(client, context, offer) {
  const participant = client?.room?.localParticipant;
  if (!client?.isBotReady || typeof participant?.publishData !== 'function'
      || typeof participant.sid !== 'string' || !participant.sid) throw Error('Companion action transport unavailable');
  const action_config = {actions: offer ? [CHAUFFEUR_ACTION] : [], characters: [],
    objects: offer ? [{name: offer.token, description: "V's currently summoned owned car and selected map waypoint, bound to this request only."}] : [],
    current_attention_object: offer?.token ?? ''};
  const data = {...context, run_llm: 'false', action_config, current_attention_object: offer?.token ?? '',
    participant_sid: participant.sid};
  await participant.publishData(new TextEncoder().encode(JSON.stringify({type: 'context-update', data})), {reliable: true});
}
