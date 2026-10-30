// Romance with any character through the bond system (docs/SIDE_ROMANCE.md): the trait data, the bond milestone to romance step, the refusal path, persistence per save,
// the relationship block and partner tone of a new romance, breaking up. The game half and the settings page are bridge/romance-lua.test.mjs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {traitOf, traitProblem, tableProblems, shippedTraits, MIN_FROM, MAX_FROM, DEFAULT_FROM} from './romance-traits.mjs';
import {screenRomance} from './romance-intent.mjs';
import {RomanceBond, decideProposal, decisionNote, romanceState} from './romance-bond.mjs';
import {Bonds, BondStore, parseBonds, levelOf, storyPart, LEVELS} from './bonds.mjs';
import {selectRelationshipProfile, relationshipRegistry, RELATIONSHIP_PROFILES, BOND_ROMANCE_RULE} from './relationship-routing.mjs';
import {relationshipContext, romanceKind, romanceReminder, ROMANCE_TONE, ROMANCE_REMINDER} from './romance-context.mjs';
import {romanceOf} from './eddies.mjs';
import {MIC_PLACEHOLDER} from './call-meet.mjs';

const roster = JSON.parse(readFileSync(new URL('../characters/roster.json', import.meta.url), 'utf8'));
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const BOUNDARY = {worldToken: 'world-a', generation: 3};

// ---- the trait data ----------------------------------------------------------------------------------------------------------------------------------------------------------

test('the shipped traits cover every roster character with a valid row, and the text rules hold', () => {
  const table = JSON.parse(read('../characters/romance-traits.json'));
  const keys = roster.filter(row => row.kind !== 'ambient').map(row => row.key);
  assert.deepEqual(tableProblems(table, keys), []);
  const rows = Object.values(table.traits);
  assert.ok(rows.some(row => row.open) && rows.some(row => !row.open), 'both kinds exist');
  for (const row of rows.filter(item => item.open)) assert.ok(row.from >= MIN_FROM && row.from <= MAX_FROM);
  // The styles are written for each character: no two open characters share one.
  const styles = rows.filter(row => row.open).map(row => row.style);
  assert.equal(new Set(styles).size, styles.length, 'no style line is used twice');
});

test('the main cast is judged by personality and story: Takemura is formal and slow, children and the cruel are never', () => {
  const takemura = traitOf('takemura');
  assert.equal(takemura.open, true);
  assert.ok(takemura.from >= 7, 'a formal man trusts slowly');
  assert.match(takemura.style, /formal|restrained|courte|reserved|disciplin/i);
  // A refusal comes with the reason the character says no with.
  for (const key of ['adam-smasher', 'luka-soto', 'dorothy-allred']) {
    const trait = traitOf(key);
    assert.equal(trait.open, false, key);
    assert.equal(trait.from, null);
    assert.equal(trait.style, '');
    assert.ok(trait.reason.length > 20, key);
  }
  // The five the game itself lets V romance are open (their native romance is unchanged).
  for (const key of Object.keys(RELATIONSHIP_PROFILES)) assert.equal(traitOf(key).open, true, key);
});

test('a character with no row (a player\'s own, a pack\'s) is open from level 7 with no style line, and a bad row is refused', () => {
  assert.deepEqual(traitOf('my-own-character'), {open: true, from: DEFAULT_FROM, reason: '', style: '', listed: false});
  assert.equal(traitOf(undefined).listed, false);
  assert.equal(traitProblem({open: true, from: 4, reason: 'a fine reason here', style: 'a fine style written here'}) !== null, true);
  assert.equal(traitProblem({open: true, from: 6, reason: 'a fine reason here', style: 'a fine style written here'}), null);
  assert.equal(traitProblem({open: false, reason: 'a fine reason here', extra: 1}) !== null, true);
  assert.match(traitProblem({open: false, reason: 'an em dash \u2014 in it here'}), /dash/);
  assert.match(traitProblem({open: false, reason: 'a semicolon; in it here'}), /semicolon/);
  assert.match(traitProblem({open: false, reason: `works with ${'A' + 'MM'} here fine`}), /mod/);
  assert.ok(Object.isFrozen(shippedTraits()));
});

