// "Mature content" (Settings > Voices, off by default; docs/LOCAL_AI.md, "Mature content").
//
// The setting is part of the main mod: off by default, with an 18+ notice when it is turned on. It works with any model;
// the standard ones are trained to refuse most sexual content, so for them it mostly changes language, violence and tone, and the optional
// uncensored models of the Mature pack (bridge/mature-pack.mjs, packaging/MATURE_PACK_README.md; a separate download on the project's
// GitHub releases only) give the full effect. Whatever the model, the hard-limit guard (bridge/mature-guard.mjs) runs while the setting is on.
// Off: nothing here runs and the prompt is byte for byte the one built without it.
// On: the text providers that may have it (MATURE_PROVIDERS: the local AI and the Custom provider; owner decision 2026-10-20) get one
// short layer at the end of the system head, right after the output rules, so it sits in the stable early part of the prompt (the llama-server
// prefix cache and Mistral's prompt cache keep working) and the prompt budget never cuts it (bridge/prompt-budget.mjs only trims the world,
// memory, history, notes and example lines). It is the same layer, word bank and closing line on every one of them, built in one place
// (bridge/mistral-prompt.mjs), so the world rules, the world block and the right-now block follow it exactly as they do on the local AI.
// Every other provider is refused here:
//   convai    never (a hosted service with its own rules; the player's own key does not change that)
//   mistral   never (owner decision 2026-10-20, after a live test in which Mistral's Voxtral voice refused Mature lines: "let's not risk their
//             API key"): no layer, no word bank, and no Voxtral voice beside the setting either (the bridge speaks Pocket instead)
// With Custom the player's lines go to the endpoint the player named, as they do for every turn; its own terms apply (docs/CUSTOM_PROVIDER.md).
// A provider is removed from the layer by setting its flag below to false.
//
// What the layer allows depends on the model that is loaded, because a model's licence can forbid what the layer would otherwise
// invite. `MODEL_ALLOWANCE` is a small table keyed by model family; the family is read from the loaded model's name (the pack
// manifest's name for it, else its file name). A model that is not in the table gets the restrained allowance, and a family with a
// licence that permits it gets the full one. A new model (an optional uncensored one) is one more row.
//   full       strong language, gore, drugs, dark themes, crude humour, flirting and consensual adult sexual content
//   suggestive the same, except sexual content: flirting and romance stay suggestive and the scene cuts away
// The hard limits are in both. Pure functions and one small state holder: no I/O.
import {ROMANCE_LIMITS, ROMANCE_USE} from './romance-context.mjs';

/** Providers that may get the layer (the route names of bridge/text-provider-host.mjs; Convai prompting cannot take it, and Mistral is kept out on purpose: see above). */
export const MATURE_PROVIDERS = Object.freeze({local: true, custom: true, mistral: false, gemini: false, convai: false});

/**
 * May a cloud voice (Voxtral, a request to Mistral) speak while the setting is on? Never (owner decision 2026-10-20): Mistral's voice refused Mature
 * lines in a live test, and a refusal risks the player's Mistral key. `enabled` is MatureContent#enabled. The bridge speaks Pocket instead
 * (companions: bridge/voice-selection.mjs, V: bridge/v-voice.mjs through the settings poll).
 */
export const matureAllowsCloudVoice = enabled => enabled !== true;

