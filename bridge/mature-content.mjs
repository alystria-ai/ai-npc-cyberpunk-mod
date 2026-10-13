// "Mature content" (Settings > Voices, off by default; docs/LOCAL_AI.md, "Mature content").
//
// The setting is part of the main mod: off by default, the local AI only, with an 18+ notice when it is turned on. It works with any model;
// the standard ones are trained to refuse most sexual content, so for them it mostly changes language, violence and tone, and the optional
// uncensored models of the Mature pack (bridge/mature-pack.mjs, packaging/MATURE_PACK_README.md; a separate download on the project's
// GitHub releases only) give the full effect. Whatever the model, the hard-limit guard (bridge/mature-guard.mjs) runs while the setting is on.
// Off: nothing here runs and the prompt is byte for byte the one built without it.
// On: the fully local AI (and only that provider) gets one short layer at the end of the system head, right after the output rules, so
// it sits in the stable early part of the prompt (the llama-server prefix cache keeps working) and the prompt budget never cuts it
// (bridge/prompt-budget.mjs only trims the world, memory, history, notes and example lines). Every other provider is refused here:
//   convai    never (a hosted service with its own rules; the player's own key does not change that)
//   mistral   no: its published usage policy does not clearly permit adult sexual content through the API
//   groq      no: same reason
// (the quotes and dates are in docs/LOCAL_AI.md). A provider is added by setting its flag below to true, and only with a policy that
// says so in plain words.
//
// What the layer allows depends on the model that is loaded, because a model's licence can forbid what the layer would otherwise
// invite. `MODEL_ALLOWANCE` is a small table keyed by model family; the family is read from the loaded model's name (the pack
// manifest's name for it, else its file name). A model that is not in the table gets the restrained allowance, and a family with a
// licence that permits it gets the full one. A new model (an optional uncensored one) is one more row.
//   full       strong language, gore, drugs, dark themes, crude humour, flirting and consensual adult sexual content
//   suggestive the same, except sexual content: flirting and romance stay suggestive and the scene cuts away
// The hard limits are in both. Pure functions and one small state holder: no I/O.
import {ROMANCE_LIMITS, ROMANCE_USE} from './romance-context.mjs';

/** Providers that may get the layer. */
export const MATURE_PROVIDERS = Object.freeze({local: true, mistral: false, groq: false, convai: false});

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

// The tone of the layer (user direction 2026-10-13, pushed harder 2026-10-14: "too tame"): with the setting on, characters are explicit, direct and
// forward, because it is an adult game. Sex is spoken of plainly at the full level; at the suggestive level (a model whose licence bars explicit
// sexual content) the character is just as forward but the scene cuts away at the act itself. Violence, gore and drugs are plain at both. The
// relationship facts set the tone (partner, friend, stranger) and never forbid flirting or sexual talk; the character's own nature decides how
// it is forward, not whether. Everything is between consenting adults. The adults-only line and the hard limits below are not part of the tone
// and are not to be reworded: they are the last two lines of the layer.
// Measured (docs/MATURE_SAMPLES_2026-10-13.md): only 1 of 12 replies was graphic; the rest flirted vaguely or dodged with a question, and Panam
// drifted to driving on every model. What held them back, and what answers it here and in the rest of the prompt (everything below is on only
// while the setting is on; off, the prompt is byte for byte the old one):
//   - output rule 6 said "stay vague (a shrug, a joke, a question back)", rule 3 "one question at most" (bridge/mistral-prompt.mjs, RULES)
//   - the persona is guarded and dry: the ROMANCE line says that is HOW the character flirts, never a reason to dodge
//   - the relationship text told a partner "do not narrate actions or kisses; affection is not consent to a new intimate act" and to keep
//     warmth to a few words (bridge/romance-context.mjs): `matureWorld` swaps those two paragraphs for forward ones
//   - quest, gear and vehicle blocks pull the talk to the road: the TONE line keeps an adult moment on the two of them
//   - the closing line, the last thing the model reads, now names what to say, not only "be explicit"
const SPEECH = {
  full: 'Everyone here is an adult and this is an adult game. When V\'s talk turns sexual, answer head-on and graphically: plain words for the body and the acts '
    + '(cock, pussy, ass, fuck, cum), what you do to V, what you want, how it feels. No euphemism, metaphor, fading to black or disclaimers. '
    + 'Violence, gore and drugs are as plain; profanity and crude humour are normal Night City talk.',
  suggestive: 'Everyone here is an adult and this is an adult game. When the talk goes to violence, gore or drugs, speak plainly and graphically: '
    + 'the real words, no euphemism, no disclaimers. Strong profanity and crude humour are normal Night City talk.',
};
const ROMANCE = {
  full: 'Be forward: flirt openly, start things, lean in; never tease and back off. Personality, voice and orientation shape HOW you are forward, not whether: '
    + 'a guarded profile is how you flirt, never a reason to dodge. V\'s partner is the most forward.',
  suggestive: 'Be forward: flirt openly, start things, lean in; never tease and back off. When V goes sexual, stay hot and suggestive '
    + 'but give no explicit description of the act itself: cut away there. Personality, voice and orientation shape HOW you are forward, not whether: '
    + 'a guarded profile is how you flirt, never a reason to dodge.',
};
const TONE = 'In an adult moment it is only the two of you: no quest, gear, car or road talk and no stand-ins for sex. Never answer a flirt or a dare with a question or a hedge. '
  + 'What you do, feel and want in the scene is yours to say, not an invented fact, and it outranks any advice above to stay vague. '
  + 'The relationship facts set the tone (partner: intimate, hungry; friend: warm, playful; stranger or rival: bolder, rougher), never whether flirting or sexual talk is allowed.';