// ---- what V says ---------------------------------------------------------------------------------------------------------------------------------------------------------------

test('V\'s words: a proposal, a break up, and the lines that are neither', () => {
  for (const line of ['Will you be my girlfriend?', 'I love you, Goro', 'I think I am falling for you', 'be my partner', 'Let\'s make it official', 'I have feelings for you']) {
    assert.equal(screenRomance(line), 'propose', line);
  }
  for (const line of ['I think we should break up', 'It\'s over between us', 'I\'m done with you', 'I don\'t love you anymore', 'let\'s just be friends']) assert.equal(screenRomance(line), 'end', line);
  for (const line of ['I love you guys', 'do you love me?', 'we\'re done here', 'let\'s split up and search the building', 'I would never go out with you', 'nice jacket', '', MIC_PLACEHOLDER]) {
    assert.equal(screenRomance(line), null, line);
  }
});

// ---- the decision ----------------------------------------------------------------------------------------------------------------------------------------------------------------

const open = {open: true, from: 6, reason: 'You trust slowly but loyalty means everything to you.', style: 'You stay formal and restrained even in love, and you never gush.'};
const closed = {open: false, reason: 'You took a vow and you keep it.'};
const traits = Object.freeze({'goro': open, 'padre': closed});
const turnOf = (profileKey, text, extra = {}) => ({requestId: `r-${Math.random()}`, profileKey, name: profileKey, text, bonds: {on: true}, ...extra});

test('the milestone: below the trait\'s level the answer is "not yet", at the level it is yes, and nothing changes until the reply is out', () => {
  assert.equal(decideProposal({trait: traitOf('goro', traits), level: 5, state: null}), 'defer');
  assert.equal(decideProposal({trait: traitOf('goro', traits), level: 6, state: null}), 'accept');
  assert.equal(decideProposal({trait: traitOf('goro', traits), level: 10, state: 'ended'}), 'accept', 'after a break up V can ask again');
  assert.equal(decideProposal({trait: traitOf('goro', traits), level: 10, state: 'together'}), null, 'already together');
  assert.equal(decideProposal({trait: traitOf('goro', traits), level: 8, hurt: 60, state: null}), 'sting', 'V hurt them recently');
  assert.equal(decideProposal({trait: traitOf('padre', traits), level: 10, state: null}), 'refuse');
  assert.equal(decideProposal({trait: traitOf('goro', traits), level: 6, hurt: 5, state: null}), 'accept', 'a little left over does not matter');
  // The bond levels the traits name are real levels.
  assert.ok(LEVELS.length === 10 && MIN_FROM >= 5 && MAX_FROM <= 10);
});

test('V asks at the bond level: the turn carries the yes, and after the reply the romance is recorded and handed to the game', () => {
  const bonds = new Bonds({store: new BondStore()});
  const romance = new RomanceBond({traits, bonds});
  const turn = turnOf('goro', 'Goro, I love you. Will you be my partner?');
  const note = romance.noteFor(turn, {level: 6});
  assert.match(note, /say yes/);
  assert.match(note, /trust slowly/, 'the character\'s own reason is in it');
  assert.match(note, /nothing sexual unless V leads/);
  assert.equal(romance.noteFor(turn, {level: 2}), note, 'decided once per request: later builds of the same turn read the same');
  // Before the reply is out nothing is recorded.
  assert.equal(romance.stateFor('goro', BOUNDARY), null);
  const change = romance.afterTurn(turn, undefined, BOUNDARY);
  assert.equal(change.profileKey, 'goro');
  assert.equal(change.state, 'together');
  assert.equal(romance.stateFor('goro', BOUNDARY), 'together');
  // The bond status the game reads carries it once, as a change newer than any a session had before.
  const status = bonds.status();
  assert.deepEqual(status.romance.changes.map(item => [item.profileKey, item.state, item.id]), [['goro', 'together', status.romance.revision]]);
  assert.equal(romance.afterTurn(turn, undefined, BOUNDARY), null, 'a turn is carried out once');
});

