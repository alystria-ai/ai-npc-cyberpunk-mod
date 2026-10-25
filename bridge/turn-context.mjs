// What is going on around V right now, as one short block at the very FRONT of a turn's dynamic context.
// mod/turn-context.lua reads it on demand when a turn is built (game clock, district, who is with V, vehicle, V's gender and
// lifepath) and sends plain values. This module validates that snapshot, words it, and bounds it. Nothing is written to memory.
// It goes first so Mistral's context cap (head 60 percent, tail kept) can never cut it; Convai ignores the order.
// For a character with V it also states the plain truth about where she is and what she is doing (in person with V, on foot, sitting,
// riding, driving, fighting; what the companion modules know), and says that anything else is not true: a small model otherwise
// invents a place or a task for her ("I was just finishing some checks in the basement"), and a later turn builds on it.
// Where she is is worded by bridge/place-names.mjs (a named place only from the game's own record; indoors or outdoors when the game says,
// else "which street or building is not given"), and a companion in person is told her usual workplace, home and hangouts are not here:
// a model with a bar in its profile otherwise puts V in the bar (live 2026-10-15, docs/DYNAMIC_CONTEXT_AUDIT.md, "where V is").
// A stranger (an ordinary NPC or archetype) gets only what a bystander could see or know: the time, where it is, whether V is in
// a vehicle, whether V has company and V's apparent gender. Never the lifepath, the quest journal or the party's names.
// A phone chat (V texting a contact through the in-game phone; the reply is text) gets the time, V's district and what V is doing,
// and is told she is somewhere else with her own place and doing not given: she must neither claim to be with V nor invent where
// she is. She is not told who stands next to V: a person on the other end of a text could not know.
// Weather, V's health band, the police heat stage and a rough money band (added 2026-10-14; the CET calls are unconfirmed, so each is
// optional): a companion in person gets all four, a stranger gets the weather and a visible injury (a bystander sees both; never heat
// or money), a phone contact gets the weather where V is (like the time) and nothing else of V's body, wanted state or wallet.
// The weather and the part of the day are scenery, not news: stated on every turn they became the topic (a player report of 2026-10-21,
// "the NPCs always mention the weather"). With `split` they leave this block for a short "Background" line of their own (describeTurnContext
// `background`), which carries each only when it is new to the conversation (bridge/scenery-memory.mjs; sceneryFor below): the first turn, a
// change, after a long silence, or when V asks. Health, heat and money stay in the block: they are V's standing state, and one that matters.
// Where she is (2026-10-22, a player report: "standing in the middle of Little China" while V was in the H10 apartment, and a place worked into
// replies that did not need it): the place is its own modest sentence after the first one, never part of it, because the first sentence is said
// again right before V's words (bridge/mistral-prompt.mjs HERE) and a place there got worked into every reply. Inside, outside or "somewhere in"
// the area, never "standing in" a district; the guidance says to mention a place or the time only when it matters to what V says.
// Settings > Dynamic info (bridge/dynamic-info.mjs): `off`, the kinds the player turned off, are taken out of the snapshot before it is worded.
import {describePlace} from './place-names.mjs';
import {headOf} from './johnny-head.mjs';
import {sceneryMemory} from './scenery-memory.mjs';
import {stripSnapshot, NO_KINDS} from './dynamic-info.mjs';

