// Phone Chat first-message latency. The first message to a contact used to pay everything at once after V pressed
// Enter: the character's memory check (Convai /character/list + /character/get, about 3-5 s), a fresh browser page and
// its realtime connection (about 5-6 s), then the reply (about 1.2 s). The game publishes the contact whose Chat is
// open (`chatContact` in phone-chat-input.json), so the bridge does the first two while V is still typing.
//
// This module only decides WHEN to prepare. What preparing means (route, memory check, connection) is the injected
// `prepare`, which uses the same routes the real turn uses and never sends a message, so no dialogue, memory write or
// session is created by it. Every failure is swallowed: the first message then simply pays the old cost.
//
// Bounded: one contact at a time, a dwell before the first open (so paging through contacts opens nothing), at most
// MAX_STARTS opens per Chat visit, an idle cap, and unused warm pages are released when V moves to another contact.
// It is driven by the bridge's existing phone poll; there is no timer of its own and nothing in the game's frame.
import {transportKey} from './transport-pool.mjs';

export const PHONE_WARM_DWELL_MS = 600;
export const PHONE_WARM_KEEPALIVE_MS = 15000;
export const PHONE_WARM_IDLE_MS = 5 * 60 * 1000;
export const PHONE_WARM_MAX_STARTS = 4;
// A phone conversation page nobody used for this long is closed, with the phone host's browser when it was the last one (bridge/convai-bridge.mjs releaseUnused;
// RealtimeHost.releaseIdlePages). Longer than a message and its follow-up usually take; the next message opens a page again.
export const PHONE_HOST_IDLE_MS = 3 * 60 * 1000;
const CONTACT = /^[A-Za-z0-9_-]{1,120}$/;
const STALE_MS = 15000;

export class PhoneWarm {
  // enabled(): false while anything else owns the bridge (a talk turn, a microphone, a reset, a single-session plan).
  // profileFor(contact): the contact's profile key, or undefined for an unknown contact.
  // prepare(profile, {signal}): checks the memory and opens the connection; resolves {config, opened} (the transport
  //   config the real turn will use, or null when the turn must do it; opened is true only when this call opened the
  //   page) and may throw.
  // keepAlive(config): resolves {present, ready, busy} for the opened page and sends only the idle-timer reset.
  // release(config): closes an idle page that was opened ahead and never used.
  constructor({enabled = () => true, profileFor, prepare, keepAlive, release, now = Date.now,
    dwellMs = PHONE_WARM_DWELL_MS, keepAliveMs = PHONE_WARM_KEEPALIVE_MS, idleMs = PHONE_WARM_IDLE_MS,
    maxStarts = PHONE_WARM_MAX_STARTS, retryMs = 4000, onError = () => {}} = {}) {
    if (typeof profileFor !== 'function' || typeof prepare !== 'function') throw Error('Invalid phone warm-up');
    Object.assign(this, {enabled, profileFor, prepare, keepAlive, release, now, dwellMs, keepAliveMs, idleMs, maxStarts,
      retryMs, onError});
    this.target = null; this.warmed = new Map(); this.used = new Set(); this.closed = false;
  }
  // The latest published phone state (null when unreadable). Cheap and synchronous; work runs in the background.
  observe(state) {
    if (this.closed) return;
    const at = this.now();
    const contact = state?.active === true && typeof state.chatContact === 'string' && CONTACT.test(state.chatContact)
      && Number.isFinite(state.updated) && at - state.updated <= STALE_MS && state.updated <= at + 1000
      ? state.chatContact : null;
    if (!contact) { this.drop(); return; }
    const id = JSON.stringify([state.world, state.saveIdentity?.generation ?? null, contact]);
    if (this.target?.id !== id) {
      this.drop();
      const profile = this.profileFor(contact);
      if (!profile) return;
      this.target = {id, contact, profile, since: at, starts: 0, retryAt: 0, running: null, controller: null,
        config: null, nextCheck: 0, ready: false};
      return;
    }
    const target = this.target;
    // A message already sent (or sending) owns the connection; never race it.
    if (state.request || target.running || at - target.since < this.dwellMs) return;
    if (at - target.since > this.idleMs) return;
    let allowed = false;
    try { allowed = this.enabled() === true; } catch { allowed = false; }
    if (!allowed) return;
    if (!target.ready) {
      if (target.starts < this.maxStarts && at >= target.retryAt) this.start(target);
    } else if (target.config && this.keepAlive && at >= target.nextCheck) this.check(target);
  }
  start(target) {
    target.starts++;
    const controller = target.controller = new AbortController();
    const run = target.running = (async () => {
      try {
        const outcome = await this.prepare(target.profile, {signal: controller.signal});
        if (controller.signal.aborted || this.target !== target) return;
        target.ready = true; target.nextCheck = this.now() + this.keepAliveMs;
        if (outcome?.config) { target.config = outcome.config; if (outcome.opened === true) this.opened(outcome.config); }
      } catch (error) {
        if (controller.signal.aborted || this.target !== target) return;
        target.retryAt = this.now() + this.retryMs * target.starts;
        try { this.onError(error); } catch { /* an observer never affects a reply */ }
      } finally { if (target.running === run) target.running = null; }
    })();
  }
  check(target) {
    target.nextCheck = this.now() + this.keepAliveMs;
    const controller = target.controller = new AbortController();
    const run = target.running = (async () => {
      try {
        const status = await this.keepAlive(target.config);
        if (controller.signal.aborted || this.target !== target) return;
        // The page is gone (closed by a reset, evicted, or the connection dropped before any message): open it again.
        // A busy page is a message in flight; one that exists but is not ready is left to that message's own reconnect.
        if (status && !status.present && !status.busy) { target.ready = false; target.config = null; }
        else if (status?.present && status.ready === false) target.nextCheck = Number.MAX_SAFE_INTEGER;
      } catch { /* the next interval looks again */ }
      finally { if (target.running === run) target.running = null; }
    })();
  }
  opened(config) {
    const key = transportKey(config);
    // A page a message already used (or is using) is a conversation, never a speculative page.
    if (this.used.has(key)) return;
    // One speculative page at a time: release the earlier ones nobody spoke through.
    // `warmed` holds only pages opened ahead and not yet spoken through (claim() removes a page the moment a
    // message takes it).
    for (const [other, previous] of [...this.warmed]) {
      if (other === key) continue;
      this.warmed.delete(other);
      if (this.release) Promise.resolve().then(() => this.release(previous)).catch(() => {});
    }
    this.warmed.set(key, config);
  }
  // A real message is about to use this transport: its page is no longer speculative, and a warm-up for another
  // contact that is still opening gives way to it.
  // Returns the config unchanged so it can wrap the message's own transport config in place.
  claim(config, profile) {
    try {
      const key = transportKey(config);
      this.used.add(key); this.warmed.delete(key);
      while (this.used.size > 64) this.used.delete(this.used.values().next().value);
    } catch { /* a malformed config is not a warm page */ }
    this.interrupt(profile);
    return config;
  }
  // A message to `profile` is starting: a warm-up still opening another contact's conversation gives way to it.
  interrupt(profile) {
    const target = this.target;
    if (target?.running && profile !== undefined && target.profile !== profile) target.controller?.abort();
  }
  // The Chat closed, moved to another contact, or the phone state went stale: stop work; leave pages to the pool.
  drop() {
    const target = this.target; this.target = null;
    if (target?.running) target.controller?.abort();
  }
  close() {
    this.closed = true; this.drop(); this.warmed.clear();
  }
}
