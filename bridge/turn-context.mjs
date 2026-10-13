// What is going on around V right now, as one short block at the very FRONT of a turn's dynamic context.
// mod/turn-context.lua reads it on demand when a turn is built (game clock, district, who is with V, vehicle, V's gender and
// lifepath) and sends plain values. This module validates that snapshot, words it, and bounds it. Nothing is written to memory.
// It goes first so Mistral's context cap (head 60 percent, tail kept) can never cut it; Convai ignores the order.
// For a character with V it also states the plain truth about where she is and what she is doing (in person with V, on foot, sitting,
// riding, driving, fighting; what the companion modules know), and says that anything else is not true: a small model otherwise
// invents a place or a task for her ("I was just finishing some checks in the basement"), and a later turn builds on it.
// A stranger (an ordinary NPC or archetype) gets only what a bystander could see or know: the time, where it is, whether V is in
// a vehicle, whether V has company and V's apparent gender. Never the lifepath, the quest journal or the party's names.
// A phone chat (V texting a contact through the in-game phone; the reply is text) gets the time, V's district and what V is doing,
// and is told she is somewhere else with her own place and doing not given: she must neither claim to be with V nor invent where
// she is. She is not told who stands next to V: a person on the other end of a text could not know.
// Weather, V's health band, the police heat stage and a rough money band (added 2026-10-14; the CET calls are unconfirmed, so each is
// optional): a companion in person gets all four, a stranger gets the weather and a visible injury (a bystander sees both; never heat
// or money), a phone contact gets the weather where V is (like the time) and nothing else of V's body, wanted state or wallet.
import {placeName} from './protocol.mjs';

// The whole block, framing included (the phone's block is the longest: it also says what she cannot know).
export const MAX_CHARS = 800;
const MAX_NAME = 60, MAX_PARTY = 6;
const PLACE = /^[A-Za-z0-9][A-Za-z0-9 _.'-]{0,63}$/;
const LIFEPATHS = {nomad: 'Nomad', streetkid: 'Street Kid', corpo: 'Corpo'};
// What a companion is doing: [her state after "You are with V in person", the preposition for the place].
const ACTIVITIES = {
  following: [', on foot, following V', 'through'], standing: [', standing near V', 'in'], combat: [', in a fight alongside V', 'in'],
  'to-seat': [', walking over to sit down beside V', 'in'], seated: [', sitting beside V', 'in'],
  'getting-up': [', getting up from your seat beside V', 'in'], passenger: [", riding along in V's vehicle", 'through'],
  driving: [", driving V's vehicle", 'through'], boarding: [", getting into V's vehicle", 'in'],
  'leaving-car': [", getting out of V's vehicle", 'in'],
  attacking: [', going after a target V picked', 'in']};
// What a remote character is told to hold to: not with V, no view of V's surroundings, no invented place or doing of her own.
const PHONE_SUFFIX = " Treat this as fact: you are not with V and cannot see V's surroundings, and you do not know how near or far you are, so never say you are there, close or nearby. "
  + 'Never name a place you are at or a task you are doing right now or have just done; if asked, stay vague in your own way (your usual life is fine; plans and wishes are fine). Do not recite it.';
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
  if (Object.hasOwn(GENDERS, value.gender)) result.gender = value.gender;
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
  return Object.keys(result).length > 2 ? result : {version: 1, status: 'unavailable'};
}

/** "late night, about 2 AM": the part of the day, then the hour to the nearest whole hour. */
export function timeOfDay(hour, minute) {
  const part = hour < 5 ? 'late night' : hour < 7 ? 'early morning' : hour < 12 ? 'morning' : hour < 14 ? 'midday'
    : hour < 17 ? 'afternoon' : hour < 20 ? 'evening' : 'night';
  const rounded = Math.round((hour * 60 + minute) / 60) % 24;
  const clock = rounded === 0 ? 'midnight' : rounded === 12 ? 'noon' : `${rounded % 12 || 12} ${rounded < 12 ? 'AM' : 'PM'}`;
  return `${part}, about ${clock}`;
}

const listOf = names => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
const placeOf = snapshot => snapshot.district
  ? (snapshot.area ? `${placeName(snapshot.area) ?? snapshot.area}, ${placeName(snapshot.district) ?? snapshot.district}`
    : placeName(snapshot.district) ?? snapshot.district) : null;

// The block, plus what a per-turn diagnostic needs: how many facts it states, its length, or why there is none.
export function describeTurnContext(input, {ambient = false} = {}) {
  if (!input) return {text: '', parts: 0, reason: 'no input'};
  if (input.reaction) return {text: '', parts: 0, reason: 'automatic reaction'};
  if (input.turnContext === undefined) return {text: '', parts: 0, reason: 'the game sent none'};
  const snapshot = parseTurnContext(input.turnContext);
  if (!snapshot || snapshot.status !== 'ready') return {text: '', parts: 0, reason: 'unavailable or malformed'};
  const sentences = [];
  const place = placeOf(snapshot), phone = input.channel === 'phone';
  // The first sentence, so a budget cut never reaches it: where she is and what she is doing. She is in person with V (a face to
  // face talk, a companion, a voice chat) or on a call, and the call says nothing of her own place or doing.
  if (!ambient && !phone) {
    const mine = (snapshot.party ?? []).find(row => row.key === input.profileKey);
    const [state, via] = ACTIVITIES[mine?.activity] ?? ['', 'in'];
    sentences.push(`You are with V in person${state}${place ? ` ${via} ${place}` : ''}.`);
  } else if (!ambient && phone) {
    sentences.push(`You are messaging V by text on the phone, not talking to V in person${place ? `; V is in ${place}` : ''}. You are somewhere else; where you are and what you are doing are not given.`);
  }
  if (snapshot.hour !== undefined) sentences.push(`It is ${timeOfDay(snapshot.hour, snapshot.minute)}.`);
  // The weather goes to all three kinds of turn: a stranger or a contact on the phone could know it as well.
  if (snapshot.weather) sentences.push(WEATHER[snapshot.weather]);
  // An ordinary NPC is already told its own district (archetypeContext); say it only when that block had none.
  if (ambient && place && !input.archetype?.district) sentences.push(`You are in ${place}.`);
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
  if (!sentences.length) return {text: '', parts: 0, reason: 'empty'};
  const prefix = 'Right now (from the game, this turn only): ';
  const suffix = ambient
    ? ' You are a stranger to V and know only what you can see and hear. Background only; bring it up only when it fits.'
    : phone ? PHONE_SUFFIX : ' Treat this as fact: never claim to be anywhere else, or to have just been doing something, unless this says so (what you would like to do or will do is fine). Do not recite it.';
  // Over budget: drop whole sentences from the end, never cut one in half.
  const budget = MAX_CHARS - prefix.length - suffix.length;
  while (sentences.length && sentences.join(' ').length > budget) sentences.pop();
  if (!sentences.length) return {text: '', parts: 0, reason: 'over budget'};
  return {text: prefix + sentences.join(' ') + suffix, parts: sentences.length, reason: ''};
}

export const turnContext = (input, options) => describeTurnContext(input, options).text;

// One line per reply for the bridge log (stderr): whether this turn's context carried the block, or why not. Counts only.
export function turnContextDiagnostic(input, options) {
  const {text, parts, reason} = describeTurnContext(input, options);
  return text ? `Turn context: ${parts} facts, ${text.length} chars` : `Turn context: none (${reason})`;
}