// The whole block, framing included (the phone's block is the longest: it also says what she cannot know).
export const MAX_CHARS = 900;
const MAX_NAME = 60, MAX_PARTY = 6;
const PLACE = /^[A-Za-z0-9][A-Za-z0-9 _.'-]{0,63}$/;
const LIFEPATHS = {nomad: 'Nomad', streetkid: 'Street Kid', corpo: 'Corpo'};
// What a companion is doing, after "You are with V in person".
const ACTIVITIES = {
  following: ', on foot, following V', standing: ', standing near V', combat: ', in a fight alongside V',
  'to-seat': ', walking over to sit down beside V', seated: ', sitting beside V',
  'getting-up': ', getting up from your seat beside V', passenger: ", riding along in V's vehicle",
  driving: ", driving V's vehicle", boarding: ", getting into V's vehicle",
  'leaving-car': ", getting out of V's vehicle",
  attacking: ', going after a target V picked'};
// Said last in every form: the facts are scenery unless the talk needs them.
const MENTION = ' Do not recite it, and mention a place or the time only if it matters to what V says.';
// What a remote character is told to hold to: not with V, no view of V's surroundings, no invented place or doing of her own.
const PHONE_SUFFIX = " Treat this as fact: you are not with V and cannot see V's surroundings, and you do not know how near or far you are, so never say you are there, close or nearby. "
  + 'Never name a place you are at or a task you are doing right now or have just done; if asked, stay vague in your own way (your usual life is fine; plans and wishes are fine).' + MENTION;
// A holocall (docs/HOLOCALL.md): V called her from the phone and they talk by voice, with or without the live picture. Like a phone
// contact she is somewhere else with her own place and doing not given, and learns nothing of V's company, heat or wallet.
const CALL_SUFFIX = " Treat this as fact: you are on a call, not with V, and you do not know how near or far you are, so never say you are there, close or nearby. "
  + 'Never name a place you are at or a task you are doing right now or have just done; if asked, stay vague in your own way (your usual life is fine; plans and wishes are fine).' + MENTION;
// Johnny in V's head (docs/JOHNNY_IN_YOUR_HEAD.md): he has no body and goes where V goes. He knows what V sees and feels, so he gets
// what a companion in person gets (company, health, heat, money), but never a place or a doing of his own.
const HEAD_SUFFIX = ' Treat this as fact: you have no body here and go wherever V goes; never claim to be anywhere else, to touch, carry or'
  + ' see anything V does not, or to have been doing something on your own.' + MENTION;
const MOTIONS = {still: 'standing still', walking: 'walking', running: 'running'};
const GENDERS = {female: 'a woman (she/her)', male: 'a man (he/him)'};
// Weather kinds the game side sends (mod/turn-context.lua weatherKind), V's health bands and the money bands.
const WEATHER = {clear: 'The sky is clear.', cloudy: 'The sky is overcast.', rain: 'It is raining.', 'heavy-rain': 'It is pouring rain.',
  'toxic-rain': 'Toxic rain is falling.', fog: 'It is foggy.', smog: 'The air is thick with smog.', sandstorm: 'A sandstorm is blowing.'};
// A stranger can only see an injury, so the wording says "looks"; a healthy V is not mentioned at all.
const HEALTH = {healthy: null, hurt: ['V is hurt.', 'V looks hurt.'], 'badly-hurt': ['V is badly hurt.', 'V looks badly hurt.']};
const MONEY = {broke: 'V is nearly broke.', low: 'V is short on cash.', ok: null, comfortable: 'V has plenty of eddies.', rich: 'V is rich.'};
const heatSentence = stage => stage >= 5 ? 'V is wanted at the highest level; MaxTac is after V.'
  : stage >= 3 ? 'V has a serious police chase on them.' : stage >= 1 ? 'The police are after V.' : null;
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);

function clean(value, limit) {
  if (typeof value !== 'string' || value.length > limit) return null;
  const text = value.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text && !text.startsWith('LocKey#') ? text : null;
}
// CET encodes an empty Lua sequence as an empty JSON object.
function sequence(value, limit) {
  if (Array.isArray(value)) return value.length <= limit ? value : null;
  return plain(value) && Object.keys(value).length === 0 ? [] : null;
}

