import {normalizeConvaiEmotion} from './companion-expressions.mjs';

// The SDK's emotionChange callback strips these fields. Only the original
// reliable data message from the pinned provider participant can enter here.
function owner(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  if (value.response_id !== undefined) {
    if (typeof value.response_id !== 'string' || !value.response_id || value.response_id.length > 512
        || /[\u0000-\u001f\u007f]/.test(value.response_id)) return null;
    out.response_id = value.response_id;
  }
  const turn = value.neurosync_turn_id ?? value.turn_id;
  if (turn !== undefined) {
    if (!Number.isSafeInteger(turn) || turn < 0
        || (value.neurosync_turn_id !== undefined && value.turn_id !== undefined && value.neurosync_turn_id !== value.turn_id)) return null;
    out.neurosync_turn_id = turn;
  }
  if (value.epoch !== undefined) {
    if (!Number.isSafeInteger(value.epoch) || value.epoch < 0) return null;
    out.epoch = value.epoch;
  }
  return out.response_id !== undefined || out.neurosync_turn_id !== undefined ? out : null;
}

function matches(left, right) {
  if (!left || !right) return false;
  let common = false;
  for (const field of ['response_id', 'neurosync_turn_id', 'epoch']) {
    if (left[field] !== undefined && right[field] !== undefined) {
      if (left[field] !== right[field]) return false;
      if (field !== 'epoch') common = true;
    }
  }
  return common;
}

export class ConvaiEmotion {
  constructor({retiredOwners = []} = {}) {
    this.retiredOwners = retiredOwners;
    this.sequence = -1; this.owner = null; this.signal = undefined; this.ambiguous = false;
    this.lastReason = null;
  }
  observeOwner(value) {
    const next = owner(value);
    if (!next || this.ambiguous || this.retiredOwners.some(old => matches(old, next))) return false;
    if (this.owner && !matches(this.owner, next)) {
      this.ambiguous = true; this.signal = undefined; return false;
    }
    this.owner = {...this.owner, ...next}; return true;
  }
  // Live October 5 probe: Convai sends exactly one bot-emotion per voiced
  // turn on the reliable, ordered data channel of the pinned provider, with
  // no response/turn id in either envelope (text-only turns send none). It
  // arrives after this turn's LLM text and before its first audio packet.
  // Such an id-less event belongs to this response only when the caller has
  // seen this response's own owner or its own reply text, and not yet its
  // terminal, on that same channel; a second one in a response is ambiguous.
  acceptOrdered(value, {terminal = false, textStarted = false} = {}) {
    if (owner(value) || value?.response_id !== undefined || value?.turn_id !== undefined
        || value?.neurosync_turn_id !== undefined) return this.accept(value);
    if (this.ambiguous) { this.lastReason = 'ambiguous-owner'; return false; }
    if (!this.owner && !textStarted) { this.lastReason = 'response-owner-not-established'; return false; }
    if (terminal) { this.lastReason = 'after-response-terminal'; return false; }
    if (this.orderedSeen) { this.ambiguous = true; this.signal = undefined; this.lastReason = 'repeated-ownerless'; return false; }
    this.orderedSeen = true;
    return this.admit(value, 'ordered');
  }
  accept(value) {
    const incoming = owner(value);
    if (this.ambiguous) { this.lastReason = 'ambiguous-owner'; return false; }
    if (!incoming) { this.lastReason = 'missing-or-invalid-event-owner'; return false; }
    if (!this.owner) { this.lastReason = 'response-owner-not-established'; return false; }
    if (!matches(this.owner, incoming)) { this.lastReason = 'different-response-owner'; return false; }
    return this.admit(value, 'response-id');
  }
  admit(value, basis) {
    // Copy the two public fields into this realm before strict normalization.
    const parsed = normalizeConvaiEmotion({emotion: value.emotion,
      ...(value.scale !== undefined ? {scale: value.scale} : {})});
    if (!parsed) { this.lastReason = 'invalid-emotion-body'; return false; }
    // Identical replays are harmless; never advance the game sequence for one.
    if (this.signal?.emotion === parsed.emotion && this.signal.scale === parsed.scale) {
      this.lastReason = 'duplicate'; return false;
    }
    this.signal = {version: 1, correlated: true, sequence: ++this.sequence,
      emotion: parsed.emotion, scale: parsed.scale, basis};
    this.lastReason = 'accepted'; return true;
  }
  snapshot() { return this.signal ? {...this.signal} : undefined; }
  clear() { this.signal = undefined; this.owner = null; this.ambiguous = true; }
}
