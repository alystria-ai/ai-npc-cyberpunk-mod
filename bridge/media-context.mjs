// Music and TV (Settings > Dynamic info > Music and TV): the song on the car radio or V's pocket radio, and what a TV near V shows.
// STUB: the extension point wired into bridge/turn-context.mjs. The real module replaces it.

/** The snapshot's `media` table from mod/media-context.lua, validated; undefined when absent or malformed. */
export function parseMedia() { return undefined; }

/** A short text that changes when the thing said changes (the scenery memory tells a conversation again only on a change), or undefined. */
export function mediaSignature() { return undefined; }

/** The sentences for this form of turn ('person' in person with V, 'head' Johnny, 'ambient' a stranger, 'phone', 'call', 'voice'), [] when none. */
export function mediaSentences() { return []; }
