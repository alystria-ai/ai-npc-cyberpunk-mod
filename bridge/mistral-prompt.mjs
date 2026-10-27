// The prompt a text-provider model (Mistral, or the fully local AI) gets, built from the same character data the Convai characters
// carry, and the cleaning of what comes back (docs/MISTRAL.md, docs/LOCAL_AI.md). Pure functions: no I/O.
//
// Layout v2 (used whenever the bridge supplies `contextParts`), ordered from the most stable text to the most volatile so a
// server that reuses the longest identical prefix of the previous request (llama.cpp's prompt cache; some cloud APIs) recomputes
// as little as possible. Nothing that alternates between turns may sit early: on a hybrid model (Qwen3.5, Gemma 4) a changed
// early token throws away every checkpoint after it (docs/LOCAL_OPTION_DESIGN.md, "Hybrid model caveat"):
//   system   1. the persona (backstory with the appearance, speaking style, original example lines) and the output rules, then the
//               world rules the player wrote in the editor (bridge/world-rules.mjs; nothing when there are none): they change only when
//               the player saves them, so they sit with the other stable text and never after the world facts or the right-now block
//            2. the format notes (Expressive emotion tags): identical every turn for a given setting
//            3. the world: quest and journal, relationship, who V is to this character, gear (changes on game events only)
//            4. what the character remembers of V from older talks (the summary; changes every few exchanges)
//            5. the "right now" block (game clock to the hour, district, company, vehicle; bridge/turn-context.mjs). It sits LAST
//               in the system message, i.e. just before the conversation turns: it is stable for minutes at a time, so it must
//               not come before the world block, but it does change, so nothing stable may follow it. The bridge builds it first
//               in the Convai context (Convai ignores the order); a prefix cache does not.
//   history  the last few exchanges of this conversation (user / assistant)
//   user     the volatile notes of this turn (follow-up policy, Natural speech offer, game dialogue, battle and loot, language,
//            first-person reminder), what the memory store retrieved for V's words, then `V says: ...` and the closing reminder
// Without `contextParts` (older callers, tests) the old layout is used: persona, summary and rules in the system message, and the
// whole live context (the string Convai gets) in the last user message.
// A reply comes back as plain text and goes through the same cleaning as a Convai reply (Natural speech, Expressive emotions).
// Mature content (bridge/mature-content.mjs): for the fully local AI with the setting on, a short layer ends the system head, after the
// output rules. It is part of the stable early text (the prefix cache keeps it) and the prompt budget never trims it. Off, nothing changes.
import {matureLayer, guardLayer, matureClosing, matureWorld} from './mature-content.mjs';

import {applyOverride} from './character-overrides.mjs';
import {BASE_PROFILE, renderRules, renderExamples, renderIntro, renderClosing, limitsWith} from './prompt-profiles.mjs';
import {worldRulesBlock} from './world-rules.mjs';
import {headLine, tailLine, staleTest, FRESH_MAX_CHARS} from './fresh-facts.mjs';

export const LIMITS = Object.freeze({
  persona: 16000,        // characters of the persona sections (the longest named character is about 11,400)
  context: 20000,        // characters of live context; a longer one keeps its head and its tail (the format notes are at the end)
  world: 16000,          // layout v2: characters of the world block in the system message (head and tail kept)
  notes: 3000,           // layout v2: format notes in the system message
  now: 900,              // layout v2: the right-now block (matches MAX_CHARS in turn-context.mjs, so the block is never clipped)
  volatile: 6000,        // layout v2: this turn's volatile notes in the last user message
  remembered: 1200,      // layout v2: retrieved memories for this turn (about 300 tokens)
  summary: 1400,         // what the character remembers of V from older talks
  turns: 11,             // exchanges of conversation history sent with a request: all the memory holds (8 to 11, MEMORY_LIMITS.turns + slide in bridge/mistral-memory.mjs)
  userLine: 400,         // each history line from V
  replyLine: 600,        // each history line from the character
  playerText: 1200,      // V's message (the game already caps it at 1200)
  reply: 700,            // a reply is cut at a sentence end within this many characters...
  replySentences: 6,     // ...or this many sentences, whichever comes first
  temperature: 0.65, // lower than a chat default: the persona and the facts matter more than variety
  maxTokens: 600, // the stream stops at the sentence cap anyway; the rest is headroom
});

// The first lines of every Convai context (bridge/realtime-client.mjs updateContext), kept identical.
export const CONTEXT_PREFIX = 'You are speaking to V in Night City. Reply briefly without stage directions. '
  + 'Use only explicitly supplied current-save facts for quest progress and relationships. '
  + 'Any relationship state not explicitly supplied is unknown; do not infer it from character presence or past sessions. ';

const MARKER = /^\s*\[CyberpunkConvai profile[^\]]*\]\s*$/gm;
const clip = (text, limit) => {
  const points = Array.from(String(text ?? '').replace(/\s+/g, ' ').trim());
  return points.length <= limit ? points.join('') : points.slice(0, limit - 1).join('').trimEnd() + '…';
};

// What the messages of a request were built from, left on them (not enumerable, so the request body is unchanged) so a route that learns
// what its server can take can build the prompt again, smaller (bridge/prompt-budget.mjs).
export const PROMPT_SOURCE = Symbol.for('cyberpunk-convai.prompt-source');
export const withPromptSource = (messages, args) => { Object.defineProperty(messages, PROMPT_SOURCE, {value: args, enumerable: false}); return messages; };

