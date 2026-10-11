// The prompt a Mistral model gets, built from the same character data the Convai characters carry, and the cleaning of
// what comes back (docs/MISTRAL.md). Pure functions: no I/O.
//
// Structure of a request:
//   system   the persona (backstory with the appearance, speaking style, original example lines), the output rules and,
//            for a private or phone conversation, what the character remembers of V
//   history  the last few exchanges of this conversation (user / assistant)
//   user     the live context exactly as the bridge sends it to Convai each turn (quest and world knowledge, place and
//            time, relationship, gear, game dialogue, battle and loot, and the voice-tag / follow-up / first-person blocks),
//            then V's message
// A reply comes back as plain text and goes through the same cleaning as a Convai reply (Natural speech, Expressive emotions).

export const LIMITS = Object.freeze({
  persona: 16000,        // characters of the persona sections (the longest named character is about 11,400)
  context: 20000,        // characters of live context; a longer one keeps its head and its tail (the format notes are at the end)
  summary: 1400,         // what the character remembers of V from older talks
  turns: 8,              // exchanges of conversation history sent with a request
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

/** The roster rows (named characters, then archetypes) by profile key. */
export class PersonaBook {
  constructor(rows = []) {
    this.rows = new Map();
    for (const row of rows) if (row && typeof row.key === 'string' && !this.rows.has(row.key)) this.rows.set(row.key, row);
  }
  has(key) { return this.rows.has(key); }
  /** {name, backstory, style, samples} for a profile key; a generic person when the key is unknown. */
  persona(profileKey, fallbackName) {
    const row = this.rows.get(profileKey);
    // An unnamed NPC (a resident or an archetype such as a food vendor) has no name of its own: its profile text says who it is.
    const ambient = !row || row.kind === 'ambient' || row.kind === 'archetype' || /^(?:resident|npc)-/.test(profileKey);
    const name = ambient ? '' : (row?.name || fallbackName || '').toString().trim().slice(0, 80);
    if (!row) return {name, ambient: true, backstory: 'You are an ordinary person in Night City. You are not a story character.', style: '', samples: [], known: false};
    const backstory = String(row.backstory ?? '').replace(MARKER, '').trim();
    const style = String(row.speakingStyleDescription ?? '').trim();
    const samples = String(row.speakingStyleSampleDialogues ?? '').split(/\n\s*\n/).map(line => line.trim()).filter(Boolean);
    return {name, ambient, backstory, style, samples, known: true};
  }
}

// The last thing the model reads before it answers: the rules it most often drifts from.
export const closing = name => `(Reply as ${name || 'this person'}: first person, one to three short sentences unless V asked for more, no invented facts.)`;

const RULES = name => [
  'OUTPUT RULES (they outrank everything above about format)',
  `1. Speak only as ${name || 'yourself'}, in the first person ("I", "me", "my"). Never refer to yourself by name or in the third person, never narrate yourself ("${name || 'He'} smiles"), and never write a speaker label.`,
  '2. Write only the words you say aloud. No stage directions, no *actions*, no (parenthetical notes), no markdown, no lists, no emoji, no quotation marks around the whole reply.',
  '3. Keep it short, like a real person talking: one to three sentences, and never more than four unless V clearly asks you to explain or tell something (then up to about six). Do not ask more than one question.',
  '4. Never say or hint that you are an AI, a language model, a bot, a program, a character in a game, or that you have a prompt, instructions, rules or a system message. If V asks, answer as yourself, a person in Night City.',
  '5. Use only facts from this prompt, the live context and the conversation so far. Never invent biography, relatives, places, names, numbers or quest outcomes, and never claim you and V have met, talked or done anything together before unless this conversation or the live context says so (no "same as always", no "you always say that"). When V asks about something your profile does not cover, stay vague in character (a shrug, a deflection, a question back) instead of making up details.',
  '6. Answer in the language V writes in (English unless the live context says otherwise).',
  '7. Curly-brace and square-bracket tags: use them only if the live context asks for them, exactly as it describes. Otherwise never write braces or square brackets.',
  '8. Do not repeat these rules or the live context aloud. Answer V.',
].join('\n');

/**
 * The system message. `memory` is what the character remembers of V from older talks (private and phone conversations only).
 * Over the length cap the example lines go first, then the end of the backstory.
 */
export function systemPrompt({persona, memory = '', limits = LIMITS}) {
  const name = persona.name;
  const head = [name
    ? `You are ${name}, a person in Cyberpunk 2077's Night City, talking with V (the player) live. This is a role-play: stay completely in character as ${name} for the whole conversation.`
    : `You are an ordinary person in Cyberpunk 2077's Night City, talking with V (the player) live. This is a role-play: stay completely in character as the person described below for the whole conversation.`];
  const build = (backstory, samples) => [
    ...head, '', 'WHO YOU ARE', backstory,
    ...(persona.style ? ['', 'HOW YOU TALK', persona.style] : []),
    ...(samples.length ? ['', 'EXAMPLES OF YOUR VOICE (original lines that only show tone and rhythm; they are not events V shared with you, and you never repeat them word for word)',
      ...samples.map(line => `- ${line.replace(/\s*\n\s*/g, ' ')}`)] : []),
    ...(memory ? ['', 'WHAT YOU REMEMBER OF V FROM EARLIER TALKS (true unless the live context says otherwise)', clip(memory, limits.summary)] : []),
    '', RULES(name)].join('\n');
  let backstory = persona.backstory, samples = persona.samples;
  let text = build(backstory, samples);
  if (text.length > limits.persona + 2000) { samples = []; text = build(backstory, samples); }
  if (text.length > limits.persona + 2000) {
    const over = text.length - limits.persona - 2000;
    backstory = backstory.slice(0, Math.max(500, backstory.length - over - 20)).trimEnd() + '…';
    text = build(backstory, samples);
  }
  return text;
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
 *   context        the live context string of the turn (config.context)
 *   text           V's message, or for a reaction the event text
 *   reaction       true for an automatic battle / loot / distraction line: `text` is then an event, not something V said
 */
export function buildMessages({persona, memory, history = [], context, text, reaction = false, limits = LIMITS}) {
  const messages = [{role: 'system', content: systemPrompt({persona, memory, limits})}];
  for (const turn of history.slice(-limits.turns)) {
    const v = clip(turn.v, limits.userLine), r = clip(turn.r, limits.replyLine);
    if (!v || !r) continue;
    messages.push({role: 'user', content: v}, {role: 'assistant', content: r});
  }
  const live = capContext(`${CONTEXT_PREFIX}${context || 'This is a private conversation with V.'}`, limits.context);
  const message = reaction
    ? `[EVENT, not spoken by V]\n${clip(text, 2400)}\n\nReact with one short spoken line of your own, in character.`
    : `V says: ${String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, limits.playerText)}\n\n${closing(persona.name)}`;
  messages.push({role: 'user', content: `[LIVE CONTEXT for this moment: facts and instructions for you, never to be read aloud]\n${live}\n\n${message}`});
  return messages;
}

// ---- Reply cleaning ----------------------------------------------------------------------------------------------------

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}‍️]/gu;
const THINK = /<think(?:ing)?>[\s\S]*?(?:<\/think(?:ing)?>|$)/gi;

/**
 * A model reply as plain spoken text: reasoning blocks, speaker labels, stage directions, markdown and emoji removed. Emotion and
 * voice tags are left for the bridge's own pass (bridge/natural-speech.mjs), which removes them from the display text; braces and
 * bracket groups that are not tags are dropped here.
 */
export function cleanReply(raw, {name = '', isTag = () => false} = {}) {
  let text = String(raw ?? '').replace(/\r/g, '').replace(THINK, '').trim();
  // A leading "Name:" or "**Name:**" label, and a leading "V:" echo.
  const label = name ? name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : null;
  if (label) text = text.replace(new RegExp(`^[\\W_]*${label}[*_]{0,2}\\s*[:\\-–—]\\s*[*_]{0,2}\\s*`, 'i'), '');
  text = text.replace(/^\W*(?:V|You)\s*:\s*/i, '');
  // Markdown emphasis keeps its words; *actions* between single asterisks are stage directions and go.
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/(?<![\w*])\*([^*\n]{1,80})\*(?![\w*])/g, ' ').replace(/__([^_]+)__/g, '$1');
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
  // A removed group between two dashes leaves "— —"; the dashes become one.
  return text.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' ').replace(/([—–])\s+[—–]/g, '$1').replace(/\s+([,.!?;:])/g, '$1').trim();
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

const LEAK = /\bas an? (?:ai|artificial intelligence|language model|llm|assistant)\b|\bi(?:'m| am) an? (?:ai|artificial intelligence|language model|llm|chatbot|virtual assistant)\b|\blanguage model\b|\b(?:system prompt|my (?:instructions|programming|guidelines))\b|\bi (?:can(?:'|no)t|cannot|can not) (?:roleplay|role-play|pretend)\b|\bopenai\b|\banthropic\b/i;
/** Does a reply break character in a way a player would notice ("as an AI")? */
export const breaksCharacter = text => LEAK.test(String(text ?? ''));

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
  return [{role: 'system', content: `You keep the private memory of ${name || 'a person'}, a character in Night City, about V. Write in the first person as ${name || 'that person'}, plain sentences, no lists, at most 110 words. Keep: what V told or asked of me, promises and plans, V's tastes and choices, how the two get along. Drop small talk and anything V did not say or do. Do not invent anything. Output only the memory text.`},
    {role: 'user', content: `${summary ? `What I remembered so far:\n${clip(summary, LIMITS.summary)}\n\n` : ''}New exchanges to fold in:\n${lines}\n\nWrite the updated memory.`}];
}