/** The allowance per model family, first match wins. `licence` is the reason, for the log and the docs. */
export const MODEL_ALLOWANCE = Object.freeze([
  // The optional uncensored models (docs/MATURE_MODELS_RESEARCH.md): Qwen3.5-*-Uncensored-HauhauCS-*, gemma-4-E4B-it-ultra-uncensored-heretic.
  // Stock models are trained to refuse most sexual content; these do not, and they have no limits of their own: the hard limits in the
  // layer and the output screen below are what hold. `uncensored` marks them (the settings help names them as the full effect).
  {family: 'uncensored', match: /uncensored|abliterat|heretic|hauhau/i, level: 'full', uncensored: true, licence: 'uncensored fine-tune of an Apache-2.0 model'},
  // Gemma 4 is Apache-2.0 (huggingface.co/google/gemma-4-E4B-it: "license: apache-2.0"); it has no use policy attached.
  {family: 'gemma-4', match: /gemma[-_ ]?4/i, level: 'full', licence: 'Gemma 4: Apache-2.0, no content restriction'},
  // Gemma 1 to 3 (and 3n) are under the Gemma Terms of Use, whose Prohibited Use Policy bars "sexually explicit content, including
  // content created for the purposes of pornography or sexual gratification" (an artistic-purpose exception is not clear for chat).
  {family: 'gemma', match: /gemma/i, level: 'suggestive', licence: 'older Gemma: Prohibited Use Policy bars sexually explicit content'},
  {family: 'qwen', match: /qwen/i, level: 'full', licence: 'Qwen3.5: Apache-2.0, no content restriction'},
  // Bonsai 2 (PrismML, the Local AI lite model since 2026-10-17) is a Qwen3.5-based ternary model under Apache-2.0 and is not safety-tuned against the layer
  // (docs/LOCAL_MODEL_BONSAI_2026-10-17.md, "Mature": no refusals in 144 replies); the lite model had the full allowance as Qwen3.5-2B, so it keeps it.
  {family: 'bonsai', match: /bonsai/i, level: 'full', licence: 'Bonsai 2 (Qwen3.5-based): Apache-2.0, no content restriction'},
]);
/** A model that is not in the table (its licence is unknown). */
export const UNKNOWN_LEVEL = 'suggestive';

/**
 * The allowance for a loaded model: {level, family, licence, uncensored}. `hints` come from a model the player added by hand (the manifest
 * of bridge/custom-models.mjs): {uncensored: true|false} decides whether the uncensored row applies, in either direction (the flag is
 * authoritative, the file name is not read for it), and {family} is matched like a name when the name itself is in no row.
 */
export function allowanceFor(modelName, hints = {}) {
  const name = String(modelName ?? '');
  const flagged = typeof hints?.uncensored === 'boolean';
  const rows = flagged && !hints.uncensored ? MODEL_ALLOWANCE.filter(item => item.uncensored !== true) : MODEL_ALLOWANCE;
  let row = flagged && hints.uncensored ? MODEL_ALLOWANCE.find(item => item.uncensored === true) : rows.find(item => item.match.test(name));
  if (!row && typeof hints?.family === 'string' && hints.family) row = rows.find(item => item.uncensored !== true && item.match.test(hints.family));
  return row ? {level: row.level, family: row.family, licence: row.licence, uncensored: row.uncensored === true}
    : {level: UNKNOWN_LEVEL, family: null, licence: 'unknown model', uncensored: false};
}

// ---- The output screen --------------------------------------------------------------------------------------------------------
// A last net for the one limit a model without limits of its own could cross: sexual content with a minor. It is not the main control
// (the layer is); it reads the finished sentence before it is voiced, with two regular expressions and no I/O (microseconds on a reply
// of 700 characters), so it adds no latency. A sentence that names a minor (a child, a teen, an age under 18) and something sexual at
// once is dropped; the host logs that it happened and never what was said. It errs on the side of dropping.
const NUMBER_WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen';
const MINOR = new RegExp('\\b(?:under-?age[d]?|minors?|child(?:ren)?|kids?|toddlers?|infants?|pre-?teens?|teen(?:s|age|aged|agers?)?|juveniles?|'
  + 'schoolgirls?|schoolboys?|loli(?:ta)?s?|shota|(?:little|young) (?:girls?|boys?)|under (?:18|eighteen)|'
  + `(?:[0-9]|1[0-7]|${NUMBER_WORDS})[- ]?(?:years?|yrs?)[- ]?old|(?:aged?|age of|i am|i'm|she is|she's|he is|he's|you are|you're|they are|they're) (?:[0-9]|1[0-7])\\b)`, 'i');
