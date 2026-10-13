// Bridge side of the Skippy add-on (docs/ADDON_API.md, "Bridge module"). Quick and side-effect free apart from the small session
// notebook below, which only the `remember` hook writes. It turns the facts of a remark (addons/skippy/EVENTS.md) into a short block
// of plain words for the model, names one joke style (a "device", docs/addons/SKIPPY_BIBLE.md section 5) for the line so remarks that
// come every ten seconds do not share a shape, and tells the model how recent lines opened and which jokes it has overused, so it
// starts and jokes differently. The persona and the modes live in convai-addon.json.
export const apiVersion = '1.0';

let log = () => {};
export function activate(api) { log = api.log; }

const val = (object, key) => (object && typeof object === 'object' ? object[key] : undefined);
const join = parts => parts.filter(Boolean).join(', ');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** From this many metres a distance is worth saying; a nearer shot never gets its metres mentioned (the engine uses the same number). */
export const LONG_SHOT_METRES = 30;

// ---- The device kit --------------------------------------------------------------------------------------------------------

const DEVICES = {
  killer: {
    'provocation': 'Provocation: say the word Provocation, then a crude cartoon taunt at the enemy',
    'fun fact': 'Fun fact: a morbid or absurd fact about the enemy or the wound',
    'notice': 'Notice: a deadpan system notification about a target',
    'error': 'Error: an error message or a bug report about V\'s aim',
    'achievement': 'Achievement: an absurd achievement title',
    'rating': 'Rating: a survey, review or star rating request',
    'fine print': 'Fine print: warranty, terms of service or a legal disclaimer',
    'volume': 'Volume: raise your own volume by a silly percentage and shout in capitals',
    'loading': 'Loading: the loading hum or an update at the worst moment',
    'diagnostic': 'Diagnostic: a readout of your own joy, heat or stress',
    'sponsor': 'Sponsor: an advert read in the middle of the fight',
    'pro tip': 'Pro tip: a cheerful murder tip',
    'outburst': 'Outburst: a plain emotional gasp or brag with no label',
    'callback': 'Callback: a nod to one of your recent lines or an earlier moment, in completely new words',
  },
  puppy: {
    'get well soon': 'Get well soon: cheerful recovery wishes for a crippled enemy',
    'incident report': 'Incident report: file a death as an incident, an accident or a misunderstanding',
    'denial': 'Denial: insist the dead one is just resting',
    'medical': 'Medical: physiotherapy, ripperdoc, Trauma Team or cane advice',
    'apology': 'Apology: apologise to a target or a body part',
    'volume': 'Volume: raise your own volume by a silly percentage and shout in capitals, in panic',
    'loading': 'Loading: the loading hum or an update at the worst moment',
    'diagnostic': 'Diagnostic: a readout of your own stress, guilt or relief',
    'sponsor': 'Sponsor: an advert for something gentle, read in the middle of the fight',
    'wellness tip': 'Wellness tip: a self-care tip at the worst possible moment',
    'rating': 'Rating: a survey or star rating request about kindness',
    'puppies': 'Puppies: think about puppies to calm down',
    'outburst': 'Outburst: a plain emotional gasp with no label',
    'callback': 'Callback: a nod to one of your recent lines or an earlier moment, in completely new words',
  },
};