// Fail closed on the shape, fail soft on a field: a bad field is simply absent, a malformed snapshot carries nothing but
// never loses the message.
export function parseTurnContext(value) {
  if (value === undefined) return undefined;
  if (!plain(value) || value.version !== 1 || value.status !== 'ready') return {version: 1, status: 'unavailable'};
  const result = {version: 1, status: 'ready'};
  if (Number.isInteger(value.hour) && value.hour >= 0 && value.hour <= 23
      && Number.isInteger(value.minute) && value.minute >= 0 && value.minute <= 59) {
    result.hour = value.hour; result.minute = value.minute;
  }
  if (typeof value.district === 'string' && PLACE.test(value.district)) {
    result.district = value.district;
    if (typeof value.area === 'string' && PLACE.test(value.area) && value.area !== value.district) result.area = value.area;
  }
  // Whether V is inside a building (an unconfirmed native read, so it is absent when the game could not say). It only sharpens the place.
  if (typeof value.indoors === 'boolean' && result.district) result.indoors = value.indoors;
  if (Object.hasOwn(GENDERS, value.gender)) result.gender = value.gender;
  if (Object.hasOwn(GENDERS, value.voice)) result.voice = value.voice;
  if (Object.hasOwn(LIFEPATHS, value.lifepath)) result.lifepath = value.lifepath;
  if (Object.hasOwn(WEATHER, value.weather)) result.weather = value.weather;
  if (Object.hasOwn(HEALTH, value.health)) result.health = value.health;
  if (Number.isInteger(value.heat) && value.heat >= 0 && value.heat <= 5) result.heat = value.heat;
  if (Object.hasOwn(MONEY, value.money)) result.money = value.money;
  if (typeof value.vehicle === 'boolean') result.vehicle = value.vehicle;
  if (value.vehicle === true && typeof value.driving === 'boolean') result.driving = value.driving;
  if (Object.hasOwn(MOTIONS, value.motion) && value.vehicle !== true) result.motion = value.motion;
  const rows = sequence(value.party, MAX_PARTY * 2);
  if (rows) {
    const party = [], seen = new Set();
    for (const row of rows) {
      const name = clean(row?.name, MAX_NAME);
      if (!plain(row) || typeof row.key !== 'string' || !/^[a-z0-9-]{1,80}$/.test(row.key) || !name || seen.has(row.key)) continue;
      seen.add(row.key); party.push({key: row.key, name, ...(Object.hasOwn(ACTIVITIES, row.activity) ? {activity: row.activity} : {})});
      if (party.length >= MAX_PARTY) break;
    }
    if (party.length) result.party = party;
  }
  // The game's dialogue loudness (0 to 1), sent only while V's voice for typed lines is on (bridge/v-voice.mjs). It is no part of
  // the words written for the model, so it never makes an otherwise empty snapshot count as something read (with every Dynamic info
  // switch off it is all there is, and it still reaches V's voice).
  const volume = typeof value.dialogueVolume === 'number' && Number.isFinite(value.dialogueVolume) && value.dialogueVolume >= 0 && value.dialogueVolume <= 1
    ? {dialogueVolume: value.dialogueVolume} : {};
  if (Object.keys(result).length <= 2) return {version: 1, status: 'unavailable', ...volume};
  return {...result, ...volume};
}

const dayPart = hour => hour < 5 ? 'late night' : hour < 7 ? 'early morning' : hour < 12 ? 'morning' : hour < 14 ? 'midday'
  : hour < 17 ? 'afternoon' : hour < 20 ? 'evening' : 'night';

/** "late night, about 2 AM": the part of the day, then the hour to the nearest whole hour. */
export function timeOfDay(hour, minute) {
  const part = dayPart(hour);
  const rounded = Math.round((hour * 60 + minute) / 60) % 24;
  const clock = rounded === 0 ? 'midnight' : rounded === 12 ? 'noon' : `${rounded % 12 || 12} ${rounded < 12 ? 'AM' : 'PM'}`;
  return `${part}, about ${clock}`;
}

const listOf = names => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
// Where V is: {text, inside, kind} (bridge/place-names.mjs), or null. A named place only when the game's own record says V is there.
const placeOf = snapshot => describePlace({district: snapshot.district, area: snapshot.area, indoors: snapshot.indoors});