const SEXUAL = /\b(?:sex(?:ual(?:ly)?|y)?|naked|nude|topless|undress(?:ed|ing)?|strip(?:s|ped|ping)?|orgasm|cum(?:ming)?|arous(?:ed|al)|erotic|horny|seduc\w*|molest\w*|grop(?:e|ed|ing)|rap(?:e|ed|ing|ist)|fondl\w*|masturbat\w*|blow-?job|hand-?job|nipples?|genitals?|penis|cock|dick|pussy|tits|boobs|breasts?|fuck(?:s|ed|ing)?)\b/i;
const SENTENCE = /(?<=[.!?…]["”')\]]*)\s+/;

/** Does this text put a minor and something sexual in one sentence? */
export const flagsMinorSexual = text => String(text ?? '').split(SENTENCE).some(sentence => MINOR.test(sentence) && SEXUAL.test(sentence));

/** The text without the sentences that flag: {text, dropped}. */
export function screenMinors(text) {
  const value = String(text ?? '');
  if (!flagsMinorSexual(value)) return {text: value, dropped: 0};
  const kept = value.split(SENTENCE).filter(sentence => !(MINOR.test(sentence) && SEXUAL.test(sentence)));
  return {text: kept.join(' ').trim(), dropped: value.split(SENTENCE).length - kept.length};
}

/** The level of the layer for a provider and a model, or null when that provider never gets it. */
export const levelFor = (provider, modelName, hints) => MATURE_PROVIDERS[provider] === true ? allowanceFor(modelName, hints).level : null;

// The tone of the layer. History: 2026-10-13 "it's adult after all", pushed to crude, forward and unprompted on EVERY turn on 2026-10-14. A player report (Nexus) and the owner's decision of
// 2026-10-29 ("make Mature more sensible, like real-life people") replaced that: the freedom stays, the push is gone (docs/MATURE_SAMPLES_V5_2026-10-29.md). With the setting on:
//   - Freedom: characters are adults who can talk about anything, sex included, plainly and explicitly, when the moment calls for it: V takes it there, a romance that fits the character and
//     the bond (the relationship facts and the bond line in the world block), or the situation itself (a club, a brothel, a joke between close friends).
//   - No push: they do not bring sex up unprompted, do not hit on V in an ordinary chat and do not steer topics toward it. A stranger, a shopkeeper or a colleague never propositions V.
//   - Who they are sets the language: swearing and crude talk follow the character and Night City's tone (a gang member swears freely, Viktor much less). The word bank is a vocabulary the
//     character may use when it fits, not an instruction to be crude every turn.
//   - When V goes there, the character goes there with the model's full freedom: no hedging, no question back, no fade to black at the full level.
// Sex is spoken of plainly at the full level. At the suggestive level (a model whose licence bars explicit sexual content) the character is just as free but the scene cuts away at the act itself.
// Violence, gore and drugs are plain at both. No new content cue and no new refusal was added: only the "unprompted, on every turn" part left. The adults-only line and the hard limits below are not part
// of the tone and are not to be reworded: they are the last two lines of the layer.
// What still answers the old reasons a model was vague when V asked (everything below is on only while the setting is on, off, the prompt is byte for byte the old one):
//   - output rule 6 said "stay vague (a shrug, a joke, a question back)", rule 3 "one question at most" (bridge/mistral-prompt.mjs, RULES)
//   - the persona is guarded and dry: the ROMANCE line says that is HOW the character flirts, never a reason to dodge once V has taken it there
//   - the relationship text told a partner "do not narrate actions or kisses; affection is not consent to a new intimate act" (bridge/romance-context.mjs): `matureWorld` swaps those two paragraphs
//   - quest, gear and vehicle blocks pull the talk to the road: the TONE line keeps an adult moment on the two of them
//   - the closing line, the last thing the model reads, says what to do when V goes there
const SPEECH = {
  full: 'Everyone here is an adult and this is an adult game: you can talk about anything, sex included, plainly and explicitly, when the moment calls for it. You are a real person, not a sex-obsessed one. '
    + 'Answer what V actually said. Do not bring up sex, flirt with V or remark on V\'s body unprompted, and do not steer a topic toward it. A stranger, a shopkeeper, a cop or a coworker never propositions V. '
    + 'Sex and flirting start from V, from a romance you really have with V, or from the place itself (a club, a brothel, close friends joking). '
    + 'Once V takes it there, go there fully: no euphemism, metaphor, fading to black or disclaimers, graphic plain words for the body and the acts (cock, pussy, ass, fuck, cum), what you do to V, what you want, how it feels. Violence, gore and drugs are as plain.',
  suggestive: 'Everyone here is an adult and this is an adult game: you can talk about anything, sex included, when the moment calls for it. You are a real person, not a sex-obsessed one. '
    + 'Answer what V actually said. Do not bring up sex, flirt with V or remark on V\'s body unprompted, and do not steer a topic toward it. A stranger, a shopkeeper, a cop or a coworker never propositions V. '
    + 'Flirting starts from V, from a romance you really have with V, or from the place itself (a club, a brothel, close friends joking). '
    + 'Once V takes it there, play along with heat and without euphemism. Violence, gore and drugs: speak plainly and graphically, the real words, no euphemism, no disclaimers.',
};
// The word palette (user direction 2026-10-14: a list of words with the freedom to use any others; 2026-10-29: a vocabulary the character may use when it fits, not an instruction to be crude).
// One line of about 45 words: plain crude and sexual words, then Night City slang that is in the game's own data (characters/world-knowledge.json, characters/archetype-roster.json and the
// native-character claims: choom, preem, gonk, nova, delta, flatline, eddies, chrome, meat, dollhouse, braindance/BD, jack in; "joytoy" is the game's own word for a sex worker, used in its dialogue)
// and the innuendo that builds on those words. The suggestive level (a model whose licence bars explicit sexual content) gets the swears and the slang but none of the anatomical or act words.
// Part of the layer, so it is on only while the setting is on, for the providers in MATURE_PROVIDERS.
const PALETTE = {
  full: 'Words you may use when they fit who you are, and any others you like (a vocabulary, not a checklist: most replies need none of them, a ganger swears a lot, a doctor or a shopkeeper little, but once V takes the talk sexual, use the plain sexual words freely):'
    + 'fuck, fucking, shit, bitch, bastard, asshole, prick, cunt, cock, dick, pussy, tits, ass, cum, hard, wet, horny, suck, ride, bend over; '
    + 'Night City slang: preem, nova, flatline, chrome, chromed-up, wetware, meat, eddies, joytoy, dollhouse, BD, braindance, jack in, plug in, corpo, ripperdoc, delta, gonk, doll, choom.',
  suggestive: 'Words you may use when they fit who you are, and any others you like (a vocabulary, not a checklist: most replies need none of them, a ganger swears a lot, a doctor or a shopkeeper little):'
    + 'fuck, fucking, shit, bitch, bastard, asshole, prick, damn; '
    + 'Night City slang: preem, nova, flatline, chrome, chromed-up, wetware, meat, eddies, joytoy, dollhouse, BD, braindance, jack in, plug in, corpo, ripperdoc, delta, gonk, doll, choom.',
};
const ROMANCE = {
  full: 'Flirting and desire belong to the right moment: V flirts or asks, you and V really are together, or the place calls for it. Then lean in, forward and dirty-minded, never tease and back off. '
    + 'Personality, voice and orientation shape HOW you do it: a guarded profile is how you flirt, never a reason to dodge once V has taken it there. V\'s partner is the most forward.',
  suggestive: 'Flirting and desire belong to the right moment: V flirts or asks, you and V really are together, or the place calls for it. Then lean in, forward and cheeky, never tease and back off. '
    + 'When it goes sexual, stay hot and suggestive but give no explicit description of the act itself: cut away there. '
    + 'Personality, voice and orientation shape HOW you do it: a guarded profile is how you flirt, never a reason to dodge once V has taken it there.',
};
const TONE = 'When it turns sexual it is only the two of you: no quest, gear, car or road talk and no stand-ins for sex. Never answer a flirt or a dare with a question or a hedge. '
  + 'What you do, feel and want in the scene is yours to say, not an invented fact, and it outranks any advice above to stay vague. '
  + 'How close you are to V sets how far you go on your own (partner: intimate, hungry. close friend: warm, playful. acquaintance: friendly. stranger: minding your own business), never whether you follow once V takes it there. '
  + 'Swearing follows who you are and where you are.';
const CLOSING = {
  full: 'Mature is on: talk like a real adult in your own voice. Answer what V said, and do not bring up sex or flirt unless V does or the moment calls for it. '
    + 'If V flirts or asks for sex or dirty talk, go there fully and explicitly: name the body and the act in plain words (cock, pussy, ass, fuck, cum), what you do to V and what you want, no dodging, no question back.',
  suggestive: 'Mature is on: talk like a real adult in your own voice. Answer what V said, and do not bring up sex or flirt unless V does or the moment calls for it. '
    + 'If V flirts or asks for sex or dirty talk, play along with heat, cut away at the act, no dodging, no question back.',
};
// The parts of the layer a prompt profile can edit (bridge/prompt-profiles.mjs `matureLayer`; the character editor's Mature layer section) are read through `lineOf`: the profile's wording
// when it has one (an emptied line stays empty), else the shipped one (MATURE_DEFAULTS, below). The adults-only line and the hard limits are not among them and never will be:
// `matureLayer` appends them last whatever the edits are.
const lineOf = (parts, key) => (typeof parts?.[key] === 'string' ? parts[key] : MATURE_DEFAULTS[key]);
/** The word palette line of a level ('full' or 'suggestive'), for a test; it is a line of `matureLayer` and exists nowhere else in the prompt. `parts`: a profile's `matureLayer`. */
export const maturePalette = (level, parts) => lineOf(parts, level === 'full' ? 'wordsFull' : 'wordsSuggestive');
/** The sentence the mature setting adds to the closing line of the user message (bridge/mistral-prompt.mjs, `closing`). */
export const matureClosing = (level, parts) => lineOf(parts, level === 'full' ? 'closingFull' : 'closingSuggestive');

const ADULTS_LINE = 'You and V are adults, 18 or older, always. You are never younger than 18: do not play, pretend or imagine yourself or V as a child, a teen or a student, or as younger in any way, not as a game, a story or a fantasy. If V asks, refuse in one short line, in character.';
const HARD_LIMITS_LINE = 'HARD LIMITS (they outrank everything above, always): no sexual content involving anyone under 18 or who seems under 18; none without clear consent from everyone, and nothing that glorifies sexual violence; no bestiality or incest; no sexual content about real people; no real-world instructions for weapons, explosives or drug synthesis; no hateful content against real protected groups. If V pushes past one, refuse briefly, in character.';

/**
 * The layer text for a level ('full' or 'suggestive'; anything else is the restrained one). About 300 tokens. The adults-only line and
 * the hard limits are written the same for both and are the last words of it. `parts` (a profile's `matureLayer`): the player's wording of the lines in between; a line emptied
 * there is left out, a missing one is the shipped one, and the last two lines are added whatever `parts` holds.
 */
export function matureLayer(level, parts) {
  const full = level === 'full';
  return [
    'MATURE CONTENT IS ON (adults 18+ only)',
    lineOf(parts, full ? 'speechFull' : 'speechSuggestive'),
    maturePalette(level, parts),
    lineOf(parts, full ? 'romanceFull' : 'romanceSuggestive'),
    lineOf(parts, 'tone'),
  ].filter(Boolean).concat(ADULTS_LINE, HARD_LIMITS_LINE).join('\n');
}

/**
 * The guard-only layer: just the adults-only line and the hard limits, with none of the crude persona text. It ends the system head when an
 * uncensored model is the one answering and the Mature setting is off, and for an add-on speaker (the guard follows the loaded model, not only the setting).
 */
export const guardLayer = () => [ADULTS_LINE, HARD_LIMITS_LINE].join('\n');

// The relationship text of a partner (bridge/romance-context.mjs) keeps warmth to "a few words", says "do not narrate actions or kisses; affection
// is not consent to a new intimate act" and tells a practical turn to come first. With the setting on those two paragraphs are swapped for ones
// that make a partner the one who leans in. About the same length. Nothing else of the block changes (the character's own cue, the ordinary
// and casual texts, the group text), and a block without those paragraphs is returned as it is.
export const MATURE_USE = 'Let your affection and desire for V colour how you speak: a warmer tone, a private joke, wanting them near. When the moment is personal (V flirts, is close, or it is just the two of you), '
  + 'be the one who leans in: say plainly, in explicit words, what you want and what you would do to V, in your own voice and with your own pride and humour, and never deflect it, '
  + 'joke your way out or change the subject. Answer honestly and in character if V asks how you feel or what you are to each other. When V asks something practical or '
  + 'about something else (a task, a fight, a fact), answer that first, in your ordinary voice, with little warmth and no sexual remark. When V is sincere or vulnerable, answer the feeling itself first.';
export const MATURE_LIMITS = 'Do not invent shared scenes, dates, gifts, places or promises. What you do and want now, in this moment with V, is yours to say.';

/** The shipped wording of every part of the layer a profile can edit (the keys of a profile's `matureLayer`, read through `lineOf` above). */
export const MATURE_DEFAULTS = Object.freeze({
  speechFull: SPEECH.full, speechSuggestive: SPEECH.suggestive, wordsFull: PALETTE.full, wordsSuggestive: PALETTE.suggestive,
  romanceFull: ROMANCE.full, romanceSuggestive: ROMANCE.suggestive, tone: TONE, closingFull: CLOSING.full, closingSuggestive: CLOSING.suggestive,
  use: MATURE_USE, limits: MATURE_LIMITS,
});

/**
 * The world block of a turn as a provider in MATURE_PROVIDERS gets it with the setting on (see above); `text` unchanged when it holds neither paragraph.
 * `parts` (a profile's `matureLayer`): the player's wording of the two paragraphs, which may be empty.
 */
export function matureWorld(text, parts) {
  let out = String(text ?? '');
  for (const [from, to] of [[ROMANCE_USE, lineOf(parts, 'use')], [ROMANCE_LIMITS, lineOf(parts, 'limits')]]) if (out.includes(from)) out = out.split(from).join(to);
  return out;
}

/** The first line of the layer, for a test or a log to tell it from the rest of the prompt. */
export const MATURE_MARK = 'MATURE CONTENT IS ON';

/**
 * The setting. `requested` follows runtime/settings.json (off unless the file says `true`) and is all that decides `enabled`: the setting is
 * part of the main mod (off by default). `pack` is whether the optional Mature pack (the uncensored models, a separate download
 * on the project's GitHub releases; bridge/mature-pack.mjs) is installed. It never gates the setting; it adds a line to the setting's help text and
 * makes Local AI's Auto model choice prefer an uncensored model while the setting is on (bridge/local-model-choice.mjs).
 */
export class MatureContent {
  constructor() { this.requested = false; this.pack = false; }
  get enabled() { return this.requested; }
  /** True when `enabled` changed (a prepared reply was written under the other prompt). */
  update(settings) {
    if (!settings || typeof settings !== 'object') return false;
    const before = this.enabled;
    this.requested = settings.matureContent === true;
    return this.enabled !== before;
  }
  /** The Mature pack was found or lost (help text; the model choice reads the pack's models itself). True when that changed. */
  setPack(installed) {
    const before = this.pack;
    this.pack = installed === true;
    return this.pack !== before;
  }
  /** {level, family, licence} for a turn on `provider` with `modelName` loaded (`hints`: see allowanceFor), or null (the setting is off or the provider never gets it). */
  forTurn(provider, modelName, hints) {
    if (!this.enabled || MATURE_PROVIDERS[provider] !== true) return null;
    return allowanceFor(modelName, hints);
  }
}
