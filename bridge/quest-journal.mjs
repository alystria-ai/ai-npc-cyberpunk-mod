// The journal block of the play file (docs/REAL_QUESTS.md): what the game shows of each story pack as a real quest, a journal entry with its description, the
// objective in the HUD tracker and a waypoint on the map at the stage's place when that place has a position.
//
// Pure: computed from the runner's state whenever the play file is (bridge/bond-pack-runner.mjs playState), so the game always rebuilds the journal from the
// bridge state and never from the save. A pack the bridge no longer holds (a load of an earlier save rewound it, a memory reset forgot it, the story finished it)
// is simply not in the block, and the game removes its entry: no ghost entry can outlive the state it came from.
//
// A row: {pack, kind, character, title, description, objective, state: 'active' | 'succeeded' | 'failed', serial, since, endedAt?, place?: {id, name, radius,
//   district?, x?, y?, z?, anchor?, fallback?}}. `since` is the game clock of the stage (or the ending), so the game drops a row stamped later than the loaded save, as it does for
// a quest stage. The finished quests kept are the newest FINISHED_KEEP, by the game clock of their ending.
import {placesOf} from './quest-format.mjs';
import {placesWithPositions} from './named-places.mjs';

export const FINISHED_KEEP = 12;
export const LIMITS = Object.freeze({title: 80, description: 600, objective: 120, place: 120});

const finite = value => typeof value === 'number' && Number.isFinite(value);
const clip = (value, max) => {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length <= max ? text : text.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
};

/**
 * Pack places whose name points at a named place of Night City (bridge/named-places-data.mjs), checked in this order (a more specific place first: Viktor's
 * clinic is "behind the Esoterica"). A pack place with its own position, or one captured in the game, never needs this.
 */
