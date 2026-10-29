// The primitives a play stage may use (docs/QUEST_PRIMITIVES.md, docs/BOND_QUESTS.md section 21): the single list the validator (bridge/bond-packs.mjs) checks a
// stage's `do` against, and the events each one can raise. The game side is mod/quest-prims.lua, mod/quest-prims-action.lua and mod/quest-prims-drive.lua, which
// read the same field names. Pure data and small checks, no I/O.
//
// A field type is one of: 'place' (a key of the pack's `places`), 'places' (a list of them), 'id' (a short name), 'event' (an event name), 'record' (a TweakDB record
// name), 'bool', 'text', 'int:lo:hi', 'num:lo:hi', 'enum:a|b|c', or 'any' (a bounded plain value, for fields whose shape the game side owns).
const ID = /^[a-z][a-z0-9-]{0,31}$/;
const EVENT = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,79}$/;
const RECORD = /^[A-Za-z][A-Za-z0-9_.]{2,80}$/;

/** Every primitive: its fields, the ones that must be there, the places it refers to, and the events it raises (`<id>` is the spec's own id). */
export const PRIMITIVES = Object.freeze({
  place:     {fields: {at: 'place', dwell: 'num:0:3600'}, required: ['at'], events: ['place:<at>:arrived', 'place:<at>:left']},
  pin:       {fields: {at: 'place'}, required: ['at'], events: []},
  timer:     {fields: {id: 'id', seconds: 'num:1:100000', clock: 'enum:game|real'}, required: ['id', 'seconds'], events: ['timer:<id>']},
  party:     {fields: {}, required: [], events: ['party:lost']},
  together:  {fields: {id: 'id', minutes: 'num:0.5:600', metres: 'num:1:30', breakSeconds: 'num:10:3600', seated: 'bool', at: 'place'}, required: ['id', 'minutes'],
    events: ['together:<id>:done', 'together:<id>:broken']},
  seat:      {fields: {}, required: [], events: ['seat:seated', 'seat:stood']},
  cast:      {fields: {id: 'id', who: 'text', at: 'place', x: 'num:-100000:100000', y: 'num:-100000:100000', z: 'num:-10000:10000', facing: 'any', record: 'record', archetype: 'text', carry: 'bool'},
    required: ['id', 'who'], events: ['cast:<id>:arrived']},
  squad:     {fields: {id: 'id', at: 'place', faction: 'text', kinds: 'any', count: 'int:1:8', hostile: 'bool', waves: 'any', points: 'any', shared: 'bool', alertAfterSeconds: 'num:1:3600'},
    required: ['id', 'at', 'faction'], events: ['squad:<id>:spawned', 'squad:<id>:hostile', 'squad:<id>:down', 'squad:<id>:fled', 'squad:<id>:wave<N>'], listens: ['squad:<id>:go']},
  hostage:   {fields: {id: 'id', at: 'place', kind: 'enum:floor', record: 'record', cast: 'id', on: 'event', hold: 'num:0:60'}, required: ['id', 'at'],
    events: ['hostage:<id>:down', 'hostage:<id>:freed', 'hostage:<id>:dead'], listens: ['hostage:<id>:exposed']},
  escortee:  {fields: {id: 'id', from: 'id', record: 'record', to: 'place', boltOn: 'event', calmOn: 'event', bonus: 'num:0:10', metres: 'num:1:100'}, required: ['id'],
    events: ['escortee:<id>:arrived', 'escortee:<id>:bolted', 'escortee:<id>:back', 'escortee:<id>:lost'], listens: ['escortee:<id>:bolt', 'escortee:<id>:calm', 'escortee:<id>:swap']},
  ride:      {fields: {to: 'place', checkpoints: 'places', limitMinutes: 'num:1:600', heat: 'bool', hidden: 'bool'}, required: ['to'],
    events: ['ride:started', 'ride:checkpoint:<place>', 'ride:arrived', 'ride:timeout', 'ride:abandoned', 'ride:failed-heat']},
  post:      {fields: {id: 'id', at: 'place', stance: 'enum:stand|prone|car', release: 'event', fightFrom: 'bool'}, required: ['id', 'at'],
    events: ['post:<id>:set', 'post:<id>:lost', 'post:<id>:released', 'post:<id>:fighting'], listens: ['post:<id>:fight']},
  remote:    {fields: {deadZone: 'place'}, required: [], events: ['remote:silenced', 'remote:resumed']},
  runner:    {fields: {id: 'id', route: 'places', driver: 'record', record: 'record', vehicle: 'text', speed: 'num:1:100', caughtMetres: 'num:3:100', stoppedSeconds: 'num:1:600'},
    required: ['id', 'route'], events: ['runner:<id>:caught', 'runner:<id>:lost', 'runner:<id>:stopped']},
  tail:      {fields: {id: 'id', driver: 'record', record: 'record', vehicle: 'text', gap: 'num:5:200', at: 'place', noticeMetres: 'num:3:200', lostMetres: 'num:20:1000'}, required: ['id'],
    events: ['tail:<id>:noticed', 'tail:<id>:lost']},
  check:     {fields: {id: 'id', what: 'enum:hour|weather|heat|song|gear|item|district|radio', args: 'any', now: 'bool'}, required: ['id', 'what'], events: ['check:<id>:<value>'], listens: ['check:<id>:go']},

  // ---- round 2 (docs/QUEST_PRIMITIVES.md section 10): the special loops, the scene pieces and the systems -----------------------------------------------------
  // race: the stage's copy drives her car to `to` while V drives. `from` is the start line (the copy waits there for race:<id>:go or `headStart` seconds), `reversed`
  // makes the slowest arrival the winner and a racer who stands still for `stillSeconds` loses. `heat`: a wanted level voids the race.
  race:      {fields: {id: 'id', from: 'place', to: 'place', vehicle: 'text', reversed: 'bool', heat: 'bool', limitMinutes: 'num:1:120', headStart: 'num:0:120', stillSeconds: 'num:2:120', speed: 'num:1:100'},
    required: ['id', 'to'], events: ['race:<id>:started', 'race:<id>:won', 'race:<id>:lost', 'race:<id>:void', 'race:<id>:timeout', 'race:<id>:stopped'], listens: ['race:<id>:go']},
  // convoy: a column of friendly cars to a place: the stage's copy leads in her car (lead 'self'), or the cars lead (lead 'cars'), with `cars` more cars behind.
  // `reroute` is a second route that replaces the rest of `route` on convoy:<id>:reroute. `fallback`: when the column cannot be driven, the lead goes alone and the cars follow out of sight.
  convoy:    {fields: {id: 'id', route: 'places', reroute: 'places', cars: 'int:1:3', lead: 'enum:self|cars', driver: 'record', vehicle: 'text', speed: 'num:1:100', limitMinutes: 'num:1:240', fallback: 'bool'},
    required: ['id', 'route'], events: ['convoy:<id>:started', 'convoy:<id>:leg<N>', 'convoy:<id>:arrived', 'convoy:<id>:lost-one', 'convoy:<id>:failed', 'convoy:<id>:rerouted', 'convoy:<id>:fallback'],
    listens: ['convoy:<id>:go', 'convoy:<id>:reroute']},
  // bout: two fighters of the stage (cast ids, or 'self' for the stage's copy) trade fists for `rounds` rounds of `roundSeconds`, stopped when one is at `floor` percent health.
  // V is never in it. `staged`: nobody is hit, the winner is `winner` (a | b | random) and the events come from timers (the talk-and-bet scene when a real bout cannot be made safe).
  bout:      {fields: {id: 'id', at: 'place', a: 'text', b: 'text', rounds: 'int:1:5', roundSeconds: 'num:10:300', floor: 'num:5:60', handicap: 'num:0:60', staged: 'bool', winner: 'enum:a|b|random'},
    required: ['id', 'a', 'b'], events: ['bout:<id>:started', 'bout:<id>:round<N>', 'bout:<id>:a-down', 'bout:<id>:b-down', 'bout:<id>:stopped', 'bout:<id>:ended'], listens: ['bout:<id>:go', 'bout:<id>:stop']},
  // hold-until: the stage's waves are won when the game clock reaches `hour`, not by kills. `witness` (an escortee or hostage id of the stage) must be alive then.
  'hold-until': {fields: {id: 'id', hour: 'num:0:24', squad: 'id', witness: 'id'}, required: ['id', 'hour'], events: ['hold-until:<id>:reached', 'hold-until:<id>:failed']},
  // apart: a privacy ring. V stays between `inner` and `outer` metres of a place for `minutes` game minutes (paused outside the ring, broken after breakSeconds of real time).
  apart:     {fields: {id: 'id', at: 'place', inner: 'num:3:100', outer: 'num:10:400', minutes: 'num:0.5:240', breakSeconds: 'num:10:3600'}, required: ['id', 'at', 'minutes'],
    events: ['apart:<id>:done', 'apart:<id>:near', 'apart:<id>:far', 'apart:<id>:broken']},
  // unseen: stealth. The squad of the stage (relaxed, its faction's normal attitude) must not turn to combat and V must not enter combat until V reaches `at`.
  unseen:    {fields: {id: 'id', squad: 'id', at: 'place'}, required: ['id'], events: ['unseen:<id>:spotted', 'unseen:<id>:reached']},
  // dead-zone: a place that silences `remote` while V is inside it.
  'dead-zone': {fields: {id: 'id', at: 'place'}, required: ['id', 'at'], events: ['dead-zone:<id>:entered', 'dead-zone:<id>:left']},
  // workspot: a chosen pose on a copy (`who`: 'self' or a cast id) at a place. A pose that cannot be played falls back to `fallback` (an idle key) and says so.
  workspot:  {fields: {id: 'id', who: 'text', at: 'place', key: 'enum:guitar|smoke|lean|rail|dance|lie-back|sit-ground|sit-ledge|kneel|mechanic|cook|weights|prone-rifle|drink|arms-crossed', fallback: 'text'},
    required: ['id', 'key'], events: ['workspot:<id>:set', 'workspot:<id>:fallback', 'workspot:<id>:lost']},
  // npc-react: reports what an ordinary cast member does after what V says (leave, report V, attack, cower, brawl, obey a command).
  'npc-react': {fields: {id: 'id', cast: 'id'}, required: ['id', 'cast'],
    events: ['npc:<id>:leave', 'npc:<id>:call-police', 'npc:<id>:attack', 'npc:<id>:cower', 'npc:<id>:brawl', 'npc:<id>:obey']},
  // pay: V pays an ordinary cast member in eddies (a toll, a haggle, a tab). V's words are read by the bridge (bridge/quest-pay.mjs), which sends pay:<id>:offer with the amount
  // in the command; the game checks the balance and takes the money. `amount` is the asking price, `min` the least the cast member takes (a haggle).
  pay:       {fields: {id: 'id', to: 'id', amount: 'int:1:20000', min: 'int:1:20000', reason: 'enum:toll|haggle|tab|bribe'}, required: ['id', 'to', 'amount'],
    events: ['pay:<id>:paid', 'pay:<id>:short', 'pay:<id>:broke', 'pay:<id>:declined'], listens: ['pay:<id>:offer']},
  // gift: dir 'receive': the stage's copy gives V an item for `tier` (bridge/gift-tables.mjs), `second` when V already has it. dir 'give': V gives the copy an item, read from V's
  // words, and the copy reacts by her likes table. `item` is a record of the allowlist (a custom record is made once at runtime, docs/QUEST_PRIMITIVES.md section 10).
  gift:      {fields: {id: 'id', dir: 'enum:give|receive', tier: 'enum:common|uncommon|rare|epic|legendary', item: 'record', second: 'record', quantity: 'int:1:20'}, required: ['id', 'dir'],
    events: ['gift:<id>:given', 'gift:<id>:second', 'gift:<id>:failed', 'gift:<id>:loved', 'gift:<id>:liked', 'gift:<id>:neutral', 'gift:<id>:disliked'], listens: ['gift:<id>:offer']},
  // garage: adds a vehicle to V's garage for good (the game's own vehicle unlock). Shipped packs only: a community pack that uses it is refused. Given once per save.
  garage:    {fields: {id: 'id', vehicle: 'record', second: 'record'}, required: ['id', 'vehicle'], events: ['garage:<id>:added', 'garage:<id>:owned', 'garage:<id>:failed']},
  // memory-share: a related character learns what happened. A copy of the mod gets the note as a synthetic exchange, a character the game placed only talks about it.
  'memory-share': {fields: {id: 'id', to: 'text', note: 'text'}, required: ['id', 'to'], events: ['memory-share:<id>:done']},
  // call-in: the character calls V (an incoming holocall the mod starts) and plays the call `call` of the pack's `calls`. Not answered in `ringSeconds`, or when the game cannot
  // start a call: a Phone Chat text with the call's first line and "call me", and the call plays when V calls (the call-script below).
  'call-in': {fields: {id: 'id', call: 'id', ringSeconds: 'num:5:120', text: 'bool'}, required: ['id', 'call'],
    events: ['call:<id>:ringing', 'call:<id>:answered', 'call:<id>:done', 'call:<id>:hung-up', 'call:<id>:missed', 'call:<id>:texted']},
  // call-script: plays the call `call` when V calls this character (V rings, or answers the text of a call-in).
  'call-script': {fields: {id: 'id', call: 'id'}, required: ['id', 'call'], events: ['call:<id>:answered', 'call:<id>:done', 'call:<id>:hung-up']},
});

