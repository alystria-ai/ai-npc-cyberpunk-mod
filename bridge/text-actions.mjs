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
// Offered here: drive to the map destination, fight the marked target, follow V (a world character), leave V's party, and the housemate
// choices STAY (live at V's place, the apartment id follows), MOVEOUT and JOIN (come along from home; a name or ALL follows). Distract is gone.
// There is no wait / stay / sit command in the game, so none is offered, and the prompt says so.

import {parseDriveUnavailable, DRIVE_LIMIT, SEATED_MODES, HOME_APARTMENT_NAMES} from './companion-actions.mjs';
import {screenWords, explicitRequest, certainWords} from './text-action-words.mjs';

export const ACTION_CODES = Object.freeze(['DRIVE', 'FIGHT', 'FOLLOW', 'LEAVE']);
// Housemates (docs/HOUSEMATES.md): live at V's place (an apartment id follows), move out, join V's party from home (a member name or ALL follows).
export const HOME_CODES = Object.freeze(['STAY', 'MOVEOUT', 'JOIN']);

export {DRIVE_LIMIT};

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
  // A companion who lives in another of V's flats than the one V stands in is not sent home on V's first word: she asks first (bridge/companion-actions.mjs
  // leaveAwayText). `asking` members have no leave this turn; once the question was asked (`confirmed`) V's answer is an ordinary leave.
  const asking = member => member.away === true && member.confirmed !== true;
  const standing = [];
  for (const member of members.filter(asking)) {
    const where = member.homeName ? data(member.homeName, 60) : "another of V's flats", here = member.hereName ? data(member.hereName, 60) : 'a different flat';
    standing.push(`${member.self ? 'You live' : `${data(member.name, 40)} lives`} in ${where} and V is in ${here} now. If V sends ${member.self ? 'you' : 'them'} away (go, go home, rest, leave), nobody leaves yet: `
      + `${member.self ? 'you ask' : 'the one concerned asks'} V in your own words whether ${member.self ? 'you' : 'she'} should stay here (then ${member.self ? 'you live' : 'she lives'} here from now on) or go back to ${where}, and nothing is carried out until V answers`);
  }
  if (members.some(member => !asking(member))) {
    const own = members.findIndex(member => member.self);
    if (members.length === 1 && own === 0) {
      rows.push({code: 'LEAVE', what: `leave V's company (V sends the companion away: "you can go", "go home", "we're done here", "I don't need you anymore", "I'll go on without you")`,
        tell: 'V is sending you away. You go your own way, and the game removes you from V\'s company right after your reply: say a short goodbye that fits you',
        resolve: () => ({...base, leave: 1})});
    } else {
      rows.push({code: 'LEAVE', what: `a companion leaves V's party (V sends one of ${members.filter(member => !asking(member)).map(member => data(member.name, 40)).join(', ')} away, or all of them); answer DISMISSED followed by that name, or DISMISSED ALL`,
        tell: 'V is sending a companion away. The game removes them from V\'s party right after your reply: the one leaving says a short goodbye that fits them',
        resolve: argument => {
          const wanted = word(argument);
          if (wanted === 'all' && members.length > 1 && !members.some(asking)) return {...base, leave: 'all'};
          // One unambiguous companion by the whole name or its first word.
          const hits = members.map((member, index) => ({index, full: word(member.name)}))
            .filter(row => !asking(members[row.index]) && wanted && (row.full === wanted || row.full.split(' ')[0] === wanted || wanted.split(' ')[0] === row.full.split(' ')[0]));
          return hits.length === 1 ? {...base, leave: hits[0].index + 1} : null;
        }});
    }
  }
  // Housemates (docs/HOUSEMATES.md): STAY (the apartment V names), MOVEOUT, JOIN (the people V calls into the party).
  const home = homeRows(offer, base, standing);
  rows.push(...home.rows);
  if (!rows.length && !limits.length && !standing.length) return null;
  const tail = [
    limits.length ? `Right now ${limits.join('; ')}. If V asks for that, say what is needed, in your own words, briefly.` : '',
    ...standing,
    `You cannot wait on a spot, ${home.rows.length ? '' : 'stay behind, '}sit on command or do any other task, whatever V says: do not agree to it or promise it.`,
  ].filter(Boolean);
  const named = rows.find(row => row.code === 'LEAVE' && /DISMISSED followed/.test(row.what));
  return {
    codes: rows.map(row => row.code), rows, limits,
    /** The offered codes V's words could be about (bridge/text-action-words.mjs); [] means no decision request is worth sending. */
    screen: (text, last) => home.screen(text, screenWords(text, {codes: rows.map(row => row.code), last}), rows),
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
      return found.length === 1 ? (home.guessable(text, found[0]) ? found[0] : null) : null;
    },
    /**
     * The safety net under a decision that failed or said none: the offered action V's line plainly asks for in plain words ("drive me", "take the
     * wheel", "attack him", "follow me"), as a decision, or null (bridge/text-action-words.mjs explicitRequest; never a leave).
     */
    explicit: text => {
      const code = explicitRequest(text, {codes: rows.map(row => row.code)});
      return code && rows.some(row => row.code === code) ? {code, argument: ''} : null;
    },
    /** What the words settle with no model (bridge/text-action-words.mjs certainWords): {code, argument}, {none: true} or null. */
    settle: (text, found) => found.some(code => HOME_CODES.includes(code)) ? null : certainWords(text, {codes: rows.map(row => row.code), found}),
    notes(code) {
      const row = rows.find(item => item.code === code);
      const head = row ? `GAME ACTIONS: ${row.tell}: agree in your own words, in one or two short sentences, and promise nothing more. Never speak of codes or the game.`
        : rows.length || standing.length ? 'GAME ACTIONS: V is not asking you to do anything the game can carry out this time; just answer.' : 'GAME ACTIONS: none is possible right now.';
      return [head, ...tail].join('\n');
    },
    classifier({text, last}) {
      if (!rows.length) return null;
      const wording = row => (row.code === 'LEAVE' ? 'DISMISSED' : row.code);
      const lines = rows.map(row => `${wording(row)}: ${row.what}`);
      // What exists in the game but cannot be done this turn: asked for, it is NONE. Without this a small model picks the nearest listed action.
      const blocked = ['drive V somewhere or be driven ("drive for me", "take the wheel", "take me there")', 'attack an enemy ("attack", "take him out")', 'come along with V ("follow me", "come with me")', 'leave V\'s company ("you can go")'].filter((_text, index) => !rows.some(row => row.code === ACTION_CODES[index]));
      return [{role: 'system', content: 'You read one message from V, the player of a video game, to a companion character and decide which game action, if any, V is asking the companion to do right now.\n'
        + 'Actions:\n' + lines.join('\n') + '\nNONE: anything else (conversation, questions, jokes, stories, remarks, thanks, "leave it", "forget it", or a request for something not listed).\n'
        + (blocked.length ? `These are not possible right now, so asking for any of them is NONE, never another action: ${blocked.join('; ')}.\n` : '')
        + home.rules
        + 'Rules: only V\'s new message counts. A request is a request even phrased as a question ("can you drive for me?", "could you take him out?"). A question about whether the companion could, would, knows how or has done it ("do you know how to drive?", "would you ever follow me?", "remember when you drove?") is NONE, and so is a hypothetical, a joke or a wish for later. "Let\'s leave this place", "leave it" and "I\'m leaving" do not send the companion away. The message may be in any language, in slang or with typos ("folow me", "u drive"): judge what V means. A story or remark that only contains the word ("I followed the news", "that drive-by scared me", "I\'m leaving the city someday") is NONE.\n'
        + `Answer with one word only: ${[...rows.map(wording), 'NONE'].join(', ')}${named ? ' (DISMISSED may be followed by a name or ALL)' : ''}${home.answerHint}.`},
      {role: 'user', content: `${last ? `Just before, V said: ${JSON.stringify(String(last.v ?? '').slice(0, 160))} and the companion answered: ${JSON.stringify(String(last.r ?? '').slice(0, 200))}\n\n` : ''}V's new message: ${JSON.stringify(String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 400))}`}];
    },
    decide(raw) {
      const match = /^\W*(drive|fight|follow|dismissed|leave|stay|move[ _-]?out|join|none)\b[\s:,=-]*([^\n]{0,40})/i.exec(String(raw ?? ''));
      if (!match) return null;
      const upper = match[1].toUpperCase().replace(/[ _-]/g, '');
      const code = upper === 'DISMISSED' ? 'LEAVE' : upper;
      const argument = match[2].trim().replace(/[.\s]+$/, '');
      // Only a leave, a stay (the apartment) or a join (the name) may carry a word; any other code followed by words is not a clear answer.
      if (code === 'NONE' || !rows.some(row => row.code === code) || (!['LEAVE', 'STAY', 'JOIN'].includes(code) && argument)) return null;
      return {code, argument};
    },
    message(decision) {
      const row = decision && rows.find(item => item.code === decision.code);
      return row ? row.resolve(decision.argument) : null;
    },
  };
}

