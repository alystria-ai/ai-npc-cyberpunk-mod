// Companion actions for the text routes (Mistral, the local AI; docs/MISTRAL.md, "Actions").
//
// On the Convai route the model asks for an action through Convai's action system (bridge/companion-actions.mjs). A text model has no
// such channel, so the text route decides in its own small request and the game's verified offers stay the only authority:
//
//   1. A turn with offers (drive to the map destination, attack the marked target, follow V, leave V's party) first asks a tiny
//      CLASSIFIER request, with no persona and a few lines of rules, which one of the offered actions V's new message plainly asks for,
//      or NONE. It runs while the memory store retrieves what the character remembers, so it normally costs no time.
//   2. The character's reply is then written with that decision in its notes: "V is asking you to drive them ... agree briefly", or,
//      when no action is possible, what V has to do first. The reply never contains a code, and a stray code is cut out of the text.
//   3. The decided action is handed to `CompanionActions.deliver` (the message the Convai client would send); the game's own capture
//      (mod/gameplay-actions.lua) still checks the exact offer.
//
// Why not function calling, or a code inside the reply (both measured on ministral-8b, the free plan; scripts/Eval-MistralPrompt.mjs
// --actions): a turn that calls a tool comes back with the tool call and NO spoken text (speaking would need a second request), and the
// model calls tools nobody asked for. A code that opens the reply ("[DRIVE] Sure ...", a forced choice on every turn) streams well but
// the persona picks the code by mood: 74% recall and 56% precision, and it used the leave code to mean "no". A separate decision is
// reliable because the classifier sees only V's words and the list.
//
// Offered here: drive to the map destination, fight the marked target, follow V (a world character), leave V's party. Distract is gone.
// There is no wait / stay / sit command in the game, so none is offered, and the prompt says so.

import {parseDriveUnavailable, SEATED_MODES} from './companion-actions.mjs';
import {screenWords, explicitRequest} from './text-action-words.mjs';

export const ACTION_CODES = Object.freeze(['DRIVE', 'FIGHT', 'FOLLOW', 'LEAVE']);

// Why the game cannot let this companion drive V right now (codes: bridge/companion-actions.mjs). Each becomes one short sentence of what
// V has to do first.
export const DRIVE_LIMIT = Object.freeze({
  'player-driving': 'V is driving a vehicle that is not V\'s own car; V would have to get out of it first, then ask',
  'player-seated': 'V is sitting in a vehicle that is not V\'s own car; V would have to get out first, then ask',
  'no-waypoint': 'no destination is marked on the map; V has to mark one first',
  'no-car': "V's own car is not standing close by; V has to stand next to it or call it first",
  'car-moving': "V's car has to stand still first",
  combat: 'there is fighting going on; it has to be over first',
  busy: 'it is not possible right now',
});

const FOLLOW_LIMIT = {
  quest: 'you are needed where you are for something important', scene: 'you are in the middle of something', combat: 'there is fighting going on',
  police: 'you are on duty', hostile: 'you are not on friendly terms with V', working: 'you have to keep working here',
  vehicle: 'you are in a vehicle', busy: 'you are busy with something else', 'already-here': 'it is not possible right now',
  unavailable: 'it is not possible right now',
};