/** Primitives only the shipped packs may use (a community pack that names one is refused). */
export const TRUSTED_ONLY = Object.freeze(new Set(['garage']));

/** The primitives the game side plays now. A name in PRIMITIVES but not here is accepted and skipped with a warning (the stage plays on its other parts). */
export const BUILT = Object.freeze(new Set(Object.keys(PRIMITIVES)));

export const isEventName = value => typeof value === 'string' && EVENT.test(value);
export const isId = value => typeof value === 'string' && ID.test(value);

const plainValue = (value, depth = 0) => {
  if (depth > 4) return false;
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return typeof value !== 'string' || value.length <= 120;
  if (Array.isArray(value)) return value.length <= 24 && value.every(item => plainValue(item, depth + 1));
  if (typeof value === 'object') return Object.keys(value).length <= 16 && Object.values(value).every(item => plainValue(item, depth + 1));
  return false;
};

function checkField(type, value, places) {
  const [kind, a, b] = type.split(':');
  switch (kind) {
    case 'place': return typeof value === 'string' && places.has(value) ? null : 'must name a place of the pack';
    case 'places': return Array.isArray(value) && value.length >= 1 && value.length <= 24 && value.every(item => typeof item === 'string' && places.has(item)) ? null : 'must be a list of places of the pack';
    case 'id': return isId(value) ? null : 'must be lowercase letters, digits or hyphens';
    case 'event': return isEventName(value) ? null : 'must be an event name';
    case 'record': return typeof value === 'string' && RECORD.test(value) ? null : 'must be a record name';
    case 'bool': return typeof value === 'boolean' ? null : 'must be true or false';
    case 'text': return typeof value === 'string' && value.length >= 1 && value.length <= 80 && !/[\u0000-\u001f]/.test(value) ? null : 'must be short text';
    case 'int': return Number.isInteger(value) && value >= Number(a) && value <= Number(b) ? null : `must be a whole number from ${a} to ${b}`;
    case 'num': return typeof value === 'number' && Number.isFinite(value) && value >= Number(a) && value <= Number(b) ? null : `must be a number from ${a} to ${b}`;
    case 'enum': return typeof value === 'string' && a.split('|').includes(value) ? null : `must be one of ${a.split('|').join(', ')}`;
    case 'any': return plainValue(value) ? null : 'must be a small plain value';
    default: return 'has an unknown type';
  }
}

