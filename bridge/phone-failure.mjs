// Why a Phone Chat message failed, in one short code for the bridge log and the support report.
//
// The player's phone only ever says "Message could not be delivered. Please try again." (bridge/phone-chat.mjs). That line is the
// catch-all of the whole send, so on its own it cannot tell a refused key from a world change. `describePhoneFailure` turns the
// error and the step of the send it happened in into `{stage, reason, detail}`:
//   stage   which step of the send failed (PHONE_STAGES)
//   reason  a stable code (PHONE_REASONS), never text from the player or the character
//   detail  the error's own first line, clipped, for the log line only (it is not copied into the support report)
// Pure functions: nothing here reads a file, a setting or the network.
import {classifyFailure} from './convai-quota.mjs';
import {failureKind} from './mistral-client.mjs';

// The Convai notice codes the phone shows its own short status for (mod/phone-chat.lua, STATUS_BY_CODE; the same sentences as the game's notices).
// Every other failure keeps "Message could not be delivered. Please try again."; the mistral-, local- and custom- codes are passed by their prefix.
export const PHONE_CODES = Object.freeze(new Set(['daily-limit', 'quota-shared', 'quota-own', 'key-rejected', 'key-memory-needed']));

export const PHONE_STAGES =Object.freeze(['route', 'binding', 'provider', 'reply', 'publish']);

const CONTROLS = /[\u0000-\u001f\u007f]/g;
const clip = (value, size) => typeof value === 'string' ? value.replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim().slice(0, size) : '';

// The messages the send itself raises (bridge/phone-chat.mjs, the bridge's phone reply hook, admitPlayerConversation).
const OWN_MESSAGES = [
  [/^Phone contact is not supported\b/, 'contact-unsupported'],
  [/^Invalid reply\b/, 'invalid-reply'],
  [/^Phone world changed\b|^Conversation world changed\b|^Conversation memory changed\b/, 'world-changed'],
  [/^Phone memory binding changed\b|^Stale memory binding\b|^Invalid player memory route\b|^Phone history audience changed\b/, 'memory-route-changed'],
  [/still releasing/i, 'connection-busy'],
];

export function describePhoneFailure(error, stage = 'provider') {
  const text = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : '';
  const detail = clip(text, 160);
  const known = PHONE_STAGES.includes(stage) ? stage : 'provider';
  return {stage: known, reason: reasonFor(error, text), detail};
}

function reasonFor(error, text) {
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return 'cancelled';
  // PhoneKnowledge / PlayerPhoneKnowledge: "Phone knowledge: CODE" with the code on the error.
  if (typeof error?.code === 'string' && /^[A-Z][A-Z_]{2,40}$/.test(error.code) && /phone knowledge/i.test(text)) return `route-${error.code.toLowerCase().replaceAll('_', '-')}`;
  for (const [pattern, reason] of OWN_MESSAGES) if (pattern.test(text)) return reason;
  // The shared key's own guard, then Convai's answers (convai-quota.mjs reads only the message text).
  const quota = classifyFailure(error);
  if (quota === 'daily') return 'daily-limit';
  if (quota === 'signin') return 'convai-signin';
  if (quota === 'rate') return 'rate-limit';
  if (quota === 'busy') return 'convai-busy';
  if (quota === 'quota') return 'convai-quota';
  if (quota === 'speaker') return 'convai-speaker-limit';
  if (quota === 'memory') return 'convai-memory-needed';
  if (quota === 'rejected') return 'convai-key-rejected';
  // The text providers: "[mistral:limit]", "[local:network]", "[custom:key]", and the local server that could not start.
  const marker = /\[(mistral|local|custom):(\w+)\]/.exec(text);
  if (/\[local:unavailable\]/.test(text)) return 'local-unavailable';
  if (marker) return `${marker[1]}-${failureKind(error) ?? marker[2]}`;
  if (/\bsession\b.{0,40}\b(?:not found|expired|invalid|belongs)\b|\bbelongs to another\b/i.test(text)) return 'session-rejected';
  if (/timed? ?out|timeout|ETIMEDOUT/i.test(text) || error?.name === 'TimeoutError') return 'timeout';
  if (/chromium|executable|playwright|browser (?:has been )?closed|target (?:page|closed)|page (?:crashed|closed)/i.test(text)) return 'browser';
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket|websocket/i.test(text)) return 'network';
  return 'unknown';
}

