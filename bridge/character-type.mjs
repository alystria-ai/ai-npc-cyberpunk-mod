// Context by character type (docs/CONTEXT_BY_TYPE.md). A player's suggestion of 31 Oct: story characters know the quest, side characters get quest and world
// context only when they need it, strangers never. Three types, one small table of what each may be told, one line that tells the character what kind of
// person it is. Everything here is cheap: a Map lookup per turn, the tie words of a character worked out once.
//
//   story     the named cast that is not a cast sweep side character (companions, romances, fixers, bosses) and any character the player made or an
//             add-on brought: as before, the full context.
//   side      the cast sweep's side characters (roster `minor`), who are real, named, and have little to do with V's story.
//   stranger  a crowd person: a resident or an archetype (`npc-*`, bridge/protocol.mjs isAmbientProfile).
//
// The values of POLICY, per part of the context (the key of a block in bridge/quest-context.mjs conversationContextBlocks):
//   'all'   the part as the type has always had it
//   'tied'  only what is tied to this character. A job or a past quest is tied when the quest catalog lists the character in it, when its words name the
//           character, its faction or role (the roster summary), or the place V and the character stand in, or when V's words in this turn are about it.
//           What is tied only by V's words is not part of the stable text: it comes after the history, in the notes of this turn
//   'none'  never
// The parts: journal (V's tracked quest), jobs (V's open jobs), history (V's finished and failed quests), recency (what V and this character did
// together last), story (the main story as this character knows it from finished quests), briefing (a job the character gave), knowledge (the world
// facts the character knows). recency, story, briefing and knowledge are per speaker by construction (their rules name the speaker), so a side character's
// 'all' is only her own.
import {isAmbientProfile} from './protocol.mjs';

export const TYPES = Object.freeze(['story', 'side', 'stranger']);
const frozen = table => Object.freeze(Object.fromEntries(Object.entries(table).map(([type, row]) => [type, Object.freeze({...row})])));
export const POLICY = frozen({
  story:    {journal: 'all',  jobs: 'all',  history: 'all',  recency: 'all',  story: 'all',  briefing: 'all',  knowledge: 'all'},
  side:     {journal: 'tied', jobs: 'tied', history: 'tied', recency: 'all',  story: 'all',  briefing: 'all',  knowledge: 'all'},
  stranger: {journal: 'none', jobs: 'none', history: 'none', recency: 'none', story: 'none', briefing: 'none', knowledge: 'none'},
});

/** What a type may be told of one part: 'all', 'tied' or 'none'. An unknown type or part is 'all' (as it was before types). */
export const modeFor = (type, part) => POLICY[type]?.[part] ?? 'all';

// The type line, one short sentence per type. The character's own role or faction from the roster summary follows it.
export const TYPE_LINES = Object.freeze({
  story: "You are one of the people V's story runs through, and you know what concerns you of it.",
  side: "You are an everyday Night City person with a life of your own, not part of V's story. You know your own corner of the city, your people and your work, "
    + 'and you talk about the jobs V is on only when they touch you or when V brings them up.',
  stranger: "You are a stranger to V, an ordinary person in Night City. You know nothing of V's story or jobs, only what is in front of you.",
});

const WORD = /[\p{L}\p{N}]+/gu;
const fold = text => String(text ?? '').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
// Words that are in nearly every text of this game and tie nothing to anyone.
const COMMON = new Set(('night city quest gig job jobs the and for with from that this have your about into what when where there were been they them then than also only more most some such many much very just like over under after before again'
  + ' tracked objective objectives journal mission part main side street streets people person people someone nobody gang crew work works working known member group').split(' '));
export const words = text => {
  const out = new Set();
  for (const word of fold(text).match(WORD) ?? []) if (word.length >= 4 && !COMMON.has(word) && !/^\d+$/.test(word)) out.add(word);
  return out;
};

/** Do the words of `text` meet the set `wanted`? */
export function touches(text, wanted) {
  if (!wanted || !wanted.size) return false;
  for (const word of words(text)) if (wanted.has(word)) return true;
  return false;
}

