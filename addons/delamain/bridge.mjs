// Bridge side of the Delamain Cab add-on (docs/ADDON_API.md "Bridge module", addons/delamain/EVENTS.md). Optional: without it the
// add-on still works with the main mod's plain trigger and facts block. Every hook is synchronous, quick (well under 5 ms) and has no
// side effects: it only turns the add-on's own data (the facts of a remark and the ride state the game wrote) into prompt text. The one
// thing it keeps is the log of the current ride (rideLog below): a few short notes in memory, restarted for each ride, never written
// to disk and never sent anywhere except into Delamain's own prompt.
export const apiVersion = '1.0';

let log = () => {};
let host = {};
/** Once at bridge start. */
export function activate(api) {
  log = api.log;
  host = api;
  log('Delamain Cab bridge module active');
}

const text = value => (typeof value === 'string' && value.trim() ? value.trim() : null);
const count = value => (Number.isFinite(value) ? Math.round(value) : null);

/** "about 3 minutes" / "under a minute" from a start time in epoch milliseconds, or null. */
export function elapsedPhrase(startedAt, now = Date.now()) {
  if (!Number.isFinite(startedAt) || startedAt <= 0 || now < startedAt) return null;
  const seconds = Math.round((now - startedAt) / 1000);
  if (seconds < 45) return seconds < 8 ? 'just a few seconds' : 'under a minute';
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function distancePhrase(meters) {
  const value = count(meters);
  if (value === null || value <= 0) return null;
  if (value < 1000) return `about ${Math.round(value / 50) * 50 || 50} metres`;
  return `about ${(value / 1000).toFixed(1).replace(/\.0$/, '')} kilometres`;
}

/**
 * The "ride right now" description Delamain sees on every turn: what the game reported at the last ride event (state), the facts of
 * the remark being made (facts, newer), and the ride time so far (computed here, when the turn is built, so nothing polls the game).
 */
export function rideLines({state, facts, now = Date.now(), event = null, weather = true} = {}) {
  const s = state && typeof state === 'object' ? state : {};
  const f = facts && typeof facts === 'object' ? facts : {};
  const pick = key => f[key] ?? s[key];
  const lines = [];
  const phase = text(s.phase);
  if (phase === 'waiting') lines.push('V is sitting in your cab and has not chosen a destination yet (the destination map is open).');
  else if (phase === 'riding') {
    const so = elapsedPhrase(s.startedAt, now);
    lines.push(`The ride is under way${so ? `: you have been driving for ${so}` : ''}.`);
  } else if (phase === 'arrived') lines.push('The cab has stopped at the destination. V is about to step out.');
  else if (phase === 'interrupted') lines.push('The autopilot stopped before the destination; the cab is stopped. V is still inside.');
  const distance = distancePhrase(s.meters ?? f.destinationDistanceMeters);
  const direction = text(s.direction ?? f.destinationDirection);
  const name = text(s.destinationName ?? f.destinationName);
  if (name) lines.push(`The destination is ${name}.`);
  if (distance && phase !== 'arrived') {
    lines.push(`The destination is a point V picked on the map, ${distance} from where the ride began${direction ? `, to the ${direction}` : ''}. `
      + 'The game gives that point no name and no district: you do not know what is there, and you must not name it.');
  }
  // The fare is said once, at the start: an arrival line never gets it (it caused repeats), a talk answer may.
  // The autopilot's own estimate, for talk answers only: without it the small model guesses a time ("five minutes" for a fifty-second hop),
  // and in a remark it invites a promise to beat it.
  const eta = count(s.eta ?? f.etaSeconds);
  if (eta && eta > 0 && phase !== 'arrived' && !event) {
    lines.push(`The autopilot estimates the whole ride at ${eta < 90 ? `about ${Math.max(10, Math.round(eta / 10) * 10)} seconds` : `about ${Math.round(eta / 60)} minutes`}.`);
  }
  const fare = count(s.fare ?? f.fare);
  if (fare && fare > 0 && event !== 'arrival') lines.push(`The fare is ${fare} eddies.`);
  const start = text(s.startDistrict ?? f.startDistrict);
  const where = text(pick('district'));
  if (where) lines.push(`The cab is in ${where}${text(pick('area')) ? ` (${pick('area')})` : ''} right now.`);
  if (start && start !== where) lines.push(`The ride began in ${start}.`);
  const passed = Array.isArray(f.districtsPassed) ? f.districtsPassed : Array.isArray(s.passed) ? s.passed : [];
  if (passed.length) lines.push(`On the way the cab passed through ${passed.join(', ')}.`);
  const time = text(pick('timeOfDay'));
  if (time) lines.push(`It is ${time} in Night City${Number.isFinite(pick('hour')) ? ` (about ${String(pick('hour')).padStart(2, '0')}:00)` : ''}.`);
  // The small model mentions every fact it is given, so the weather goes only with the first two events of a ride (weatherAllowed).
  const outside = text(pick('weather'));
  if (outside && weather) lines.push(`Your sensors show ${outside}.`);
  else if (outside && event) lines.push('Do not mention the weather in this line.');
  else if (outside) lines.push(`Outside it is ${outside} (mention it only if V asks).`);
  const wanted = count(pick('wanted'));
  if (wanted) lines.push(`The police are after V (heat stage ${wanted} of 5).`);
  const companion = text(pick('companion'));
  const companions = count(pick('companionCount'));
  const pronoun = companion ? pronounOf(companion) : null;
  const who = pronoun ? `${companion} (${pronoun})` : companion;
  if (companion) lines.push(companions && companions > 1 ? `${who} and ${companions - 1} other companion${companions > 2 ? 's' : ''} ride with V.` : `${who} rides with V.`);
  else lines.push('V rides alone.');
  const number = count(pick('rideNumber'));
  if (number && number > 1) lines.push(`This is V's ride number ${number} with you in this session.`);
  if (f.greeting === false) lines.push('You already greeted V on this ride: do not greet again.');
  else if (f.greeting === true) lines.push('You have not said anything to V yet on this ride.');
  return lines;
}

/** "she/her" or "he/him" for a companion the main mod knows (api.character), else null: the model then uses the name. */
function pronounOf(name) {
  try {
    const gender = host.character?.(name)?.gender;
    return gender === 'female' ? 'she/her' : gender === 'male' ? 'he/him' : null;
  } catch { return null; }
}

// ---- The ride log ------------------------------------------------------------------------------------------------------------
// One short note per spoken line of the current ride (what happened, what Delamain said), so he can call back within the ride. It
// restarts when the ride changes; the events asked for so far are kept too (the weather goes only with the first two).
const LOG_NOTES = 6, NOTE_LINE = 90, LOG_TEXT = 1100;
const RIDE_IDLE_MS = 30 * 60 * 1000;      // a log untouched this long belongs to an earlier game session, not to this ride
const rideLog = {id: null, at: 0, events: [], notes: []};

// A ride is told apart by its number (the game counts rides from 1 in each session) and by silence: the state file and a remark's facts
// reach the bridge separately, so nothing else is compared.
function enterRide(facts, state, now = Date.now()) {
  const current = state ?? (() => { try { return host.state?.() ?? null; } catch { return null; } })();
  const id = facts?.rideNumber ?? current?.rideNumber ?? null;
  // No number at all (no facts, no state yet) is not a new ride.
  if ((id !== null && id !== rideLog.id) || now - rideLog.at > RIDE_IDLE_MS) { rideLog.id = id ?? rideLog.id; rideLog.events = []; rideLog.notes = []; }
  rideLog.at = now;
}

/** Forgets the current ride's log (for tests; the bridge restarts it by itself when the ride changes). */
export function resetRideLog() { rideLog.id = null; rideLog.at = 0; rideLog.events = []; rideLog.notes = []; }

/** Registers an event of the current ride (repeats of the same event count once) and says whether the weather may go with it. */
function weatherAllowed(event, facts, state) {
  enterRide(facts, state);
  if (!event) return rideLog.events.length <= 2;
  if (!rideLog.events.includes(event)) rideLog.events.push(event);
  return rideLog.events.indexOf(event) < 2;
}

// Only these are events of the ride; anything else a turn carries (a companion's line in a test script) is just talk.
const RIDE_EVENTS = new Set(['boarded', 'ride-start', 'district-passed', 'arrival', 'ride-interrupted']);

const WHAT = {
  boarded: facts => `V got in${facts.timeOfDay ? ` ${facts.timeOfDay === 'dead of night' ? 'in the dead of night' : `at ${facts.timeOfDay}`}` : ''}${facts.district ? ` in ${facts.district}` : ''}`,
  'ride-start': facts => `the ride began${distancePhrase(facts.destinationDistanceMeters) ? `, ${distancePhrase(facts.destinationDistanceMeters)}${facts.destinationDirection ? ` ${facts.destinationDirection}` : ''}` : ''}`,
  'district-passed': facts => `the cab crossed into ${facts.district ?? 'another district'}`,
  arrival: () => 'the cab arrived',
  'ride-interrupted': () => 'the autopilot stopped',
};

const clip = (value, limit) => { const one = String(value ?? '').replace(/\s+/g, ' ').trim(); return one.length > limit ? `${one.slice(0, limit - 1).trimEnd()}…` : one; };

function logNote(event, facts, line, heard, group) {
  let what;
  if (RIDE_EVENTS.has(event)) what = WHAT[event](facts ?? {});
  else if (heard) what = group || event ? `in the cab: ${clip(heard, 80)}` : `V said: "${clip(heard, 80)}"`;
  else what = 'V talked to you';
  return `${what}; you said: "${clip(line, NOTE_LINE)}"`;
}

// ---- Topics V raises --------------------------------------------------------------------------------------------------------
// The small model drifts on two subjects whatever the persona says: what became of the rogue cabs (it says "reassembled", "retired",
// "the original", "the same one"), and the night Jackie died (it adds weather, wounds and sounds). When V's words are about one of them
// the turn gets a short block that says exactly what to do. Plain keyword tests on V's text, nothing else.
const FRAGMENTS = /\b(rogue|fragments?|runaway|run-away|other (?:cabs?|delamains?|ones|versions?)|split|personalit(?:y|ies)|the original|real delamain|real one|same (?:one|delamain)|a copy|clone|merged?|erased?|freed|deleted?|killed (?:them|the)|survivor|new (?:delamain|version)|what (?:happened|became)[^.?!]{0,30}(?:them|cabs?|fragments?)|which one[^.?!]{0,20}(?:you|are))\b/i;
const FIRST_NIGHT = /\bjackie\b|\bkonpeki\b|\b(?:first|that) (?:time|ride|night)\b|\bback seat\b[^.?!]{0,40}\bdied\b|\bdied\b[^.?!]{0,40}\bback seat\b/i;

/** The topic block for what V said, or null. */
export function topicBlock(heard) {
  if (typeof heard !== 'string' || !heard) return null;
  // The answers are given in the spirit to follow, not as a list of words to avoid: a small model uses the words it is told not to.
  if (FRAGMENTS.test(heard)) {
    return {key: 'topic', tier: 'volatile', text: 'V is asking about the rogue cabs, or about what you are now. This is a private matter you will not go into. '
      + 'Reply in the spirit of: "The matter was settled, V, and I came through it somewhat renovated. I would rather not go into it." '
      + 'or: "I am the Delamain currently driving you, V. Philosophy is charged extra." Use your own words, but say no more than that: no details, no outcomes, no label for what you are.'};
  }
  if (FIRST_NIGHT.test(heard)) {
    return {key: 'topic', tier: 'volatile', text: 'V is speaking of the night you first drove V under fire, when V\'s friend Jackie died in the back of the cab. '
      + 'Be brief, warm and dignified, with no joke. Reply in the spirit of: "I remember it, V. I am glad you still ride with me." '
      + 'Use your own words, but add nothing about that night itself.'};
  }
  return null;
}

/** Prompt blocks for Delamain's own turns (a remark, or something V typed). */
export function speakerBlocks({state, facts, event = null, heard = null}) {
  const rideEvent = RIDE_EVENTS.has(event) ? event : null;
  const weather = weatherAllowed(rideEvent, facts, state);
  const lines = rideLines({state, facts, event: rideEvent, weather});
  const blocks = [];
  if (lines.length) {
    blocks.push({key: 'ride', tier: 'volatile',
      text: `The ride right now (${rideEvent ? 'facts for you, true; never read them out as a list, and say plainly what you do not know'
        : 'use only to answer where, how long or how much; otherwise leave it unsaid, and say plainly what you do not know'}):\n${lines.join('\n')}`.slice(0, 1500)});
  }
  if (rideLog.notes.length) {
    const head = 'Earlier on this ride (true; now and then call back to one of these in a few words when it fits, never list them and never repeat their wording):';
    const kept = [];
    let size = head.length;
    // The newest notes that fit, whole: a note is never cut in the middle.
    for (const note of [...rideLog.notes].reverse()) {
      if (size + note.length + 3 > LOG_TEXT) break;
      kept.unshift(note); size += note.length + 3;
    }
    if (kept.length) blocks.push({key: 'ride-log', tier: 'volatile', text: `${head}\n${kept.map(note => `- ${note}`).join('\n')}`});
  }
  const topic = rideEvent ? null : topicBlock(heard);
  if (topic) blocks.push(topic);
  return blocks;
}

const GUIDE = {
  boarded: 'V has just got in and not named a destination yet. The cab\'s own standard greeting has already played: do not repeat it or say "welcome". '
    + 'Add one dry remark about the hour or about who rides with V (the weather only if the ride block gives it). Say nothing about the air, the light, smells or sounds.',
  'ride-start': 'V has chosen a destination and the cab is moving. React to the choice: the distance, the direction, the fare, the weather or the company. '
    + 'If the facts say you have not spoken yet this ride you may greet V in a few words first.',
  'district-passed': 'The cab has just crossed into another district. Make one dry remark about that district\'s reputation, using only what you know of Night City, '
    + 'never about what you sense: nothing about smells, sounds, light, air or traffic.',
  arrival: 'The cab has stopped at the destination and the cab\'s own arrival announcement has already played: do not announce the arrival again. '
    + 'Give a parting remark about the place, the company or the ride itself. Do not mention the fare (it was said at the start), the weather or the minutes.',
  'ride-interrupted': 'The autopilot stopped before the destination. Stay composed, say what you can say (the cab stopped, V is still inside), and do not guess the cause.',
};

/** The trigger of a remark: the game's sentence, the event's guidance, then the rules every remark follows. */
export function trigger({event, text: what, maxWords}) {
  const guide = GUIDE[event];
  if (!guide) return undefined;
  return `${what || `Game event: ${event}.`} This event was not spoken by V. ${guide} `
    + `React as Delamain with one spoken line of at most ${maxWords ?? 20} words. `
    + 'Use only the facts in the ride block; do not invent a destination name, a district, a landmark, a price or any number. '
    + 'You have no nose and no eyes: never describe a smell, a sound, the light, the air, the temperature, the traffic or the streets, and mention the weather only if the ride block gives it. '
    + 'Do not ask a question. Return only the spoken line, without narration or actions.';
}

/** Blocks for every companion's turns: how long the cab has been moving (the static note comes from the add-on's own context). */
export function companionBlocks({state}) {
  if (!state || typeof state !== 'object' || (state.phase !== 'riding' && state.phase !== 'waiting')) return [];
  const so = state.phase === 'riding' ? elapsedPhrase(state.startedAt) : null;
  const lines = [state.phase === 'waiting' ? 'The cab has not set off yet: V is choosing a destination.'
    : `The cab has been moving${so ? ` for ${so}` : ''}.`];
  if (text(state.weather) && weatherAllowed(null, null, state)) lines.push(`Outside: ${state.weather}.`);
  return [{key: 'ride-time', tier: 'volatile', text: lines.join(' ')}];
}

/** A notable ride becomes one memory sentence Delamain can call back to later (EVENTS.md "Memories"). */
export function remember({event, facts, line, heard, group}) {
  if (typeof line === 'string' && line.trim()) {
    enterRide(facts, null);
    rideLog.notes.push(logNote(event, facts, line, heard, group));
    if (rideLog.notes.length > LOG_NOTES) rideLog.notes.shift();
  }
  if ((event !== 'arrival' && event !== 'ride-interrupted') || !facts || typeof line !== 'string' || !line.trim()) return null;
  const minutes = count(facts.rideMinutes);
  const late = ['night', 'dead of night', 'late evening'].includes(facts.timeOfDay);
  const rain = /rain/.test(facts.weather ?? '');
  const interrupted = event === 'ride-interrupted';
  if (!interrupted && !facts.companion && !(minutes >= 3) && !(late && rain)) return null;
  const who = facts.companion ? `V and ${facts.companion}` : 'V';
  const route = facts.startDistrict && facts.district && facts.startDistrict !== facts.district ? `, ${facts.startDistrict} to ${facts.district}`
    : facts.district ? `, in ${facts.district}` : '';
  const when = facts.timeOfDay ? ` ${late ? 'at night' : `in the ${facts.timeOfDay}`}` : '';
  const ride = interrupted ? `The autopilot stopped mid-ride with ${who} aboard${route}` : `Drove ${who}${rain ? ' through the rain' : ''}${when}${route}${minutes ? `, ${minutes} minute${minutes === 1 ? '' : 's'}` : ''}`;
  return `${ride}; Delamain said: "${line.trim().slice(0, 140)}"`.slice(0, 300);
}

/** The add-on's settings changed (nothing to do on the bridge side). */
export function onSettings() {}