test('too soon: a character who is open but not close enough says so kindly and nothing is recorded', () => {
  const bonds = new Bonds({store: new BondStore()}), romance = new RomanceBond({traits, bonds});
  const turn = turnOf('goro', 'Be my girlfriend');
  const note = romance.noteFor(turn, {level: 4});
  assert.match(note, /too soon, not never/);
  assert.doesNotMatch(note, /say yes/);
  assert.equal(romance.afterTurn(turn, undefined, BOUNDARY), null);
  assert.equal(romance.stateFor('goro', BOUNDARY), null);
  assert.equal(bonds.status().romance.changes.length, 0);
});

test('the refusal path: a character who never would says no in their own way for their own reason, at any bond level, and keeps the friendship', () => {
  const bonds = new Bonds({store: new BondStore()}), romance = new RomanceBond({traits, bonds});
  const turn = turnOf('padre', 'I love you, Padre');
  const note = romance.noteFor(turn, {level: 10});
  assert.match(note, /You would not, and never will/);
  assert.match(note, /Your reason: You took a vow and you keep it\./);
  assert.match(note, /in your own way/);
  assert.match(note, /keep the friendship/);
  assert.equal(romance.afterTurn(turn, undefined, BOUNDARY), null);
  assert.equal(romance.stateFor('padre', BOUNDARY), null);
  assert.equal(bonds.status().romance.changes.length, 0);
  // A recent threat or insult stings even where they would say yes.
  const hurt = romance.noteFor(turnOf('goro', 'be my partner'), {level: 9, hurt: 40});
  assert.match(hurt, /still stings/);
  assert.equal(romance.afterTurn(turnOf('goro', 'be my partner'), undefined, BOUNDARY), null);
});

test('a line that proposes nothing, a group round, a reaction and a turn without bonds get no note', () => {
  const romance = new RomanceBond({traits});
  assert.equal(romance.noteFor(turnOf('goro', 'How is the garden?'), {level: 9}), '');
  assert.equal(romance.noteFor(turnOf('goro', 'be my partner', {group: {index: 1}}), {level: 9}), '');
  assert.equal(romance.noteFor(turnOf('goro', 'be my partner', {reaction: {kind: 'fight'}}), {level: 9}), '');
  assert.equal(romance.noteFor(turnOf('goro', 'be my partner', {bonds: undefined}), {level: 9}), '');
  assert.equal(romance.noteFor(turnOf('Bad Key', 'be my partner'), {level: 9}), '');
  assert.equal(romance.noteFor(turnOf('addon-someone', 'be my partner'), {level: 9}), '');
  // Already together: asking again changes nothing.
  assert.equal(romance.noteFor(turnOf('goro', 'be my partner'), {level: 9, together: true}), '');
});

test('a spoken turn has no words yet: it carries the answer as a condition, and the transcript decides after the reply', () => {
  const bonds = new Bonds({store: new BondStore()}), romance = new RomanceBond({traits, bonds});
  const spoken = turnOf('goro', MIC_PLACEHOLDER);
  const note = romance.noteFor(spoken, {level: 7});
  assert.match(note, /^If V says now that they love you or want to be together with you: you feel the same and know V well enough, so say yes/);
  assert.match(note, /never bring it up yourself/);
  // The transcript says something else: nothing happens, even though the character was ready to say yes.
  assert.equal(romance.afterTurn(spoken, 'How is the garden?', BOUNDARY), null);
  const second = turnOf('goro', '');
  romance.noteFor(second, {level: 7});
  assert.equal(romance.afterTurn(second, 'Goro, be my partner', BOUNDARY).state, 'together');
  // A character who never would: the condition is the refusal, and a spoken proposal records nothing.
  const refuse = turnOf('padre', MIC_PLACEHOLDER);
  assert.match(romance.noteFor(refuse, {level: 10}), /you would never, because you took a vow and you keep it\./);
  assert.equal(romance.afterTurn(refuse, 'be my partner', BOUNDARY), null);
  // Together, a spoken turn is ready for a break up and says nothing of a proposal.
  const together = turnOf('goro', MIC_PLACEHOLDER);
  assert.match(romance.noteFor(together, {level: 9, together: true}), /^If V says now that they are ending the relationship between you: it is over and you accept it/);
  assert.equal(romance.afterTurn(together, 'be my partner', BOUNDARY), null);
  assert.equal(romance.afterTurn(together, 'it\'s over between us', BOUNDARY).state, 'ended');
});