const book = new Map();   // profile key -> {type, name, summary, ties}
/** Gives the registry the roster rows (named, then archetypes). Called once when the bridge starts, again by a test. */
export function setCharacterRoster(rows = []) {
  book.clear();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.key !== 'string' || book.has(row.key)) continue;
    const ambient = row.kind === 'ambient' || row.kind === 'archetype' || isAmbientProfile(row.key);
    const type = ambient ? 'stranger' : row.kind === 'named' && row.minor === true ? 'side' : row.kind === 'named' ? 'story' : null;
    if (type) book.set(row.key, {type, name: String(row.name ?? ''), summary: String(row.summary ?? ''), aliases: Array.isArray(row.aliases) ? row.aliases : []});
  }
}

/** The type of a profile: a crowd key is a stranger, a roster row says its own, anything else (a character the player made, an add-on's voice) is a story character as before. */
export function characterTypeOf(profileKey) {
  if (isAmbientProfile(profileKey)) return 'stranger';
  return book.get(profileKey)?.type ?? 'story';
}

// The role or faction line: the first sentence of the roster summary, said to the character. "Adam Giles is a member of the Animals gang, ..." is
// "Your place in Night City: a member of the Animals gang, ...". The sentence has to start with the name (or an alias, or the first name) and "is"; a summary that does
// not is left out rather than said wrongly.
function roleOf(entry) {
  const sentence = entry.summary.split(/(?<=[.!?])\s/u)[0]?.trim() ?? '';
  const name = entry.name.trim();
  for (const who of [name, ...entry.aliases, name.split(/\s+/u)[0]]) {
    if (typeof who !== 'string' || !who.trim() || !sentence.startsWith(who.trim() + ' is ')) continue;
    const rest = sentence.slice(who.trim().length + 4).replace(/[.!?]+$/u, '').trim();
    return rest ? `Your place in Night City: ${rest}.` : '';
  }
  return '';
}

const lines = new Map();
/** The line that tells a character what kind of person it is, '' for a profile the registry does not know the kind of (a custom character, an add-on voice). Stable per character. */
export function typeLine(profileKey) {
  if (lines.has(profileKey) && lines.get(profileKey).size === book.size) return lines.get(profileKey).text;
  const entry = book.get(profileKey);
  let text = '';
  if (isAmbientProfile(profileKey)) text = TYPE_LINES.stranger;
  else if (entry && entry.type !== 'stranger') {
    const role = roleOf(entry);
    text = `${TYPE_LINES[entry.type]}${role ? ' ' + role : ''}`;
  } else if (entry) text = TYPE_LINES.stranger;
  lines.set(profileKey, {text, size: book.size});
  return text;
}

const tied = new Map();
/** The words that tie a quest, a job or a fact to this character: the name and aliases, and the proper names of the roster summary (the faction, the crew, the place). Once per character. */
export function tieWords(profileKey) {
  const entry = book.get(profileKey);
  if (!entry) return new Set();
  const cached = tied.get(profileKey);
  if (cached && cached.size === book.size) return cached.words;
  const out = words([entry.name, ...entry.aliases].join(' '));
  for (const proper of entry.summary.match(/\b\p{Lu}[\p{L}\p{N}'-]{2,}/gu) ?? []) for (const word of words(proper)) out.add(word);
  tied.set(profileKey, {words: out, size: book.size});
  return out;
}

/** The words of the place V and the character stand in (the district and the named area of the turn's right-now facts), for a turn whose snapshot says. */
export function placeWords(snapshot) {
  return snapshot && typeof snapshot === 'object' ? words([snapshot.district, snapshot.area].filter(Boolean).join(' ')) : new Set();
}

/**
 * How a text is tied to a character for this turn: 'own' (the character's name, faction or role, or the place they stand in), 'talk' (V's words in this
 * turn), or false. 'own' is stable between turns, so it stays in the stable part of the prompt; 'talk' is for this turn only.
 */
export function tieOf(text, {profileKey, place, talk} = {}) {
  const own = tieWords(profileKey);
  if (touches(text, own) || touches(text, place)) return 'own';
  if (talk && touches(text, words(talk))) return 'talk';
  return false;
}
