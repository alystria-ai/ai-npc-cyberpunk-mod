// Other mods' state (Settings > Dynamic info > Other mods' state): V's tiredness, hunger, thirst, nerve and addictions from Dark Future.
// STUB: the extension point wired into bridge/turn-context.mjs. The real module replaces it.

/** The snapshot's `mods` table from mod/mod-state.lua, validated; undefined when absent or malformed. */
export function parseMods() { return undefined; }

/** A short text that changes when the state said changes, or undefined. */
export function modsSignature() { return undefined; }

/** The sentences for this form of turn ('person', 'head', 'ambient', 'phone', 'call', 'voice'), [] when none. */
export function modsSentences() { return []; }