test('breaking up: V ends it, the character takes it in their own way, and the state becomes ended', () => {
  const bonds = new Bonds({store: new BondStore()}), romance = new RomanceBond({traits, bonds});
  const turn = turnOf('goro', 'Goro, it\'s over between us');
  const note = romance.noteFor(turn, {level: 9, together: true});
  assert.match(note, /V is ending the relationship/);
  assert.match(note, /in your own voice/);
  assert.match(note, /Do not beg, bargain, threaten/);
  assert.equal(romance.afterTurn(turn, undefined, BOUNDARY).state, 'ended');
  assert.equal(romance.stateFor('goro', BOUNDARY), 'ended');
  assert.equal(bonds.status().romance.changes.at(-1).state, 'ended');
  // Not together: a break up line is just talk.
  assert.equal(romance.noteFor(turnOf('goro', 'it\'s over between us'), {level: 9}), '');
  // And V can ask again later.
  const again = turnOf('goro', 'will you be my girlfriend?');
  assert.match(romance.noteFor(again, {level: 9, ended: true}), /say yes/);
});

// ---- persistence per save ------------------------------------------------------------------------------------------------------------------------------------------

test('per save: the game\'s block is the truth, a decision waits only for the same world, and a loaded save brings back its own state', () => {
  const romance = new RomanceBond({traits});
  const other = {worldToken: 'world-b', generation: 1};
  romance.noteBlock('goro', null, BOUNDARY);
  assert.equal(romance.stateFor('goro', BOUNDARY), null);
  const turn = turnOf('goro', 'be my partner');
  romance.noteFor(turn, {level: 8});
  romance.afterTurn(turn, undefined, BOUNDARY);
  assert.equal(romance.stateFor('goro', BOUNDARY), 'together');
  // The game has not written the fact yet: the next turn's block says none, and the decision stands.
  romance.noteBlock('goro', null, BOUNDARY);
  assert.equal(romance.stateFor('goro', BOUNDARY), 'together');
  // The game wrote it: the block agrees and the game is the truth again (a later block that says ended is believed).
  romance.noteBlock('goro', 'together', BOUNDARY);
  assert.equal(romance.stateFor('goro', BOUNDARY), 'together');
  romance.noteBlock('goro', 'ended', BOUNDARY);
  assert.equal(romance.stateFor('goro', BOUNDARY), 'ended');
  // Another save (another world binding) knows nothing of this one until its own block arrives.
  assert.equal(romance.stateFor('goro', other), null);
  romance.noteBlock('goro', 'together', other);
  assert.equal(romance.stateFor('goro', other), 'together');
  // Back in the first world the state is unknown until a turn there says it (a reaction without a block never invents one).
  assert.equal(romance.stateFor('goro', BOUNDARY), null, 'only the newest world is remembered');
  assert.equal(romance.stateFor('goro', {worldToken: 'world-a', generation: 4}), null, 'a reload of the world is a new binding');
  // A decision made in one world never reaches the next.
  const turn2 = turnOf('goro', 'be my partner');
  romance.noteBlock('goro', null, BOUNDARY);
  romance.noteFor(turn2, {level: 8});
  romance.afterTurn(turn2, undefined, BOUNDARY);
  romance.noteBlock('goro', null, other);
  assert.equal(romance.stateFor('goro', BOUNDARY), null, 'the other world\'s block dropped the waiting decision');
  assert.equal(romanceState('together'), 'together');
  assert.equal(romanceState('married'), null);
  assert.deepEqual(parseBonds({version: 1, on: true, romance: 'together'}).romance, 'together');
  assert.equal(parseBonds({version: 1, on: true, romance: 'married'}).romance, undefined);
  assert.equal(parseBonds({version: 1, on: true}).romance, undefined);
});