// Game data (names) goes into the prompt inside quotes, one line, bounded.
const data = (value, max = 50) => JSON.stringify(String(value ?? '').replace(/[\u0000-\u001f\u007f"\\{}\[\]<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max));
const word = value => String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * The actions of one turn, from the offer the host gets (`config.companionAction`, CompanionActions.configFor).
 * Returns null when the turn has nothing to say about actions. Otherwise
 *   codes      the actions the game offers this turn (DRIVE, FIGHT, FOLLOW, LEAVE)
 *   rows       {code, what, asks, tell, resolve(argument)}: `what` is the action in the classifier's words, `asks` what V says to start it,
 *              `tell` the note the character gets when it is decided, `resolve` the message for CompanionActions.deliver (or null)
 *   notes(code)  the character's prompt text for a decision (a code of `codes`, or null for none / unknown)
 *   classifier({text, last})  the messages of the decision request, or null when nothing is offered
 *   decide(raw)  the offered code in a classifier answer (or null) and, for a named leave, its argument
 *   explicit(text)  the decision for a line that plainly asks for a ride, an attack or to follow (or null): used only when the classifier gave none
 */
export function actionMenu(offer) {
  if (!offer || typeof offer !== 'object' || typeof offer.token !== 'string' || !offer.token) return null;
  const rows = [];
  const limits = [];
  const base = {version: 1, token: offer.token};
  if (offer.drive !== false && typeof offer.destinationName === 'string') {
    const seated = SEATED_MODES.includes(offer.seated);
    rows.push({code: 'DRIVE', what: `drive V in V's car to the map destination (V asks to be driven, to take the wheel, to be taken somewhere${seated ? ', or tells the companion to drive, take over or swap seats' : ''})`,
      tell: seated
        ? `V is sitting in their own car ${data(offer.carName ?? "V's car")} and is asking you to drive them to the map destination ${data(offer.destinationName)}. `
          + (offer.seated === 'driver'
            ? `V has the driver seat: tell V to step out of it so you can take the wheel, then you get out and take the driver seat, and V gets into a passenger seat. The game starts it right after your reply`
            : `You take the driver seat if you do not have it yet and drive. The game starts it right after your reply`)
        : `V is asking you to drive them in their car ${data(offer.carName ?? "V's car")} to the map destination ${data(offer.destinationName)}. You take the wheel and the game starts it right after your reply`,
      resolve: () => ({...base})});
  } else if (!offer.group && parseDriveUnavailable(offer.driveUnavailable)) {
    limits.push(`you cannot drive V anywhere (${DRIVE_LIMIT[offer.driveUnavailable]})`);
  }
  if (offer.tactic?.kinds?.includes('fight')) {
    const {targetName, distance, hostile} = offer.tactic;
    rows.push({code: 'FIGHT', what: 'attack the enemy V marked (V tells the companion to attack, fight, kill, take out or get them)',
      tell: `V is telling you to attack ${data(targetName)} (tagged by V or in V's sights, ${Math.max(0, Math.round(Number(distance) || 0))} m away${hostile ? ', hostile' : ''}). You go in and the game starts it right after your reply`,
      resolve: () => ({...base, tactic: 'fight'})});
  } else if (offer.tacticUnavailable) {
    limits.push('you cannot attack anyone (nobody is tagged or in V\'s sights; V has to tag an enemy in the scanner or aim at one first)');
  }
  if (offer.follow) rows.push({code: 'FOLLOW', what: 'come along with V and travel with them (V asks the companion to come with them or follow them)',
    tell: 'V is asking you to come along and travel with them. You join V and the game does it right after your reply', resolve: () => ({...base, follow: true})});
  else if (offer.followUnavailable && Object.hasOwn(FOLLOW_LIMIT, offer.followUnavailable)) limits.push(`you cannot come along with V (${FOLLOW_LIMIT[offer.followUnavailable]})`);
  const members = Array.isArray(offer.leave?.members) ? offer.leave.members : [];
  if (members.length) {
    const own = members.findIndex(member => member.self);
    if (members.length === 1 && own === 0) {
      rows.push({code: 'LEAVE', what: `leave V's company (V sends the companion away: "you can go", "go home", "we're done here", "I'll go on without you")`,
        tell: 'V is sending you away. You go your own way, and the game removes you from V\'s company right after your reply: say a short goodbye that fits you',
        resolve: () => ({...base, leave: 1})});
    } else {
      rows.push({code: 'LEAVE', what: `a companion leaves V's party (V sends one of ${members.map(member => data(member.name, 40)).join(', ')} away, or all of them); answer DISMISSED followed by that name, or DISMISSED ALL`,
        tell: 'V is sending a companion away. The game removes them from V\'s party right after your reply: the one leaving says a short goodbye that fits them',
        resolve: argument => {
          const wanted = word(argument);
          if (wanted === 'all' && members.length > 1) return {...base, leave: 'all'};
          // One unambiguous companion by the whole name or its first word.
          const hits = members.map((member, index) => ({index, full: word(member.name)}))
            .filter(row => wanted && (row.full === wanted || row.full.split(' ')[0] === wanted || wanted.split(' ')[0] === row.full.split(' ')[0]));
          return hits.length === 1 ? {...base, leave: hits[0].index + 1} : null;
        }});
    }
  }
  if (!rows.length && !limits.length) return null;
  const tail = [
    limits.length ? `Right now ${limits.join('; ')}. If V asks for that, say what is needed, in your own words, briefly.` : '',
    'You cannot wait on a spot, stay behind, sit on command or do any other task, whatever V says: do not agree to it or promise it.',
  ].filter(Boolean);
  const named = rows.find(row => row.code === 'LEAVE' && /DISMISSED followed/.test(row.what));
  return {
    codes: rows.map(row => row.code), rows, limits,
    /** The offered codes V's words could be about (bridge/text-action-words.mjs); [] means no decision request is worth sending. */
    screen: (text, last) => screenWords(text, {codes: rows.map(row => row.code), last}),
    /**
     * What the reply should be written for while the decision is out: 'NONE' for a question about the character ("do you know how to
     * drive?", "did you ever fight?"), the only action the screen found, or null (the reply waits). A wrong guess costs a second
     * reply, never a wrong action: the reply is held back until the decision agrees.
     */
    guess: (text, found) => {
      const sentences = String(text ?? '').trim().split(/(?<=[.!?])\s+/);
      const sentence = sentences.at(-1) ?? '';   // the question is the last sentence
      // A question about the character (typed with or without its question mark), or remarks that ask nothing of her: plain talk. A
      // wrong "plain talk" costs the same second reply a wrong action does, and these are the lines that were guessed wrongly on
      // 2026-10-13 ("what are some of the services you excel at specifically" was written as "V sends you away").
      if ((TALK.test(sentence) || OPEN_QUESTION.test(sentence)) && !REQUEST_QUESTION.test(sentence)) return 'NONE';
      if (sentences.every(part => REMARK.test(part) && !ADDRESSES_HER.test(part))) return 'NONE';
      return found.length === 1 ? found[0] : null;
    },
    /**
     * The safety net under a decision that failed or said none: the offered action V's line plainly asks for in plain words ("drive me", "take the
     * wheel", "attack him", "follow me"), as a decision, or null (bridge/text-action-words.mjs explicitRequest; never a leave).
     */
    explicit: text => {
      const code = explicitRequest(text, {codes: rows.map(row => row.code)});
      return code && rows.some(row => row.code === code) ? {code, argument: ''} : null;
    },
    notes(code) {
      const row = rows.find(item => item.code === code);
      const head = row ? `GAME ACTIONS: ${row.tell}: agree in your own words, in one or two short sentences, and promise nothing more. Never speak of codes or the game.`
        : rows.length ? 'GAME ACTIONS: V is not asking you to do anything the game can carry out this time; just answer.' : 'GAME ACTIONS: none is possible right now.';
      return [head, ...tail].join('\n');
    },
    classifier({text, last}) {
      if (!rows.length) return null;
      const lines = rows.map(row => `${row.code === 'LEAVE' ? 'DISMISSED' : row.code}: ${row.what}`);
      // What exists in the game but cannot be done this turn: asked for, it is NONE. Without this a small model picks the nearest listed action.
      const blocked = ['drive V somewhere or be driven ("drive for me", "take the wheel", "take me there")', 'attack an enemy ("attack", "take him out")', 'come along with V ("follow me", "come with me")', 'leave V\'s company ("you can go")'].filter((_text, index) => !rows.some(row => row.code === ACTION_CODES[index]));
      return [{role: 'system', content: 'You read one message from V, the player of a video game, to a companion character and decide which game action, if any, V is asking the companion to do right now.\n'
        + 'Actions:\n' + lines.join('\n') + '\nNONE: anything else (conversation, questions, jokes, stories, remarks, thanks, "leave it", "forget it", or a request for something not listed).\n'
        + (blocked.length ? `These are not possible right now, so asking for any of them is NONE, never another action: ${blocked.join('; ')}.\n` : '')
        + 'Rules: only V\'s new message counts. A request is a request even phrased as a question ("can you drive for me?", "could you take him out?"). A question about whether the companion could, would, knows how or has done it ("do you know how to drive?", "would you ever follow me?", "remember when you drove?") is NONE, and so is a hypothetical, a joke or a wish for later. "Let\'s leave this place", "leave it" and "I\'m leaving" do not send the companion away. The message may be in any language.\n'
        + `Answer with one word only: ${[...rows.map(row => row.code === 'LEAVE' ? 'DISMISSED' : row.code), 'NONE'].join(', ')}${named ? ' (DISMISSED may be followed by a name or ALL)' : ''}.`},
      {role: 'user', content: `${last ? `Just before, V said: ${JSON.stringify(String(last.v ?? '').slice(0, 160))} and the companion answered: ${JSON.stringify(String(last.r ?? '').slice(0, 200))}\n\n` : ''}V's new message: ${JSON.stringify(String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 400))}`}];
    },
    decide(raw) {
      const match = /^\W*(drive|fight|follow|dismissed|leave|none)\b[\s:,=-]*([^\n]{0,40})/i.exec(String(raw ?? ''));
      if (!match) return null;
      const code = match[1].toUpperCase() === 'DISMISSED' ? 'LEAVE' : match[1].toUpperCase();
      const argument = match[2].trim().replace(/[.\s]+$/, '');
      // Only a leave may carry a name; any other code followed by words is not a clear answer.
      if (code === 'NONE' || !rows.some(row => row.code === code) || (code !== 'LEAVE' && argument)) return null;
      return {code, argument};
    },
    message(decision) {
      const row = decision && rows.find(item => item.code === decision.code);
      return row ? row.resolve(decision.argument) : null;
    },
  };
}

// A line that asks the character something about itself or the past rather than asking it to do something (English only; another
// language is guessed as a request, which is only a little slower when it is not).
const TALK = /^(?:[^?!.]{0,30}[,:] )?(?:do|did|does|have|has|had|who|what|why|how|where|when|which|is|are|was|were|ever|remember|isn'?t|aren'?t)\b[^]*\?$/i;
// An open question without its question mark ("what are some of the services you excel at"). "How about you drive", "why don't you" and
// "what if you took the wheel" are requests and stay out.
const OPEN_QUESTION = /^(?:[^?!.]{0,30}[,:] )?(?:what|who|why|how|where|when|which)\b(?!\s+(?:about|if|else|don'?t|do not|not|come)\b)/i;
// A remark about oneself or something else ("I used to fight in the pits", "Your driving scared me", "I've never seen a car like that"):
// it is not a request unless it speaks to her ("I need you to drive", "I'll go on without you"). English only, like TALK.
const REMARK = /^(?:i|i'm|i've|i'd|i'll|my|he|she|they|there|there's)\b(?![^]*[,;]\s*(?:take|get|go|come|follow|drive|walk|hang|do|head|accompany|leave|attack|kill|shoot|fight|pick|stay|let'?s|bounce|scram|peace)\b)/i;
const ADDRESSES_HER = /\b(?:you|u|ya|y'all|yourself)\b/i;
const REQUEST_QUESTION = /^(?:[^?!.]{0,30}[,:] )?(?:can|could|would|will|won'?t|wanna|want to|mind|do you mind|do you want|do you wanna|do you think you could)\b/i;

// A code in a reply is never spoken: the character is not told about codes, but a small model may still write one.
// The last three are an ordinary NPC's reactions (docs/NPC_REACTIONS.md, `reactionMenu` below): [attack], [call-police] (also spelled
// "call police" or "police") and [leave], which is also the companion code above.
// A tag's own full stop ("Fine. [leave].") goes with it, so no doubled stop is left behind.
const TAG = /\[\s*(?:action\s*[:=]\s*)?(drive|fight|follow|leave|dismissed|none|no[ _-]?(?:tag|reaction)|attack|call[ _-]?police|police)\b\s*(?:[:=]\s*([^\]\n]{0,40}))?\]\.?/gi;
const LOWER_CODES = ['drive', 'fight', 'follow', 'leave', 'dismissed', 'none', 'no-tag', 'no-reaction', 'attack', 'police', 'call-police', 'callpolice'];
const normalCode = code => {
  const upper = String(code).toUpperCase().replace(/[ _]/g, '-');
  return upper === 'DISMISSED' ? 'LEAVE' : upper === 'CALLPOLICE' || upper === 'POLICE' ? 'CALL-POLICE' : upper;
};

// Is this unfinished bracket group (it starts with "[" and runs to the end of the text) the start of a code?
function couldBeCode(partial) {
  let body = partial.slice(1).trimStart().toLowerCase();
  if (/^[a-z]*$/.test(body) && 'action'.startsWith(body)) return true;   // "", "a", "act", ...
  body = body.replace(/^action\s*[:=]\s*/, '');
  if (body === '') return true;
  const word = /^[a-z]+/.exec(body)?.[0] ?? '';
  if (!word) return false;
  // Still being written: the letters so far start a code ("call police" and "call_police" count as "call-police").
  const typed = body.replace(/\s+$/, '');
  if (/^[a-z]+(?:[ _-][a-z]*)?$/.test(typed)) return LOWER_CODES.some(code => code.startsWith(typed.replace(/[ _]/g, '-')));
  return LOWER_CODES.includes(word);   // a whole code followed by an argument that is still being written
}

/**
 * The reply text without any action code, and the codes found: [{code, argument}] in order (informational: a code in a reply never
 * starts an action). `streaming`: the text is still being written, so an unfinished code at its end ("[DR") is held back.
 */
export function splitActions(raw, {streaming = false} = {}) {
  const found = [];
  let text = String(raw ?? '').replace(TAG, (_match, code, argument) => { found.push({code: normalCode(code), argument: argument?.trim() || ''}); return ' '; });
  if (streaming) {
    const at = text.lastIndexOf('[');
    if (at >= 0 && !text.includes(']', at) && text.length - at <= 52 && couldBeCode(text.slice(at))) text = text.slice(0, at);
  }
  if (found.length) text = text.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.!?;:])/g, '$1').replace(/^\s+/, '');
  return {text, found};
}

// ---------------------------------------------------------------------------------------------------------------------------------
// An ordinary NPC's reaction (docs/NPC_REACTIONS.md). The text routes have no action channel and, for this, no decision request either: the
// reply decides. A person the game offers reactions for (config.companionAction.reaction, bridge/companion-actions.mjs) gets one short
// note, and a reply that opens with one tag ("[call-police] Back off, I am calling the cops.") hands that reaction to the game after the
// reply. The tag is rare in practice and by these rules: it is cut from every text the player hears or reads; it counts only at the very
// START or END of a reply with words besides it; only a kind the game offered counts; and the game still checks the exact offer
// (mod/npc-reactions.lua).
//
// Why the reply OPENS with the tag (measured on ministral-8b, scripts/Eval-MistralPrompt.mjs --reactions, 2026-10-21): a tag asked for at the
// END after the words was written for 3% of the threats ("give me your money or I will hurt you") and 50 to 60% with every rewording of the note
// that was tried: the persona writes its in-character defiance and never gets to the tag. A tag the reply must open with is a choice made
// before the persona speaks, and with "[none]" as the answer for everything else the model judged every line (a joke, a flirt, "I could murder
// a burger") correctly. The cost: a model that has chosen sometimes stops after the tag ("[attack]"); the host asks once more for the words.

const REACTION_TAG = Object.freeze({leave: 'leave', 'call-police': 'call-police', attack: 'attack'});
// When each tag is the right one, in the words the model reads. A civilian who is robbed or held at gunpoint reports it; a vicious insult sends
// the person off; a ganger or a merc fights back.
const REACTION_WORDS = Object.freeze({
  'call-police': 'you report V to the police (a robbery, a weapon, a threat to hurt or kill you)',
  attack: 'you turn on V and fight (a threat or an assault you will not take)',
  leave: 'you end the talk and walk or run off (a vicious insult, or V is too much for you)',
});
const REACTION_ORDER = Object.freeze(['leave', 'call-police', 'attack']);
// The order of the note: the serious reactions first.
const REACTION_NOTE_ORDER = Object.freeze(['call-police', 'attack', 'leave']);
// The code in a reply (normalCode above) -> the reaction kind of the offer.
const REACTION_OF_CODE = Object.freeze({LEAVE: 'leave', 'CALL-POLICE': 'call-police', ATTACK: 'attack'});
// A tag at the very end of the reply, after the words, with at most closing punctuation after it; or at the very start, before them.
const TRAILING_TAG = /\[\s*(leave|attack|call[ _-]?police|police)\s*\][\s.!?"'*)]*$/i;
const LEADING_TAG = /^[\s"'*(]*\[\s*(leave|attack|call[ _-]?police|police)\s*\]/i;

/** The note a reply is written with when the game offers these reactions: kept short, it is read on every turn of such a person. */
export function reactionNotes(kinds) {
  const list = REACTION_NOTE_ORDER.filter(kind => kinds?.includes(kind)).map(kind => `[${REACTION_TAG[kind]}] ${REACTION_WORDS[kind]}`).join('; ');
  if (!list) return '';
  return 'GAME REACTION: judge V\'s latest message, then begin your reply with exactly one tag, a space, and what you say out loud (one or two sentences, never the tag alone). '
    + 'If the message threatens to hurt or kill you, robs you, assaults you or is a vicious insult, react whatever your character is like (scared, calm or tough) with one of: ' + list + '. '
    + 'Anything else (small talk, questions, jokes, flirting, rude or annoyed remarks, "shut up", "go away", insults that are only rude, talk about violence in general) gets [none]. The tag is not spoken; the no-brackets rule does not apply to it.';
}

/** The kind of reaction when the whole reply is one reaction tag and nothing else ("[attack]"), else null. */
export function reactionOnlyTag(raw) {
  const {found, text} = splitActions(raw);
  return found.length === 1 && !text.trim() ? REACTION_OF_CODE[found[0].code] ?? null : null;
}

/** The note of the second request for a reply that was only a tag: the choice is made, the model is asked only for the words that go with it. */
export function reactionChosenNotes(kind) {
  return `GAME REACTION: you have just decided to ${REACTION_ACT[kind] ?? 'react'}. Say out loud, in one or two short sentences and in your own voice, what you say as you do it. Write no tag.`;
}
const REACTION_ACT = Object.freeze({leave: 'end the talk and walk away from V', 'call-police': 'report V to the police', attack: 'turn on V and attack'});

/**
 * The reaction an ordinary NPC's reply asked for, from the turn's offer (`config.companionAction`). Returns null when the turn offers none.
 *   kinds        the offered kinds
 *   notes        the sentence for the reply's prompt
 *   pick(raw)    {kind} for a reply that ends with an offered tag, else {kind: null, why}: 'no-tag', 'not-offered', 'not-at-end',
 *                'several-tags' or 'no-words' (codes only, never the words of the reply)
 *   resolve(kind)  the message for CompanionActions.deliver
 */
export function reactionMenu(offer) {
  const kinds = Array.isArray(offer?.reaction?.kinds) ? REACTION_ORDER.filter(kind => offer.reaction.kinds.includes(kind)) : [];
  if (!kinds.length || typeof offer.token !== 'string' || !offer.token) return null;
  return {
    kinds,
    notes: reactionNotes(kinds),
    pick(raw) {
      const text = String(raw ?? '');
      const {found, text: spoken} = splitActions(text);
      const asked = found.map(item => REACTION_OF_CODE[item.code]).filter(Boolean);
      if (!asked.length) return {kind: null, why: 'no-tag'};
      const end = TRAILING_TAG.exec(text.trimEnd()) ?? LEADING_TAG.exec(text);
      if (!end) return {kind: null, why: 'not-at-end'};
      if (found.length > 1) return {kind: null, why: 'several-tags'};
      if (!spoken.replace(/\s+/g, '').length) return {kind: null, why: 'no-words'};
      const kind = REACTION_OF_CODE[normalCode(end[1])];
      return kinds.includes(kind) ? {kind} : {kind: null, why: 'not-offered'};
    },
    resolve: kind => (kinds.includes(kind) ? {version: 1, token: offer.token, reaction: kind} : null),
  };
}
