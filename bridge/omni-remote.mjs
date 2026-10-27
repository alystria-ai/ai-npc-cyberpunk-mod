// Remote OmniVoice (docs/REMOTE_OMNIVOICE.md): what the mod's client (bridge/remote-voice.mjs) and the standalone server (bridge/omni-server.mjs)
// agree on. One small HTTP protocol over the player's own network, no key, no account; the server runs the same resident worker the local route
// uses (bridge/resident-voice.mjs, bridge/resident-voice-worker.py) and only moves its requests and answers across the wire.
//
//   GET  /v1/health               -> JSON: who is there, whether the voice is loaded, the card, the voices it holds
//   POST /v1/voices               -> JSON {voices, reload?}: the voice table the game wants (the same descriptors the local worker is sent);
//                                    answers the voices it holds and the clips it still needs ({missing: [{key, sha256}]})
//   PUT  /v1/clips/<key>?sha256=  -> raw WAV: a reference clip the server does not have (a player's own clip, V's voice); stored under its
//                                    own player-voices folder as <key>.wav, checked against the hash
//   POST /v1/prepare              -> JSON {profile, steps?, languageReference?}: the hidden warm-up render
//   POST /v1/synthesize           -> JSON {profile, text, steps?, language?, languageReference?}: answers the phrase as a raw WAV, its timing in
//                                    the X-Omni-Timing header. Closing the connection cancels a job that has not started (like the local route).
//
// Everything a request names is a logical name the server validates with the same registry the local worker uses (voice keys, `runtime/...wav`
// descriptors with a hash): the client never sends a file path the server would open, and a clip is only ever stored under a key it passed.
export const OMNI_PROTOCOL = 1;
export const OMNI_SERVICE = 'ai-npc-omnivoice-server';
export const DEFAULT_PORT = 8765;
export const DEFAULT_LISTEN = '127.0.0.1';
// Request size limits (the server answers 413 above them): a voice table of 1024 voices with their transcripts stays well under 8 MB, a phrase is at
// most 12,000 characters, a reference clip at most the worker's own 32 MB.
export const LIMITS = Object.freeze({jsonBytes: 256 * 1024, voicesBytes: 8 * 1024 * 1024, clipBytes: 32 * 1024 * 1024, textChars: 12_000,
  waiting: 16, clipFiles: 2048});
export const TIMING_HEADER = 'x-omni-timing';
export const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const SHA_PATTERN = /^[a-f0-9]{64}$/;

const DNS_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/**
 * The address a player typed or pasted ("192.168.1.20", "192.168.1.20:8765", "gaming-server.local:9000", "http://host:8765/", "[::1]:8765"):
 * {host, port, origin} (origin http://host:port, an IPv6 host bracketed) or {reason} (the codes the settings page words):
 * 'empty', 'scheme' (https:// and anything but http://), 'extras' (a user, password, path other than "/", query or #), 'host', 'port', 'long'.
 * The default port is 8765. Pure.
 */
export function parseServerAddress(text) {
  const raw = String(text ?? '').replace(/^﻿/, '').trim();
  if (!raw) return {reason: 'empty'};
  if (raw.length > 255 || /[\x00-\x1f\x7f\s]/.test(raw)) return {reason: raw.length > 255 ? 'long' : 'host'};
  let rest = raw;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(rest);
  if (scheme) {
    if (scheme[1].toLowerCase() !== 'http') return {reason: 'scheme'};
    rest = rest.slice(scheme[0].length);
  }
  const slash = rest.indexOf('/');
  if (slash >= 0) {
    if (rest.slice(slash) !== '/') return {reason: 'extras'};
    rest = rest.slice(0, slash);
  }
  if (/[@?#\\]/.test(rest)) return {reason: 'extras'};
  let host = rest, port = DEFAULT_PORT;
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    if (close < 0) return {reason: 'host'};
    host = rest.slice(0, close + 1);
    const tail = rest.slice(close + 1);
    if (tail) {
      if (!tail.startsWith(':')) return {reason: 'host'};
      port = tail.slice(1);
    }
    if (!/^\[[0-9A-Fa-f:.]+\]$/.test(host) || !host.includes(':')) return {reason: 'host'};
  } else {
    const colon = rest.lastIndexOf(':');
    if (colon >= 0) {
      host = rest.slice(0, colon);
      port = rest.slice(colon + 1);
    }
    // Names and IPv4 numbers only; an unbracketed IPv6 address is ambiguous with a port.
    if (!host || host.includes(':')) return {reason: 'host'};
    if (/^[\d.]+$/.test(host) ? !IPV4.test(host) : !(host.length <= 253 && host.split('.').every(label => DNS_LABEL.test(label)))) return {reason: 'host'};
  }
  if (typeof port === 'string') {
    if (!/^\d{1,5}$/.test(port)) return {reason: 'port'};
    port = Number(port);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return {reason: 'port'};
  host = host.toLowerCase();
  return {host, port, origin: `http://${host}:${port}`};
}

/** The server's version in one line of plain words ("OmniVoice server 0.3.3 (protocol 1)"). */
export const versionLine = (version, protocol = OMNI_PROTOCOL) => `OmniVoice server ${version ?? '?'} (protocol ${protocol})`;