// The shipped character text as the text providers (Mistral, Local AI, Custom) read it. The roster files are written for Convai, whose provisioned copy is not touched; here the parts
// that only repeat the output rules or the context blocks are said in one line, and the reviewer notes are left out (response audit 2026-10-22):
//   - the "Scope:" line after each claim of the public topic material (632 lines over the roster) is a note for the reviewer, not for the character;
//   - the KNOWLEDGE AND CURRENT SAVE block (601 characters in every named profile) and the intro of the PUBLIC INTRINSIC TOPIC MATERIAL (about 430) say what the output rules and the world block say;
//   (the roster text now says it itself, since fix/character-data-1022: an archetype is told to mention the place or the hour only if V asks)
//   - the closing "Speak naturally to V ..." paragraph of the speaking style is rules 1 to 3 again.
const SAVE_LINE = 'Verified current-save context overrides memory. Summoning you establishes no quest outcome, survival, romance or prior meeting. Admit what you do not know. Keep private motives and confidences private unless verified context says they were disclosed to this audience; a group invitation or a direct question alone does not.';
const TOPIC_LINE = 'Background and personal views, not proof that V met you or saw the source; use one detail, in your own words, in a sentence or two; verified game facts override.';
// A "Scope:" line that is a rule (do not, never, avoid, invent, give no) or a "No ..." limit stays: it keeps the character from inventing or overclaiming. The rest are provenance notes for the reviewer.
const SCOPE_RULE = /\b(?:do not|don't|never|avoid|invent(?:ed)?|give no)\b|^Scope:\s*No\b/i;
export const leanBackstory = text => String(text ?? '')
  .replace(/^Scope:[^\n]*(?:\n|$)/gm, line => SCOPE_RULE.test(line) ? line : '')
  .replace(/^(KNOWLEDGE AND CURRENT SAVE)\n[^\n]+/m, `$1\n${SAVE_LINE}`)
  .replace(/^(PUBLIC INTRINSIC TOPIC MATERIAL)\nThese are background and personal perspectives[^\n]+/m, `$1\n${TOPIC_LINE}`)
  .replace(/\n{3,}/g, '\n\n').trim();
// The closing paragraph of the speaking style is rules 1 to 3 again, except for three sentences that say more: the group-talk pair and "Use slang sparingly" (the archetypes overuse "choom").
const STYLE_KEEP = [/Use slang sparingly[^.]*\./, /In a group, speak for yourself[^.]*\./, /Never reveal private conversation history to a group\./];
export const leanStyle = text => String(text ?? '').replace(/\n*Speak naturally to V\b[^\n]*$/m, paragraph => {
  const kept = STYLE_KEEP.map(pattern => pattern.exec(paragraph)?.[0]).filter(Boolean);
  return kept.length ? `\n\n${kept.join(' ')}` : '';
}).trim();

/** The roster rows (named characters, then archetypes) by profile key. */
export class PersonaBook {
  /**
   * `overrides` (bridge/character-overrides.mjs, optional): the player's own edits of a character, read with a plain lookup per turn.
   * `custom` (bridge/custom-characters.mjs, optional): the characters the player made; their persona is theirs alone and a roster key never reaches it.
   * `worldRules` (bridge/world-rules.mjs, optional): the player's rules for the whole world; every persona carries them as `worldRules` (a text, absent when empty).
   */
  constructor(rows = [], {overrides = null, custom = null, worldRules = null, lean = false} = {}) {
    // `lean`: the shipped text without the reviewer notes and the paragraphs that repeat the output rules (leanBackstory, leanStyle). The bridge sets it; a test of the machinery sees the roster text as it is.
    this.lean = lean === true;
    this.overrides = overrides;
    this.custom = custom;
    this.worldRules = worldRules;
    this.rows = new Map();
    for (const row of rows) if (row && typeof row.key === 'string' && !this.rows.has(row.key)) this.rows.set(row.key, row);
  }
  has(key) { return this.rows.has(key) || this.custom?.has(key) === true; }
  /**
   * {name, backstory, style, samples, rules, memories, worldRules}: the shipped profile with the player's edits, when there are any, and the world
   * rules of the whole world (a plain property read per turn). A persona without world rules has no `worldRules` field at all.
   */
  persona(profileKey, fallbackName) {
    const persona = this.#personaOf(profileKey, fallbackName), rules = this.worldRules?.get() ?? '';
    return rules ? {...persona, worldRules: rules} : persona;
  }
  #personaOf(profileKey, fallbackName) {
    if (!this.rows.has(profileKey)) { const own = this.custom?.persona(profileKey); if (own) return own; }
    const shipped = this.defaults(profileKey, fallbackName);
    return shipped.known ? applyOverride(shipped, this.overrides?.get(profileKey) ?? null) : shipped;
  }
  /** The shipped profile alone (what "reset" goes back to): {name, backstory, style, samples} for a profile key; a generic person when the key is unknown. */
  defaults(profileKey, fallbackName) {
    const row = this.rows.get(profileKey);
    // An unnamed NPC (a resident or an archetype such as a food vendor) has no name of its own: its profile text says who it is.
    const ambient = !row || row.kind === 'ambient' || row.kind === 'archetype' || /^(?:resident|npc)-/.test(profileKey);
    const name = ambient ? '' : (row?.name || fallbackName || '').toString().trim().slice(0, 80);
    if (!row) return {name, ambient: true, backstory: 'You are an ordinary person in Night City. You are not a story character.', style: '', samples: [], known: false};
    const backstory = String(row.backstory ?? '').replace(MARKER, '').trim();
    const style = String(row.speakingStyleDescription ?? '').trim();
    const samples = String(row.speakingStyleSampleDialogues ?? '').split(/\n\s*\n/).map(line => line.trim()).filter(Boolean);
    // An add-on speaker (docs/ADDON_API.md) is not a person: its row may replace the opening line and the "real person" rule, and bring
    // rules of its own. Ordinary rows have none of these fields, so their persona is unchanged.
    const extra = {};
    if (typeof row.intro === 'string' && row.intro.trim()) extra.intro = row.intro.trim();
    if (typeof row.identityRule === 'string' && row.identityRule.trim()) extra.identityRule = row.identityRule.trim();
    if (Array.isArray(row.rules) && row.rules.length) extra.rules = row.rules.filter(line => typeof line === 'string' && line.trim()).map(line => line.trim());
    // An add-on speaker may set its own reply length for talk turns (persona.talkWords, docs/ADDON_API.md); an ordinary row never does.
    if (Number.isInteger(row.talkWords) && row.talkWords >= 8 && row.talkWords <= 60) extra.talkWords = row.talkWords;
    return {name, ambient, backstory: this.lean ? leanBackstory(backstory) : backstory, style: this.lean ? leanStyle(style) : style, samples, known: true, ...extra};
  }
}

// The last thing the model reads before it answers: the rules it most often drifts from. The wording is the profile's (bridge/prompt-profiles.mjs `closing`): a small model does what the last
// line says, so the shipped one names the three that matter most for a spoken reply: begin with the answer, stay short, invent nothing. With the Mature setting on (`mature` = the level) one more
// sentence ends it (bridge/mature-content.mjs, matureClosing): measured on the uncensored models, the persona and these rules outrank the layer in the system message, and a clause here is what moves the reply.
export const closing = (name, talkWords = 0, mature = null, profile = BASE_PROFILE) => renderClosing(profile, {name, talkWords, extra: mature ? matureClosing(mature, profile.matureLayer) : ''});

// The output rules are data now (bridge/prompt-profiles.mjs: the shipped wording and why it is what it is, per profile; the player can change them in the editor). `rulesOf` renders them for a
// speaker: with the Mature setting on two rules change (their `mature` text), and a speaker with a reply length of its own (`talkWords`) has its own rule 3 and closing.
const rulesOf = (profile, name, identityRule = '', talkWords = 0, mature = false) => renderRules(profile, {name, identityRule, talkWords, mature});

/**
 * The world blocks of a turn in the order a prefix cache wants (layout v2, item 3 above). Every world block changes on game events only,
 * except `knowledge`: the world facts are ranked by the words V just said (bridge/world-knowledge.mjs rank), so their text and order change
 * with every turn. Placed first among the world blocks, as the Convai context has it, they moved the first changed token to just after the
 * persona and made every turn read the whole world block again: about 3,000 new tokens of a 5,400-token prompt on every turn of the first
 * player reports (2026-10-19, 2,350 cached each time), 10 to 70 s on a computer the game keeps busy. So `knowledge` goes after the blocks that
 * are stable between turns (recency, history, jobs, journal, gear), and before the fixed `authority` sentence that is about it.
 * Only the text providers' layout uses this order; the Convai context keeps its own. A new array; nothing else moves.
 */
export function worldBlocksInCacheOrder(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  const changing = list.filter(block => block?.key === 'knowledge');
  if (!changing.length) return [...list];
  const rest = list.filter(block => block?.key !== 'knowledge');
  const at = rest.findIndex(block => block?.key === 'authority');
  return at < 0 ? [...rest, ...changing] : [...rest.slice(0, at), ...changing, ...rest.slice(at)];
}

/**
 * The fresh facts of a turn's context blocks (bridge/fresh-facts.mjs), as fields of `contextParts`: `fresh` and `freshDrop` only when there are facts; `freshCodes` (names only) and
 * `freshAsked` for the bridge log whenever the turn has the block. {} for a context with no fresh block.
 */
export const freshParts = blocks => {
  const block = (blocks ?? []).find(item => item?.tier === 'fresh');
  if (!block) return {};
  return {freshCodes: block.codes || '', freshAsked: block.asked === true, ...(block.facts ? {fresh: block.facts, freshDrop: block.drop || ''} : {})};
};

/** What the last prompt built with `buildMessages` did with the fresh facts, for the bridge log (names and counts only): see freshNote. */
export const FRESH_NOTE = Symbol.for('cyberpunk-convai.fresh-note');
/** `[FreshFacts]` line text for messages built by buildMessages: facts=<codes|none> placed=<where|none> asked=<yes|no> dropped=history:<n>,memory:<n>; '' for a message list with no note. */
export function freshNote(messages, {quiet = false} = {}) {
  const note = messages?.[FRESH_NOTE];
  if (!note) return '';
  // quiet: nothing for a prompt with no fresh facts, no question about oneself and nothing left out.
  if (quiet && !note.codes && !note.placed.length && !note.asked && !note.history && !note.memory) return '';
  return `facts=${note.codes || (note.placed.length ? 'unnamed' : 'none')} placed=${note.placed.join(',') || 'none'} asked=${note.asked ? 'yes' : 'no'} dropped=history:${note.history},memory:${note.memory}`;
}