export const NAMED_PLACE_WORDS = Object.freeze([
  ['victors-clinic', /\bviktor'?s\b/i],
  ['mistys-esoterica', /\besoterica\b/i],
  ['toms-diner', /\btom'?s diner\b/i],
  ['afterlife', /\bafterlife\b/i],
  ['lizzies-bar', /\blizzie'?s\b/i],
  ['totentanz', /\btotentanz\b/i],
  ['judys-apartment', /\bjudy'?s (flat|apartment)\b/i],
  ['v-apartment-h10', /\bmegabuilding h10\b/i],
  ['el-coyote-cojo', /\bcoyote cojo\b/i],
  ['wakakos-office', /\bwakako'?s\b/i],
  ['clouds', /\bClouds\b/],
  ['sunset-motel', /\bsunset motel\b/i],
]);

/** The named place a pack place's name points at (with its position, when one is known), or null. */
export function namedPlaceFor(name, list = placesWithPositions()) {
  if (typeof name !== 'string' || !name) return null;
  for (const [id, words] of NAMED_PLACE_WORDS) {
    if (!words.test(name)) continue;
    return list.find(place => place.id === id) ?? null;
  }
  return null;
}

/**
 * The place a stage sends V to, the key of one of the pack's places: a pin first, then a place V must reach, then the end of a drive, then the first place
 * any primitive of the stage names. Null for a stage with none (a talk, a call).
 */
export function stagePlaceKey(doList) {
  const specs = Array.isArray(doList) ? doList.filter(spec => spec && typeof spec === 'object') : [];
  for (const [kind, key] of [['pin', 'at'], ['place', 'at'], ['ride', 'to'], ['cast', 'at']]) {
    const found = specs.find(spec => spec.p === kind && typeof spec[key] === 'string');
    if (found) return found[key];
  }
  return placesOf(specs)[0] ?? null;
}

/** The waypoint of a pack place: its own position, else the named place it points at. Without either it has no x, y, z (the game may still find a capture). */
export function resolvePlace(pack, key, {named = placesWithPositions()} = {}) {
  const place = typeof key === 'string' ? pack?.places?.[key] : null;
  if (!place || typeof place !== 'object') return null;
  const out = {id: key, name: clip(place.name, LIMITS.place), radius: finite(place.radius) ? place.radius : 25, ...(typeof place.district === 'string' ? {district: place.district} : {})};
  if (finite(place.x) && finite(place.y) && finite(place.z)) return {...out, x: place.x, y: place.y, z: place.z};
  const anchor = namedPlaceFor(place.name, named);
  if (anchor && finite(anchor.x) && finite(anchor.y) && finite(anchor.z)) return {...out, x: anchor.x, y: anchor.y, z: anchor.z, named: anchor.id};
  return out;
}

/**
 * Every started quest has a map pin from the start (owner decision 1 Nov 2026: the Judy quest showed no marker because it names no place of its own). The pin goes, in this order:
 *   stage     the place the stage sends V to, when it has a position
 *   earlier   else the last place an earlier stage of the quest had, so the pin stays where V last had a reason to go and moves only when a stage names a new place
 *   first     else the quest's first place, by the order of its places
 *   named     else the first named place of Night City the quest's own words point at (a dinner "at Lizzie's"), checked in the stage's words before the rest
 *   landmark  else a place the character is known for (LANDMARKS), then the Afterlife
 * A place in the first three steps that has a name but no position yet may still be measured in the game (the probe's capture), so it keeps its own id and the game
 * takes the capture first and the fallback after. `anchor` says which step gave the position. The game side may also use the character's own position when she is
 * about, but the bridge never guesses it: it does not know where she is.
 */
export const LANDMARKS = Object.freeze({
  'judy-alvarez': ['judys-apartment', 'lizzies-bar'],
  'jackie-welles': ['el-coyote-cojo'],
  'rogue-amendiares': ['afterlife'],
  'johnny-silverhand': ['afterlife'],
  'viktor-vektor': ['victors-clinic', 'afterlife'],
});
export const DEFAULT_LANDMARK = 'afterlife';

const positioned = place => place && finite(place.x) && finite(place.y) && finite(place.z);
const named = (list, id) => list.find(place => place.id === id) ?? null;
const spot = (place, anchor) => ({id: place.id, name: clip(place.phrase ?? place.name ?? place.id, LIMITS.place), radius: finite(place.radius) ? place.radius : 25,
  x: place.x, y: place.y, z: place.z, named: place.id, anchor});

/** The first named place of Night City the given texts point at, in order, that has a position, or null. */
export function namedPlaceInText(texts, list = placesWithPositions()) {
  for (const text of texts) {
    if (typeof text !== 'string' || !text) continue;
    for (const [id, words] of NAMED_PLACE_WORDS) {
      if (!words.test(text)) continue;
      const found = named(list, id);
      if (positioned(found)) return found;
    }
  }
  return null;
}

/** The place the pin falls back to when the stage has no usable one: its first place, the words of the quest, the character's landmark, the default landmark. Always a position while the list has one. */
export function fallbackPlace(pack, stage, list = placesWithPositions()) {
  for (const [key, place] of Object.entries(pack?.places ?? {})) {
    const resolved = resolvePlace(pack, key, {named: list});
    if (positioned(resolved)) return {...resolved, anchor: 'first'};
  }
  const texts = [stage?.objective, stage?.label, stage?.know, pack?.title, pack?.description, pack?.summary, ...(pack?.stages ?? []).flatMap(item => [item.objective, item.know, item.label])];
  const word = namedPlaceInText(texts, list);
  if (word) return spot(word, 'named');
  for (const id of [...(LANDMARKS[pack?.character] ?? []), DEFAULT_LANDMARK]) {
    const found = named(list, id);
    if (positioned(found)) return spot(found, 'landmark');
  }
  return null;
}

/**
 * The pin of an active quest: see the chain above. `stages`: the stages played so far, newest first, each with its `do` (the places they sent V to).
 * Returns the place as the game gets it, or null only when the position list is empty.
 */
export function pinPlace(pack, stage, doList, earlier, {named: list = placesWithPositions()} = {}) {
  const own = resolvePlace(pack, stagePlaceKey(doList), {named: list});
  const back = () => {
    for (const before of earlier) {
      const place = resolvePlace(pack, stagePlaceKey(before), {named: list});
      if (positioned(place)) return {...place, anchor: 'earlier'};
    }
    return null;
  };
  if (positioned(own)) return {...own, anchor: 'stage'};
  // The stage names a place with no position yet: the game may have measured it, so it stays the place and the fallback rides along.
  const spare = back() ?? fallbackPlace(pack, stage, list);
  if (own) return {...own, anchor: 'stage', ...(spare ? {fallback: {x: spare.x, y: spare.y, z: spare.z, id: spare.id, name: spare.name, anchor: spare.anchor}} : {})};
  return spare ?? null;
}

/**
 * How the journal files an ended pack: 'succeeded', 'failed', or 'abandoned' (not shown at all: the story finished it first, or the ending is unknown).
 * An ending's own `outcome` decides. Without it, an ending that costs bond points or the stand-up of a meeting is a failure.
 */
export function outcomeOf(pack, entry) {
  const last = entry?.trail?.at?.(-1);
  if (!last || last.ending !== true) return null;
  if (last.choice === 'unfinished') return 'abandoned';
  const ending = pack?.endings?.[last.stage];
  if (!ending) return 'abandoned';
  if (ending.outcome === 'succeeded' || ending.outcome === 'failed') return ending.outcome;
  if (last.stage === 'stood-up' || (Number.isFinite(ending.bond) && ending.bond < 0)) return 'failed';
  return 'succeeded';
}

/**
 * The journal block: one row per pack in progress and per recently finished pack, newest first.
 * packs: Map id -> pack. entries: Map id -> runner entry {status, trail}. stageOf(pack, entry) -> the current stage. doFor(pack, entry, stage) -> its `do` as the game gets it.
 */
export function journalBlock({packs, entries, stageOf = (pack, entry) => pack.stages?.find(stage => stage.id === entry.trail.at(-1).stage) ?? null, doFor = (pack, entry, stage) => stage?.do ?? [], named = placesWithPositions()} = {}) {
  const active = [], finished = [];
  for (const [id, entry] of entries ?? []) {
    const pack = packs?.get?.(id);
    if (!pack || !entry || !Array.isArray(entry.trail) || !entry.trail.length) continue;
    const base = {pack: id, kind: pack.kind === 'hangout' ? 'hangout' : 'quest', character: pack.character, title: clip(pack.title, LIMITS.title),
      description: clip(pack.description ?? pack.summary ?? pack.title, LIMITS.description), serial: entry.trail.length};
    const last = entry.trail.at(-1);
    if (entry.status === 'active') {
      const stage = stageOf(pack, entry);
      if (!stage) continue;
      // Stages played before this one, newest first, for a stage that names no place of its own: the pin stays where the last place was.
      const earlier = entry.trail.slice(0, -1).reverse().map(step => stageOf(pack, {...entry, trail: [step]})).filter(Boolean).map(before => doFor(pack, entry, before));
      const place = pinPlace(pack, stage, doFor(pack, entry, stage), earlier, {named});
      active.push({...base, objective: clip(stage.objective ?? stage.label ?? pack.title, LIMITS.objective), state: 'active',
        since: Number.isSafeInteger(last.at) ? last.at : null, ...(place ? {place} : {})});
      continue;
    }
    const outcome = outcomeOf(pack, entry);
    if (outcome !== 'succeeded' && outcome !== 'failed') continue;
    const ending = pack.endings?.[last.stage];
    // A finished quest's entry tells how it went: the ending's own sentence after the description, as the game adds the closing lines of a finished job.
    const told = ending?.memory ? clip(`${base.description} ${ending.memory}`, LIMITS.description) : base.description;
    // The objective of the last stage played, shown struck through as the game shows a finished quest's objectives.
    const played = pack.stages?.find(stage => stage.id === entry.trail.at(-2)?.stage);
    finished.push({...base, description: told, objective: clip(played?.objective ?? played?.label ?? '', LIMITS.objective),
      state: outcome, since: Number.isSafeInteger(last.at) ? last.at : null, endedAt: Number.isSafeInteger(last.at) ? last.at : null});
  }
  const newest = (a, b) => (b.since ?? -1) - (a.since ?? -1) || a.pack.localeCompare(b.pack);
  active.sort(newest); finished.sort(newest);
  return [...active, ...finished.slice(0, FINISHED_KEEP)];
}