/** The one log line for a failed message. Never the message or the reply: the contact, the provider, the step and the reason. */
export function phoneFailureLine({contact, provider, stage, reason, detail, event}) {
  return `Phone chat ${event ? `${clip(event, 20)} event` : 'message'} failed: reason=${reason} stage=${stage} contact=${clip(contact, 60) || '?'} provider=${clip(provider, 20) || '?'}`
    + (detail ? ` detail="${detail}"` : '');
}

/** The record the support report carries (runtime/phone-failure-state.json): when, the code, the step and the provider, a count; no detail text. */
export function phoneFailureRecord({previous, failure, provider, now = Date.now()}) {
  const count = Number.isSafeInteger(previous?.count) && previous.count >= 0 ? previous.count : 0;
  const reasons = previous?.reasons && typeof previous.reasons === 'object' && !Array.isArray(previous.reasons) ? {...previous.reasons} : {};
  const reason = clip(failure.reason, 40);
  reasons[reason] = (Number.isSafeInteger(reasons[reason]) ? reasons[reason] : 0) + 1;
  // Bounded: at most twelve different reasons are counted.
  const kept = Object.fromEntries(Object.entries(reasons).slice(-12));
  return {version: 1, updated: now, last: {at: now, reason, stage: clip(failure.stage, 20), provider: clip(provider, 20) || null},
    count: count + 1, reasons: kept};
}

// A load, a close or a newer message ending a send in progress is the game moving on, not a fault to report automatically.
export const PHONE_NOT_A_FAULT = Object.freeze(new Set(['cancelled', 'world-changed', 'route-world-changed', 'route-request-expired']));

/**
 * What the bridge does with each failed message: one log line, the small state file the support report reads, and (for a fault, not
 * the game moving on) the automatic error report. Nothing here is awaited by a send; every step is best effort.
 *   log(line)              the bridge log
 *   read() / write(record) the state file (runtime/phone-failure-state.json); read once, to carry the count across a restart
 *   report(info)           the automatic error report hook
 *   provider()             which provider answers right now ('convai', 'mistral', 'local', 'custom')
 */
export class PhoneFailureLog {
  constructor({log = () => {}, read = async () => null, write = async () => {}, report = () => {}, provider = () => undefined, now = Date.now} = {}) {
    Object.assign(this, {log, read, write, report, provider, now});
    this.chain = Promise.resolve(); this.previous = undefined;
  }
  note(info) {
    let provider; try { provider = this.provider(); } catch { provider = undefined; }
    try { this.log(phoneFailureLine({contact: info.contact, provider, stage: info.stage, reason: info.reason, detail: info.detail, event: info.event})); } catch { /* a log line never fails a send */ }
    // An appointment event the character started (bridge/appointment-events.mjs) is not a message V sent and the game has a template for it: the log line
    // above is all it leaves, no automatic report and no count in the failure record.
    if (info.event) return Promise.resolve();
    try { if (!PHONE_NOT_A_FAULT.has(info.reason)) this.report({...info, provider}); } catch { /* a report never fails a send */ }
    this.chain = this.chain.catch(() => {}).then(async () => {
      if (this.previous === undefined) this.previous = await Promise.resolve().then(() => this.read()).catch(() => null);
      const record = phoneFailureRecord({previous: this.previous, failure: info, provider, now: this.now()});
      this.previous = record;
      await this.write(record);
    }).catch(() => {});
    return this.chain;
  }
}