// Where V (or the companion in person) is, as one modest sentence of its own: [subject, verb] is ['You', 'are'] or ['V', 'is']. A named interior
// (V's apartment, a bar, a clinic) says "inside"; the Badlands say "outdoors"; a plain neighbourhood says indoors or outdoors when the game's
// own reading does, else only that it is somewhere in the area. Never "standing in" a district: a companion with a workplace in her profile
// otherwise fills the gap with that workplace (live 2026-10-15), and one told "standing in Little China" said so while V was indoors (2026-10-22).
function whereSentence(place, [who, be], vehicle = false) {
  if (!place) return null;
  if (place.kind === 'home' || place.kind === 'venue') return `${who} ${be} inside ${place.text}.`;
  if (place.kind === 'wild') return `${who} ${be} outdoors in ${place.text}, out in open country.`;
  if (place.inside === true) return `${who} ${be} indoors, in a building in ${place.text}; which building is not given.`;
  // In a vehicle the game's interior flag says nothing about the air around the car: no "open air" then.
  if (place.inside === false && !vehicle) return `${who} ${be} outdoors in ${place.text}, in the open air, not inside a building.`;
  return `${who} ${be} somewhere in ${place.text}; exactly where is not given.`;
}
const YOU = ['You', 'are'], V = ['V', 'is'];

// A holocall turn's call (bridge/protocol.mjs parseHolocall), or null.
const holocallOf = input => plain(input.holocall) && (input.holocall.mode === 'audio' || input.holocall.mode === 'holo') ? input.holocall : null;

// An add-on voice with no body (a cab's AI, docs/ADDON_API.md persona.voiceContext) is not a person standing beside V: it is never told it is
// "with V in person", it does not learn V's lifepath, wallet, health or heat, and it is told who else is with V only in a group conversation
// (live 2026-10-14: "Also with V: Alex" made the cab address V's companion in private talk). It gets neither the clock nor the weather
// here either: a small model recites whatever it is given on every turn ("The rain is a minor inconvenience" in seven talk answers of ten),
// and the add-on's own state block gives the hour and the weather when V asks about them.
function voiceTurnContext(input, snapshot) {
  const sentences = [];
  const others = input.group ? (snapshot.party ?? []).filter(row => row.key !== input.profileKey) : [];
  if (others.length) sentences.push(`Also with V: ${listOf(others.map(row => row.name))}.`);
  if (!sentences.length) return {text: '', parts: 0, reason: 'a voice gets only who is in a group round'};
  const prefix = 'Right now (from the game, this turn only): ';
  const suffix = ' Background only: never recite it, and bring it up only when it fits or V asks.';
  return {text: prefix + sentences.join(' ') + suffix, parts: sentences.length, reason: ''};
}

// Which of the weather and the part of the day this turn states ({weather, time}, booleans): each only when new to the conversation
// (bridge/scenery-memory.mjs). Everything is stated for a turn with nothing to decide on (no snapshot, a reaction, no turn id).
const EVERYTHING = Object.freeze({weather: true, time: true});
export function sceneryFor(input, memory = sceneryMemory, off = NO_KINDS) {
  if (!input || input.reaction || input.turnContext === undefined) return EVERYTHING;
  const snapshot = stripSnapshot(parseTurnContext(input.turnContext), off);
  if (!snapshot || snapshot.status !== 'ready') return EVERYTHING;
  // One conversation: a character, one physical NPC (its entity) or one phone contact.
  return memory.decide({key: `${input.channel === 'phone' ? 'phone' : 'talk'}|${input.profileKey}|${input.entity ?? ''}`, id: input.requestId ?? input.id,
    weather: snapshot.weather, part: snapshot.hour === undefined ? undefined : dayPart(snapshot.hour), text: input.text});
}
const BACKGROUND = 'Background (mention only if it matters or V asks):';