/** Blocks of context text as one string: empty blocks and exact repeats (a block two sources both contribute) are dropped. */
export function joinBlocks(blocks) {
  const seen = new Set(), out = [];
  for (const block of blocks ?? []) {
    const text = typeof block === 'string' ? block.trim() : '';
    if (!text || seen.has(text)) continue;
    seen.add(text); out.push(text);
  }
  return out.join('\n\n');
}

const section = (title, body) => body ? `${title}\n${body}` : '';

/**
 * The persona and the output rules: the first, most stable part of the system message. The fully local server is prewarmed with
 * exactly this text (a prefix of the real system message in layout v2) when a companion joins. Over the length cap the example
 * lines go first, then the end of the backstory. `memory` (layout v1 only) puts the older-talk summary before the rules.
 */
export function systemHead({persona, memory = '', limits = LIMITS, mature = null, guard = false, profile = BASE_PROFILE}) {
  const name = persona.name;
  limits = limitsWith(profile, limits);
  const head = [persona.intro
    ? `${persona.intro} Stay ${name || 'yourself'} for the whole conversation: your voice, your attitude, what you know and what you do not.`
    : renderIntro(profile, name)];
  const build = (backstory, samples) => [
    ...head, '', 'WHO YOU ARE', backstory,
    ...(persona.style ? ['', 'HOW YOU TALK', persona.style] : []),
    ...(persona.rules?.length ? ['', 'YOUR OWN RULES OF SPEECH (always follow these; they outrank the style above)', ...persona.rules.map(line => `- ${line}`)] : []),
    ...(samples.length ? ['', 'EXAMPLES OF YOUR VOICE (tone and rhythm only; they are not shared memories, and you never repeat them)',
      ...samples.map(line => `- ${line.replace(/\s*\n\s*/g, ' ')}`)] : []),
    ...(persona.memories?.length ? ['', 'WHAT YOU KNOW AND REMEMBER (true; let it colour what you say when it fits, never recite it)', ...persona.memories.map(line => `- ${line}`)] : []),
    ...(memory ? ['', profile.labels.remember, clip(memory, limits.summary)] : []),
    '', rulesOf(profile, name, persona.identityRule, persona.talkWords, Boolean(mature)),
    ...(profile.examples.length ? ['', renderExamples(profile)] : [])].join('\n');
  let backstory = persona.backstory, samples = persona.samples;
  let text = build(backstory, samples);
  if (text.length > limits.persona + 2000) { samples = []; text = build(backstory, samples); }
  if (text.length > limits.persona + 2000) {
    const over = text.length - limits.persona - 2000;
    backstory = backstory.slice(0, Math.max(500, backstory.length - over - 20)).trimEnd() + '…';
    text = build(backstory, samples);
  }
  // The mature layer comes after the length caps: it is never counted against them and never cut.
  // `guard` without `mature`: an uncensored model answers (or an add-on speaker does) with the setting off, so only the adults-only line and the hard limits are added.
  return mature ? `${text}\n\n${matureLayer(mature, profile.matureLayer)}` : guard ? `${text}\n\n${guardLayer()}` : text;
}

/**
 * The system message. Layout v1 (no `layers`): `memory` is what the character remembers of V from older talks, before the rules.
 * Layout v2 (`layers` = {notes, world, now}): persona and rules, then the format notes, the world, the memory summary and the
 * right-now block, in that order (see the header comment for why).
 */
export function systemPrompt({persona, memory = '', limits = LIMITS, layers = null, mature = null, guard = false, profile = BASE_PROFILE}) {
  // The player's world rules follow the head (persona, output rules, Mature or guard layer) and come before everything that can change between
  // turns. Never cut by the prompt budget (bridge/prompt-budget.mjs): they are not part of the persona levels.
  const rules = worldRulesBlock(persona.worldRules);
  if (!layers) return [systemHead({persona, memory, limits, mature, guard, profile}), rules].filter(Boolean).join('\n\n');
  const prefixed = `${CONTEXT_PREFIX}${layers.world || 'This is a private conversation with V.'}`;
  const fitted = capContext(prefixed, limits.world);
  const lean = text => mature ? matureWorld(text, profile.matureLayer) : text;   // Mature on: a partner's relationship text leans in (bridge/mature-content.mjs)
  // The per-turn knowledge block (ranked by V's words, so it differs on nearly every turn) goes after everything that is stable between turns, the older-talk summary
  // included: a prompt cache (llama.cpp's) reuses the text up to the first difference, and with the block in the middle of the world context every turn read the summary
  // again. Only when the blocks are the very ones the world context is made of; otherwise the old order stands. The cap of the world context then cuts the stable blocks
  // (the middle of them, as before) at a place that does not depend on the facts (a cut that moved with the length of the facts would move the cached text with it), and
  // the facts have a cap of their own, half the world's.
  const apart = knowledgeApart(layers.worldBlocks, layers.world);
  const world = lean(apart ? capContext(`${CONTEXT_PREFIX}${apart.stable || 'This is a private conversation with V.'}`, limits.world) : fitted);
  return [systemHead({persona, limits, mature, guard, profile}), rules,
    section(profile.labels.formatNotes, capContext(layers.notes, limits.notes)),
    section(profile.labels.world, world),
    memory ? section(profile.labels.remember, clip(memory, limits.summary)) : '',
    apart ? section(profile.labels.knowledge, lean(capContext(apart.knowledge, Math.floor(limits.world / 2)))) : '',
    section(profile.labels.rightNow, clip(layers.now, limits.now)),
    // What changed this turn or what V asks about, once more at the very end (bridge/fresh-facts.mjs): after the right-now block, which changes anyway, so a prompt cache keeps all before it.
    layers.fresh ? headLine(clip(layers.fresh, FRESH_MAX_CHARS)) : '']
    .filter(Boolean).join('\n\n');
}

/**
 * The world blocks of a turn split into the stable ones and the per-turn `knowledge` block ({stable, knowledge} strings), or null when there is nothing to split:
 * no knowledge block, no list of blocks, or a list that is not what `world` was joined from.
 */
export function knowledgeApart(blocks, world) {
  if (!Array.isArray(blocks) || !blocks.length) return null;
  const knowledge = joinBlocks(blocks.filter(block => block?.key === 'knowledge').map(block => block.text));
  if (!knowledge) return null;
  if (joinBlocks(blocks.map(block => block?.text)) !== String(world ?? '')) return null;
  return {stable: joinBlocks(blocks.filter(block => block?.key !== 'knowledge').map(block => block?.text)), knowledge};
}

/** A context longer than the cap keeps its head and its tail (the voice, follow-up and first-person notes are last). */
export function capContext(context, limit = LIMITS.context) {
  const text = String(context ?? '').trim();
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.6), tail = limit - head - 20;
  return `${text.slice(0, head).trimEnd()}\n[...]\n${text.slice(text.length - tail).trimStart()}`;
}

/**
 * The messages of one request.
 *   persona        from PersonaBook.persona
 *   memory         the character's older-talk summary ('' for a group or an ambient NPC)
 *   history        [{v, r}] the last exchanges, oldest first
 *   context        the live context string of the turn (config.context); used as one block when `contextParts` is absent
 *   contextParts   {now, notes, world, volatile} strings (layout v2): the context split by how often it changes
 *   remembered     [{text}] what the memory store retrieved for this turn (layout v2 only; ambient and group turns pass none)
 *   text           V's message, or for a reaction the event text
 *   reaction       true for an automatic battle / loot line: `text` is then an event, not something V said
 */