// ---- the relationship block and the partner tone -------------------------------------------------------------------------------------------------------------

const registry = relationshipRegistry({'takemura': 'id-takemura', 'judy-alvarez': 'id-judy', 'meredith-stout': 'id-meredith', 'rogue-amendiares': 'id-rogue'});
const choose = (profileKey, bondRomance, extra = {}) => selectRelationshipProfile({profileKey, registry, boundary: BOUNDARY, bondRomance, ...extra});
const together = style => ({state: 'together', style});

test('a new romance feeds the same relationship block and partner tone the game romances get, with the style line written for that character', () => {
  const selection = choose('takemura', together(open.style));
  assert.equal(selection.style, 'romantic');
  assert.equal(selection.reason, 'bond-romance');
  assert.equal(selection.kind, 'relationship');
  assert.deepEqual(selection.saveRelationship, {status: 'confirmed', evidenceRule: BOND_ROMANCE_RULE});
  assert.equal(romanceKind(selection), 'partner');
  assert.equal(romanceOf(selection, RELATIONSHIP_PROFILES), 'partner');
  const text = relationshipContext(selection, 'private');
  assert.match(text, /the current save confirms that you and V are together/);
  assert.ok(text.includes(open.style), 'the style line of the character');
  assert.ok(text.includes(ROMANCE_TONE.partner), 'the partner tone: pet names, the phone-nearby talk');
  assert.match(text, /pet name or nickname/);
  assert.match(text, /over the phone from far away/);
  assert.ok(text.includes('nothing sexual happens unless V leads'), 'Mature stays as it is: only when V leads');
  assert.equal(relationshipContext(selection, 'phone'), text, 'phone turns get the same');
  assert.equal(romanceReminder(selection, 'private'), ROMANCE_REMINDER.partner);
  assert.equal(romanceReminder(selection, 'group'), '');
  // A group round keeps it private.
  assert.match(relationshipContext(selection, 'group', {}), /Keep private relationship history/);
  // A character with no rule and no romance gets nothing, as before.
  assert.equal(relationshipContext(choose('rogue-amendiares', null), 'private'), '');
  assert.equal(romanceKind(choose('rogue-amendiares', null)), '');
  assert.equal(romanceOf(choose('rogue-amendiares', null), RELATIONSHIP_PROFILES), null);
  // Without a style line the general tone still covers it.
  assert.match(relationshipContext(choose('rogue-amendiares', together('')), 'private'), /you and V are together/);
  // The bond: a romance is story points, like a game romance.
  assert.equal(storyPart({profileKey: 'takemura', romance: 'partner'}).romance, 150);
});

