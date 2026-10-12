// Companion actions for the text routes (Mistral, Groq, the local AI; docs/MISTRAL.md, "Actions").
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

import {parseDriveUnavailable} from './companion-actions.mjs';

export const ACTION_CODES = Object.freeze(['DRIVE', 'FIGHT', 'FOLLOW', 'LEAVE']);

// Why the game cannot let this companion drive V right now (codes: bridge/companion-actions.mjs). Each becomes one short sentence of what
// V has to do first.
export const DRIVE_LIMIT = Object.freeze({
  'player-driving': 'V is in the driver seat; V would have to get out of the car first, then ask',
  'player-seated': 'V is sitting in a car; V would have to get out first, then ask',
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
 */
export function actionMenu(offer) {
  if (!offer || typeof offer !== 'object' || typeof offer.token !== 'string' || !offer.token) return null;
  const rows = [];
  const limits = [];
  const base = {version: 1, token: offer.token};
  if (offer.drive !== false && typeof offer.destinationName === 'string') {
    rows.push({code: 'DRIVE', what: `drive V in V's car to the map destination (V asks to be driven, to take the wheel, to be taken somewhere)`,
      tell: `V is asking you to drive them in their car ${data(offer.carName ?? "V's car")} to the map destination ${data(offer.destinationName)}. You take the wheel and the game starts it right after your reply`,
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

// A code in a reply is never spoken: the character is not told about codes, but a small model may still write one.
const TAG = /\[\s*(?:action\s*[:=]\s*)?(drive|fight|follow|leave|dismissed|none)\b\s*(?:[:=]\s*([^\]\n]{0,40}))?\]/gi;
const LOWER_CODES = ['drive', 'fight', 'follow', 'leave', 'dismissed', 'none'];

// Is this unfinished bracket group (it starts with "[" and runs to the end of the text) the start of a code?
function couldBeCode(partial) {
  let body = partial.slice(1).trimStart().toLowerCase();
  if (/^[a-z]*$/.test(body) && 'action'.startsWith(body)) return true;   // "", "a", "act", ...
  body = body.replace(/^action\s*[:=]\s*/, '');
  if (body === '') return true;
  const head = /^[a-z]+/.exec(body)?.[0] ?? '';
  if (!head) return false;
  if (head.length === body.length) return LOWER_CODES.some(code => code.startsWith(head));
  return LOWER_CODES.includes(head);   // a whole code followed by an argument that is still being written
}

/**
 * The reply text without any action code, and the codes found: [{code, argument}] in order (informational: a code in a reply never
 * starts an action). `streaming`: the text is still being written, so an unfinished code at its end ("[DR") is held back.
 */
export function splitActions(raw, {streaming = false} = {}) {
  const found = [];
  let text = String(raw ?? '').replace(TAG, (_match, code, argument) => { found.push({code: code.toUpperCase() === 'DISMISSED' ? 'LEAVE' : code.toUpperCase(), argument: argument?.trim() || ''}); return ' '; });
  if (streaming) {
    const at = text.lastIndexOf('[');
    if (at >= 0 && !text.includes(']', at) && text.length - at <= 52 && couldBeCode(text.slice(at))) text = text.slice(0, at);
  }
  if (found.length) text = text.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.!?;:])/g, '$1').replace(/^\s+/, '');
  return {text, found};
}