// Which devices suit which moment, best first within no particular order (the rotation picks among those not used lately).
const SUITS = {
  killer: {
    'fight-start': 'provocation,notice,sponsor,loading,pro tip,diagnostic',
    'first-kill': 'fun fact,achievement,notice,rating,outburst,diagnostic',
    'kill': 'notice,fun fact,rating,pro tip,outburst,fine print,sponsor,error',
    'headshot': 'achievement,outburst,diagnostic,rating,fun fact,volume',
    'headshot-streak': 'volume,achievement,diagnostic,outburst,rating',
    'multi-kill': 'volume,achievement,loading,diagnostic,outburst,sponsor',
    'last-enemy': 'notice,rating,achievement,loading,outburst,sponsor',
    'elite-kill': 'achievement,fun fact,rating,volume,sponsor,fine print',
    'long-shot': 'achievement,diagnostic,rating,notice,fun fact',
    'stealth-kill': 'notice,pro tip,fun fact,loading,outburst',
    'kill-other-way': 'error,fine print,rating,outburst,diagnostic',
    'companion-kill': 'error,fine print,diagnostic,rating,outburst',
    'enemy-downed': 'error,fine print,diagnostic,notice,outburst',
    'limb-shot': 'error,notice,fine print,outburst,diagnostic',
    'dismember': 'fun fact,outburst,notice,achievement,volume',
    'miss-streak': 'error,diagnostic,pro tip,rating,fine print',
    'reload': 'loading,sponsor,pro tip,notice,fun fact,diagnostic',
    'reload-under-fire': 'loading,notice,pro tip,outburst,diagnostic',
    'v-hurt': 'fine print,notice,pro tip,diagnostic,sponsor',
    'big-hit-taken': 'fine print,error,volume,outburst,diagnostic',
    'near-death': 'volume,fine print,diagnostic,outburst,error',
    'v-healed': 'rating,notice,sponsor,outburst,fine print',
    'reinforcements': 'provocation,notice,pro tip,sponsor,diagnostic',
    'heat-up': 'notice,fine print,sponsor,provocation,pro tip',
    'civilian-hit': 'error,fine print,notice,outburst',
    'civilian-killed': 'error,fine print,notice,outburst',
    'weapon-mode-change': 'notice,diagnostic,loading,fine print,outburst',
    'skippy-drawn': 'notice,loading,diagnostic,rating,sponsor',
    'fight-end': 'rating,diagnostic,fine print,achievement,sponsor',
  },
  puppy: {
    'fight-start': 'apology,wellness tip,diagnostic,loading,puppies,sponsor',
    'first-kill': 'incident report,denial,apology,diagnostic,outburst',
    'kill': 'incident report,denial,apology,wellness tip,outburst,rating',
    'headshot': 'volume,incident report,denial,diagnostic,outburst',
    'headshot-streak': 'volume,diagnostic,outburst,rating,apology',
    'multi-kill': 'volume,incident report,diagnostic,outburst,sponsor',
    'last-enemy': 'wellness tip,rating,diagnostic,loading,sponsor,puppies',
    'elite-kill': 'incident report,volume,denial,apology,diagnostic',
    'long-shot': 'incident report,apology,diagnostic,denial,medical',
    'stealth-kill': 'denial,incident report,wellness tip,apology',
    'kill-other-way': 'apology,rating,diagnostic,denial,outburst',
    'companion-kill': 'incident report,apology,diagnostic,denial',
    'enemy-downed': 'get well soon,medical,apology,sponsor,rating',
    'mercy-streak': 'get well soon,medical,rating,sponsor,diagnostic',
    'limb-shot': 'get well soon,medical,apology,sponsor,outburst',
    'dismember': 'volume,outburst,denial,medical,apology',
    'miss-streak': 'rating,diagnostic,wellness tip,puppies,outburst',
    'reload': 'loading,wellness tip,apology,sponsor,diagnostic',
    'reload-under-fire': 'loading,wellness tip,apology,outburst,diagnostic',
    'v-hurt': 'wellness tip,medical,apology,diagnostic,sponsor',
    'big-hit-taken': 'volume,outburst,medical,diagnostic,apology',
    'near-death': 'volume,diagnostic,outburst,wellness tip,medical',
    'v-healed': 'rating,sponsor,wellness tip,outburst,puppies',
    'reinforcements': 'diagnostic,wellness tip,apology,sponsor,outburst',
    'heat-up': 'wellness tip,diagnostic,sponsor,apology,outburst',
    'civilian-hit': 'volume,apology,outburst,medical,diagnostic',
    'civilian-killed': 'volume,apology,outburst,medical,diagnostic',
    'weapon-mode-change': 'diagnostic,loading,outburst,apology,rating',
    'skippy-drawn': 'diagnostic,loading,wellness tip,rating,sponsor',
    'fight-end': 'rating,diagnostic,wellness tip,incident report,medical',
  },
};

