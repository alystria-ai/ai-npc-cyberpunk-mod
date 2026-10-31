// Narration in plain prose, removed from a reply before it is shown or spoken.
//
// Roleplay tuned models (a player report of 31 Oct: sao10k/l3-euryale-70b on a Custom endpoint) describe the speaker or the delivery in
// ordinary words, with no asterisks and no brackets: "Jackie's voice over the phone, concerned, hey are you okay?". The bracket and
// asterisk cleaning (cleanReply in bridge/mistral-prompt.mjs) cannot see that, and the voice read all of it.
//
// What goes is a *lead*: narration at the start of the reply or of a sentence, and only when the character's own name (or a third
// person form: he, she, they, his, her, their) or a bare place of the voice ("Over the phone, concerned,") opens it and what follows has
// the shape of narration (a voice, a delivery word, a verb of saying or of a gesture). Speech that merely contains such words stays:
// "Jackie's gonna love this", "my voice is shot", "concerned? me?", "She said she would call", "Over the phone? Sure." A sentence is
// judged on its first words only. It is a few regular expressions over a reply of a few hundred characters (well under a millisecond),
// it runs in the bridge, and nothing here runs in the game.
//
// Languages: a name label ("Jackie:") works in every language. A voice lead ("la voz de Jackie") and a "says" lead ("Jackie dice:") are also
// known in Spanish, French, German, Italian and Portuguese, a short list on purpose. Anything else stays as written.

// The first word of a *stage direction*: what a character does (sighs, laughs, leans in, clears throat), not what it stresses.
// Words that are also ordinary words ("look", "take", "hold") count only in their -s, -ed and -ing forms ("looks", "holding").
export const ACTION_STEM = /^(?:sigh|laugh|chuckl|giggl|snicker|smil|grin|smirk|wink|nod|shrug|paus|gasp|groan|cough|whisper|beep|bzz+t?|click|clap|cheer|cry|sob|snort|scoff|yawn|stretch|blush|frown|glar|stare|squint|wave|sip|sniff|hiss|mutter|shiver|tremble|flinch|wince|grimac|fidget|growl|mumbl|murmur|nudg|glanc|gestur|slump|stomp|twirl|bounc|crouch|kneel|beam|pout|sulk|tsk|ahem|exhal|inhal|swallow|lick|scratch)e?(?:s|es|ed|d|ing)?$/i;
export const ACTION_FORM = /^(?:look|turn|step|walk|sit|stand|hold|take|put|reach|lift|set|pull|push|cross|fold|lean|point|tap|pat|roll|shak|tilt|rais|lower|rub|clear|drink|bow|touch|hug|spin|jump|duck|storm|breath|bit)(?:s|es|ed|d|ing|ning|ting|ping)$/i;