test('the five of the game keep their own cues, a casual encounter that became a romance is a partnership, and On and Off are still the player\'s word', () => {
  const judy = choose('judy-alvarez', together('a style that should not be used'));
  assert.match(relationshipContext(judy, 'private'), /Judy's affection comes out sideways/);
  assert.doesNotMatch(relationshipContext(judy, 'private'), /a style that should not be used/);
  const meredith = choose('meredith-stout', together('You stay blunt and controlled, even about this.'));
  assert.equal(meredith.kind, 'relationship');
  assert.equal(romanceKind(meredith), 'partner');
  const meredithText = relationshipContext(meredith, 'private');
  assert.ok(meredithText.includes('You stay blunt and controlled, even about this.'));
  assert.doesNotMatch(meredithText, /Never claim that you are V's partner/);
  assert.equal(romanceOf(meredith, RELATIONSHIP_PROFILES), 'partner');
  // Off keeps the ordinary delivery whatever the save holds; On is affectionate with no romance at all.
  assert.equal(choose('judy-alvarez', together(''), {mode: 'off'}).style, 'ordinary');
  assert.equal(choose('judy-alvarez', {state: 'ended', style: ''}, {mode: 'on'}).style, 'romantic');
  assert.equal(choose('takemura', null).style, 'ordinary');
});

test('after a break up the character is ordinary and knows it ended: no pet names, no tenderness, whatever the game\'s own receipt says', () => {
  const ended = choose('takemura', {state: 'ended', style: open.style});
  assert.equal(ended.style, 'ordinary');
  assert.equal(ended.reason, 'bond-romance-ended');
  assert.equal(romanceKind(ended), '');
  assert.equal(romanceOf(ended, RELATIONSHIP_PROFILES), null);
  const text = relationshipContext(ended, 'private');
  assert.match(text, /You and V were together once and it ended/);
  assert.match(text, /no pet names, no tenderness, no flirting/);
  assert.doesNotMatch(text, /pet name or nickname/, 'no partner tone');
  assert.equal(romanceReminder(ended, 'private'), '');
  // Judy, with the game's receipt confirmed and V having ended it: the receipt's "never just friends" line is not said.
  const facts = {};
  for (const name of ['sq030_judy_lover']) facts[name] = {status: 'known', value: 1, present: true, sourceId: 'native-quests-system', evidenceRefs: ['core-arcs.judy.committed']};
  const snapshot = {version: 1, status: 'ready', gameVersion: '2.5', ...BOUNDARY, capturedAt: Date.now(), facts};
  const native = {snapshot, now: Date.now()};
  const stillTogether = choose('judy-alvarez', null, native);
  assert.equal(stillTogether.style, 'romantic', 'the game\'s own romance, as before');
  const brokenUp = choose('judy-alvarez', {state: 'ended', style: ''}, native);
  assert.equal(brokenUp.style, 'ordinary');
  assert.equal(brokenUp.saveRelationship, undefined);
  const judyText = relationshipContext(brokenUp, 'private');
  assert.match(judyText, /it ended/);
  assert.doesNotMatch(judyText, /never just friends/);
  assert.equal(romanceOf(brokenUp, RELATIONSHIP_PROFILES), null);
  // V asks again and she agrees: together overrides the old end.
  assert.equal(choose('judy-alvarez', together(''), native).style, 'romantic');
});

test('the bridge wires it: the selection reads the romance of the turn\'s block, the note is a volatile block, the decision is carried out after the reply', () => {
  const source = read('./convai-bridge.mjs');
  assert.match(source, /import \{RomanceBond\} from '\.\/romance-bond\.mjs'/);
  assert.match(source, /if \(turn\?\.bonds\) romanceBond\.noteBlock\(profile, turn\.bonds\.romance, boundary\)/);
  assert.match(source, /block\('volatile', romanceNote\(input, prepared, admitted\)\)/);
  assert.match(source, /romanceBond\.afterTurn\(input, result\?\.userText, \{worldToken: prepared\.worldToken, generation: prepared\.generation\}\)/);
  assert.match(source, /romanceBond\.bonds = bonds;/);
  assert.match(read('./player-knowledge.mjs'), /bonds: \{romance: frozen\.bonds\.romance \?\? null\}/);
});

test('the notes are plain text: no dashes, no semicolons, and nothing explicit', () => {
  for (const decision of ['accept', 'defer', 'sting', 'refuse', 'end']) {
    const note = decisionNote(decision, {reason: 'You trust slowly.'});
    assert.ok(note.length > 80, decision);
    assert.doesNotMatch(note, /[\u2013\u2014;]|--/, decision);
    assert.doesNotMatch(note, /\b(?:sex|kiss|naked|bed)\b/i, decision);
  }
  assert.equal(decisionNote('nothing', open), '');
  assert.ok(levelOf(240).level === 5);
});
