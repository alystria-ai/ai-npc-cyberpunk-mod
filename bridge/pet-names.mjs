// Pet names for V ("handsome", "babe") are rare (owner, 2026-10-31: Judy and Panam called V "handsome" in nearly every reply).
//
// The rule: at most one pet name in PET_NAME_GAP replies of a character, at most one in a reply, and never the one she used last. Two cheap steps on the character's own last replies,
// plain string work with no request and no model, the same shape as bridge/reply-variety.mjs:
//   1. BEFORE the reply: petNameNote() tells the model, in the closing tier right after V's words, that this reply has none, or which ones to leave out.
//   2. AFTER the reply: limitPetNames() takes out the pet names the rule does not allow, when enough of the reply remains.
// Only a pet name said TO V counts: it stands alone between commas or sentence ends, or follows a lead-in word ("hey handsome"). "You look handsome" and "a handsome devil" are left alone.
// Pure functions, no state, no I/O (rememberReply keeps its list in a map the caller owns).

export const PET_NAME_GAP = 6;
const KEPT_REPLIES = 12;        // the replies looked at for the names used lately
const MIN_WORDS_LEFT = 3;       // a reply with its pet names taken out keeps at least this many words, else it is left as it is

const PET_NAMES = ['handsome', 'gorgeous', 'cutie pie', 'cutie', 'sweetheart', 'sweetie', 'sweetness', 'sweet cheeks', 'darling', 'darlin', 'babes', 'babe', 'baby', 'honey', 'hon', 'sugar', 'doll',
  'love', 'lover', 'beautiful', 'stud', 'hot stuff', 'pretty boy', 'sunshine', 'angel'];
const PET_LEADS = ['hey', 'oh', 'ah', 'well', 'yes', 'yeah', 'yep', 'okay', 'ok', 'sure', 'thanks', 'thank you', 'come on', 'listen', 'easy', 'relax', 'please', 'sorry', 'goodnight', 'good night', 'good morning'];
const SPELLING = {babes: 'babe', darlin: 'darling', 'cutie pie': 'cutie'};
const pattern = () => new RegExp(`(?<lead>^|[,;:.!?…]\\s*|\\b(?:${PET_LEADS.join('|')})\\s+)(?<name>${PET_NAMES.join('|')})(?=\\s*(?:[,.!?…;:]|$))`, 'giu');
const keyOf = name => { const lower = name.toLowerCase(); return SPELLING[lower] ?? lower; };
const clean = reply => String(reply ?? '').replace(/\[[^\]]{1,40}\]|<[^>]{1,40}>/g, ' ').replace(/[‘’ʼ]/g, "'");
const listOf = items => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;
const wordCount = text => String(text ?? '').split(/\s+/u).filter(word => /[\p{L}\p{N}]/u.test(word)).length;
const recentOf = (replies, count) => (Array.isArray(replies) ? replies : []).filter(reply => typeof reply === 'string').slice(-count);

/** The pet names said to V in a reply, in order, one word each ("handsome", "babe"). */
export function petNamesIn(reply) {
  return [...clean(reply).matchAll(pattern())].map(match => keyOf(match.groups.name));
}

/** True when no pet name was said in the last PET_NAME_GAP - 1 replies, so one may be said now. `replies`: the character's own replies, oldest first. */
export const petNameAllowed = replies => !recentOf(replies, PET_NAME_GAP - 1).some(reply => petNamesIn(reply).length);

/** The last pet name used in the replies (the newest reply that had one, its last name), or ''. */
export function lastPetName(replies) {
  for (const reply of recentOf(replies, KEPT_REPLIES).reverse()) { const names = petNamesIn(reply); if (names.length) return names.at(-1); }
  return '';
}

/**
 * The note for this turn about pet names, or '' when none was used lately. A pet name in the last PET_NAME_GAP - 1 replies means none now; otherwise the ones used lately are named so
 * that the next one is another. No dashes or semicolons in it: it is read by a model.
 */
export function petNameNote(replies) {
  const used = [...new Set(recentOf(replies, KEPT_REPLIES).flatMap(petNamesIn))];
  if (!used.length) return '';
  const names = listOf(used.map(name => `"${name}"`));
  if (!petNameAllowed(replies)) return `You called V ${names} lately, so this reply has no pet name for V at all. Say V, or nothing.`;
  return `If you call V a pet name this reply, use only one, and not ${names}.`;
}

// Where one pet name stands decides what goes with it: after a comma the comma goes too; after a lead-in word the lead-in stays; at the start of a sentence the name goes, with the comma
// after it (or, when it was the whole sentence, its full stop).
function removal(match, text) {
  const {lead} = match.groups, start = match.index, end = start + match[0].length, rest = text.slice(end);
  if (/^[,;:]/.test(lead)) return {from: start, to: end, put: '', capital: false};
  if (/^\p{L}/u.test(lead)) return {from: start, to: end, put: lead.trimEnd(), capital: false};
  const whole = /^\s*[.!?…]/u.test(rest);
  const cut = whole ? rest.match(/^\s*[.!?…]+\s*/u)[0].length : rest.match(/^\s*[,;:]?\s*/u)[0].length;
  return {from: start + lead.length, to: end + cut, put: '', capital: true};
}

/**
 * The reply with the pet names the rule does not allow taken out, or null when nothing was taken out or too little would remain. The rule: no pet name when one was said in the last
 * PET_NAME_GAP - 1 of `replies`, otherwise the first one, unless it is the one she used last. `replies`: the character's own last replies, oldest first.
 */
export function limitPetNames(reply, replies) {
  const text = String(reply ?? '');
  const found = [...text.matchAll(pattern())];
  if (!found.length) return null;
  const allowOne = petNameAllowed(replies), previous = lastPetName(replies);
  const drops = found.filter((match, index) => !(allowOne && index === 0 && keyOf(match.groups.name) !== previous)).map(match => removal(match, text));
  if (!drops.length) return null;
  let out = '', at = 0;
  for (const drop of drops) { out += text.slice(at, drop.from) + drop.put; at = drop.to; }
  out += text.slice(at);
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.!?…;:])/g, '$1').replace(/([,;:])\s*([.!?…])/g, '$2').trim();
  // A sentence that starts in lower case because its first word was a pet name starts with a capital again.
  out = out.replace(/(^|[.!?…]\s+)(\p{Ll})/gu, (_all, lead, letter) => lead + letter.toUpperCase());
  if (wordCount(out) < MIN_WORDS_LEFT) return null;
  return {reply: out, removed: drops.length};
}

/** Would limitPetNames take a pet name out of this start of a reply? Then the voice does not begin with it: the finished reply, with the name out, is spoken instead. */
export const headHasPetName = (head, replies) => limitPetNames(head, replies) !== null;

/** Keeps a character's last replies by key for the pet name note (a map of arrays, at most KEPT_REPLIES each, oldest first). Returns that character's list. */
export function rememberReply(memory, key, reply) {
  if (!(memory instanceof Map) || typeof key !== 'string') return [];
  if (typeof reply !== 'string' || !reply.trim()) return memory.get(key) ?? [];
  const list = [...(memory.get(key) ?? []), reply].slice(-KEPT_REPLIES);
  memory.set(key, list);
  return list;
}