const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordsOf = text => text.toLowerCase().replace(/[‘’‛ʼ]/g, "'").split(/[^\p{L}\p{N}']+/u).map(word => word.replace(/^'+|'+$/g, '')).filter(Boolean);

// ---- Word lists --------------------------------------------------------------------------------------------------------------------

// Words that say how a line is delivered. They count only inside a lead that a name, a pronoun, a voice or a place has already opened.
const DELIVERY = new Set(`concerned worried anxious nervous nervously tense tensely urgent urgently uneasy relieved surprised startled amused annoyed irritated
  angry angrily sad sadly happy cheerful cheerfully excited excitedly eager eagerly tired tiredly weary wearily sleepy groggy groggily hoarse hoarsely raspy gruff
  breathless breathlessly shaky strained trembling quivering wavering cracking crackling hushed whispering murmuring muttering sighing laughing chuckling giggling
  grinning smiling smirking frowning grimacing shrugging nodding winking blushing scowling glaring staring squinting wincing pausing hesitating gasping groaning
  sobbing softly quietly gently warmly coldly flatly dryly wryly drily sarcastically teasingly playfully cautiously hesitantly firmly sternly curtly briskly tersely
  lightly calmly evenly steadily bluntly bitterly kindly tenderly sheepishly awkwardly thoughtfully seriously solemnly grimly wistfully fondly lovingly
  nonchalantly casually low soft quiet warm cold flat dry curt brisk terse bright light calm steady muffled distorted garbled faint thin tight static crackle
  crackles slowly quickly briefly silently deep long slow quick sharp small wry faint
  preocupada preocupado suavemente bajito baixinho doucement inquiète inquiet besorgt leise preoccupata preoccupato`.split(/\s+/).filter(Boolean));
// Small words and the usual furniture of a delivery clause ("with a hint of worry", "a little tired", "over the phone").
const FILLER = new Set(`and then still a an the very so too bit little slightly rather quite more again now just all but yet as if of her his their its voice tone
  over through on from via in into line phone call comm comms holocall speaker headset radio intercom hologram holo screen to at v back up down out off away aside
  softer lower louder deeper with some hint trace touch tinge edge note concern worry warmth relief amusement hesitation breath sigh smile laugh grin while before
  after across along by
  por en desde teléfono telefono telefone au par téléphone telephone am im telefon per al pelo`.split(/\s+/).filter(Boolean));
const LOCATIVE = /^(?:over|on|through|via|from|across|down|in)\s+(?:the|a|an|her|his|their|that|this)\s+(?:phone|line|call|comm|comms|holocall|speaker|speakers|headset|radio|intercom|holo|hologram|screen|static|connection|distance)\b/i;
const LOC_PREP = new Set(['over', 'on', 'through', 'via', 'from', 'across', 'down', 'in', 'crackling', 'echoing', 'drifting', 'coming', 'carried', 'muffled']);
// What a voice does ("Her voice crackles", "softens", "drops"). "is" and "was" are left out: "Her voice is amazing" is a remark about someone's voice.
const VOICE_VERB = /^(?:crackl|crack|come|carr|soften|drop|waver|tremble|break|sound|fill|cut|fade|lower|rise|hum|pour|echo|catch|quiver|tighten|trail|seem|flicker|stutter|distort|buzz|hiss|rasp|sharpen|thicken|slip|shake|float|drift|ring|burst|pierce|snap|go|turn|grow|get)(?:s|es|ed|d|ing)$/i;
// Verbs of speaking, inflected (-s, -ed, -ing) or irregular.
const SAY = /^(?:(?:say|repl(?:y|ie)|answer|respond|whisper|murmur|mutter|add|continu|ask|tell|speak|begin|breath|call|snap|growl|hiss|offer|admit|not|remark|exclaim|insist|chim|quip|retort|declar|announc|suggest|promis|warn)(?:s|es|ed|d|ing)|said|told|spoke|began)$/i;
const INFLECTED = /(?:s|ed|d|ing)$/i;
const FIRST_SECOND = new Set(`i me my mine myself we us our ours you your yours yourself i'm i'll i've i'd we're we'll we've you're you'll you've you'd let's lets`.split(/\s+/));
const BODY = /^(?:eyes?|head|hands?|arms?|smile|face|shoulders?|tone|breath|lips?|brow|jaw|expression|gaze|chest|fingers?|mouth|laugh|voice)$/i;
const CONNECTORS = new Set(['then', 'and', 'as', 'while', 'before', 'after', 'but', 'still', 'now']);
const PRONOUN = /^(?:he|she|they)$/i;

const OBJECT_WORDS = new Set(['him', 'them', 'her', 'it']);
const isSayVerb = word => SAY.test(word);
const isVerb = word => SAY.test(word) || ((ACTION_STEM.test(word) || ACTION_FORM.test(word)) && INFLECTED.test(word));
const hasPerson = tokens => tokens.some(word => FIRST_SECOND.has(word));
// Every word of a lead is a delivery word, small furniture, a verb of saying or of a gesture, or a part of the body: "grins at V and says", "shakes his head", "says softly".
const narrative = word => DELIVERY.has(word) || FILLER.has(word) || OBJECT_WORDS.has(word) || BODY.test(word) || isVerb(word);
const hasQuote = text => /["“”]/.test(text);

// The other languages: "the voice of NAME" and a verb of saying, followed by the usual colon or comma.
const OTHER_VOICE = String.raw`(?:la voz de|la voix de|a voz de|la voce di|die stimme von|stimme von)`;
const OTHER_SAY = String.raw`(?:dice|dijo|responde|respondió|susurra|murmura|contesta|pregunta|dit|répond|répondit|murmure|souffle|demande|sagt|sagte|antwortet|flüstert|murmelt|fragt|disse|diz|risponde|sussurra|chiede|sussurrou|pergunta)`;

// ---- Name forms --------------------------------------------------------------------------------------------------------------------

const FORMS_CACHE = new Map();
/** The ways a character is called: the full name, each part of it of three letters or more, and the aliases the same way, longest first. */
export function nameForms(name, aliases = []) {
  const list = Array.isArray(aliases) ? aliases : [];
  const key = `${name ?? ''}\u0001${list.join('\u0002')}`;
  const known = FORMS_CACHE.get(key);
  if (known) return known;
  const found = new Set();
  for (const text of [name, ...list]) {
    if (typeof text !== 'string') continue;
    const whole = text.replace(/\s+/g, ' ').trim();
    if (whole.length < 2 || whole.length > 60) continue;
    found.add(whole);
    for (const part of whole.split(' ')) {
      const bare = part.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      if (bare.length >= 3 && !/^(?:the|von|van|der|den|del|de|la|le|el|mr|mrs|ms|dr)$/i.test(bare)) found.add(bare);
    }
  }
  const forms = [...found].sort((a, b) => b.length - a.length);
  const result = Object.freeze({forms, pattern: forms.length ? forms.map(escapeRegex).join('|') : null});
  if (FORMS_CACHE.size >= 200) FORMS_CACHE.clear();
  FORMS_CACHE.set(key, result);
  return result;
}

const MATCHERS = new Map();
function matchersFor(pattern) {
  let found = MATCHERS.get(pattern ?? '');
  if (found) return found;
  const who = pattern ? `(?:${pattern})` : null;
  found = {
    // "Jackie:" in front of a sentence, in any form of the name.
    label: who ? new RegExp(`^[\\W_]{0,3}${who}[*_]{0,2}\\s*:[*_]{0,2}\\s+`, 'iu') : null,
    // "Jackie's voice", "Her voice", "La voz de Jackie".
    voice: new RegExp(`^(?:${who ? `${who}(?:'s|’s)\\s+|` : ''}(?:his|her|their)\\s+)(?:voice|tone)(?![\\p{L}])|^${OTHER_VOICE}\\s+${who ?? '(?!)'}(?![\\p{L}])`, 'iu'),
    named: who ? new RegExp(`^${who}(?=[\\s,;:])`, 'iu') : null,
    otherSay: who ? new RegExp(`^${who}\\s+${OTHER_SAY}(?![\\p{L}])`, 'iu') : null,
  };
  if (MATCHERS.size >= 200) MATCHERS.clear();
  MATCHERS.set(pattern ?? '', found);
  return found;
}

// ---- Reading a sentence ------------------------------------------------------------------------------------------------------------

const DELIMITER = /[,:;—–]/;
const clauseOf = text => /^[^,;:—–]*/.exec(text)[0];

/** A piece of narration after a lead has begun: delivery words only, a gesture, the place of the voice. */
function narrationPiece(segment) {
  const tokens = wordsOf(segment);
  if (!tokens.length) return true;
  if (tokens.length > 7 || hasPerson(tokens) || /\d/.test(segment) || hasQuote(segment)) return false;
  if (tokens.every(word => DELIVERY.has(word) || FILLER.has(word)) && tokens.some(word => DELIVERY.has(word))) return true;
  if (LOCATIVE.test(segment.trim()) && tokens.length <= 6) return true;
  let at = 0;
  while (at < tokens.length && CONNECTORS.has(tokens[at])) at++;
  if (at < tokens.length && PRONOUN.test(tokens[at])) at++;
  if (at >= tokens.length) return false;
  if (isVerb(tokens[at]) && tokens.length - at <= 6) return tokens.slice(at + 1).every(narrative);
  return /^(?:his|her|their)$/.test(tokens[at]) && BODY.test(tokens[at + 1] ?? '') && tokens.length - at <= 6 && tokens.slice(at + 2).every(narrative);
}
const deliveryPiece = segment => narrationPiece(segment) && wordsOf(segment).some(word => DELIVERY.has(word));

/**
 * `text` is a sentence without its end punctuation, `headEnd` where the head (the name, the voice, the pronoun and its verb) ends; the clause up to the
 * first delimiter was already accepted. Walks the next pieces while they are narration. Returns where the speech starts, or text.length when none does.
 */
function walk(text, headEnd) {
  let begin = headEnd, first = true;
  for (let at = headEnd; at <= text.length; at++) {
    const delimiter = at < text.length ? text[at] : '';
    if (delimiter && !DELIMITER.test(delimiter)) continue;
    if (!first && !narrationPiece(text.slice(begin, at))) return begin;
    first = false;
    if (!delimiter) return text.length;
    if (delimiter === ':') return at + 1;
    begin = at + 1;
  }
  return text.length;
}

/**
 * Where the speech starts in `sentence` (the sentence with its end punctuation and the space after it): the index to cut the lead at,
 * sentence.length when the whole sentence is narration, or -1 when the sentence does not open with narration.
 */
function leadEnd(sentence, matchers) {
  const lead = sentence.length - sentence.trimStart().length;
  const body = sentence.trimEnd().replace(/[.!?…]+["”')\]]*$/, '').length;
  if (lead >= body) return -1;
  const text = sentence.slice(lead, body);
  // A sentence that is narration whole is dropped, unless it is a question ("Her voice? Never heard it."): narration states, it does not ask.
  const done = cut => (cut < text.length ? lead + cut : /\?/.test(sentence.slice(body)) ? -1 : sentence.length);

  // 1. A voice: "Jackie's voice over the phone, concerned,", "Her voice crackles through the line."
  const voice = matchers.voice.exec(text);
  if (voice) {
    const rest = text.slice(voice[0].length);
    const clause = clauseOf(rest), tokens = wordsOf(clause);
    const abroad = new RegExp(`^${OTHER_VOICE}`, 'i').test(voice[0]);
    const opening = abroad || !tokens.length || LOC_PREP.has(tokens[0]) || VOICE_VERB.test(tokens[0]) || tokens[0] === 'and';
    if (!opening || tokens.length > 10 || hasPerson(tokens) || /\d/.test(clause) || hasQuote(clause)) return -1;
    const cut = walk(text, voice[0].length);
    return !tokens.length && cut >= text.length ? -1 : done(cut);   // "Her voice" alone says nothing about the voice
  }
  // 2. The name: "Jackie says softly:", "Jackie grins at V.", "Jackie, grinning:", "Jackie, concerned, hey ...", "Jackie dice:".
  const named = matchers.named?.exec(text);
  if (named) {
    const after = text.slice(named[0].length);
    const verb = /^\s+(\p{L}[\p{L}']*)/u.exec(after);
    if (verb && isVerb(verb[1].toLowerCase())) {
      const clause = clauseOf(after), tokens = wordsOf(clause);
      if (tokens.length > 9 || hasPerson(tokens) || /\d/.test(clause) || hasQuote(clause)) return -1;
      // A verb of saying in the present tense with nothing but words after it ("Jackie says hello there.") is narration: the lead goes, the words stay (below). Anything else
      // must be all narration, and a verb of saying in the past tense needs its delivery ("said, quietly,") or a colon ("said:"): "Jackie said it was fine, so it is fine." is
      // the speaker reporting what was said.
      const said = verb[1].toLowerCase();
      const present = isSayVerb(said) && /^[^\s]+s$/.test(said) && !DELIMITER.test(after);
      const calm = tokens.slice(1).every(narrative);
      if (!present && !calm) return -1;
      if (isSayVerb(said) && !present && !tokens.slice(1).every(word => DELIVERY.has(word) || FILLER.has(word)) && text[named[0].length + clause.length] !== ':') return -1;
      const cut = walk(text, named[0].length);
      // A verb of saying with no delimiter ("Jackie says hello there."): what follows the verb is what is said, so only the lead goes.
      if (cut >= text.length && isSayVerb(verb[1].toLowerCase()) && !DELIMITER.test(after)) {
        const said = /^\s+\p{L}[\p{L}']*(?:\s+(?:softly|quietly|gently|warmly|firmly|calmly|slowly|again|then|back|aloud))*\s+(?=\S)/u.exec(after);
        return said ? lead + named[0].length + said[0].length : sentence.length;
      }
      return done(cut);
    }
    const comma = /^\s*,\s*/.exec(after);
    if (comma && !verb) {
      const piece = clauseOf(after.slice(comma[0].length));
      return deliveryPiece(piece) ? done(walk(text, named[0].length + comma[0].length)) : -1;
    }
    const other = matchers.otherSay?.exec(text);
    if (other && /^\s*(?:\p{L}+\s*){0,2}[:,]/u.test(text.slice(other[0].length))) return done(walk(text, other[0].length));
    return -1;
  }
  // 3. A pronoun and a gesture or a verb of saying, strictly: "She says softly:", "He grins.", "She smiles, ..."
  const pronoun = /^(?:he|she|they)\s+(\p{L}[\p{L}']*)/iu.exec(text);
  if (pronoun && isVerb(pronoun[1].toLowerCase())) {
    const tokens = wordsOf(clauseOf(text.slice(pronoun[0].length)));
    return tokens.length <= 4 && tokens.every(narrative) && !hasPerson(tokens) ? done(walk(text, pronoun[0].length)) : -1;
  }
  // 4. A place and a delivery in front of the words: "Over the phone, concerned, hey ..."
  const place = LOCATIVE.exec(text);
  if (place) {
    const comma = /^\s*,\s*/.exec(text.slice(place[0].length));
    if (comma && deliveryPiece(clauseOf(text.slice(place[0].length + comma[0].length)))) return done(walk(text, place[0].length));
  }
  return -1;
}

// A sentence: its words, its closing punctuation and the space after it; the last one may have no punctuation.
const SENTENCE = /[^.!?…]+(?:[.!?…]+["”')\]]*|$)\s*/g;
const SINGLE_QUOTED = /^[‘'](.+)[’']$/s;

/**
 * The reply with the narration leads of its sentences removed, and a "Name:" label of any form of the name. `name`: the speaker (empty for an unnamed
 * person, then only the third person forms apply); `aliases`: other names the character goes by. The text comes back as it was when nothing matched.
 */
export function stripNarration(text, {name = '', aliases = []} = {}) {
  const raw = String(text ?? '');
  if (raw.length < 4) return raw;
  const matchers = matchersFor(nameForms(name, aliases).pattern);
  const sentences = raw.match(SENTENCE) ?? [raw];
  let changed = false;
  const out = [];
  for (const sentence of sentences) {
    let piece = sentence;
    if (matchers.label) {
      const start = piece.trimStart(), label = matchers.label.exec(start);
      if (label && start.length > label[0].length) { piece = start.slice(label[0].length); changed = true; }
    }
    const end = leadEnd(piece, matchers);
    if (end >= 0) { piece = piece.slice(end); changed = true; }
    // The first word of the speech that is left opens a sentence now.
    out.push(piece !== sentence ? piece.replace(/^(\s*)(\p{Ll})/u, (_, space, letter) => space + letter.toUpperCase()) : piece);
  }
  if (!changed) return raw;
  let result = out.join('').replace(/[ \t]{2,}/g, ' ').replace(/^[\s,;:—–-]+/, '').trim();
  // The words of a narrated line were often quoted ("Jackie says softly, 'hey.'"): the quotation marks go with the narration.
  const quoted = SINGLE_QUOTED.exec(result);
  if (quoted && !/[‘’']/.test(quoted[1])) result = quoted[1].trim().replace(/^\p{Ll}/u, letter => letter.toUpperCase());
  return result;
}
