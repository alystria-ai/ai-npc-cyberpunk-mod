// A meeting V called off in plain words to someone else (docs/IMMERSIVE_INVITATIONS.md, "Cancel"). V arranged a meeting with a character who is not here, then
// says "never mind, cancel that" to the companion standing next to V (a talk or voice turn). The words are screened here, in every language of the menus;
// the game (mod/immersive-service.lua) reads this file once a second while a meeting stands and ends the one meeting, or, with several, the one V named.
// No model is asked and nothing is added to the turn: a line that is not an explicit call-off writes nothing.
import {resolve} from 'node:path';
import {plainCallOff} from './meet-requests.mjs';

/** The file's content for one turn, or null: V's own talk or voice words (not a reaction, a call or an automatic line) that are an explicit call-off. */
export function callOffRecord(input, userText, now = Date.now()) {
  if (!input || input.reaction || input.holocall || input.event || input.automatic) return null;
  const text = typeof userText === 'string' && userText.trim() ? userText : typeof input.text === 'string' ? input.text : '';
  if (!text.trim() || [...text].length > 300 || !plainCallOff(text)) return null;
  return {version: 1, id: String(input.requestId ?? now), updated: now, text: text.trim()};
}

/** Writes the call-off of a turn (never awaited, never in front of a reply). `write`: (path, text) => Promise. */
export function publishCallOff(runtime, write, input, userText) {
  try {
    const record = callOffRecord(input, userText);
    if (record) void Promise.resolve(write(resolve(runtime, 'call-off.json'), JSON.stringify(record))).catch(() => {});
  } catch { /* the reply never depends on this */ }
}
