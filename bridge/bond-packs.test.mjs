// Story packs (docs/RELATIONSHIPS_AND_QUESTS.md, section 7 and 8; bridge/bond-packs.mjs): the shipped example packs pass the validator, the validator
// catches what a pack author gets wrong, and the plot-safety gate opens only when the character's story is done. Data only: no pack runs in a turn yet.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validatePack, packGate, shippedPacks, blockingPrefixes, PACK_LIMITS} from './bond-packs.mjs';
import {parseJournalHistory} from './journal-history.mjs';

const roster = new Set(JSON.parse(readFileSync(new URL('../characters/roster.json', import.meta.url), 'utf8')).map(row => row.key));
const packs = shippedPacks();
const byId = Object.fromEntries(packs.map(({pack}) => [pack.id, pack]));
const clone = value => JSON.parse(JSON.stringify(value));

function journal(rows, {complete = true} = {}) {
  const coverage = {status: complete ? 'complete' : 'partial', ageSeconds: 1, windowSeconds: 30, observed: rows.length, omitted: complete ? 0 : 3, unstable: false};
  return parseJournalHistory({version: 1, status: 'ready', generation: 1, capturedAtMs: 2000, tracked: {status: 'untracked'}, coverage: {active: coverage, history: coverage},
    quests: rows.map(([path, state], index) => ({id: String(100 + index), nativeId: path.slice(path.lastIndexOf('/') + 1), nativePath: path, title: 'Quest ' + index,
      state, lane: state === 'active' ? 'active' : 'history', observedAtMs: 1000, objectivesComplete: state !== 'active', objectives: []}))});
}

test('the three example packs are shipped, one per character, and pass the validator', () => {
  assert.deepEqual(packs.map(({pack}) => pack.id).sort(), ['judy-dinner-dress', 'kerry-new-song', 'panam-truck-ransom']);
  for (const {file, pack} of packs) {
    assert.equal(file, `${pack.id}.json`);
    const result = validatePack(pack, {characters: roster});
    assert.deepEqual(result.errors, [], file);
    // Every stage carries a fixed English line for the moments no model may be called (the shared Convai key).
    for (const stage of pack.stages) assert(stage.say?.en, `${pack.id} ${stage.id}: a fixed line`);
  }
  assert.equal(byId['panam-truck-ransom'].requires.eddies, true, 'the ransom asks for eddies');
  assert(byId['panam-truck-ransom'].stages[0].effects.some(effect => effect.kind === 'vehicleBlocked'), 'her truck is blocked while it is stolen');
});

