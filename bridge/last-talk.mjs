// Time since V last talked to a character (Settings > Dynamic info > Time since last talk; docs/DYNAMIC_INFO.md).
// STUB: the extension point wired into bridge/turn-context.mjs and bridge/quest-context.mjs. The real module replaces it.

/** The game clock the game side sent (whole game seconds), or undefined. */
export function parseGameTime(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** The one sentence about the gap since this character was last talked to, or ''. Built once per turn id. */
export function lastTalkSentence() { return ''; }