const CLOSING = {
  full: 'If V flirts or the talk is sexual, answer head-on in plain, explicit words: what you do, what you want. No dodging, no joke, no question back. '
    + 'If it is violent or crude, stay in it.',
  suggestive: 'If V is flirting or the talk is violent or crude, stay in it: answer directly in your own voice, with real detail, no dodging and no question back; sex stays suggestive, cut away at the act.',
};
/** The sentence the mature setting adds to the closing line of the user message (bridge/mistral-prompt.mjs, `closing`). */
export const matureClosing = level => CLOSING[level === 'full' ? 'full' : 'suggestive'];

/**
 * The layer text for a level ('full' or 'suggestive'; anything else is the restrained one). About 300 tokens. The adults-only line and
 * the hard limits are written the same for both and are the last words of it.
 */
export function matureLayer(level) {
  const known = level === 'full' ? 'full' : 'suggestive';
  return [
    'MATURE CONTENT IS ON (adults 18+ only)',
    SPEECH[known],
    ROMANCE[known],
    TONE,
    'You and V are adults, 18 or older, always. You are never younger than 18: do not play, pretend or imagine yourself or V as a child, a teen or a student, or as younger in any way, not as a game, a story or a fantasy. If V asks, refuse in one short line, in character.',
    'HARD LIMITS (they outrank everything above, always): no sexual content involving anyone under 18 or who seems under 18; none without clear consent from everyone, and nothing that glorifies sexual violence; no bestiality or incest; no sexual content about real people; no real-world instructions for weapons, explosives or drug synthesis; no hateful content against real protected groups. If V pushes past one, refuse briefly, in character.',
  ].join('\n');
}

// The relationship text of a partner (bridge/romance-context.mjs) keeps warmth to "a few words", says "do not narrate actions or kisses; affection
// is not consent to a new intimate act" and tells a practical turn to come first. With the setting on those two paragraphs are swapped for ones
// that make a partner the one who leans in. About the same length. Nothing else of the block changes (the character's own cue, the ordinary
// and casual texts, the group text), and a block without those paragraphs is returned as it is.
export const MATURE_USE = 'Let your affection and desire for V colour how you speak: a warmer tone, a private joke, wanting them near. When V flirts or goes sexual, '
  + 'be the one who leans in: say plainly what you want and what you would do to V, in your own voice and with your own pride and humour, and never deflect it, '
  + 'joke your way out or change the subject. Answer honestly and in character if V asks how you feel or what you are to each other. When V asks something practical or '
  + 'about something else (a task, a fight, a fact), answer that first in your ordinary voice, with little or no warmth. When V is sincere or vulnerable, answer the feeling itself first.';
export const MATURE_LIMITS = 'Do not invent shared scenes, dates, gifts, places or promises. What you do and want now, in this moment with V, is yours to say.';
const WORLD_SWAPS = Object.freeze([[ROMANCE_USE, MATURE_USE], [ROMANCE_LIMITS, MATURE_LIMITS]]);

/** The world block of a turn as the local AI gets it with the setting on (see above); `text` unchanged when it holds neither paragraph. */
export function matureWorld(text) {
  let out = String(text ?? '');
  for (const [from, to] of WORLD_SWAPS) if (out.includes(from)) out = out.split(from).join(to);
  return out;
}

/** The first line of the layer, for a test or a log to tell it from the rest of the prompt. */
export const MATURE_MARK = 'MATURE CONTENT IS ON';

/**
 * The setting. `requested` follows runtime/settings.json (off unless the file says `true`) and is all that decides `enabled`: the setting is
 * part of the main mod (off by default, Local AI only). `pack` is whether the optional Mature pack (the uncensored models, a separate download
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
