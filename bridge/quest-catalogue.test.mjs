// Every name of the quest catalogue (docs/BOND_QUESTS.md section 21) can be written as pack data and passes the validator: the `do` primitives are in
// bridge/quest-primitives.mjs, the rest is expressed by a pack field named in CATALOGUE_ELSEWHERE. One pack uses every round 2 primitive and field.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PRIMITIVES, CATALOGUE, CATALOGUE_ELSEWHERE, TRUSTED_ONLY} from './quest-primitives.mjs';
import {validatePack} from './bond-packs.mjs';

test('every name of the catalogue is a primitive or has a place in a pack', () => {
  for (const name of CATALOGUE) assert(name in PRIMITIVES || name in CATALOGUE_ELSEWHERE, `${name} is not covered`);
  for (const name of Object.keys(CATALOGUE_ELSEWHERE)) assert(CATALOGUE.includes(name), `${name} is not in the catalogue list`);
});

const place = (x, y) => ({name: 'A place', radius: 20, x, y, z: 10, captured: true});
const lines = {
  'T.a': {text: 'Hello there.', audio: 'audio/T.a.wav'}, 'T.call1': {text: 'It is me.', channel: 'holocall', audio: 'audio/T.call1.wav'},
  'T.call2': {text: 'Listen.', channel: 'holocall', audio: 'audio/T.call2.wav'}, 'T.won': {text: 'You won.', audio: 'audio/T.won.wav'},
  'T.loved': {text: 'I love it.', audio: 'audio/T.loved.wav'}, 'T.text': {text: 'Call me.', audio: 'audio/T.text.wav'},
};
const base = () => ({
  format: 2, id: 'all-primitives', character: 'panam-palmer', title: 'All of them', summary: 'Every round 2 primitive.',
  requires: {questsFinished: ['quests/main_quest/act_01/q104_02_av_chase'], facts: {'takemura-alive': true}, before: ['quests/main_quest/prologue/q005_heist'],
    notBegun: ['ep1/quests/main_quest/q306_reed_epilogue'], window: {allowActive: ['quests/main_quest/prologue/q003'], untracked: true}, invitations: true},
  start: {channels: ['own', 'phone'], chance: 0.5, bringUp: 'You want V to come along for something.'},
  places: {a: place(100, 100), b: place(500, 100), c: place(900, 100), d: place(900, 500), ring: place(100, 900)},
  lines,
  gaps: {g1: {asks: 'What now?', know: 'The call goes on.', situation: 'nervous', idle: 'panam', resumeAfterSeconds: 60}},
  calls: {c1: {caller: 'self', picture: 'voice', text: 'T.text', onHangUp: 'call:ring:hung-up', steps: [{say: 'T.call1'}, {gap: 'g1'}, {event: 'x:y'}, {say: 'T.call2'}, {hangup: true}]}},
  unfinishedWhen: {finished: 'quests/main_quest/prologue/q005_heist', ending: 'unfinished'},
  stages: [
    {id: 'one', type: 'play', know: 'You are racing V.', situation: 'celebrating',
      do: [{p: 'cast', id: 'fan', who: 'extra', record: 'Character.afterlife_merc_fixer', at: 'a'}, {p: 'cast', id: 'fan2', who: 'extra', record: 'Character.afterlife_merc_fixer', at: 'a'},
        {p: 'race', id: 'dash', from: 'a', to: 'b', reversed: false, heat: true, limitMinutes: 10}, {p: 'convoy', id: 'col', route: ['a', 'b', 'c'], reroute: ['a', 'd'], cars: 2, lead: 'self', fallback: true, holdLegs: [1]},
        {p: 'bout', id: 'fight', a: 'fan', b: 'fan2', rounds: 3, roundSeconds: 40, floor: 25, staged: true, winner: 'random'},
        {p: 'npc-react', id: 'react', cast: 'fan'}, {p: 'pay', id: 'toll', to: 'fan', amount: 100, min: 60, reason: 'haggle'},
        {p: 'workspot', id: 'pose', who: 'self', at: 'a', key: 'guitar', fallback: 'panam'}, {p: 'apart', id: 'ring', at: 'ring', inner: 10, outer: 60, minutes: 5},
        {p: 'dead-zone', id: 'dz', at: 'd'}],
      script: [{when: 'race:dash:won', say: 'T.won'}, {when: 'pay:toll:paid', event: 'next:go'}, {when: 'apart:ring:done', event: 'next:go2'}],
      music: [{source: 'radio:Morro Rock Radio', start: 'stage:enter', stop: 'race:dash:won', fadeIn: 1, fadeOut: 2, volume: 0.6, duck: true, loop: true}],
      sfx: [{source: 'file:sfx/rain.ogg', at: 'place:a', loop: true, start: 'stage:enter', stop: 'race:dash:won'}, {source: 'game:ui_jingle_quest_new', at: 'v', start: 'race:dash:won'}],
      choices: [{id: 'done', on: 'event:race:dash:won', next: 'two'}], timeout: {gameHours: 4, next: 'out'}},
    {id: 'two', type: 'play', know: 'You are at the end.',
      do: [{p: 'squad', id: 'wave', at: 'b', faction: 'maelstrom', count: 3, hostile: false}, {p: 'hostage', id: 'wit', at: 'b'}, {p: 'unseen', id: 'sneak', squad: 'wave', at: 'c'},
        {p: 'hold-until', id: 'dawn', hour: 6, squad: 'wave', witness: 'wit'}, {p: 'gift', id: 'give', dir: 'give'}, {p: 'gift', id: 'get', dir: 'receive', tier: 'common', second: 'Items.Nomad_01_Set_Boots'},
        {p: 'garage', id: 'car', vehicle: 'Vehicle.v_sport1_rayfield_aerondight_player'}, {p: 'memory-share', id: 'tell', to: 'judy-alvarez', note: 'V did well.'},
        {p: 'call-in', id: 'ring', call: 'c1', ringSeconds: 20}, {p: 'call-script', id: 'back', call: 'c1'}],
      script: [{when: 'gift:give:loved', say: 'T.loved'}, {when: 'call:ring:texted', event: 'ok:text'}],
      choices: [{id: 'fin', on: 'event:hold-until:dawn:reached', next: 'good'}, {id: 'bad', on: 'event:hold-until:dawn:failed', next: 'out'}], timeout: {gameHours: 12, next: 'out'}},
  ],
  endings: {good: {memory: 'You held the line together.', bond: 40, history: 'We held a farmhouse until dawn.', share: [{to: 'judy-alvarez', note: 'V and Panam held a farmhouse.'}], situation: 'relaxed'},
    out: {memory: 'It fell apart.', bond: 0}, unfinished: {memory: 'It never finished.', bond: 0}},
});