test('the validator catches broken packs', () => {
  const base = byId['panam-truck-ransom'];
  const broken = (change, pattern) => {
    const pack = clone(base); change(pack);
    const result = validatePack(pack, {characters: roster});
    assert.equal(result.ok, false, String(pattern));
    assert(result.errors.some(error => pattern.test(error)), `${pattern}: ${result.errors.join(' | ')}`);
  };
  broken(pack => { pack.id = 'X'; }, /^id must/);
  broken(pack => { pack.character = 'nobody-at-all'; }, /not on the roster/);
  broken(pack => { pack.requires.questsFinished = []; }, /must name at least one of panam-palmer's quests/);
  broken(pack => { pack.requires.eddies = false; }, /must require eddies/);
  broken(pack => { pack.stages[0].choices[0].next = 'nowhere'; }, /next "nowhere" is neither a stage nor an ending/);
  broken(pack => { pack.stages[0].ask.amount = 500000; }, /ask needs/);
  broken(pack => { pack.stages[0].effects = [{kind: 'setQuestFact'}]; }, /an effect must be one of/);
  broken(pack => { pack.stages[0].know = 'x'.repeat(PACK_LIMITS.know + 1); }, /know must be/);
  broken(pack => { pack.stages[0].say = {de: 'nur deutsch'}; }, /needs an English line/);
  broken(pack => { pack.stages[0].choices.push({id: 'odd', on: 'quest:done', next: 'alone'}); }, /on must be tag/);
  broken(pack => { pack.stages[1].choices = [{id: 'met', on: 'meet:met', next: 'back'}]; delete pack.stages[1].meet; }, /needs a meet in the stage/);
  // A stage nobody can reach, and a loop that never reaches an ending.
  broken(pack => { pack.stages.push({id: 'orphan', know: 'nobody gets here', say: {en: 'hi'}, next: 'repaid'}); }, /stage orphan cannot be reached/);
  broken(pack => {
    pack.stages = [{id: 'a', know: 'a', choices: [{id: 'b', on: 'tag', means: 'b', next: 'b'}]}, {id: 'b', know: 'b', next: 'a'}];
  }, /never reaches an ending/);
  assert.equal(validatePack(null).ok, false);
});

const PANAM_STORY = [['quests/side_quest/sq027_02_raffen_shiv_attack', 'succeeded'], ['quests/side_quest/sq027_01_basilisk_convoy', 'succeeded']];
const open = {level: 6, channel: 'own', settings: {eddies: true, invitations: true}};

test('the gate: open only after the character\'s story, at the bond, on one of the mod\'s own channels, with the systems it needs', () => {
  const pack = byId['panam-truck-ransom'];
  assert.deepEqual(packGate(pack, {...open, journalHistory: journal(PANAM_STORY)}), {open: true});
  assert.equal(packGate(pack, {...open, journalHistory: journal(PANAM_STORY.slice(1))}).why, 'quest-not-finished');
  assert.equal(packGate(pack, {...open, journalHistory: journal([['quests/side_quest/sq027_02_raffen_shiv_attack', 'failed']])}).open, true, 'failed counts as finished');
  assert.equal(packGate(pack, {...open, journalHistory: journal(PANAM_STORY, {complete: false})}).why, 'journal-unknown');
  assert.equal(packGate(pack, {...open, journalHistory: null}).why, 'journal-unknown');
  assert.equal(packGate(pack, {...open, level: 4, journalHistory: journal(PANAM_STORY)}).why, 'bond');
  assert.equal(packGate(pack, {...open, channel: 'story', journalHistory: journal(PANAM_STORY)}).why, 'channel', 'the game\'s own Panam never starts a pack');
  assert.equal(packGate(pack, {...open, settings: {eddies: false}, journalHistory: journal(PANAM_STORY)}).why, 'eddies-off');
  assert.equal(packGate(pack, {...open, busy: true, journalHistory: journal(PANAM_STORY)}).why, 'busy');
  // One of her quest lines active again, or the end of the story: closed.
  assert.equal(packGate(pack, {...open, journalHistory: journal([...PANAM_STORY, ['quests/side_quest/sq004_riders_on_the_storm', 'active']])}).why, 'quest-active');
  assert.equal(packGate(pack, {...open, journalHistory: journal([...PANAM_STORY, ['quests/main_quest/act_01/q115_afterlife', 'active']])}).why, 'quest-active');
  // Another character's active quest does not matter.
  assert.equal(packGate(pack, {...open, journalHistory: journal([...PANAM_STORY, ['quests/side_quest/sq030_judy_romance', 'active']])}).open, true);
  assert(blockingPrefixes(pack).includes('quests/main_quest/act_01/q104'), 'her arc prefixes are added');
  // Judy's pack: no money, both her quests.
  const judy = byId['judy-dinner-dress'];
  const judyDone = [['quests/side_quest/sq026_04_hiromi', 'succeeded'], ['quests/side_quest/sq030_judy_romance', 'succeeded']];
  assert.deepEqual(packGate(judy, {...open, settings: {}, journalHistory: journal(judyDone)}), {open: true});
  assert.equal(packGate(judy, {...open, journalHistory: journal(judyDone.slice(0, 1))}).why, 'quest-not-finished');
  const partner = {...judy, requires: {...judy.requires, relationship: 'partner'}};
  assert.equal(packGate(partner, {...open, journalHistory: journal(judyDone)}).why, 'relationship');
  assert.equal(packGate(partner, {...open, romance: 'partner', journalHistory: journal(judyDone)}).open, true);
});