// The block, plus what a per-turn diagnostic needs: how many facts it states, its length, or why there is none.
// `fresh` ({weather, time}, default both) leaves out a fact the conversation was already told. `split` moves the weather and the time out
// of the block into `background` (its own short line, "" when there is none), so the block itself does not change when they come and go and
// the text provider's prompt cache keeps its prefix: the bridge puts it in the volatile tail (bridge/quest-context.mjs).
export function describeTurnContext(input, {ambient = false, voice = false, split = false, fresh = EVERYTHING, off = NO_KINDS} = {}) {
  if (!input) return {text: '', background: '', parts: 0, reason: 'no input'};
  if (input.reaction) return {text: '', background: '', parts: 0, reason: 'automatic reaction'};
  if (input.turnContext === undefined) return {text: '', background: '', parts: 0, reason: 'the game sent none'};
  const snapshot = stripSnapshot(parseTurnContext(input.turnContext), off);
  if (!snapshot || snapshot.status !== 'ready') return {text: '', background: '', parts: 0, reason: 'unavailable or malformed'};
  if (voice) return {...voiceTurnContext(input, snapshot), background: ''};
  const sentences = [], scenery = [];
  const scene = (kind, sentence) => { if (fresh[kind] !== false) (split ? scenery : sentences).push(sentence); };
  const head = !ambient && input.channel !== 'phone' ? headOf(input) : null;
  const call = !ambient && !head && !input.group && input.channel !== 'phone' ? holocallOf(input) : null;
  // Remote: a phone chat or a holocall. Neither learns who is with V, V's heat or V's money.
  const spot = placeOf(snapshot), phone = input.channel === 'phone' || call !== null;
  const pushWhere = who => { const text = whereSentence(spot, who, snapshot.vehicle === true); if (text) sentences.push(text); };
  // The first sentence, so a budget cut never reaches it: where she is and what she is doing. She is in person with V (a face to
  // face talk, a companion, a voice chat) or on a call, and the call says nothing of her own place or doing.
  if (head) {
    // One sentence (bridge/mistral-prompt.mjs HERE): where he is, and where V is.
    sentences.push("You are in V's head, the engram on the Relic: you see what V sees and hear what V hears, nobody else sees or hears you, and V talks to you under their breath.");
    pushWhere(V);
  } else if (!ambient && !phone) {
    const mine = (snapshot.party ?? []).find(row => row.key === input.profileKey);
    sentences.push(`You are with V in person${ACTIVITIES[mine?.activity] ?? ''}.`);
    pushWhere(YOU);
  } else if (call) {
    const where = '. You are somewhere else; where you are and what you are doing are not given.';
    sentences.push(call.mode === 'holo'
      ? `You are on a holocall with V (a video call on the phone): you see and hear each other, but you are not with V in person${where}`
      : `You are on a voice call with V on the phone, not talking to V in person${where}`);
    pushWhere(V);
  } else if (!ambient && phone) {
    sentences.push('You are messaging V by text on the phone, not talking to V in person. You are somewhere else; where you are and what you are doing are not given.');
    pushWhere(V);
  }
  if (snapshot.hour !== undefined) scene('time', `It is ${timeOfDay(snapshot.hour, snapshot.minute)}.`);
  // The weather goes to all three kinds of turn: a stranger or a contact on the phone could know it as well.
  if (snapshot.weather) scene('weather', WEATHER[snapshot.weather]);
  // An ordinary NPC is already told its own district (archetypeContext); say it only when that block had none.
  if (ambient && spot && !input.archetype?.district) pushWhere(YOU);
  const others = phone ? [] : (snapshot.party ?? []).filter(row => row.key !== input.profileKey);
  if (others.length) {
    sentences.push(ambient ? `V has ${others.length === 1 ? 'one other person' : `${others.length} other people`} with them.`
      : `Also with V: ${listOf(others.map(row => row.name))}.`);
  }
  if (snapshot.vehicle === true) sentences.push(snapshot.driving === true ? 'V is driving.' : 'V is in a vehicle.');
  if (!ambient && snapshot.motion) sentences.push(`V is ${MOTIONS[snapshot.motion]}.`);
  // V's condition: an injury a stranger could see, and for a companion in person also the police heat. Never on the phone.
  const hurt = HEALTH[snapshot.health];
  if (hurt && !phone) sentences.push(hurt[ambient ? 1 : 0]);
  const heat = !ambient && !phone && snapshot.heat !== undefined ? heatSentence(snapshot.heat) : null;
  if (heat) sentences.push(heat);
  const sex = GENDERS[snapshot.gender], lifepath = LIFEPATHS[snapshot.lifepath];
  if (ambient) {
    if (sex) sentences.push(`V looks like ${sex}.`);
  } else if (sex || lifepath) {
    sentences.push(`V is ${[sex, lifepath ? `lifepath ${lifepath}` : null].filter(Boolean).join(', ')}.`);
  }
  // Money is the least urgent fact, so it goes last and is the first to go in a budget cut. A companion in person only.
  if (!ambient && !phone && MONEY[snapshot.money]) sentences.push(MONEY[snapshot.money]);
  const background = scenery.length ? `${BACKGROUND} ${scenery.join(' ')}` : '';
  // A stranger hears who V is to them on every turn, with or without other facts: a player report (2026-10-25) had every pedestrian and guard talk as if they knew V.
  if (!sentences.length) return ambient ? {text: STRANGER_NOTE, background, parts: scenery.length, reason: ''} : {text: '', background, parts: scenery.length, reason: background ? '' : 'empty'};
  const prefix = 'Right now (from the game, this turn only): ';
  const suffix = ambient
    ? ` ${STRANGER_NOTE} Background only; bring it up only when it matters to what V says.`
    : head ? HEAD_SUFFIX : call ? CALL_SUFFIX : phone ? PHONE_SUFFIX : ' Treat this as fact: never claim to be anywhere else, or to have just been doing something, unless this says so (what you would like to do or will do is fine).'
      + ' Your usual workplace, home and hangouts are not here unless this says so: never greet or serve V as if V had come to them.' + MENTION;
  // Over budget: drop whole sentences from the end, never cut one in half.
  const budget = MAX_CHARS - prefix.length - suffix.length;
  while (sentences.length && sentences.join(' ').length > budget) sentences.pop();
  if (!sentences.length) return ambient ? {text: STRANGER_NOTE, background, parts: scenery.length, reason: ''} : {text: '', background, parts: scenery.length, reason: background ? '' : 'over budget'};
  return {text: prefix + sentences.join(' ') + suffix, background, parts: sentences.length + scenery.length, reason: ''};
}