test('a pack that uses every round 2 primitive, call, sound and gate field passes the validator', () => {
  const result = validatePack(base());
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test('every round 2 primitive is used by that pack', () => {
  const used = new Set(base().stages.flatMap(stage => stage.do.map(spec => spec.p)));
  for (const name of ['race', 'convoy', 'bout', 'hold-until', 'apart', 'unseen', 'dead-zone', 'workspot', 'npc-react', 'pay', 'gift', 'garage', 'memory-share', 'call-in', 'call-script']) {
    assert(used.has(name), `${name} is not in the test pack`);
  }
});

test('a community pack may not use garage, and a primitive that names an id nothing makes is refused', () => {
  assert(TRUSTED_ONLY.has('garage'));
  const community = validatePack(base(), {community: true});
  assert(community.errors.some(error => /garage is only for the packs shipped/.test(error)), community.errors.join('\n'));
  const broken = base();
  broken.stages[0].do.push({p: 'pay', id: 'x', to: 'nobody', amount: 5});
  assert(validatePack(broken).errors.some(error => /pay\.to/.test(error)));
  const sound = base();
  sound.stages[0].sfx[0].start = 'never:happens';
  assert(validatePack(sound).errors.some(error => /sfx 1: start/.test(error)));
  const call = base();
  call.stages[1].do[8].call = 'zzz';
  assert(validatePack(call).errors.some(error => /call-in\.call/.test(error)));
});