/**
 * Checks one `do` entry. Returns {errors, warnings}. `places`: a Set of the pack's place ids. The entry is {p, ...fields}.
 */
export function checkPrimitive(spec, places, where) {
  const errors = [], warnings = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) || typeof spec.p !== 'string') return {errors: [`${where}: a primitive needs a name in "p"`], warnings};
  const def = PRIMITIVES[spec.p];
  if (!def) return {errors: [`${where}: unknown primitive ${JSON.stringify(spec.p).slice(0, 40)}`], warnings};
  if (!BUILT.has(spec.p)) warnings.push(`${where}: primitive ${spec.p} is not played yet and will be skipped`);
  for (const [key, value] of Object.entries(spec)) {
    if (key === 'p') continue;
    const type = def.fields[key];
    if (!type) { errors.push(`${where}: ${spec.p} has no field ${JSON.stringify(key).slice(0, 40)}`); continue; }
    const problem = checkField(type, value, places);
    if (problem) errors.push(`${where}: ${spec.p}.${key} ${problem}`);
  }
  for (const key of def.required) if (spec[key] === undefined) errors.push(`${where}: ${spec.p} needs ${key}`);
  return {errors, warnings};
}

/** The events a primitive entry raises, with `<id>`, `<at>` filled in (`<N>` and `<place>` and `<value>` stay open: a pattern the validator matches loosely). */
export function eventsOf(spec) {
  const def = PRIMITIVES[spec?.p];
  if (!def) return [];
  return def.events.map(name => name.replace('<id>', spec.id ?? '').replace('<at>', spec.at ?? ''));
}

/** Whether `name` could be raised by one of the entries (an exact name, or a pattern with an open part). */
export function raisable(name, entries) {
  for (const spec of entries) {
    for (const pattern of eventsOf(spec)) {
      if (pattern === name) return true;
      if (/<[a-zA-Z]+>/.test(pattern)) {
        const source = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/<[a-zA-Z]+>/g, '[a-z0-9:_.-]+');
        if (new RegExp(`^${source}$`).test(name)) return true;
      }
    }
  }
  return false;
}

/** Events the runner and the lines raise themselves (never a primitive's). */
export const CORE_EVENTS = Object.freeze(['stage:enter']);
export const CORE_PATTERNS = Object.freeze([/^line:[A-Za-z0-9._:-]+:done$/, /^gap:[a-z][a-z0-9-]*:(?:open|resume|[a-z][a-z0-9-]*)$/, /^meet:(?:met|stood-up)$/, /^ending:[a-z][a-z0-9-]*$/]);
export const isCoreEvent = name => CORE_EVENTS.includes(name) || CORE_PATTERNS.some(pattern => pattern.test(name));
