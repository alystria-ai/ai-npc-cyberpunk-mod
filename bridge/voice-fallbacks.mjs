// The fallback archetype voices of the side characters (docs/CAST_SWEEP.md, "Voices"): characters/cast-sweep-voices.json names, for each cast sweep person, the archetype
// voice that speaks them until they have a clip of their own. The voice service speaks a key that has no voice of its own with the voice its `aliases` option names
// (bridge/voice-selection.mjs voiceOf), so the fallback is an alias and nothing is copied: the voice workers never learn the side characters' keys, they prepare
// the archetype voice once (not once per person), and a character that has a row of its own in an engine's table (shipped, or clips built on this PC) keeps it.
// Pure functions over text and tables, no I/O, nothing per frame.

const KEY = /^[a-z0-9][a-z0-9-]{0,127}$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * {key: archetype key} from the text of cast-sweep-voices.json. `allowed` (a Set of roster keys, or null for any key) limits it to people the roster names.
 * Entries that are not well formed are left out, an unreadable file gives no fallbacks.
 */
export function readFallbacks(text, allowed = null) {
  const out = Object.create(null);
  let parsed = null;
  try { parsed = JSON.parse(String(text).replace(/^﻿/, '')); } catch { return out; }
  if (!plain(parsed) || !plain(parsed.characters)) return out;
  for (const [key, row] of Object.entries(parsed.characters)) {
    if (!KEY.test(key) || !plain(row) || typeof row.fallback !== 'string' || !KEY.test(row.fallback)) continue;
    if (allowed && !allowed.has(key)) continue;
    out[key] = row.fallback;
  }
  return out;
}

/** The `aliases` option of the voice service: `base(key)` (the player's own characters) first, then the fallback archetype of a cast sweep person. */
export function fallbackAliases(fallbacks, base = () => null) {
  return key => base(key) || (typeof key === 'string' && Object.hasOwn(fallbacks, key) ? fallbacks[key] : null);
}

/**
 * How many fallback people an engine cannot speak with their archetype voice: its table has no row for the archetype (and none of their own). They are routed to the
 * text, never to an error. `tables` = {pocket, short, long} voices objects (an engine with no table is left out).
 */
export function missingFallbacks(fallbacks, tables) {
  const counts = {};
  for (const [engine, table] of Object.entries(tables ?? {})) {
    if (!plain(table)) continue;
    counts[engine] = Object.entries(fallbacks).filter(([key, archetype]) => !Object.hasOwn(table, key) && !Object.hasOwn(table, archetype)).length;
  }
  return counts;
}

/** The one log line for the engines that lack archetype voices, or null when none does. */
export function missingFallbacksLine(counts, total) {
  const parts = Object.entries(counts).filter(([, count]) => count > 0).map(([engine, count]) => `${engine} ${count}`);
  return parts.length ? `[VoiceFallbacks] ${parts.join(', ')} of ${total} side character(s) have no archetype voice in that engine's table and are answered in text there` : null;
}
