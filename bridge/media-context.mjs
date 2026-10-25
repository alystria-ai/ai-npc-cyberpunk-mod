// Music and TV (Settings > Dynamic info > Music and TV, docs/DYNAMIC_INFO.md): the song on the car radio or on V's pocket radio, and what a TV near V
// shows. mod/media-context.lua reads it on demand when a turn is built (never per frame) and sends plain text; this module validates that table,
// words it, and gives the scenery memory a short signature (bridge/scenery-memory.mjs) so a conversation hears it when it is new: the first turn,
// a change of song, station or channel, and after a long silence, never on every turn (the "weather every turn" lesson of
// docs/DYNAMIC_CONTEXT_AUDIT.md). The sentences land in the Background line of the right-now block, so they say what is there, not that something happened.
//
// The shape the game side sends (every field optional, the whole table absent when nothing is playing):
//   {radio: {source: 'car' | 'pocket', station: <text>, track: <text>}, tv: {channel: <text>, said: <the last line a TV said>}}
// Only the form of a turn that hears what V hears gets the words: a companion in person with V ('person') and Johnny in V's head ('head').
// A stranger, a phone chat, a call and an add-on voice get nothing: they are not in the car, and the radio is no business of theirs.
//
// Everything in it is text the game or a mod put there (a song title, a station name, a spoken TV line), so it is untrusted: tags, control
// characters and localisation-key leftovers are stripped, lengths are capped, and every piece is JSON-quoted in the sentence so an odd or hostile
// title reads as a name and not as an instruction.

const MAX_STATION = 40, MAX_TRACK = 80, MAX_CHANNEL = 40, MAX_SAID = 120;
/** The whole wording of one turn, both sentences together. */
export const MAX_CHARS = 300;
const SOURCES = new Set(['car', 'pocket']);
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);

// A localisation key that was never resolved: a LocKey#number, one of the game's key prefixes, or a path of three or more words glued with - _ or .
// and no space. Dropping a real one-word-run title is the cheaper mistake than telling the model a key.
const RAW_KEY = /^(?:LocKey#|(?:Story|Gameplay|UI|Lore|Items|Radio|Mod|Device|Devices)[-_.]\w)|^\w+(?:[-_.]\w+){2,}$/;

function clean(value, limit) {
  if (typeof value !== 'string' || value.length > limit * 4) return undefined;
  const text = value.replace(/<[^>]*>/g, ' ').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!text || text.includes('LocKey#') || RAW_KEY.test(text)) return undefined;
  if (text.length <= limit) return text;
  // Cut at the limit on a whole character (never half a surrogate pair), and say it was cut.
  const chars = Array.from(text);
  return chars.length <= limit ? text : `${chars.slice(0, limit - 1).join('').trimEnd()}…`;
}

/** The snapshot's `media` table from mod/media-context.lua, validated; undefined when absent, malformed or empty. */
export function parseMedia(value) {
  if (!plain(value)) return undefined;
  const result = {};
  const radio = value.radio;
  if (plain(radio) && SOURCES.has(radio.source)) {
    const station = clean(radio.station, MAX_STATION), track = clean(radio.track, MAX_TRACK);
    result.radio = {source: radio.source, ...(station ? {station} : {}), ...(track ? {track} : {})};
  }
  const tv = value.tv;
  if (plain(tv)) {
    const channel = clean(tv.channel, MAX_CHANNEL), said = clean(tv.said, MAX_SAID);
    result.tv = {...(channel ? {channel} : {}), ...(said ? {said} : {})};
  }
  return Object.keys(result).length ? result : undefined;
}

/** A short text that changes when the song, the station or the channel does (a TV's last line does not count: it changes all the time), or undefined. */
export function mediaSignature(media) {
  if (!plain(media)) return undefined;
  const parts = [];
  if (plain(media.radio)) parts.push(`r:${media.radio.source ?? ''}|${media.radio.station ?? ''}|${media.radio.track ?? ''}`);
  if (plain(media.tv)) parts.push(`t:${media.tv.channel ?? ''}`);
  return parts.length ? parts.join(';') : undefined;
}

const quote = text => JSON.stringify(text);

// She is in the car or next to V, so she hears it: the wording says so (a live turn of 2026-10-25 had a companion in the car answer "what song is this?" with
// "I can't hear it" from "The car radio is playing ..." under a Background header), and says what to do when V asks, without asking her to bring it up.
const RADIO_ASK = ' If V asks what is on, answer from this.';
function radioSentence(radio) {
  const hear = radio.source === 'pocket' ? "You can hear V's pocket radio, playing nearby" : 'You can hear the car radio';
  if (radio.track) return `${hear}: ${quote(radio.track)}${radio.station ? ` on ${quote(radio.station)}` : ''}.${RADIO_ASK}`;
  if (radio.station) return `${hear}, tuned to ${quote(radio.station)}.${RADIO_ASK}`;
  return `${hear}.`;
}

function tvSentence(tv, said = tv.said) {
  const head = tv.channel ? `A TV nearby is on ${quote(tv.channel)}` : 'A TV nearby is on';
  return said ? `${head}; it just said: ${quote(said)}.` : `${head}.`;
}

/** The sentences for this form of turn ('person' in person with V, 'head' Johnny; any other form hears nothing), [] when none. At most MAX_CHARS together. */
export function mediaSentences(media, form) {
  if (form !== 'person' && form !== 'head') return [];
  if (!plain(media)) return [];
  const sentences = [];
  if (plain(media.radio) && SOURCES.has(media.radio.source)) {
    // Quoting can lengthen a title full of quotation marks: over the budget the station goes first, then the whole sentence.
    let radio = radioSentence(media.radio);
    if (radio.length > MAX_CHARS) radio = radioSentence({source: media.radio.source, track: media.radio.track});
    if (radio.length <= MAX_CHARS) sentences.push(radio);
  }
  if (plain(media.tv)) {
    let tv = tvSentence(media.tv);
    const used = sentences.join(' ').length + (sentences.length ? 1 : 0);
    // Over the budget: the TV's last line is the first to be shortened, then dropped, then the whole TV sentence.
    if (used + tv.length > MAX_CHARS && media.tv.said) {
      const room = MAX_CHARS - used - tvSentence(media.tv, 'x').length + 1;
      const said = room >= 24 ? clean(media.tv.said, Math.max(1, room - 2)) : undefined;   // two characters for the quotes of an ordinary line
      tv = tvSentence(media.tv, said);
      if (said && used + tv.length > MAX_CHARS) tv = tvSentence(media.tv, undefined);
    }
    if (used + tv.length <= MAX_CHARS) sentences.push(tv);
  }
  return sentences;
}