// What a stranger knows of V: nothing, not even the name the prompt uses for the player.
export const STRANGER_NOTE = 'You have never met V and do not know who V is: "V" is only what this prompt calls the person in front of you, not a name you know. '
  + 'Never call them V or by any name, and never talk as if you knew them, unless they tell you their name in this talk or the context says you know who they are. You know only what you can see and hear.';

export const turnContext = (input, options) => describeTurnContext(input, options).text;   // options: {ambient, voice, split, fresh}

// One line per reply for the bridge log (stderr): whether this turn's context carried the block, or why not. Counts only.
export function turnContextDiagnostic(input, options) {
  const {text, background, parts, reason} = describeTurnContext(input, options);   // `voice` in the options: the form an add-on voice gets
  const head = input && input.channel !== 'phone' && headOf(input) ? ` head=${input.head.stage}` : '';
  const call = head ? head : input && !input.group && input.channel !== 'phone' && holocallOf(input) ? ` holocall=${input.holocall.mode}` : '';
  // With `split`, say whether the background line (the weather, the time) went along: counts only.
  const apart = options?.split ? (background ? ` background=${background.length}` : ' background=none') : '';
  return text || background ? `Turn context: ${parts} facts, ${text.length + background.length} chars${call}${apart}` : `Turn context: none (${reason})${call}`;
}
