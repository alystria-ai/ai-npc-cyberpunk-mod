// Street reputation for ordinary NPCs (docs/REPUTATION_DESIGN.md): a KCD2-style standing per gang, corporation, the NCPD and the residents
// of each district, worded as at most two short lines for an archetype or resident the player talks to.
//
// Off unless the game sends a `reputation` snapshot with the turn (Settings > Conversations > Street reputation, settings.reputation,
// default off): without one nothing here reads or writes a file and every context is ''. Never for a named, story or companion
// character: reputationApplies() needs an ambient profile (a resident or npc-*) with archetype facts, a private turn, no reaction.
//
// Inputs, all read-only: the quest facts and journal states the world-knowledge scan already sends with every turn (QUEST_ROWS, fixer
// gigs), V's lifepath, Street Cred and level, V's current heat, the deeds the game side recorded (mod/reputation.lua: kills, takedowns,
// wanted episodes, the NPC reactions) and the decent talks counted here. Deeds are kept in runtime/reputation.json (one book per lifepath,
// buckets per kind, group, district and game day), fade with game time, and a load can only forget them, never invent them (the rollback
// guard of the decision ledger, docs/QUEST_DECISIONS.md 4.4).
import {readFileSync, statSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {performance} from 'node:perf_hooks';
import {atomicFile} from './guarded-file.mjs';

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// CET encodes an empty Lua table as {}.
const listOf = value => Array.isArray(value) ? value : plain(value) && Object.keys(value).length === 0 ? [] : null;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
export const DAY = 86400;

// The same rule as bridge/protocol.mjs isAmbientProfile (not imported: protocol.mjs imports this module). A test keeps them equal.
export const ambientProfile = key => key === 'resident-male' || key === 'resident-female' || (typeof key === 'string' && /^npc-[a-z0-9-]+$/.test(key));

// ------------------------------------------------------------------------------------------------------------------------------ groups
export const GROUP_NAMES = Object.freeze({
  maelstrom: 'Maelstrom', 'tyger-claws': 'the Tyger Claws', valentinos: 'the Valentinos', 'sixth-street': '6th Street',
  animals: 'the Animals', 'voodoo-boys': 'the Voodoo Boys', scavengers: 'the Scavengers', wraiths: 'the Wraiths', mox: 'the Mox',
  aldecaldos: 'the Aldecaldos', barghest: 'Barghest', ncpd: 'the NCPD', arasaka: 'Arasaka', militech: 'Militech',
  'kang-tao': 'Kang Tao', netwatch: 'NetWatch', nusa: 'the NUSA agencies', biotechnica: 'Biotechnica', 'trauma-team': 'Trauma Team',
  corpo: 'corporate security'});
export const GANGS = Object.freeze(['maelstrom', 'tyger-claws', 'valentinos', 'sixth-street', 'animals', 'voodoo-boys', 'scavengers',
  'wraiths', 'mox', 'aldecaldos', 'barghest']);
const GANG_SET = new Set(GANGS);
// Old feuds of Night City: a fight with one side is a small favour to the other.
export const RIVALS = Object.freeze({valentinos: ['sixth-street'], 'sixth-street': ['valentinos'], aldecaldos: ['wraiths'],
  wraiths: ['aldecaldos'], 'voodoo-boys': ['netwatch'], netwatch: ['voodoo-boys'], arasaka: ['militech'], militech: ['arasaka']});
// TweakDB affiliation names (npc:GetAffiliation(), the archetype classifier's facts) to groups.
export const AFFILIATIONS = Object.freeze({Maelstrom: 'maelstrom', MaelstromAndroid: 'maelstrom', TygerClaws: 'tyger-claws',
  Valentinos: 'valentinos', SixthStreet: 'sixth-street', SixthStreetAndroid: 'sixth-street', Animals: 'animals', VoodooBoys: 'voodoo-boys',
  Scavengers: 'scavengers', ScavengersAndroid: 'scavengers', Wraiths: 'wraiths', WraithsAndroid: 'wraiths', TheMox: 'mox',
  Aldecaldos: 'aldecaldos', Barghest: 'barghest', NCPD: 'ncpd', Arasaka: 'arasaka', Militech: 'militech', KangTao: 'kang-tao',
  NetWatch: 'netwatch', NUSA: 'nusa', NUSA_Myers: 'nusa', Biotechnica: 'biotechnica', TraumaTeam: 'trauma-team', Zetatech: 'corpo',
  Corpbud: 'corpo', UnaffiliatedCorpo: 'corpo'});
// Archetype bases (characters/archetypes.json) whose group is fixed. Everyone else is a resident of the district (vendors, joytoys,
// street goons, corporate workers, passers-by), the corporate guard follows the employer, and a merc gets no standing (fame only).
const BASE_GROUPS = Object.freeze({...Object.fromEntries(GANGS.map(group => [group, group])), 'nomad-resident': 'aldecaldos',
  ncpd: 'ncpd', maxtac: 'ncpd', militech: 'militech', 'kang-tao': 'kang-tao', netwatch: 'netwatch', nusa: 'nusa',
  biotechnica: 'biotechnica', 'trauma-team': 'trauma-team'});

/** "Santo Domingo" or "SantoDomingo" -> "SantoDomingo"; Dogtown counts on its own whatever its root district reads as. */
export function districtKey(district, area) {
  const key = value => typeof value === 'string' ? value.replace(/[^A-Za-z0-9]/g, '').slice(0, 40) : '';
  if (key(area) === 'Dogtown' || key(district) === 'Dogtown') return 'Dogtown';
  return key(district) || null;
}
const residents = district => `residents:${district}`;
const isResidents = group => typeof group === 'string' && group.startsWith('residents:');
const spaced = key => key.replace(/([a-z])([A-Z])/g, '$1 $2');

/** The group an ordinary NPC speaks for: 'maelstrom', 'residents:Watson', or null (a merc, or a resident with no known district). */
export function groupFor(archetype, district) {
  if (!plain(archetype)) return null;
  if (archetype.base === 'merc') return null;
  if (Object.hasOwn(BASE_GROUPS, archetype.base)) return BASE_GROUPS[archetype.base];
  if (archetype.base === 'corpo-security' || archetype.category === 'corpo-security') return archetype.affiliation === 'Arasaka' ? 'arasaka' : 'corpo';
  if (archetype.category === 'police') return 'ncpd';
  if ((archetype.category === 'gang' || archetype.category === 'faction') && Object.hasOwn(AFFILIATIONS, archetype.affiliation)) {
    return AFFILIATIONS[archetype.affiliation];
  }
  // A gang member whose gang is not known speaks for nobody; a joytoy or a street goon (factions without a group) is a local.
  if (archetype.category === 'gang') return null;
  const where = districtKey(district ?? archetype.district, archetype.area);
  return where ? residents(where) : null;
}

// -------------------------------------------------------------------------------------------------------------------- the game's facts
// What V did in the story, from quest facts and journal states the game already scans (characters/world-knowledge.json allowlists; a
// test checks every key). Points per group, and the phrase a member of that group would have heard. No decay: the save holds them.
const fact = (key, value = 1, op = 'gte') => ({type: 'fact', key, op, value});
const journal = key => ({type: 'journal', key, op: 'eq', value: 'succeeded'});
export const QUEST_ROWS = Object.freeze([
  {when: fact('q003_paid_maelstrom'), effects: {maelstrom: 10}, said: 'V paid Maelstrom straight at All Foods'},
  {when: fact('q003_militech_betrayed'), effects: {maelstrom: 5, militech: -10}, said: "V warned Maelstrom about Militech's rigged chip"},
  {when: fact('q003_militech_virus_uploaded'), effects: {maelstrom: -10, militech: 5}, said: 'V handed Maelstrom a rigged Militech chip'},
  {when: fact('q003_no_deal'), effects: {maelstrom: -10}, said: 'V shot up the Maelstrom deal at All Foods'},
  {when: fact('q003_deal_royce_shoot'), effects: {maelstrom: -10}, said: 'V shot Royce at All Foods'},
  {when: fact('q003_deal_royce_knocked_out'), effects: {maelstrom: -5}, said: 'V knocked Royce out at All Foods'},
  {when: fact('q003_dumdum_dead'), effects: {maelstrom: -5}, said: 'V killed Dum Dum'},
  {when: fact('q003_brick_saved'), effects: {maelstrom: 5}, said: "V got Brick out of Royce's cage"},
  {when: fact('q003_militech_chip'), effects: {militech: 5}, said: "V took Militech's credchip"},
  {when: fact('q003_militech_refused'), effects: {militech: -5}, said: "V turned down Militech's credchip"},
  {when: fact('sq011_patricia_combat_path'), effects: {maelstrom: -10}, said: "V fought Patricia's crew at the Totentanz"},
  {when: fact('sq004_saul_rescued'), effects: {aldecaldos: 10}, said: 'V got Saul out of the Raffen camp'},
  {when: fact('sq027_convoy_hit_done', 1, 'eq'), effects: {aldecaldos: 10, militech: -10}, said: 'V helped the Aldecaldos hit a Militech convoy'},
  {when: fact('sq027_camp_combat_aftermath', 1, 'eq'), effects: {aldecaldos: 10}, said: 'V defended the Aldecaldo camp'},
  {when: journal('aldecaldos.initiation.completed'), effects: {aldecaldos: 25}, said: 'V is family to the Aldecaldos'},
  {when: fact('mq002_escaped'), effects: {aldecaldos: -5}, said: 'V walked out on the Gun Music deal'},
  {when: fact('mq002_deal_proceeded'), effects: {aldecaldos: 3}, said: 'V closed the Gun Music deal for the Aldecaldos'},
  {when: fact('ina_09_arrived_to_nomad'), effects: {aldecaldos: 3}, said: "V brought Dakota's missing man home"},
  {when: fact('ina_06_iris_hired'), effects: {aldecaldos: 3}, said: 'V got Iris back to Dakota'},
  {when: fact('q110_08a_netwatch_deal', 2), effects: {netwatch: 10, 'voodoo-boys': -15}, said: 'V cut a deal with NetWatch at the Grand Imperial Mall'},
  {when: fact('q110_placide_dead'), effects: {'voodoo-boys': -10}, said: 'V killed Placide'},
  {when: fact('q110_made_contact_with_alt'), effects: {'voodoo-boys': 3}, said: 'V did the Voodoo Boys their job on the Net'},
  {when: fact('sts_ep1_12_milko_alive'), effects: {netwatch: 5}, said: 'V let a NetWatch operation run in Dogtown'},
  {when: fact('sq026_side_maiko', 1, 'eq'), effects: {'tyger-claws': 10}, said: "V backed Maiko's deal with the Tyger Claws at Clouds"},
  {when: {all: [fact('sq026_side_judy', 1, 'eq'), fact('sq026_04_done', 1, 'eq')]}, effects: {'tyger-claws': -15}, said: "V wrecked the Tyger Claws' Clouds deal"},
  {when: fact('sq026_maiko_dead'), effects: {'tyger-claws': -5}, said: 'V killed Maiko'},
  {when: fact('jpn_01_debrief_good'), effects: {'tyger-claws': 5}, said: "V delivered Wakako's gift to the Tyger Claws"},
  {when: fact('sts_wat_kab_107_kill'), effects: {'tyger-claws': -5}, said: 'V killed a Tyger Claws enforcer for Regina'},
  {when: fact('mq306_animals_dead'), effects: {animals: -10}, said: "V fought Angie's Animals at the clinic"},
  {when: fact('mq306_angie_path', 1, 'eq'), effects: {animals: 5}, said: "V took the Animals' deal on Aaron's fight"},
  {when: fact('q112_08_oda_spared'), effects: {arasaka: 5}, said: 'V spared Oda'},
  {when: fact('q112_oda_dead'), effects: {arasaka: -5}, said: 'V killed Oda'},
  {when: fact('arr_06_v_took_money'), effects: {'kang-tao': 5}, said: "V took Kang Tao's money"},
  {when: {all: [fact('q306_somi_betrayed', 1, 'eq'), fact('q306_launchpad_done', 1, 'eq')]}, effects: {nusa: 10}, said: 'V handed Songbird to the FIA'},
  {when: fact('q306_reed_killed'), effects: {nusa: -15}, said: 'V killed Solomon Reed'},
]);
export const QUEST_CAP = 60;

// A finished fixer gig is local news: the residents of the gig's district hear a merc sorted something out (+2 each, at most +16).
const GIG_KEY = /^(?:fr5\.[a-z0-9-]+\.quest|fixers\.sts-[a-z]+-[a-z]+-\d+\.quest|fo5\.(?:jpn|hil|rey|gle|spr|rcr|arr|dtn|cpz|wwd)\d+\.quest|pg5\.[a-z]+\.completed|aldecaldos\.radar\.completed)$/;
export function gigDistrict(key) {
  if (typeof key !== 'string' || !GIG_KEY.test(key)) return null;
  if (/^(?:fr5\.|fixers\.sts-wat-)/.test(key)) return 'Watson';
  if (/^(?:fixers\.sts-wbr-|fo5\.(?:jpn|hil)\d)/.test(key)) return 'Westbrook';
  if (/^(?:fixers\.sts-hey-|fo5\.(?:rey|gle|spr)\d)/.test(key)) return 'Heywood';
  if (/^(?:fixers\.sts-std-|fo5\.(?:rcr|arr)\d)/.test(key)) return 'SantoDomingo';
  if (/^(?:fixers\.sts-cct-|fo5\.(?:dtn|cpz)\d)/.test(key)) return 'CityCenter';
  if (/^fo5\.wwd\d/.test(key)) return 'Pacifica';
  if (/^pg5\./.test(key)) return 'Dogtown';
  return 'Badlands';
}
const GIG_POINTS = 2, GIG_CAP = 16;

// Where V comes from.
export const LIFEPATH_SEEDS = Object.freeze({
  nomad: {said: 'V is nomad-born', effects: {aldecaldos: 15, [residents('Badlands')]: 10}},
  streetkid: {said: 'V grew up on the streets of Heywood', effects: {[residents('Heywood')]: 10, valentinos: 5}},
  corpo: {said: 'V used to be a corpo', effects: {corpo: 5, [residents('CityCenter')]: 5}},
});

function holds(node, world) {
  if (plain(node) && Array.isArray(node.all)) return node.all.every(child => holds(child, world));
  const row = node.type === 'fact' ? world?.facts?.[node.key] : world?.journal?.[node.key];
  if (!plain(row) || row.status !== 'known') return false;
  if (node.type === 'fact' && row.present !== true) return false;
  return node.op === 'gte' ? row.value >= node.value : row.value === node.value;
}

/** The standing the story gives: {group: {points, reasons: [{said, points}]}} from the world snapshot and the lifepath. Pure. */
export function storyStanding(world, lifepath) {
  const out = {};
  const add = (group, points, said) => {
    const row = out[group] ??= {points: 0, reasons: []};
    row.points += points; row.reasons.push({said, points});
  };
  if (plain(world) && world.status === 'ready') {
    for (const row of QUEST_ROWS) {
      if (holds(row.when, world)) for (const [group, points] of Object.entries(row.effects)) add(group, points, row.said);
    }
    for (const row of Object.values(out)) row.points = clamp(row.points, -QUEST_CAP, QUEST_CAP);
    const gigs = new Map();
    for (const [key, entry] of Object.entries(world.journal ?? {})) {
      const where = gigDistrict(key);
      if (!where || !plain(entry) || entry.status !== 'known' || entry.value !== 'succeeded') continue;
      (gigs.get(where) ?? gigs.set(where, new Set()).get(where)).add(entry.questKey ?? key);
    }
    for (const [where, quests] of gigs) add(residents(where), Math.min(GIG_CAP, quests.size * GIG_POINTS), 'V did jobs that helped people around here');
  }
  const seed = LIFEPATH_SEEDS[lifepath];
  if (seed) for (const [group, points] of Object.entries(seed.effects)) add(group, points, seed.said);
  return out;
}

// ------------------------------------------------------------------------------------------------------------------- deeds (events)
export const KINDS = Object.freeze(['kill', 'defeat', 'heat', 'react', 'talk']);
const REACTIONS = new Set(['leave', 'call-police', 'attack']);
const LIFEPATHS = new Set(['nomad', 'streetkid', 'corpo']);
const HEAT = new Set(['start', 'rise']);
const NAME = /^[A-Za-z0-9_]{1,40}$/, KEY = /^[a-z0-9-]{1,40}$/;
const VIOLENT = new Set(['kill', 'defeat', 'heat']);
export const HALF_LIFE_DAYS = Object.freeze({violent: 14, social: 7});
// Per group and game day, deeds add at most this much (raw, before decay): standing builds slowly and one massacre does not saturate.
export const DAILY_CAPS = Object.freeze({violent: {low: -20, high: 8}, social: {low: -10, high: 6}});
const WORD_TRAVELS = 3600, BODIES_FOUND = DAY;

/** A deed the game side sent (mod/reputation.lua), checked and turned into a bucket key, or null. `context`: the district fallback. */
export function normalizeEvent(raw) {
  if (!plain(raw) || !KINDS.includes(raw.k) || raw.k === 'talk' || !finite(raw.t) || raw.t < 0 || !Number.isSafeInteger(raw.s) || raw.s < 1) return null;
  const district = districtKey(typeof raw.d === 'string' && NAME.test(raw.d) ? raw.d : null, typeof raw.r === 'string' && NAME.test(raw.r) ? raw.r : null);
  // lp: the lifepath of the save the deed was done in (mod/reputation.lua reads it once per world), so a deed never lands in another V's book.
  const base = {k: raw.k, d: district ?? '', t: Math.floor(raw.t), s: raw.s, ...(LIFEPATHS.has(raw.lp) ? {lp: raw.lp} : {})};
  if (raw.k === 'kill' || raw.k === 'defeat') {
    let group = raw.p === true ? 'ncpd' : typeof raw.a === 'string' && Object.hasOwn(AFFILIATIONS, raw.a) ? AFFILIATIONS[raw.a] : null;
    if (!group && (raw.c === true || raw.a === 'Civilian')) group = district ? residents(district) : null;
    if (!group) return null;
    return {...base, a: group, x: '', w: raw.w === true};
  }
  if (raw.k === 'heat') return HEAT.has(raw.x) ? {...base, a: 'ncpd', x: raw.x, w: true} : null;
  if (!REACTIONS.has(raw.x)) return null;
  const group = groupFor({base: typeof raw.b === 'string' && KEY.test(raw.b) ? raw.b : undefined,
    category: typeof raw.g === 'string' && KEY.test(raw.g) ? raw.g : undefined,
    affiliation: typeof raw.a === 'string' && NAME.test(raw.a) ? raw.a : undefined}, district);
  return group ? {...base, a: group, x: raw.x, w: true} : null;
}

/** What one deed of a bucket does: [{group, points, delay, label}]. Pure; the labels are what a person would have heard. */
export function effectsOf(bucket) {
  const {k, a: group, x, w} = bucket, d = bucket.d, out = [];
  const push = (target, points, delay, label) => { if (target && points) out.push({group: target, points, delay, label}); };
  const civilian = isResidents(group), name = GROUP_NAMES[group];
  if (k === 'kill') {
    if (!w) {
      push(group, -1, BODIES_FOUND, civilian ? 'word is V quietly killed someone around here' : `word is V quietly killed ${name}`);
    } else if (group === 'ncpd') push('ncpd', -8, 0, 'V killed cops');
    else if (civilian) { push(group, -8, WORD_TRAVELS, 'V killed people around here'); push('ncpd', -3, 0, 'V killed civilians'); }
    else {
      push(group, -6, 0, `V killed ${name} in a fight`);
      for (const rival of RIVALS[group] ?? []) push(rival, 1, 0, `V hit ${name}`);
      if (GANG_SET.has(group)) push('ncpd', 1, 0, 'V took gangers off the street');
    }
  } else if (k === 'defeat') {
    if (!w) return out;
    if (group === 'ncpd') push('ncpd', -4, 0, 'V beat up cops');
    else if (civilian) push(group, -3, WORD_TRAVELS, 'V beat people up around here');
    else push(group, -3, 0, `V beat up ${name}`);
  } else if (k === 'heat') {
    if (x === 'start') {
      push('ncpd', -3, 0, 'V has run from the NCPD');
      if (d) push(residents(d), -1, WORD_TRAVELS, 'V brought the NCPD down on this neighbourhood');
    } else push('ncpd', -1, 0, 'V has run from the NCPD');
  } else if (k === 'react') {
    if (x === 'call-police') push(group, -3, 0, civilian ? 'people here have had to call the cops on V' : `${name} have called the cops on V`);
    else if (x === 'attack') push(group, -3, 0, `V picked fights with ${civilian ? 'people here' : name}`);
    else push(group, -1, 0, `people have walked away from V`);
  } else if (k === 'talk') push(group, 2, 0, civilian ? 'V has been decent to people here' : `V has been decent to ${name}`);
  return out;
}

const classOf = kind => VIOLENT.has(kind) ? 'violent' : 'social';

/** The deeds' standing at game second `now`: {group: {points, reasons}}, with delays, daily caps and decay. Pure. */
export function deedStanding(buckets, now) {
  const days = new Map();   // group|day|class -> {sum of positives, sum of negatives, labels}
  for (const bucket of Array.isArray(buckets) ? buckets : []) {
    if (!plain(bucket) || !finite(bucket.t) || !Number.isSafeInteger(bucket.n) || bucket.n < 1) continue;
    for (const effect of effectsOf(bucket)) {
      if (now < bucket.t + effect.delay) continue;
      const kind = classOf(bucket.k), key = `${effect.group}|${bucket.day}|${kind}`;
      const row = days.get(key) ?? days.set(key, {group: effect.group, day: bucket.day, kind, plus: 0, minus: 0, labels: new Map()}).get(key);
      const points = effect.points * bucket.n;
      if (points > 0) row.plus += points; else row.minus += points;
      row.labels.set(effect.label, (row.labels.get(effect.label) ?? 0) + points);
    }
  }
  const out = {};
  for (const row of days.values()) {
    const cap = DAILY_CAPS[row.kind];
    const plus = Math.min(cap.high, row.plus), minus = Math.max(cap.low, row.minus);
    const age = Math.max(0, now / DAY - (row.day + 0.5));
    const fade = 0.5 ** (age / HALF_LIFE_DAYS[row.kind]);
    if (fade < 0.05) continue;
    const target = out[row.group] ??= {points: 0, reasons: new Map()};
    target.points += (plus + minus) * fade;
    // Each label keeps its share of the capped, faded day.
    for (const [label, points] of row.labels) {
      const share = points > 0 ? (row.plus ? plus / row.plus : 0) : (row.minus ? minus / row.minus : 0);
      target.reasons.set(label, (target.reasons.get(label) ?? 0) + points * share * fade);
    }
  }
  return Object.fromEntries(Object.entries(out).map(([group, row]) => [group,
    {points: row.points, reasons: [...row.reasons].map(([said, points]) => ({said, points}))}]));
}

/** One group's standing from both parts: {standing (-100..100, rounded), reasons sorted by weight}. */
export function standingOf(group, story, deeds) {
  const parts = [story?.[group], deeds?.[group]].filter(Boolean);
  const points = parts.reduce((sum, part) => sum + part.points, 0);
  const reasons = parts.flatMap(part => part.reasons).filter(reason => Math.abs(reason.points) >= 0.5)
    .sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  return {standing: Math.round(clamp(points, -100, 100)), reasons};
}

// ------------------------------------------------------------------------------------------------------------------------ the words
// `max`: the highest standing of the tier.
export const TIERS = Object.freeze([
  {name: 'hostile', max: -50, label: 'an enemy', how: 'Greet V with open hostility, trust nothing V says and refuse help; you may threaten V or tell V to get lost.'},
  {name: 'wary', max: -20, label: 'bad news', how: 'Be guarded and short with V, slow to trust, and unwilling to help or share much.'},
  {name: 'neutral', max: 19},
  // Words for how to treat someone people speak well of, never for an old acquaintance: a stranger who recognises V has still never met V (a player report, 2026-10-25).
  {name: 'friendly', max: 49, label: 'one of the good ones', how: 'Be warmer with V than with a stranger, trust V a little and be readier to help or share.'},
  {name: 'trusted', max: Infinity, label: 'a friend to people here', how: 'Treat V with the respect people here have for V, trust V and help or share what you know if you can.'},
]);
// A stranger recognises V on sight only by fame: the share of people who do grows with Street Cred, and it is fixed per person (the same guard
// always does or never does). Everyone else is a plain stranger to V until V says their name in the talk.
const RECOGNISED_SHARE = [[50, 40], [35, 25], [20, 10]];
export function recognisesV(entity, cred) {
  if (typeof entity !== 'string' || !Number.isInteger(cred)) return false;
  const share = RECOGNISED_SHARE.find(([least]) => cred >= least)?.[1] ?? 0;
  if (!share) return false;
  let hash = 2166136261;   // FNV-1a: stable across restarts, no crypto needed
  for (let i = 0; i < entity.length; i++) hash = Math.imul(hash ^ entity.charCodeAt(i), 16777619) >>> 0;
  return hash % 100 < share;
}
// V gives their name in the line ("I'm V", "name's V", "call me V"): from then on this person knows who V is.
const SAYS_NAME = /\b(?:i'?m|i am|it'?s|name'?s|name is|call me|they call me)\s+v\b/i;
export const saysOwnName = text => typeof text === 'string' && SAYS_NAME.test(text);
const RECOGNISED = 'You recognise V from what people say, but you have never met V.';
const INTRODUCED = 'V just told you their name, and you have heard of V, but you have never met V.';
export const tierOf = standing => TIERS.find(tier => standing <= tier.max);
const FEARED_CRED = 35;
export function fameOf(cred) {
  if (!Number.isInteger(cred) || cred < 10) return null;
  const known = cred >= 50 ? 'V is a Night City legend' : cred >= 35 ? 'V is a big name in Night City' : cred >= 20 ? 'V is a known merc' : 'some people have heard of V';
  return `${known} (Street Cred ${cred})`;
}
export const HEADER = 'STREET STANDING (word on the street in this save):';
export const MAX_CHARS = 480;
const sentence = text => text.charAt(0).toUpperCase() + text.slice(1);

/** The lines for one ordinary NPC: '' when the standing is neutral and V is nobody. Pure. `known` ('recognised' or 'introduced') says how this
 * stranger knows who V is; absent, the lines are written as before (callers that decided recognition already). */
export function describeStanding({group, standing, reasons = [], cred, heat, place = true, known}) {
  const lines = describeStandingLines({group, standing, reasons, cred, heat, place});
  if (!lines || !known) return lines;
  const text = lines.replace(HEADER, `${HEADER} ${known === 'introduced' ? INTRODUCED : RECOGNISED}`);
  return text.length > MAX_CHARS ? text.split('\n')[0] : text;
}
function describeStandingLines({group, standing, reasons = [], cred, heat, place = true}) {
  if (!group) {
    const fame = fameOf(cred);
    return fame ? `${HEADER} ${sentence(fame)}. You know nothing else about V.` : '';
  }
  const who = isResidents(group) ? (place ? `people around ${spaced(group.slice(10))}` : 'people around here') : GROUP_NAMES[group];
  const tier = tierOf(standing), fame = fameOf(cred);
  const wanted = group === 'ncpd' && Number.isInteger(heat) && heat >= 1 ? 'V is wanted by the NCPD right now' : null;
  if (tier.name === 'neutral') {
    const facts = [wanted, fame].filter(Boolean);
    return facts.length ? `${HEADER} ${facts.map(sentence).join('. ')}. You know nothing else about V.` : '';
  }
  const fear = standing <= -20 && Number.isInteger(cred) && cred >= FEARED_CRED ? " V's name also scares you: stay wary and comply rather than defy V openly." : '';
  const first = `${HEADER} Word among ${who}: V is ${tier.label}. ${tier.how}${fear}`;
  const sign = Math.sign(standing);
  const heard = [wanted, ...reasons.filter(reason => Math.sign(reason.points) === sign).map(reason => reason.said)]
    .filter(Boolean).filter((said, index, all) => all.indexOf(said) === index).slice(0, 2);
  if (!heard.length && !fame) return first;
  let second = `What you have heard: ${heard.join('; ')}${heard.length ? '.' : ''}${fame ? `${heard.length ? ' ' : ''}${sentence(fame)}.` : ''} Never list this; let it show in how you treat V.`;
  if (first.length + 1 + second.length > MAX_CHARS) second = '';
  return second ? `${first}\n${second}` : first;
}

// ------------------------------------------------------------------------------------------------------------------- the snapshot
const SESSION = /^[A-Za-z0-9-]{1,48}$/;
const MAX_EVENTS = 64;
/** The game's `reputation` field (mod/reputation.lua capture): fail closed on the shape, drop a bad event. */
export function parseReputationSnapshot(value) {
  if (!plain(value) || value.version !== 1 || typeof value.session !== 'string' || !SESSION.test(value.session)) return null;
  const events = listOf(value.events ?? []);
  if (!events || events.length > MAX_EVENTS) return null;
  const out = {version: 1, session: value.session, events: events.map(normalizeEvent).filter(Boolean)};
  if (Number.isInteger(value.cred) && value.cred >= 0 && value.cred <= 100) out.cred = value.cred;
  if (Number.isInteger(value.level) && value.level >= 0 && value.level <= 100) out.level = value.level;
  if (finite(value.t) && value.t >= 0 && value.t <= 1e12) out.t = Math.floor(value.t);
  return out;
}

/** Whether this turn may carry a reputation line at all: an ordinary NPC's private turn with the game's snapshot. */
export function reputationApplies(input) {
  return plain(input) && ambientProfile(input.profileKey) && plain(input.archetype) && plain(input.reputation)
    && !input.reaction && !input.group && input.channel !== 'phone' && !input.holocall && !input.head && !input.addon;
}

// ------------------------------------------------------------------------------------------------------------------------ the store
export const LIMITS = Object.freeze({buckets: 512, books: 8, sessions: 16, entities: 256, fileBytes: 512 * 1024});
const BOOK = /^(?:nomad|streetkid|corpo|unknown)$/;
const emptyState = () => ({version: 1, sessions: {}, books: {}});
const bucketKey = b => `${b.k}|${b.a}|${b.x}|${b.d}|${b.day}|${b.w ? 1 : 0}`;

function readState(text) {
  let value; try { value = JSON.parse(text); } catch { return null; }
  if (!plain(value) || value.version !== 1 || !plain(value.sessions) || !plain(value.books)) return null;
  const state = emptyState();
  for (const [session, seq] of Object.entries(value.sessions)) if (SESSION.test(session) && Number.isSafeInteger(seq)) state.sessions[session] = seq;
  for (const [book, row] of Object.entries(value.books)) {
    if (!BOOK.test(book) || !plain(row) || !Array.isArray(row.buckets)) continue;
    state.books[book] = {updated: finite(row.updated) ? row.updated : 0, buckets: row.buckets.filter(b => plain(b) && KINDS.includes(b.k)
      && typeof b.a === 'string' && typeof b.x === 'string' && typeof b.d === 'string' && Number.isSafeInteger(b.day)
      && Number.isSafeInteger(b.n) && b.n > 0 && finite(b.t)).slice(-LIMITS.buckets)};
  }
  return state;
}

/** The book (one per lifepath: a load of another V never reads this V's deeds) for a turn. */
export function bookOf(input) {
  const known = input?.worldKnowledge?.lifepath;
  const value = plain(known) && known.status === 'known' ? known.value : input?.turnContext?.lifepath;
  return ['nomad', 'streetkid', 'corpo'].includes(value) ? value : 'unknown';
}

/** Adds deeds to a book (mutates). Returns how many were new. `stamp`: Street Cred and level now, for the rollback guard. */
export function addDeeds(book, deeds, stamp = {}) {
  const index = new Map(book.buckets.map(bucket => [bucketKey(bucket), bucket]));
  let added = 0;
  for (const deed of deeds) {
    const day = Math.floor(deed.t / DAY);
    const key = bucketKey({...deed, day});
    let bucket = index.get(key);
    if (!bucket) {
      bucket = {k: deed.k, a: deed.a, x: deed.x, d: deed.d, day, w: deed.w === true, n: 0, t: deed.t};
      book.buckets.push(bucket); index.set(key, bucket);
    }
    bucket.n += 1; bucket.t = Math.max(bucket.t, deed.t);
    if (Number.isInteger(stamp.cred)) bucket.c = Math.max(bucket.c ?? 0, stamp.cred);
    if (Number.isInteger(stamp.level)) bucket.l = Math.max(bucket.l ?? 0, stamp.level);
    added++;
  }
  if (book.buckets.length > LIMITS.buckets) book.buckets.sort((a, b) => a.t - b.t).splice(0, book.buckets.length - LIMITS.buckets);
  return added;
}

/** The rollback guard (mutates): a bucket from later than V's clock, or with more Street Cred or a higher level than V has now, belongs to
 * a later point of this save or to another playthrough. It is dropped: a load can only forget, never invent. Returns how many went. */
export function forgetFuture(book, {t, cred, level} = {}) {
  const before = book.buckets.length;
  book.buckets = book.buckets.filter(b => !(finite(t) && b.t > t + 120)
    && !(Number.isInteger(cred) && Number.isInteger(b.c) && b.c > cred) && !(Number.isInteger(level) && Number.isInteger(b.l) && b.l > level));
  return before - book.buckets.length;
}

export class ReputationStore {
  #path; #eventsPath; #readFile; #statFile; #write; #log; #now;
  #state = null; #eventsStamp; #dirty = false; #saving = null; #timer = null;
  #talks = new Map(); #logged = new Set(); #warned = new Set(); #introduced = new Set();   // entities V told their name this session

  constructor({path, eventsPath, readFile = file => readFileSync(file, 'utf8'), statFile = statSync, write, log = () => {}, now = Date.now} = {}) {
    if (typeof path !== 'string' || !path) throw Error('Invalid reputation store configuration');
    this.#path = path; this.#eventsPath = eventsPath; this.#readFile = readFile; this.#statFile = statFile; this.#log = log; this.#now = now;
    this.#write = write ?? (async (file, data) => {
      await mkdir(dirname(file), {recursive: true}).catch(() => {});
      return atomicFile(file, data);
    });
  }

  #warn(code, line) { if (!this.#warned.has(code)) { this.#warned.add(code); this.#log(line); } }

  // Read once, at the first turn that carries a snapshot (never at start-up: off means no file is touched).
  #load() {
    if (this.#state) return this.#state;
    let text;
    try { text = this.#readFile(this.#path); } catch (error) {
      if (error?.code !== 'ENOENT') this.#warn('read', '[Reputation] the saved standing could not be read; starting empty');
    }
    const state = typeof text === 'string' && text.length <= LIMITS.fileBytes ? readState(text) : null;
    if (typeof text === 'string' && !state) this.#warn('corrupt', '[Reputation] the saved standing is damaged; starting empty');
    this.#state = state ?? emptyState();
    return this.#state;
  }

  // The game's event file: the same ring of deeds as the inline events, written at a load, a fast travel or shutdown. One stat per turn.
  #fileEvents() {
    if (!this.#eventsPath) return null;
    try {
      const info = this.#statFile(this.#eventsPath);
      const stamp = `${info.mtimeMs}:${info.size}`;
      if (stamp === this.#eventsStamp || !info.size) return null;
      const value = JSON.parse(this.#readFile(this.#eventsPath));
      this.#eventsStamp = stamp;
      return parseReputationSnapshot({...value, version: 1});
    } catch { return null; }
  }

  // New deeds of one source (the file or the turn), by the session's last sequence number: both carry the same ring of the game's last
  // deeds, so each is read oldest first and nothing is counted twice. A deed goes to the book of the save it was done in (lp), else to
  // this turn's; only this turn's snapshot stamps Street Cred and level (the rollback guard), and only on its own book.
  #ingest(state, snapshot, name, stamp) {
    if (!snapshot) return 0;
    const seen = state.sessions[snapshot.session] ?? 0;
    const fresh = snapshot.events.filter(deed => deed.s > seen).sort((a, b) => a.s - b.s);
    if (!fresh.length) return 0;
    delete state.sessions[snapshot.session];
    state.sessions[snapshot.session] = fresh[fresh.length - 1].s;
    const sessions = Object.keys(state.sessions);
    for (const old of sessions.slice(0, Math.max(0, sessions.length - LIMITS.sessions))) delete state.sessions[old];
    let added = 0;
    for (const target of new Set(fresh.map(deed => deed.lp ?? name))) {
      const book = this.#bookFor(state, target);
      added += addDeeds(book, fresh.filter(deed => (deed.lp ?? name) === target), target === name ? stamp : {});
      book.updated = this.#now();
    }
    return added;
  }

  #bookFor(state, name) {
    let book = state.books[name];
    if (!book) {
      book = state.books[name] = {updated: 0, buckets: []};
      const names = Object.keys(state.books).sort((a, b) => state.books[a].updated - state.books[b].updated);
      for (const old of names.slice(0, Math.max(0, names.length - LIMITS.books))) if (old !== name) delete state.books[old];
    }
    return book;
  }

  // A decent talk: the third message to the same person with no reaction yet, once per person and game day.
  #talk(input, book, snapshot, group) {
    if (!group || !Number.isFinite(snapshot.t) || typeof input.entity !== 'string') return 0;
    const day = Math.floor(snapshot.t / DAY);
    let row = this.#talks.get(input.entity);
    if (!row || row.day !== day) {
      if (!row && this.#talks.size >= LIMITS.entities) this.#talks.delete(this.#talks.keys().next().value);
      row = {day, requests: new Set(), credited: false};
      this.#talks.set(input.entity, row);
    }
    if (row.credited || row.requests.has(input.requestId)) return 0;
    row.requests.add(input.requestId);
    if (row.requests.size < 3) return 0;
    row.credited = true;
    return addDeeds(book, [{k: 'talk', a: group, x: '', d: districtKey(input.archetype?.district, input.archetype?.area) ?? '', t: snapshot.t, w: true}], snapshot);
  }

  #schedule() {
    this.#dirty = true;
    if (this.#timer) return;
    this.#timer = setTimeout(() => { this.#timer = null; void this.flush(); }, 1500);
    this.#timer.unref?.();
  }

  /** Writes the store if anything changed. Resolves true when it is on disk (or nothing was due). */
  flush() {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
    if (!this.#dirty || !this.#state) return this.#saving ?? Promise.resolve(true);
    this.#dirty = false;
    const data = JSON.stringify(this.#state) + '\n';
    const run = (this.#saving ?? Promise.resolve()).then(() => this.#write(this.#path, data)).then(done => done !== false, () => {
      this.#warn('write', '[Reputation] the standing could not be saved; it is kept in memory');
      return false;
    });
    this.#saving = run.finally(() => { if (this.#saving === run) this.#saving = null; });
    return run;
  }

  /** The context lines for this turn ('' unless reputationApplies). Merges the deeds the game sent, counts a decent talk, applies the
   * rollback guard and decay, and logs one line per turn. Idempotent per turn: the bridge builds a turn's context more than once. */
  contextFor(input, {place = true} = {}) {
    if (!reputationApplies(input)) return '';
    const started = performance.now();
    try {
      const state = this.#load(), snapshot = input.reputation, name = bookOf(input);
      const district = districtKey(input.archetype.district ?? input.turnContext?.district, input.archetype.area ?? input.turnContext?.area);
      const group = groupFor(input.archetype, district);
      let changed = this.#ingest(state, this.#fileEvents(), name, snapshot) + this.#ingest(state, snapshot, name, snapshot);
      const book = this.#bookFor(state, name);
      changed += this.#talk(input, book, snapshot, group);
      changed += forgetFuture(book, snapshot);
      if (changed) { book.updated = this.#now(); this.#schedule(); }
      const now = Number.isFinite(snapshot.t) ? snapshot.t : Math.max(0, ...book.buckets.map(b => b.t));
      const story = storyStanding(input.worldKnowledge, name === 'unknown' ? undefined : name);
      const result = group ? standingOf(group, story, deedStanding(book.buckets, now)) : {standing: 0, reasons: []};
      const heat = input.turnContext?.heat;
      // Only a stranger who knows who V is hears the word on the street: one who recognises V by fame, or one V told their name (remembered for the session).
      if (typeof input.entity === 'string' && saysOwnName(input.text)) {
        if (!this.#introduced.has(input.entity) && this.#introduced.size >= LIMITS.entities) this.#introduced.delete(this.#introduced.values().next().value);
        this.#introduced.add(input.entity);
      }
      // A police officer while V is wanted knows the face from the alert.
      const wantedByThem = group === 'ncpd' && Number.isInteger(heat) && heat >= 1;
      const known = recognisesV(input.entity, snapshot.cred) || wantedByThem ? 'recognised' : this.#introduced.has(input.entity) ? 'introduced' : null;
      const text = known ? describeStanding({group, standing: result.standing, reasons: result.reasons, cred: snapshot.cred, heat, place, known}) : '';
      if (!this.#logged.has(input.requestId)) {
        if (this.#logged.size > 64) this.#logged.clear();
        this.#logged.add(input.requestId);
        this.#log(`[Reputation] group=${group ?? 'none'} standing=${result.standing} tier=${group ? tierOf(result.standing).name : 'none'}`
          + ` lines=${text ? text.split('\n').length : 0} chars=${text.length} buckets=${book.buckets.length} ms=${(performance.now() - started).toFixed(2)}`);
      }
      return text;
    } catch (error) {
      this.#warn('context', `[Reputation] skipped: ${String(error?.message ?? error).slice(0, 120)}`);
      return '';
    }
  }

  /** Counts only. */
  status() {
    const state = this.#state;
    if (!state) return {loaded: false};
    return {loaded: true, books: Object.fromEntries(Object.entries(state.books).map(([name, book]) => [name, book.buckets.length])),
      sessions: Object.keys(state.sessions).length};
  }
}