// Housemates (docs/HOUSEMATES.md): the rows STAY / MOVEOUT / JOIN of a turn whose offer carries `home` ({apartments: [{id, name}], members: [{name, self}],
// moveOut?, here?, lives?, asked?, pick?}; bridge/companion-actions.mjs homeConfig). The model only picks among the offered names: an apartment id is resolved
// against the offer, a member by name, and anything else is no action. Standing sentences for the reply go into `standing`.
function homeRows(offer, base, standing) {
  const home = offer.home && typeof offer.home === 'object' ? offer.home : null;
  const rows = [];
  const idle = {rows, screen: (_text, found) => found, guessable: () => true, rules: '', answerHint: ''};
  if (!home) return idle;
  const apartments = (Array.isArray(home.apartments) ? home.apartments : []).filter(item => item && typeof item.id === 'string' && typeof item.name === 'string');
  const people = (Array.isArray(home.members) ? home.members : []).filter(item => item && typeof item.name === 'string');
  const aptOf = id => apartments.find(item => item.id === id) ?? null;
  const first = value => word(value).split(' ')[0];
  // The apartment V means when the model named one (the id, the name or its first word), else null.
  const apartmentIn = argument => {
    const wanted = word(argument);
    const hits = wanted ? apartments.filter(item => item.id === wanted || word(item.name) === wanted || first(item.name) === first(wanted) || item.id === first(wanted)) : [];
    return hits.length === 1 ? hits[0] : null;
  };
  // Where she moves in when V named no apartment: the answer to her question, the flat V is in, the one V chose in the settings, or the only one V has.
  const fallback = () => aptOf(home.asked?.here) ?? aptOf(home.here) ?? aptOf(home.fallback) ?? (apartments.length === 1 ? apartments[0] : null);
  const mentioned = text => {
    const line = ` ${word(text)} `;
    return apartments.filter(item => line.includes(` ${item.id} `) || word(item.name).split(' ').some(part => part.length >= 4 && line.includes(` ${part} `)));
  };
  const self = people.findIndex(item => item.self), many = people.length > 1;
  const kinds = [];
  if (typeof home.lives === 'string' && home.lives) standing.push(`You live at V's place, in ${data(home.lives, 60)}.`);
  if (apartments.length) {
    kinds.push('STAY');
    const here = aptOf(home.here), askedAt = aptOf(home.asked?.here), back = home.asked ? (aptOf(home.asked.from)?.name ?? HOME_APARTMENT_NAMES[home.asked.from]) : null;
    const list = apartments.map(item => `${item.id} = ${data(item.name, 60)}`).join(', ');
    rows.push({code: 'STAY', what: `let the companion live at V's place (V says she can stay, live or move in: "you can stay at my place", "move in with me", "you can crash at my place", "this can be your home"); `
        + `answer STAY followed by the id of the apartment V means (${list}). `
        + (askedAt && back ? `V was just asked whether she stays in ${data(askedAt.name, 60)} or goes back to ${data(back, 60)}: V saying she stays here is STAY ${askedAt.id}, V saying she goes back is NONE. ` : '')
        + (home.pick ? 'V already said she may live at V\'s place and she asked which apartment: V naming or pointing to one now ("the Glen one", "Corpo Plaza", "that one") is STAY with its id. ' : '')
        + `If V names none: ${fallback() ? `it is ${fallback().id}` : 'answer NONE (the companion asks which one)'}`,
      tell: `V is telling you that you may live at V's place (${apartments.map(item => data(item.name, 60)).join(', ')}${here ? `; V is in ${data(here.name, 60)} now` : ''}). The game registers it right after your reply. It only decides where you live: you stay with V in the party and go there when V sends you home. Say yes in your own words, briefly, like someone who was just offered a home, and do not say you are leaving V now`,
      resolve: argument => {
        const apartment = word(argument) ? apartmentIn(argument) : fallback();
        return apartment ? {...base, home: {op: 'stay', apartment: apartment.id}} : null;
      }});
    if (!fallback()) standing.push(`If V says you may stay or live at V's place without saying which of V's apartments (${apartments.map(item => data(item.name, 60)).join(', ')}), ask V in your own words which one: nothing happens until V answers.`);
  }
  if (home.moveOut === true) {
    kinds.push('MOVEOUT');
    rows.push({code: 'MOVEOUT', what: `the companion can no longer live at V's place (V says she has to move out: "you can't stay here any more", "time to find your own place", "pack your things"); "go home", "leave" and "you can go" are about V's company, not this`,
      tell: 'V is telling you that you can no longer live at V\'s place. You move out, and the game does it right after your reply: answer in character, briefly',
      resolve: () => ({...base, home: {op: 'move-out'}})});
  }
  if (people.length) {
    kinds.push('JOIN');
    rows.push({code: 'JOIN', what: many
        ? `people from V's place join V's party and come along (V asks one of ${people.map(item => data(item.name, 40)).join(', ')} to come along, or all of them: "come with me", "join us", "tag along", "everyone, let's go"); answer JOIN followed by that name, or JOIN ALL${!offer.group && self >= 0 ? ', or JOIN alone when V asks the companion she is talking to' : ''}`
        : 'come along with V from V\'s place and join the party (V asks the companion to come with them: "come with me", "join us", "tag along", "let\'s go" said to her)',
      tell: many ? 'V is asking people from V\'s place to come along and join V\'s party. The game does it right after your reply: the ones addressed agree in character, briefly'
        : 'V is asking you to come along and join V\'s party. You get ready, and the game does it right after your reply: agree in character, briefly',
      resolve: argument => {
        const wanted = word(argument);
        const to = target => ({...base, home: {op: 'join', target}});
        if (!wanted) return people.length === 1 ? to(1) : !offer.group && self >= 0 ? to(self + 1) : null;
        if (wanted === 'all') return many ? to('all') : to(1);
        const hits = people.map((item, index) => ({index, full: word(item.name)}))
          .filter(item => item.full === wanted || item.full.split(' ')[0] === wanted || wanted.split(' ')[0] === item.full.split(' ')[0]);
        return hits.length === 1 ? to(hits[0].index + 1) : null;
      }});
  }
  if (!kinds.length) return idle;
  const rules = [
    kinds.includes('STAY') ? '"Stay for dinner", "stay here a second", "stay put", "stay away" and keeping close for a while are NONE: STAY is only for letting the companion live at V\'s place.' : '',
    kinds.includes('MOVEOUT') ? 'MOVEOUT is only for telling the companion she can no longer live at V\'s place.' : '',
    kinds.includes('JOIN') ? 'JOIN is only for asking someone to come along and join V\'s party now: a "let\'s go" that does not include her, V going alone or talk about somebody else coming is NONE.' : '',
  ].filter(Boolean);
  return {
    rows, rules: rules.length ? rules.join('\n') + '\n' : '',
    answerHint: `${kinds.includes('STAY') ? ' (STAY must be followed by the apartment id)' : ''}${kinds.includes('JOIN') ? ' (JOIN may be followed by a name or ALL)' : ''}`,
    // A short answer to her own question, or a line that names one of V's apartments, may be about moving in even without a stem of the table.
    screen: (text, found, all) => {
      const out = [...found], add = code => { if (all.some(row => row.code === code) && !out.includes(code)) out.push(code); };
      if (home.asked && String(text ?? '').trim().split(/\s+/).length <= 8) { add('STAY'); add('LEAVE'); }
      // The answer to her "which apartment?" may be a word or two ("the loft", "that one").
      if (home.pick && String(text ?? '').trim().split(/\s+/).length <= 8) add('STAY');
      if (apartments.length && mentioned(text).length) add('STAY');
      return out;
    },
    // A move-in with no apartment named and none to fall back on is not written as agreed: the reply waits for the decision (and asks which).
    guessable: (text, code) => code !== 'STAY' || !!fallback() || mentioned(text).length > 0,
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