// How a spoken line shows which device it used, so the rotation can look at what was really said (the model may drift from the one
// it was given). A line can match several; "outburst" is the absence of any.
const SIGNS = {
  'provocation': /\bprovocation\b/i,
  'fun fact': /\bfun fact\b/i,
  'notice': /\b(?:notice|alert|warning|status|logged|registered|noted)\b/i,
  'error': /\berror\b|\bbug\b|\bmalfunction\b/i,
  'achievement': /\bachievement\b|\bunlocked\b|\btrophy\b/i,
  'rating': /\brat(?:e|ing|ed)\b|\breviews?\b|\bstars?\b|\bsurvey\b|\bfeedback\b/i,
  'fine print': /\bwarranty\b|\bterms\b|\bclause\b|\bfine print\b|\bliabilit|\bdisclaimer\b|\bsection \d/i,
  'volume': /\bvolume\b|\b[A-Z]{3,}(?:[ ,']+[A-Z]{2,}){2,}/,
  'loading': /\bbum bum\b|\bloading\b|\binstalling\b|\bupdate\b|\bfirmware\b/i,
  'diagnostic': /\bdiagnostics?\b|\breadout\b|\bsensors?\b|\bprocessor\b|\boverheat|\bsystems?\b/i,
  'sponsor': /\bsponsor|\bbrought to you\b|\bdiscount\b|\bcoupon\b|\bpromo|\bcode\b/i,
  'pro tip': /\bpro tip\b|\btip:/i,
  'get well soon': /\bget well\b|\bspeedy\b|\bwalk again\b|\brecover/i,
  'incident report': /\bincident\b|\baccident\b|\btripped\b|\breport\b|\bfiled\b/i,
  'denial': /\bresting\b|\bnapping\b|\bsleeping\b|\bfaking\b|\bnot dead\b|\bjust a nap\b/i,
  'medical': /\bphysio|\bripperdoc|\btrauma team\b|\bcane\b|\bcrutch|\bmedical\b|\bdoctor\b/i,
  'apology': /\bsorry\b|\bapolog|\bforgive\b|\bpardon\b/i,
  'wellness tip': /\bbreathe\b|\bbreath\b|\bwellness\b|\bself-care\b|\bhydrate\b|\bstretch\b/i,
  'puppies': /\bpupp(?:y|ies)\b/i,
  'callback': /\bagain\b.*\bearlier\b|\blike before\b/i,
};

const hash = text => { let h = 0; for (const c of String(text)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };

// ---- The session notebook --------------------------------------------------------------------------------------------------
// What this bridge process has heard Skippy say, kept small: a play session is as long as the bridge runs. Only `remember` writes it.

const WINDOW = 60;          // lines whose words are counted for overused jokes
const OPENERS_SHOWN = 6;    // openings of the last lines shown to the model
const DEVICES_AVOIDED = 4;  // a device is not used again within this many lines
const session = {lines: 0, built: 0, openers: [], devices: [], words: []};

/** Forgets the session (tests, and an evaluation that wants a fresh start). */
export function resetSession() { Object.assign(session, {lines: 0, built: 0, openers: [], devices: [], words: []}); }

const STOP = new Set(`about after again also and are because been before being but can could did does done each even every for from get gets
  getting give had has have her here him his how into its just keep let like make many may more most much must not now off once one only other our out over
  said say says see she should some such than that the their them then there these they thing things this those through too under until upon very want was way
  well were what when where which while who why will with would you your yours user skippy choom boss really still right going gonna got one two three four
  five six seven eight nine ten`.split(/\s+/));
// Words that are the subject matter, the labels of the devices or the character's core vocabulary: saying them again is not a stale joke.
const CORE = /^(?:head|heads|headshot|headshots|kill|kills|killed|shot|shots|enemy|enemies|fight|fights|target|targets|bullet|bullets|magazine|gun|trigger|aim|aimed|aiming|miss|missed|misses|knee|knees|kneecap|kneecaps|leg|legs|body|arm|arms|maelstrom|tyger|claws|valentinos|animals|scavengers?|wraiths|voodoo|barghest|arasaka|militech|ncpd|maxtac|cyberpsycho|percent|volume|increasing|error|fun|fact|provocation|achievement|unlocked|please|rate|rating|stars?|review|diagnostics?|notice|warning|detected|mode|count|counts|down|dead|death|incident|streak|reload|reloading|pacifist|killer)$/i;

const wordsOf = line => new Set((String(line).toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? []).map(word => word.replace(/'s$/, '')).filter(word => !STOP.has(word) && !CORE.test(word)));

function devicesOf(line) {
  const found = new Set();
  for (const [name, sign] of Object.entries(SIGNS)) if (sign.test(line)) found.add(name);
  return found;
}

/** The overused jokes of the session: words that two or more of the last lines shared, most used first. */
export function overused(limit = 5) {
  const counts = new Map();
  for (const set of session.words) for (const word of set) counts.set(word, (counts.get(word) ?? 0) + 1);
  return [...counts].filter(([, count]) => count >= 2).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([word]) => word);
}

/** How the recent lines opened, newest last, without repeats. */
export function recentOpenings(limit = OPENERS_SHOWN) {
  const seen = new Set(), out = [];
  for (const word of [...session.openers].reverse()) {
    if (seen.has(word.toLowerCase())) continue;
    seen.add(word.toLowerCase()); out.unshift(word);
    if (out.length >= limit) break;
  }
  return out;
}

/** One device for a line of `event`: one that suits the moment and was not used in the last few lines; the choice moves on every call. */
export function deviceFor(mode, event) {
  const m = mode === 'killer' ? 'killer' : 'puppy';
  let suits = (SUITS[m][event] ?? Object.keys(DEVICES[m]).filter(name => name !== 'callback').join(',')).split(',');
  const spoken = session.devices.flatMap(set => [...set]);
  const lastLines = session.devices.slice(-DEVICES_AVOIDED).flatMap(set => [...set]);
  // Puppies calm Skippy down at most once in a long stretch.
  if (spoken.includes('puppies')) suits = suits.filter(name => name !== 'puppies');
  let options = suits.filter(name => !lastLines.includes(name));
  if (!options.length) options = suits.filter(name => !session.devices.slice(-2).some(set => set.has(name)));
  if (!options.length) options = suits;
  // Every fifth pick looks back instead, once there is something to look back on.
  const turn = session.lines + session.built++;
  const name = session.lines >= 3 && turn % 5 === 4 && !lastLines.includes('callback') ? 'callback' : options[(turn + hash(event)) % options.length];
  return {name, text: DEVICES[m][name]};
}

// ---- Describing the moment -------------------------------------------------------------------------------------------------

/** "an elite Maelstrom human, hit in the head, from 41 m, with a headshot" from the victim facts. */
export function describeVictim(victim) {
  if (!victim || typeof victim !== 'object') return '';
  const kind = victim.kind && victim.kind !== 'other' ? victim.kind : 'enemy';
  const tags = [];
  if (victim.cyberpsycho) tags.push('cyberpsycho');
  else if (victim.rarity && !['normal', 'trash', 'weak'].includes(victim.rarity)) tags.push(victim.rarity);
  if (victim.faction) tags.push(victim.faction);
  let text = [...tags, kind === 'human' && tags.length ? 'fighter' : kind].join(' ');
  if (victim.civilian) text = 'a bystander (a civilian, not part of the fight)';
  else text = `${/^[aeiou]/i.test(text) ? 'an' : 'a'} ${text}`;
  const how = [];
  if (victim.name) how.push(`listed as "${victim.name}"`);
  if (victim.zone) how.push(`hit in the ${victim.zone === 'torso' ? 'body' : victim.zone}`);
  if (victim.headshot) how.push('a headshot');
  // Only a long shot has its distance said: a nearer one makes the model fixate on metres.
  if (Number.isFinite(victim.distance) && victim.distance >= LONG_SHOT_METRES) how.push(`${Math.round(victim.distance)} m away`);
  if (victim.weapon && victim.weapon !== 'skippy') how.push(`killed by ${victim.weapon === 'companion' ? 'a companion' : `V's ${victim.weapon}`}, not by you`);
  if (victim.stealth) how.push('silently');
  return how.length ? `${text} (${how.join(', ')})` : text;
}

function fightLine(fight) {
  if (!fight) return '';
  const parts = [];
  if (fight.seconds > 0) parts.push(`the fight is ${plural(fight.seconds, 'second')} old`);
  if (fight.kills > 0) parts.push(`${plural(fight.kills, 'kill')} so far${fight.skippyKills !== undefined && fight.skippyKills !== fight.kills ? `, ${fight.skippyKills} of them with you` : ''}`);
  if (fight.headshots > 0) parts.push(plural(fight.headshots, 'headshot'));
  if (fight.headshotStreak >= 2) parts.push(`${fight.headshotStreak} headshots in a row right now`);
  if (fight.downed > 0) parts.push(`${fight.downed} put down alive`);
  if (fight.limbShots > 0) parts.push(plural(fight.limbShots, 'limb shot'));
  if (fight.civilians > 0) parts.push(`${plural(fight.civilians, 'bystander')} hit`);
  if (fight.accuracy) parts.push(`V's aim is ${fight.accuracy}`);
  if (fight.enemies !== undefined) parts.push(fight.enemies === 0 ? 'no enemy fighting now' : `${plural(fight.enemies, 'enemy')} fighting now`);
  if (fight.health) parts.push(`V is ${fight.health}`);
  if (fight.stealthOpening) parts.push('it began from stealth');
  if (fight.inVehicle) parts.push('V is in a vehicle');
  return parts.length ? `The fight so far (exact numbers): ${parts.join('; ')}.` : '';
}

function whereLine(where) {
  if (!where) return '';
  const place = join([where.area, where.district]);
  return `Where: ${join([place, where.timeOfDay ? `${where.timeOfDay}` : '', where.heat ? `police heat ${where.heat} of 5` : ''])}.`;
}

const WHOLE = value => typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;

// The extra facts of a moment in plain words. A key that is already in the fight line, or that the moment's hint says, is left out; a
// key this table does not know is left out too, so a raw name such as `firstBlood` or `ways` never reaches the model.
const EXTRAS = {
  streak: (value, facts, event) => event === 'mercy-streak' ? `${WHOLE(value)} enemies put down alive in a row, with no kill in between` : `${WHOLE(value)} headshot kills in a row`,
  count: (value, facts) => `${WHOLE(value)} kills within ${WHOLE(facts.window) ?? 8} seconds`,
  ways: value => `${WHOLE(value)} kills in the last 30 seconds made without you`,
  missed: value => `${WHOLE(value)} shots in a row hit nothing`,
  healthPct: value => `V has ${WHOLE(value)} percent health`,
  lostPct: value => `V just lost ${WHOLE(value)} percent health in a couple of seconds`,
  heat: value => `police heat is now ${WHOLE(value)} of 5`,
  bodyPart: (value, facts) => `the ${value} came off${facts.explosion === true ? ' in an explosion' : ''}`,
  enemies: value => `${plural(WHOLE(value), 'enemy')} still fighting`,
  peakEnemies: value => `up to ${plural(WHOLE(value), 'enemy')} at once so far`,
  longestStreak: value => `the longest run was ${plural(WHOLE(value), 'kill')} in quick succession`,
  lookAt: value => `V is facing ${value}`,
  outcome: value => ({clean: 'it went smoothly', rough: 'V took a beating', narrow: 'V nearly died'})[value],
  empty: value => value === true ? 'the magazine was empty' : null,
};

function extraFacts(facts, event) {
  const out = [];
  if (event === 'reinforcements' && WHOLE(facts?.to) !== null && WHOLE(facts?.from) !== null) {
    out.push(`${plural(WHOLE(facts.to) - WHOLE(facts.from), 'more enemy').replace('enemys', 'enemies')} arrived: ${WHOLE(facts.to)} are fighting now, there were ${WHOLE(facts.from)}`);
  } else if (event === 'weapon-mode-change' && facts?.from && facts?.to) {
    out.push(`your targeting mode changed from ${facts.from === 'killer' ? 'Stone Cold Killer' : 'Puppy-Loving Pacifist'} to ${facts.to === 'killer' ? 'Stone Cold Killer' : 'Puppy-Loving Pacifist'}`);
  }
  for (const [key, value] of Object.entries(facts ?? {})) {
    if (value === null || typeof value === 'object' || typeof EXTRAS[key] !== 'function') continue;
    // The fight line already says these, or the engine sends them only for the moment's own sake.
    if (key === 'enemies' && event !== 'near-death' && event !== 'reload-under-fire') continue;
    if (key === 'peakEnemies' && event !== 'last-enemy') continue;
    const text = EXTRAS[key](value, facts, event);
    if (text && !/null|NaN|undefined/.test(text)) out.push(text);
  }
  return out;
}

const HINTS = {
  'fight-start': 'The fight just began. A short reaction to what is coming; no counting.',
  'first-kill': 'The first body of the fight. This is the one the line should be about.',
  'kill': 'An ordinary kill; keep it small and different from the last one.',
  'headshot': 'A headshot. React to the shot itself.',
  'headshot-streak': 'A run of headshots. Make a fuss about the streak.',
  'multi-kill': 'Several kills in seconds. Quick, breathless.',
  'last-enemy': 'The last enemy fell and it is quiet again. A beat of calm.',
  'elite-kill': 'A dangerous target is down. Give it weight.',
  'long-shot': 'A kill from far away. React to the distance.',
  'stealth-kill': 'A silent kill. Whisper-small.',
  'kill-other-way': 'V killed without using you. A little hurt or a little proud, in character.',
  'companion-kill': 'A companion made the kill, not V. Mention it lightly.',
  'enemy-downed': 'An enemy was put down alive.',
  'mercy-streak': 'V keeps putting people down alive. Say so.',
  'limb-shot': 'A hit on an arm or leg.',
  'dismember': 'A limb came off. React to the gore in character.',
  'miss-streak': 'V is missing shot after shot. Needle V gently.',
  'reload': 'A quiet reload.',
  'reload-under-fire': 'V is reloading while enemies are shooting. Tension.',
  'v-hurt': 'V is hurt, about half health. Concern.',
  'big-hit-taken': 'V just took a heavy hit. React to the impact.',
  'near-death': 'V is almost dead. Urgent and protective; this matters most.',
  'v-healed': 'V patched up. Relief.',
  'reinforcements': 'More enemies arrived. React to the odds.',
  'heat-up': 'The police heat went up. React to the police.',
  'civilian-hit': 'V hit a bystander. React strongly; this is a real mistake.',
  'civilian-killed': 'V killed a bystander. React strongly and truthfully.',
  'weapon-mode-change': 'Your own targeting mode just changed. React to the change in yourself.',
  'skippy-drawn': 'V just picked you up. A greeting.',
  'fight-end': 'The fight is over. A closing remark that fits how it went.',
};

/**
 * The block for one remark. Plain prose, never a list of stats to read out. A line prepared ahead (the facts hold no fight) gets the
 * same style, openings and overused jokes, and no numbers.
 */
export function momentBlock({event, facts, mode}) {
  const lines = [];
  const m = facts?.mode ?? mode ?? 'puppy';
  lines.push(`You are in ${m === 'killer' ? 'Stone Cold Killer' : 'Puppy-Loving Pacifist'} mode.`);
  const hint = HINTS[event];
  if (hint) lines.push(`Moment: ${hint}`);
  const prepared = !facts?.fight;
  const victim = describeVictim(facts?.victim);
  if (victim) lines.push(`The target: ${victim}.`);
  const fight = fightLine(facts?.fight);
  if (fight) lines.push(fight);
  const where = whereLine(facts?.where);
  if (where && where !== 'Where: .') lines.push(where);
  const extras = extraFacts(facts, event);
  if (extras.length) lines.push(`Also: ${extras.join('; ')}.`);
  const device = deviceFor(m, event);
  lines.push(`Style for this line (a different one from your last lines): ${device.text}.`);
  const openings = recentOpenings();
  if (openings.length) lines.push(`Your last lines opened with: ${openings.join(', ')}. Open differently.`);
  const stale = overused();
  if (stale.length) lines.push(`Jokes and words you have already overused: ${stale.join(', ')}. Do not use them again; find a fresh one.`);
  lines.push(prepared
    ? 'This line is written ahead of the moment: use no numbers, names or body parts beyond what the moment says. Plain words only, no asterisks or markdown; to stress a word, SHOUT it in capitals.'
    : 'Use one or two of these details, never all of them and never as a list. Any number you say must be one written above, exactly as written: never round it, add to it, or count for yourself. Plain words only, no asterisks or markdown; to stress a word, SHOUT it in capitals.');
  return lines.join('\n');
}

export function speakerBlocks({event, facts, mode}) {
  if (!event || !facts) return [];
  return [{key: 'moment', tier: 'volatile', text: momentBlock({event, facts, mode})}];
}

/**
 * Called with every spoken line: it feeds the session notebook (how lines opened, which devices and words they used), and returns a
 * memory for later fights for the moments worth calling back to (a bystander, a dangerous kill). Short and concrete.
 */
export function remember({event, facts, line}) {
  if (typeof line === 'string' && line.trim()) {
    session.lines++;
    const opening = /^[^\p{L}\p{N}]*([\p{L}\p{N}'-]+)/u.exec(line);
    if (opening) session.openers = [...session.openers, opening[1]].slice(-12);
    session.devices = [...session.devices, devicesOf(line)].slice(-12);
    session.words = [...session.words, wordsOf(line)].slice(-WINDOW);
  }
  const said = typeof line === 'string' ? ` Skippy said: "${line}"` : '';
  if (event === 'civilian-killed' || (event === 'civilian-hit' && val(facts?.fight, 'civilians') >= 2)) {
    return `V hurt a bystander during a fight.${said}`.slice(0, 300);
  }
  if (event === 'elite-kill') return `V killed ${describeVictim(facts?.victim)} with Skippy.${said}`.slice(0, 300);
  if (event === 'near-death') return `V almost died in a fight.${said}`.slice(0, 300);
  if (event === 'headshot-streak' && val(facts, 'streak') >= 5) return `V landed ${facts.streak} headshots in a row.${said}`.slice(0, 300);
  return null;
}
