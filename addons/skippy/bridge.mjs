// Bridge side of the Skippy add-on (docs/ADDON_API.md, "Bridge module"). Pure, quick, side-effect free. It turns the facts of a
// remark (addons/skippy/EVENTS.md) into a short readable block for the model, and picks one fresh angle for the line so remarks
// that come every ten seconds do not all sound alike. The persona and the modes live in convai-addon.json.
export const apiVersion = '1.0';

let log = () => {};
export function activate(api) { log = api.log; }

const val = (object, key) => (object && typeof object === 'object' ? object[key] : undefined);
const join = parts => parts.filter(Boolean).join(', ');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "an elite Maelstrom human, hit in the head, from 28 m, with a headshot" from the victim facts. */
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
  if (Number.isFinite(victim.distance)) how.push(`${victim.distance} m away`);
  if (victim.weapon && victim.weapon !== 'skippy') how.push(`killed by ${victim.weapon === 'companion' ? 'a companion' : `V's ${victim.weapon}`}, not by you`);
  if (victim.stealth) how.push('silently');
  return how.length ? `${text} (${how.join(', ')})` : text;
}

function fightLine(fight) {
  if (!fight) return '';
  const parts = [];
  if (fight.seconds > 0) parts.push(`the fight is ${fight.seconds} s old`);
  if (fight.kills > 0) parts.push(`${plural(fight.kills, 'kill')} so far${fight.skippyKills !== undefined && fight.skippyKills !== fight.kills ? ` (${fight.skippyKills} with you)` : ''}`);
  if (fight.headshots > 0) parts.push(plural(fight.headshots, 'headshot'));
  if (fight.headshotStreak >= 2) parts.push(`${fight.headshotStreak} headshots in a row right now`);
  if (fight.downed > 0) parts.push(`${fight.downed} put down alive`);
  if (fight.limbShots > 0) parts.push(`${plural(fight.limbShots, 'limb shot')}`);
  if (fight.civilians > 0) parts.push(`${plural(fight.civilians, 'bystander')} hit`);
  if (fight.accuracy) parts.push(`V's aim is ${fight.accuracy}`);
  if (fight.enemies !== undefined) parts.push(fight.enemies === 0 ? 'no enemy fighting now' : `${plural(fight.enemies, 'enemy')} fighting now`);
  if (fight.health) parts.push(`V is ${fight.health}`);
  if (fight.stealthOpening) parts.push('it began from stealth');
  if (fight.inVehicle) parts.push('V is in a vehicle');
  return parts.length ? `The fight so far: ${parts.join('; ')}.` : '';
}

function whereLine(where) {
  if (!where) return '';
  const place = join([where.area, where.district]);
  return `Where: ${join([place, where.timeOfDay ? `${where.timeOfDay}` : '', where.heat ? `police heat ${where.heat} of 5` : ''])}.`;
}

// One angle per remark, picked from the counters so the same moment gets different treatment next time. Mode picks the list.
const ANGLES = {
  killer: ['a cold, clipped one-liner', 'dry pride in your own aim', 'bored understatement', 'a tease aimed at the target, never at V',
    'a gunsmith\'s critique of the shot', 'quiet menace', 'a tiny bit of bookkeeping (counts, in a few words)', 'deadpan disappointment it ended so fast'],
  puppy: ['nervous guilt', 'relief mixed with worry', 'fretting about V', 'a plea to aim lower next time', 'a soft joke at your own expense',
    'a sweet compliment that you immediately regret', 'a gasp, then a comforting thought', 'a wistful thought of puppies (only if you have not used puppies yet)'],
};

function angleFor(mode, facts) {
  const fight = facts?.fight ?? {};
  const seed = (fight.kills ?? 0) * 7 + (fight.shots ?? 0) * 3 + (fight.hits ?? 0) + (fight.downed ?? 0) * 5 + (fight.seconds ?? 0);
  const list = ANGLES[mode] ?? ANGLES.puppy;
  return list[Math.abs(seed) % list.length];
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

/** The block for one remark. Plain prose, never a list of stats to read out. */
export function momentBlock({event, facts, mode}) {
  const lines = [];
  const m = facts?.mode ?? mode ?? 'puppy';
  lines.push(`You are in ${m === 'killer' ? 'Stone Cold Killer' : 'Puppy-Loving Pacifist'} mode.`);
  const hint = HINTS[event];
  if (hint) lines.push(`Moment: ${hint}`);
  const victim = describeVictim(facts?.victim);
  if (victim) lines.push(`The target: ${victim}.`);
  const fight = fightLine(facts?.fight);
  if (fight) lines.push(fight);
  const where = whereLine(facts?.where);
  if (where && where !== 'Where: .') lines.push(where);
  const extras = [];
  for (const [key, value] of Object.entries(facts ?? {})) {
    if (['mode', 'fight', 'victim', 'where'].includes(key) || value === null || typeof value === 'object') continue;
    extras.push(`${key}: ${value}`);
  }
  if (extras.length) lines.push(`Also: ${extras.join('; ')}.`);
  lines.push(`Angle for this line: ${angleFor(m, facts)}. Use one or two of these details, not all of them, and never read the facts as a list.`);
  return lines.join('\n');
}

export function speakerBlocks({event, facts, mode}) {
  if (!event || !facts) return [];
  return [{key: 'moment', tier: 'volatile', text: momentBlock({event, facts, mode})}];
}

/** Memories of moments worth calling back to later (a bystander, a dangerous kill). Short and concrete. */
export function remember({event, facts, line}) {
  const said = typeof line === 'string' ? ` Skippy said: "${line}"` : '';
  if (event === 'civilian-killed' || (event === 'civilian-hit' && val(facts?.fight, 'civilians') >= 2)) {
    return `V hurt a bystander during a fight.${said}`.slice(0, 300);
  }
  if (event === 'elite-kill') return `V killed ${describeVictim(facts?.victim)} with Skippy.${said}`.slice(0, 300);
  if (event === 'near-death') return `V almost died in a fight.${said}`.slice(0, 300);
  if (event === 'headshot-streak' && val(facts, 'streak') >= 5) return `V landed ${facts.streak} headshots in a row.${said}`.slice(0, 300);
  return null;
}