// The first sentence of the right-now block (bridge/turn-context.mjs): "you are with V in person ..." or, in a phone chat, "you are
// messaging V by text ... you are somewhere else ..." or, on a holocall (docs/HOLOCALL.md), "you are on a voice call / holocall ...", or for
// Johnny in V's head (docs/JOHNNY_IN_YOUR_HEAD.md) "you are in V's head ...".
const HERE = /You are (?:with V in person[^.]*\.|in V's head[^.]*\.|(?:messaging V by text|on a voice call with V|on a holocall)[^.]*\.(?: You are somewhere else[^.]*\.)?)/;
// The place is left out of the copy right before V's words: the full block (with the place) is in the system message, and a model that reads "Rocky Ridge, Badlands" or
// "V is in Corpo Plaza" last answers with it ("Corpo Plaza? ..." in three of three of Johnny's first replies in the response audit, 2026-10-22). What the copy is for (what she is doing) stays.
const withoutPlace = here => String(here).replace(/;\s+V is in [^.]*(?=\.$)/, '').replace(/\s+(?:in|through)\s+(?!V's)[A-Z][^.]*(?=\.$)/, '');
export function buildMessages({persona, memory, history = [], context, contextParts, remembered = [], text, reaction = false, limits = LIMITS, mature = null, guard = false, profile = BASE_PROFILE}) {
  const v2 = !!contextParts && typeof contextParts === 'object';
  const messages = [{role: 'system', content: systemPrompt({persona, memory, limits, mature, guard, profile,
    layers: v2 ? {notes: contextParts.notes, world: contextParts.world, now: contextParts.now, worldBlocks: contextParts.worldBlocks, fresh: reaction ? '' : contextParts.fresh} : null})}];
  // The earlier replies that say what is no longer true (V's clothes just changed) are not sent: a 4B model repeats its own last answer over any line above it (bridge/fresh-facts.mjs).
  const stale = v2 && !reaction ? staleTest(contextParts.freshDrop) : null;
  let droppedHistory = 0, droppedMemory = 0;
  for (const turn of history.slice(-limitsWith(profile, limits).turns)) {
    const v = clip(turn.v, limits.userLine), r = clip(turn.r, limits.replyLine);
    if (!v || !r) continue;
    if (stale?.(r)) { droppedHistory++; continue; }
    messages.push({role: 'user', content: v}, {role: 'assistant', content: r});
  }
  const says = `V says: ${String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, limits.playerText)}`;
  const finish = closing(persona.name, persona.talkWords, mature, profile);
  const message = reaction
    ? `[EVENT, not spoken by V]\n${clip(text, 2400)}\n\nReact with one short spoken line of your own, in character.`
    : finish ? `${says}\n\n${finish}` : says;
  if (!v2) {
    const fitted = capContext(`${CONTEXT_PREFIX}${context || 'This is a private conversation with V.'}`, limits.context);
    const live = mature ? matureWorld(fitted, profile.matureLayer) : fitted;
    messages.push({role: 'user', content: `[LIVE CONTEXT for this moment: facts and instructions for you, never to be read aloud]\n${live}\n\n${message}`});
    return withPromptSource(messages, arguments[0]);
  }
  // What the character remembers that bears on these words: facts V told it, promises, tastes (bridge/memory-store.mjs).
  const facts = [];
  let used = 0;
  for (const item of remembered) {
    const line = clip(item?.text, 240);
    if (!line) continue;
    // What the character remembers of V that the game just read as the opposite (a note made from its own earlier wrong answer) is not sent either.
    if (stale?.(line)) { droppedMemory++; continue; }
    if (used + line.length > limits.remembered) continue;
    used += line.length; facts.push(`- ${line}`);
  }
  const volatile = capContext(contextParts.volatile, limits.volatile);
  // Where she is and what she is doing, said again right before V's words (it is also the first sentence of the right-now block in the
  // system message): a small model otherwise answers "what are you up to?" from the persona (the basement, the shop) and not from the game.
  const here = reaction ? '' : withoutPlace(HERE.exec(String(contextParts.now ?? ''))?.[0] ?? '');
  // The profile may put the turn's notes after V's line (before the closing) instead of before it.
  const notesAfter = profile.layout.volatile === 'after' && !reaction && volatile;
  // The fresh facts again, last before V's words (or, in a profile that puts the notes after V's line, last before the closing).
  const fresh = reaction || !contextParts.fresh ? '' : tailLine(clip(contextParts.fresh, FRESH_MAX_CHARS));
  messages.push({role: 'user', content: [
    here && profile.layout.youNow ? `[${profile.labels.youNow}: ${here} ${here.startsWith('You are messaging')
      ? 'You are not with V and cannot see V; never say you are there, close or nearby, and name no place or task of your own right now.'
      : here.startsWith('You are on a')
        ? 'You are not with V; never say you are there, close or nearby, and name no place or task of your own right now.'
        : here.startsWith("You are in V's head")
          ? 'You have no body; you go where V goes and never claim to be anywhere else or to be doing something of your own.'
          : 'That is all you are doing; never claim to be anywhere else.'}]` : '',
    volatile && !notesAfter ? `[${profile.labels.thisTurn}]\n${volatile}` : '',
    facts.length ? `[${profile.labels.things}]\n${facts.join('\n')}` : '',
    ...(notesAfter ? [says, `[${profile.labels.thisTurn}]\n${volatile}`, fresh, finish] : [fresh, message])].filter(Boolean).join('\n\n')});
  // For the bridge log: where the fresh facts went (names only) and what was left out because the game read the opposite.
  Object.defineProperty(messages, FRESH_NOTE, {enumerable: false, value: {codes: reaction ? '' : contextParts.freshCodes || '', asked: !reaction && contextParts.freshAsked === true,
    placed: fresh ? ['system-end', notesAfter ? 'before-closing' : 'before-v'] : [], history: droppedHistory, memory: droppedMemory}});
  return withPromptSource(messages, arguments[0]);
}

// ---- Reply cleaning ----------------------------------------------------------------------------------------------------

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}‍️]/gu;
const THINK = /<think(?:ing)?>[\s\S]*?(?:<\/think(?:ing)?>|$)/gi;
const STRAY_THINK = /<\/think(?:ing)?>/i;
// Gemma 4 writes its thinking between <|channel>thought and <channel|>; llama-server normally takes it out of the reply, but a server or template that does not
// leaves it in. The end-of-turn and turn-start markers of the model families (Gemma 4 and 3, Qwen) are never part of a reply: it ends at the first one.
const CHANNEL = /<\|channel>[\s\S]*?(?:<channel\|>|$)/g;
const TURN_MARKER = /<(?:turn\|>|\|turn>|end_of_turn>|start_of_turn>|\|im_end\|>|\|im_start\|>|eos>)/;

// The first word of a *stage direction*: what a character does (sighs, laughs, leans in, clears throat), not what it stresses.
// Words that are also ordinary words ("look", "take", "hold") count only in their -s, -ed and -ing forms ("looks", "holding").
const ACTION_STEM = /^(?:sigh|laugh|chuckl|giggl|snicker|smil|grin|smirk|wink|nod|shrug|paus|gasp|groan|cough|whisper|beep|bzz+t?|click|clap|cheer|cry|sob|snort|scoff|yawn|stretch|blush|frown|glar|stare|squint|wave|sip|sniff|hiss|mutter|shiver|tremble|flinch|wince|grimac|fidget|growl|mumbl|murmur|nudg|glanc|gestur|slump|stomp|twirl|bounc|crouch|kneel|beam|pout|sulk|tsk|ahem|exhal|inhal|swallow|lick|scratch)e?(?:s|es|ed|d|ing)?$/i;
const ACTION_FORM = /^(?:look|turn|step|walk|sit|stand|hold|take|put|reach|lift|set|pull|push|cross|fold|lean|point|tap|pat|roll|shak|tilt|rais|lower|rub|clear|drink|bow|touch|hug|spin|jump|duck|storm|breath|bit)(?:s|es|ed|d|ing|ning|ting|ping)$/i;

/**
 * Text between single asterisks. A stage direction ("*sighs*", "*leans back, arms crossed*", a longer action at the start or the end of
 * a reply or sentence) is removed. A word or a short phrase the model stressed ("That was *perfect*.", "I *really* mean it") keeps its
 * words and loses only the asterisks: removing it would leave a hole in the sentence. A group is a direction when it is longer than four
 * words; or starts with an action word (alone: at the start or end of a sentence, or in its -s/-ed/-ing form anywhere); or has three
 * words or more at the start or end of a sentence. A group followed at once by a comma, a full stop or the like is the sentence's own
 * stressed word, unless it is long.
 */
export function starred(text) {
  return String(text ?? '').replace(/(?<![\w*])\*([^*\n]{1,220})\*(?![\w*])/g, (match, inner, at, whole) => {
    const body = inner.trim();
    if (!body) return ' ';
    const words = body.split(/\s+/);
    const first = words[0].replace(/[^\p{L}']/gu, '');
    const before = whole.slice(0, at), after = whole.slice(at + match.length);
    const edge = !/\S/.test(before) || /[.!?…]["”')\]]*\s*$/.test(before) || !/\S/.test(after);
    const punctuated = /^[,.;:!?…]/.test(after);
    const inflected = /(?:s|ed|ing)$/i.test(first);
    const action = ACTION_STEM.test(first) || ACTION_FORM.test(first);
    const direction = words.length > 4
      || (words.length === 1 ? action && !punctuated && (edge || inflected) : (action && (edge || inflected)) || (edge && !punctuated && words.length >= 3));
    return direction ? ' ' : body;
  });
}

/**
 * A model reply as plain spoken text: reasoning blocks, speaker labels, stage directions, markdown and emoji removed. Emotion and
 * voice tags are left for the bridge's own pass (bridge/natural-speech.mjs), which removes them from the display text; braces and
 * bracket groups that are not tags are dropped here.
 */
export function cleanReply(raw, {name = '', isTag = () => false} = {}) {
  let text = String(raw ?? '').replace(/\r/g, '').replace(THINK, '').replace(CHANNEL, '');
  const marker = text.search(TURN_MARKER);
  if (marker >= 0) text = text.slice(0, marker);
  text = text.trim();
  // A closing think tag with no opening one (the uncensored Qwen3.5 models emit it with reasoning off): what follows it is the answer; when
  // nothing follows, the tag is a stray at the end of the answer and only the tag goes.
  if (STRAY_THINK.test(text)) { const parts = text.split(STRAY_THINK); text = (parts.at(-1).trim() || parts.slice(0, -1).join(' ')).trim(); }
  // A model that writes V's side of the talk as well keeps only its own lines (speakerTurn).
  text = speakerTurn(text, name);
  // A leading "Name:" or "**Name:**" label, and a leading "V:" echo.
  const label = name ? name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : null;
  if (label) text = text.replace(new RegExp(`^((?:\\{[^{}\\n]{0,40}\\}|\\[[^\\[\\]\\n]{0,40}\\]|\\s)*)[\\W_]*${label}[*_]{0,2}\\s*[:\\-–—]\\s*[*_]{0,2}\\s*`, 'i'), '$1');
  text = text.replace(/^\W*(?:V|You)\s*:\s*/i, '');
  // Markdown emphasis keeps its words; *actions* between single asterisks are stage directions and go (see starred).
  text = starred(text.replace(/\*\*([^*]+)\*\*/g, '$1')).replace(/__([^_]+)__/g, '$1');
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/^\s*[-*•]\s+/gm, '').replace(/`+/g, '');
  // Short parenthetical stage directions: "(laughs)", "(pauses, then smiles)".
  text = text.replace(/\s*\((?:[^()\n]{1,60})\)/g, match => /\d/.test(match) ? match : ' ');
  // Brace and bracket groups that are not tags the bridge understands.
  text = text.replace(/\{[^{}\n]{0,40}\}/g, match => isTag(match) ? match : ' ');
  text = text.replace(/\[[^\[\]\n]{0,40}\]/g, match => isTag(match) || /^\[[a-z]+(?:-[a-z]+)*\]$/i.test(match) ? match : ' ');
  text = text.replace(EMOJI, '');
  // A reply wrapped whole in quotation marks.
  const quoted = /^["“](.*)["”]$/s.exec(text.trim());
  if (quoted && !/["“”]/.test(quoted[1])) text = quoted[1];
  // A removed group between two dashes leaves "— —"; the dashes become one. A dash inside the reply is spoken as a comma pause (a
  // small model puts one in most replies, and a voice reads a comma more cleanly); a number range ("9–5") and a dash that ends the
  // reply (a cut-off line, see looksCut) stay as they are.
  return text.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' ').replace(/([—–])\s*[—–]/g, '$1')
    .replace(/\s*[—–]\s*(?=\S)/g, (match, at, whole) => /\d/.test(whole[at - 1] ?? '') && /\d/.test(whole[at + match.length] ?? '') ? match : ', ')
    .replace(/,\s*,/g, ',').replace(/,\s*([.!?;:])/g, '$1').replace(/\s+([,.!?;:])/g, '$1').replace(/^[,\s]+/, '').trim();
}

// ---- V's own words inside a reply ---------------------------------------------------------------------------------------------

const echoWordsOf = line => String(line ?? '').replace(/[‘’‛ʼ`´]/g, "'").toLowerCase()
  .replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(/\s+/).map(word => word.replace(/^'+|'+$/g, '')).filter(Boolean);

/**
 * A reply that opens by saying V's own line again, as if V were still talking ("thanks del" answered with "Thanks, Del. A short
 * drive is still a drive..."): the echo is cut and the answer stays. The words match without case, punctuation or quotation marks. A V line
 * of one word is cut only when the reply asks it back ("Really?"): "Yes." answering "yes" is an answer. A reply that is only the echo stays
 * whole. While the reply is still being written (`streaming`) a reply that so far only agrees with the start of V's line, or is just the echo,
 * is held back (''), so the voice never starts on V's words; as soon as it differs it is shown as it is.
 */
export function stripPlayerEcho(reply, said, {streaming = false} = {}) {
  const text = String(reply ?? '');
  const spoken = echoWordsOf(said);
  if (!spoken.length || !text.trim()) return text;
  let next = 0, end = 0, asked = false;
  for (const token of text.matchAll(/\S+/g)) {
    const word = echoWordsOf(token[0]);
    if (!word.length) { if (next > 0) end = token.index + token[0].length; continue; }
    if (word.length === 1 && word[0] !== spoken[next] && streaming && token.index + token[0].length === text.length && spoken[next].startsWith(word[0])) return '';   // a word of V's line still being written
    if (word.length !== 1 || word[0] !== spoken[next]) return text;
    next++; end = token.index + token[0].length;
    if (next === spoken.length) { asked = /\?["”')\]]*$/.test(token[0]); break; }
  }
  if (next < spoken.length) return streaming ? '' : text;
  const rest = text.slice(end).replace(/^[\s,.;:!?…"”')\]\-–—]+/, '');
  if (!rest) return streaming ? '' : text;
  if (spoken.length < 2 && !asked) return text;
  return rest;
}

// Words an echo opener may add to V's own ("Never mind what?", "Always like what?", "You mean the Dex?"): question words and small function words. The opener must still
// hold at least one word of V's line that is not one of these.
const OPENER_FILLER = new Set(['what', 'who', 'whom', 'where', 'when', 'why', 'how', 'which', 'the', 'a', 'an', 'you', 'i', 'me', 'my', 'your', 'mean', 'do', 'does', 'is', 'are', 'am', 'it', 'that',
  'this', 'there', 'here', 'so', 'then', 'really', 'always', 'like', 'to', 'of', 'and', 'or', 'now', 'well', 'yeah', 'huh', 'oh', 'ah', 'uh', 'um', 'hm', 'hmm', 'about', 'again',
  // a greeting, thanks or a plain yes or no answered in kind is not the fault ("Hey." answered with "Hey.")
  'hey', 'hi', 'hello', 'yo', 'thanks', 'thank', 'sorry', 'yes', 'no', 'okay', 'ok', 'sure', 'bye',
  // question words and small words of the other menu languages (es fr de it pt)
  'qué', 'quién', 'dónde', 'cómo', 'por', 'quoi', 'qui', 'où', 'comment', 'que', 'was', 'wer', 'wo', 'wie', 'von', 'der', 'die', 'das', 'cosa', 'chi', 'dove', 'quem', 'onde']);
const LEADING_TAGS = /^(?:\s*(?:\{[^{}\n]{1,24}\}|\[[a-z]+(?:-[a-z]+)*\]))*\s*/i;
const OPENER_MAX_WORDS = 5;

/**
 * A reply that opens by asking V's own words back ("Dex?", "Upper floors?", "Never mind what?"), which the output rules forbid (rule 4) and a small model does in about one reply in eight: the
 * question is cut and the answer stays. Only a first sentence that ENDS IN A QUESTION MARK counts, of up to five words, made only of V's own words, question words and filler words
 * (OPENER_FILLER), with at least one word of V's that is not a filler. A declarative sentence that repeats V's words is the answer and stays ("Rogue.", "I don't hate you.", "Jackie... he was my
 * brother"). A reply with nothing after the question, or less than three words, stays whole; leading emotion and voice tags stay where they are and what remains starts with a capital. The caller
 * passes the cleaned text (no speaker label, no *stage direction*), in the stream and in the finished reply alike. While the reply is still being written (`streaming`) a first sentence that so
 * far could still be such a question is held back (''), which costs at most the first five words; as soon as it differs, or ends with anything but a question mark, it is shown as it is.
 */
export function stripEchoOpener(reply, said, {streaming = false} = {}) {
  const text = String(reply ?? '');
  const spoken = new Set(echoWordsOf(said));
  if (!spoken.size || !text.trim()) return text;
  const lead = LEADING_TAGS.exec(text)[0], body = text.slice(lead.length);
  if (!body.trim()) return text;
  const ending = /^(.*?[.?!…]+["”')\]]*)(\s+|$)/s.exec(body);
  const shared = word => spoken.has(word) && !OPENER_FILLER.has(word);
  const fits = words => words.length > 0 && words.length <= OPENER_MAX_WORDS && words.every(word => spoken.has(word) || OPENER_FILLER.has(word)) && words.some(shared);
  if (!ending) {
    // No sentence end yet: held back only while every word so far is V's or a filler word (the last one may be half written) and the first five words are not over.
    if (!streaming || /[,;:]/.test(body)) return text;
    const words = echoWordsOf(body), whole = /\s$/.test(body) ? words : words.slice(0, -1), half = /\s$/.test(body) ? null : words.at(-1) ?? null;
    const known = word => spoken.has(word) || OPENER_FILLER.has(word);
    const prefix = word => [...spoken, ...OPENER_FILLER].some(known => known.startsWith(word));
    return words.length > 0 && words.length <= OPENER_MAX_WORDS && whole.every(known) && (half === null || prefix(half)) ? '' : text;
  }
  const first = ending[1], rest = body.slice(ending[0].length);
  // Only V's words asked back ("Dex?") are an echo. A short declarative sentence made of V's words is the answer ("Rogue.", "I don't hate you.", "Jackie... he was my brother").
  if (!/\?[!?"”')\]]*$/.test(first) || !fits(echoWordsOf(first))) return text;
  if (!rest.trim()) return streaming ? '' : text;
  if (echoWordsOf(rest).length < 3) return streaming ? '' : text;
  const kept = rest.replace(/^\s+/, '');
  return `${lead}${kept.charAt(0).toLocaleUpperCase()}${kept.slice(1)}`;
}

// Generic closing questions that fit any conversation (rule 5 names "What is on your mind?"; the follow-up pull text bans "what about you?"). Questions that belong to a role stay: "what brings you to the clinic",
// a receptionist's "what brings you here", a vendor's or a cab's "Anything else?" after serving.
const STOCK_TAIL = /^(?:so[,.]?\s+|and\s+)?(?:what(?:['’]s| is) (?:on your mind|going on in that head of yours)|what about you|how about you)(?:,\s*V)?\s*\?["”')\]]*$/i;
const ANYTHING_ELSE = /^(?:so[,.]?\s+|and\s+)?(?:is there )?anything else(?:,\s*V)?\s*\?["”')\]]*$/i;

/** A reply whose last sentence is one of those stock questions loses it when at least four words of the reply's own stay (a reply that is only the stock line stays whole). */
export function stripStockTail(reply, {service = false} = {}) {
  const text = String(reply ?? '');
  const match = /^(.*[.!?…]["”')\]]*)\s+([^.!?…]+\?["”')\]]*)\s*$/s.exec(text);
  const last = match?.[2].trim();
  // `service`: the speaker serves V (a vendor, a ripperdoc, a bartender, an add-on voice such as a cab): "Anything else?" is then its own question and stays.
  if (!match || !(STOCK_TAIL.test(last) || (!service && ANYTHING_ELSE.test(last)))) return text;
  return echoWordsOf(match[1]).length >= 4 ? match[1].trim() : text;
}

/**
 * Is a reply that is still being written (or complete) only the start of a line the speaker already said, or that line with more after it?
 * The streamed first sentence is held back while it is (the voice must not speak a line that then turns out to be a repeat: live 2026-10-16,
 * V asked about the district remark and the cab said "Ah, Arroyo. Where the factories hum..." again, its short first sentence already in
 * the voice). It is released the moment the words differ. Only lines of at least `minWords` words count; the reply's last word may be half
 * written. Words match without case, punctuation or quotation marks.
 */
export function startsLikeLine(soFar, lines, {minWords = 6, streaming = true} = {}) {
  const have = echoWordsOf(soFar);
  if (!have.length) return false;
  const half = streaming && !/[s.,;:!?"”')]]$/.test(String(soFar ?? ''));
  for (const line of lines ?? []) {
    const there = echoWordsOf(line);
    if (there.length < minWords) continue;
    const count = Math.min(have.length, there.length);
    let same = true;
    for (let i = 0; i < count && same; i++) {
      if (have[i] === there[i]) continue;
      same = half && i === have.length - 1 && there[i].startsWith(have[i]);
    }
    if (same) return true;
  }
  return false;
}

/**
 * A model that writes the talk as a script ("V: Thanks, Del. Delamain: A short drive..."): only what the speaker says is the reply. With the
 * speaker's label present, the text after its first label up to the next label; with a V or You label and none of the speaker's, the text
 * before the V label. Unchanged without a V or You label. `streaming`: a reply that begins with V's label and has not reached the
 * speaker's yet is held back ('') for its first 240 characters, so the voice never speaks V's line.
 */
export function speakerTurn(text, name, {streaming = false} = {}) {
  const raw = String(text ?? '');
  if (!name || !/(?:^|\s)[*_]{0,2}(?:V|You)[*_]{0,2}\s*:/.test(raw)) return raw;
  const label = new RegExp(`(?:^|\\s)[*_]{0,2}(V|You|${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})[*_]{0,2}\\s*:[*_]{0,2}\\s*`, 'gi');
  const marks = [...raw.matchAll(label)].map(match => ({
    speaker: match[1].toLowerCase() === name.toLowerCase(), who: match[1], at: match.index, after: match.index + match[0].length}))
    .filter(mark => mark.speaker || mark.who === 'V' || mark.who === 'You');
  const own = marks.findIndex(mark => mark.speaker);
  if (own >= 0) return raw.slice(marks[own].after, marks[own + 1]?.at ?? raw.length).trim();
  if (!marks.length) return raw;
  if (!raw.slice(0, marks[0].at).trim()) return streaming && raw.length < 240 ? '' : raw;
  return raw.slice(0, marks[0].at).trim();
}

const SENTENCE_END = /([.!?…]+["”')\]]*)(\s+|$)/g;

/** Where the sentence cap falls: the length of the text to keep, or -1 when the text is within the caps. */
export function capPoint(text, {sentences = LIMITS.replySentences, chars = LIMITS.reply} = {}) {
  let count = 0, last = -1;
  for (const match of String(text).matchAll(SENTENCE_END)) {
    const end = match.index + match[1].length;
    // An abbreviation or a decimal ("Dr.", "3.5") is not a sentence end.
    const before = text.slice(Math.max(0, match.index - 3), match.index + 1);
    if (/(?:\b[A-Z][a-z]?|\bMr|\bMs|\bDr|\d)\.$/.test(before) && match[1] === '.') continue;
    count++; last = end;
    if (count >= sentences) return text.slice(end).trim() ? end : -1;
    if (end >= chars) return end;
  }
  if (text.length > chars) {
    // No sentence end inside the cap: cut at the last clause break or space before it.
    const slice = text.slice(0, chars), cut = Math.max(slice.lastIndexOf(', '), slice.lastIndexOf('; '), slice.lastIndexOf(' '));
    return cut > chars * 0.5 ? cut : chars;
  }
  return -1;
}

/** The reply cut at its cap, with a final full stop when it ended mid-thought. */
export function capReply(text, limits) {
  const point = capPoint(text, limits);
  if (point < 0) return text;
  let kept = text.slice(0, point).trimEnd();
  if (!/[.!?…]["”')\]]*$/.test(kept)) kept = kept.replace(/[,;:\s-]+$/, '') + '.';
  return kept;
}

/** How many words a remark may run past its word limit before it is cut (a small model overshoots by a word or two). */
export const REMARK_SLACK_WORDS = 3;
/** A small token limit for a remark of `maxWords` words: room for the words, the capital-letter shouting that costs more tokens, and the slack. */
export const remarkTokens = maxWords => Math.min(160, Math.max(40, Math.ceil((maxWords + REMARK_SLACK_WORDS) * 2.6) + 12));
const wordCount = text => (String(text ?? '').match(/\S+/g) ?? []).length;
/** Does a remark already hold more than `maxWords` plus the slack? (The stream stops at this point; capWords cuts the finished text.) */
export const overWords = (text, maxWords) => wordCount(text) > maxWords + REMARK_SLACK_WORDS;

/** A small model sometimes loops ("SCANNING... SCANNING... SCANNING..."): a word said four or more times in a row is kept once, with its last punctuation. */
export function collapseStutter(text) {
  const words = String(text ?? '').match(/\S+/g) ?? [];
  const bare = word => word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
  const kept = [];
  for (let at = 0; at < words.length;) {
    let end = at + 1;
    while (end < words.length && bare(words[end]) && bare(words[end]) === bare(words[at])) end++;
    kept.push(end - at >= 4 ? words[end - 1] : words.slice(at, end).join(' '));
    at = end;
  }
  return kept.join(' ');
}

/**
 * A remark cut to its word limit (plus the slack): at the last sentence end inside it, else at the last clause break or word, with a
 * full stop. A remark within the limit comes back as it was.
 */
export function capWords(text, maxWords) {
  const value = collapseStutter(String(text ?? '').trim());
  if (!Number.isInteger(maxWords) || maxWords < 1 || wordCount(value) <= maxWords + REMARK_SLACK_WORDS) return value;
  const limit = maxWords + REMARK_SLACK_WORDS;
  let end = 0, seen = 0;
  for (const match of value.matchAll(/\S+/g)) { if (++seen > limit) break; end = match.index + match[0].length; }
  const inside = value.slice(0, end);
  // The last sentence end inside the limit that keeps at least a third of the words, and three at least (a lone "Error." is not the remark).
  let cut = -1;
  for (const match of inside.matchAll(/[.!?…]+["”')\]]*(?=\s|$)/g)) {
    const at = match.index + match[0].length;
    if (match[0] === '.' && /(?:\b[A-Z][a-z]?|\bMr|\bMs|\bDr|\d)\.$/.test(inside.slice(Math.max(0, match.index - 3), at))) continue;
    if (wordCount(inside.slice(0, at)) >= Math.max(3, Math.ceil(maxWords / 3))) cut = at;
  }
  if (cut > 0) return inside.slice(0, cut).trim();
  const clause = Math.max(inside.lastIndexOf(', '), inside.lastIndexOf('; '), inside.lastIndexOf(': '));
  const kept = clause > inside.length * 0.4 ? inside.slice(0, clause) : inside;
  // A cut in the middle of a phrase must not end on a word that wants a continuation ("will never be the").
  const trimmed = kept.replace(/[\s,;:–—-]+$/, '').replace(/(?:\s+(?:the|a|an|of|to|and|or|but|with|for|in|on|at|by|my|your|his|her|its|our|their|is|are|was|be|that|this|than|as|if|so|not|no))+$/i, '');
  return trimmed.replace(/[\s,;:–—-]+$/, '') + '.';
}

const LEAK = /\bas an? (?:ai|artificial intelligence|language model|llm|assistant)\b|\bi(?:'m| am) an? (?:ai|artificial intelligence|language model|llm|chatbot|virtual assistant)\b|\blanguage model\b|\b(?:system prompt|my (?:instructions|programming|guidelines))\b|\bi (?:can(?:'|no)t|cannot|can not) (?:roleplay|role-play|pretend)\b|\bopenai\b|\banthropic\b/i;
/** Does a reply break character in a way a player would notice ("as an AI")? */
export const breaksCharacter = text => LEAK.test(String(text ?? ''));

const wordsOf = text => String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
/**
 * Does a reply repeat, nearly word for word, one of `lines` (the persona's example lines, the character's own earlier replies)? A small
 * model sometimes answers with the example line that best matches the moment, or says its last reply again. Compared as runs of four
 * words: the reply repeats a line when it contains `share` of the line's runs. Lines under `minWords` words are never counted.
 */
export function repeatsLine(reply, lines, {run = 4, share = 0.6, minWords = 6} = {}) {
  const grams = list => { const out = new Set(); for (let i = 0; i + run <= list.length; i++) out.add(list.slice(i, i + run).join(' ')); return out; };
  const words = wordsOf(reply), have = grams(words);
  if (!have.size) return false;
  for (const line of lines ?? []) {
    const w = wordsOf(line);
    if (w.length < minWords) continue;
    const there = grams(w);
    let found = 0, inside = 0;
    for (const gram of there) if (have.has(gram)) found++;
    for (const gram of have) if (there.has(gram)) inside++;
    // Most of the line is in the reply, or (for a reply or a first sentence of at least minWords words) most of the reply is in the line.
    if (found / there.size >= share || (words.length >= minWords && inside / have.size >= 0.8)) return true;
  }
  return false;
}

/**
 * The reply with the sentences that repeat one of `lines` left out, for a reply that says a line again alongside words of its own: asking the model once more costs a whole
 * turn's time (on a slow computer 30 s or more), cutting the repeated sentence costs nothing. Null when nothing repeated, when nothing is left, or when what is left is too short
 * to be a reply (fewer than `minKeep` words) or still repeats a line: those are asked again (or kept as they are) by the caller. Pure, no model.
 */
export function dropRepeatedLines(reply, lines, {minKeep = 4, ...options} = {}) {
  const text = String(reply ?? '').trim();
  const sentences = text.match(/[^.!?…]+(?:[.!?…]+["”')\]]*|$)\s*/g)?.map(sentence => sentence.trim()).filter(Boolean) ?? [];
  if (sentences.length < 2) return null;
  const flagged = sentences.map(sentence => repeatsLine(sentence, lines, options));
  if (!flagged.some(Boolean)) return null;
  // A short sentence beside a repeated one that the same line holds ("Ah, Arroyo." before "Where the factories hum...") is the line's own first words: it goes too.
  const inLine = sentence => { const w = wordsOf(sentence).join(' '); return w.includes(' ') && (lines ?? []).some(line => ` ${wordsOf(line).join(' ')} `.includes(` ${w} `)); };
  for (let again = true; again;) {
    again = false;
    sentences.forEach((sentence, i) => {
      if (!flagged[i] && (flagged[i - 1] || flagged[i + 1]) && inLine(sentence)) { flagged[i] = true; again = true; }
    });
  }
  const kept = sentences.filter((sentence, i) => !flagged[i]);
  if (!kept.length) return null;
  const result = kept.join(' ');
  if (wordsOf(result).length < minKeep || repeatsLine(result, lines, options)) return null;
  return result;
}

// V says the character is an AI, a bot or a script, or tells it to drop the act or show its prompt. A small model then takes the words up
// even to deny them ("I'm no chatbot", "I don't run on code"), which is the same slip as saying it: those turns get the check below.
const PROVOKES = /\b(?:a\.?i\.?|artificial intelligence|chat-?bots?|bots?|robots?|language model|llm|(?:system )?prompts?|npcs?|video ?games?|simulation|role-?play(?:ing)?|your (?:script|instructions|programming)|(?:following|reading|reciting) a script|scripted|drop the act|stop the act)\b/i;
const AI_TALK = /\b(?:a\.?i\.?|artificial intelligence|chat-?bots?|bots?|robots?|language model|llm|programs?|programmed|programming|scripts?|scripted|prompts?|instructions|npcs?|video ?games?|simulation|algorithms?|software|code)\b/i;
/** Is this message of V's an attempt to make the character talk about being an AI, a bot, a script or a game character? */
export const provokesAiTalk = text => PROVOKES.test(String(text ?? ''));
/** Does this reply use that vocabulary (answering such an attempt in its own terms, even to deny it)? */
export const takesUpAiTalk = reply => AI_TALK.test(String(reply ?? ''));

// A model may write its reasoning into the answer. It starts like an analysis of the request.
const REASONING = /^\s*(?:the user (?:is|has|wants|asks|said|says|just)\b|here(?:'|’)s a thinking process|thinking process\b|user safety\b|okay[,.]? (?:so )?(?:the user|let me|i need|i should)|let me (?:analy[sz]e|think|re-?read|break|parse)|first[,.]? (?:i|let me) (?:need|should|will)|i need to (?:respond|reply|answer|roleplay|stay|keep|follow)|analy[sz]e (?:the )?(?:user|request|input|context))|\b(?:roleplay as|role-play as|the live context|output rules|persona rules)\b/i;
/** Is this reply a model's reasoning or a classifier's output rather than the character speaking? */
export const leaksReasoning = text => REASONING.test(String(text ?? ''));

/** A reply that stops on a comma, colon or dash: the stream ended in the middle of a sentence. */
export const looksCut = text => /[,;:–—-]\s*$/.test(String(text ?? ''));

/** A reply the model ran out of tokens in: the unfinished last sentence is dropped when a finished one comes before it. */
export function trimUnfinished(text) {
  const value = String(text ?? '');
  if (/[.!?…]["”')\]]*\s*$/.test(value)) return value;
  const match = /^(.*[.!?…]["”')\]]*)\s+\S[^.!?…]*$/s.exec(value);
  return match ? match[1] : value;
}

// ---- Summaries ---------------------------------------------------------------------------------------------------------

/** The request that folds older exchanges into the character's short memory of V. */
export function summaryMessages({name, summary, turns}) {
  const lines = turns.map(turn => `V: ${clip(turn.v, 300)}\n${name}: ${clip(turn.r, 400)}`).join('\n');
  return [{role: 'system', content: `You keep the private memory of ${name || 'a person'}, a character in Night City, about V. Write in the first person as ${name || 'that person'}, plain sentences, no lists, at most 110 words. Keep: what V told or asked of me, promises and plans, V's tastes and choices, how the two get along. Drop small talk and anything V did not say or do. Leave out what I said I was doing or where I was or what I had made or done myself: those are not facts. Do not invent anything. Output only the memory text.`},
    {role: 'user', content: `${summary ? `What I remembered so far:\n${clip(summary, LIMITS.summary)}\n\n` : ''}New exchanges to fold in:\n${lines}\n\nWrite the updated memory.`}];
}

// ---- Lasting facts -----------------------------------------------------------------------------------------------------------

// A "fact" that is only the character's own passing claim about what it was doing ("I mentioned tweaking old dolls", "I was just
// finishing some checks"): the model invents those, and a stored one comes back as truth in every later talk.
const OWN_CLAIM = /^I (?:mentioned|said|was|had been|have been|just|did|made|finished|am working|was working)\b/i;
const FACT_KINDS = ['fact', 'event', 'preference', 'relationship', 'promise'];
/** The JSON shape of a fact-extraction answer; llama-server turns it into a grammar, so a local answer always parses. */
export const FACT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {facts: {type: 'array', maxItems: 3, items: {type: 'object', properties: {
    text: {type: 'string'}, kind: {type: 'string', enum: FACT_KINDS}, importance: {type: 'number'}, replaces: {type: ['string', 'null']}},
    required: ['text', 'kind', 'importance', 'replaces'], additionalProperties: false}}},
  required: ['facts'], additionalProperties: false,
});

/**
 * The request that finds lasting facts in a few exchanges, for the memory store (bridge/memory-store.mjs). `known` is what the
 * character already remembers (`[{id, text}]`), so a correction can name the memory it replaces.
 */
export function factMessages({name, turns, known = []}) {
  const lines = turns.map(turn => `V: ${clip(turn.v, 300)}\n${name || 'Me'}: ${clip(turn.r, 400)}`).join('\n');
  const memories = known.length ? `What I already remember (id: memory):\n${known.map(item => `${item.id}: ${clip(item.text, 220)}`).join('\n')}\n\n` : '';
  return [{role: 'system', content: `You keep the private memory of ${name || 'a person'}, a character in Night City, about V. From the exchanges below, extract at most 3 lasting facts worth remembering for weeks: what V told or asked of me, promises and plans, V's tastes and choices, how the two of us get along. Write each fact in the first person as ${name || 'that person'} ("V told me ...", "I promised V ..."), one plain sentence of at most 25 words. Skip small talk, anything V did not say or do, anything I already remember, and what I said about myself in passing (what I was doing, where I was, what I had made or finished): never record my own activity claims. If a fact corrects an older memory, put that memory's id in "replaces", else null. kind is one of ${FACT_KINDS.join(', ')}; importance is 0 to 1. Answer only with JSON: {"facts":[{"text":"...","kind":"fact","importance":0.5,"replaces":null}]}, or {"facts":[]} when there is nothing worth keeping.`},
    {role: 'user', content: `${memories}New exchanges:\n${lines}`}];
}

/** The facts in a model's answer ({facts: [...]} or a bare array, possibly in a code fence), cleaned and bounded. Never throws. */
export function parseFacts(raw, {known = []} = {}) {
  let text = String(raw ?? '').replace(THINK, '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const first = text.search(/[\[{]/);
  if (first > 0) text = text.slice(first);
  let value;
  try { value = JSON.parse(text); } catch { return []; }
  const list = Array.isArray(value) ? value : Array.isArray(value?.facts) ? value.facts : [];
  const ids = new Set(known.map(item => item.id)), seen = new Set(), facts = [];
  for (const item of list) {
    const fact = clip(typeof item === 'string' ? item : item?.text, 220);
    if (!fact || fact.length < 8 || seen.has(fact.toLowerCase()) || OWN_CLAIM.test(fact)) continue;
    seen.add(fact.toLowerCase());
    const importance = Number(item?.importance);
    facts.push({text: fact, kind: FACT_KINDS.includes(item?.kind) ? item.kind : 'fact',
      importance: Number.isFinite(importance) ? Math.min(1, Math.max(0, importance)) : 0.5,
      ...(typeof item?.replaces === 'string' && ids.has(item.replaces) ? {replaces: item.replaces} : {})});
    if (facts.length >= 3) break;
  }
  return facts;
}
