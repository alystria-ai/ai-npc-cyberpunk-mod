import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildProfiles} from '../research/cyberpunk/scripts/build_research.mjs';
import {sha256, splitBackstory, splitStyle, lineSegments, rewritable, reassemble, applyRewrite} from '../scripts/first-person-profiles.mjs';
import {checkRewrite, isThirdPerson} from '../scripts/Rewrite-FirstPersonProfiles.mjs';

const json = async path => JSON.parse((await readFile(new URL(path, import.meta.url), 'utf8')).replace(/^﻿/u, ''));

const CORE = ['Judy is a technician. Her craft matters.', 'ESTABLISHED BACKGROUND\nHer own workshop.',
  'ESTABLISHED RELATIONSHIPS\nevelyn-parker: Evelyn trusts Judy.',
  'PUBLIC INTRINSIC TOPIC MATERIAL\nThese are background and personal perspectives, not proof that V met you, heard it.\nShe values independence.\nScope: Her preference.',
  'KNOWLEDGE AND CURRENT SAVE\nUse verified context. Your background is your own knowledge.',
  'KNOWLEDGE LIMITS\nEvents she did not witness.'].join('\n\n');
const BACKSTORY = CORE + '\n\nYour appearance:\nYou have green hair.\n\n[CyberpunkConvai profile v2:judy]';

test('a backstory splits into the rewritable core and an untouched appearance and marker', () => {
  const {core, tail} = splitBackstory(BACKSTORY);
  assert.equal(core, CORE);
  assert.equal(tail, '\n\nYour appearance:\nYou have green hair.\n\n[CyberpunkConvai profile v2:judy]');
  assert.equal(splitBackstory(CORE + '\n\n[CyberpunkConvai profile v2:judy]').tail, '\n\n[CyberpunkConvai profile v2:judy]');
});

test('headings, the intrinsic introduction and the shared save paragraph are fixed; the rest is labelled by kind', () => {
  const kinds = lineSegments(CORE).filter(segment => segment.kind).map(segment => segment.kind);
  assert.deepEqual(kinds, ['story', 'background', 'relationship', 'claim', 'scope', 'limit']);
  const texts = rewritable(lineSegments(CORE)).map(segment => segment.text);
  assert.equal(texts[0], 'Judy is a technician. Her craft matters.');
  assert(!texts.some(text => /^(ESTABLISHED|PUBLIC|KNOWLEDGE|These are background|Use verified)/u.test(text)));
});

test('reassembling the unchanged lines gives the text back byte for byte; a wrong line count is refused', () => {
  const segments = lineSegments(CORE), same = rewritable(segments).map(segment => segment.text);
  assert.equal(reassemble(segments, same), CORE);
  assert.throws(() => reassemble(segments, same.slice(1)), /Expected 6 rewritten lines/);
  const changed = same.map(text => text.replace(/\bHer\b/g, 'My'));
  assert.match(reassemble(segments, changed), /^Judy is a technician\. My craft matters\./);
});

test('a stored rewrite applies only to the exact source text it was written from', () => {
  const row = {sourceSha256: sha256('old text'), text: 'new text'};
  assert.equal(applyRewrite('old text', row, 'x'), 'new text');
  assert.equal(applyRewrite('anything', undefined, 'x'), 'anything');
  assert.throws(() => applyRewrite('changed text', row, 'judy/backstory'), /judy\/backstory: the third-person source changed/);
});

function fixture() {
  const source = {id: 'guide', url: 'https://example.org/q', title: 'Guide', locator: 'x', notes: 'n'};
  const dossier = {version: 1, key: 'judy', name: 'Judy', kind: 'named', sources: [source],
    profile: {backstory: 'Judy is a technician.', speakingStyleDescription: 'Her delivery is direct.',
      speakingStyleSampleDialogues: Array.from({length: 6}, (_, i) => `Original example ${i}.`)},
    intrinsicClaims: [], relationships: [{withKey: 'evelyn-parker', baseline: 'Evelyn trusts Judy.', sourceIds: ['guide']}],
    questKeys: [], uncertainties: [], knowledge: {background: ['Her workshop.'], private: [], unknown: ['Events she missed.'], conditional: []}};
  return {roster: [{key: 'judy', name: 'Judy', voice: 'v', model: 'm', aliases: [], records: []}], dossiers: [dossier]};
}

test('buildProfiles applies the first-person copy, keeps the appearance, marker and shared paragraph, and refuses a stale one', () => {
  const {roster, dossiers} = fixture();
  const [plain] = buildProfiles(roster, dossiers, {appearance: {judy: {text: 'You have green hair.'}}});
  const {core: backstoryCore} = splitBackstory(plain.backstory), {core: styleCore} = splitStyle(plain.speakingStyleDescription);
  const firstPerson = {judy: {backstory: {sourceSha256: sha256(backstoryCore), text: backstoryCore.replace('Judy is', "I'm").replace('Her workshop', 'My workshop')},
    speakingStyleDescription: {sourceSha256: sha256(styleCore), text: 'My delivery is direct.'}}};
  const [mine] = buildProfiles(roster, dossiers, {appearance: {judy: {text: 'You have green hair.'}}, firstPerson});
  assert.match(mine.backstory, /^I'm a technician\./);
  assert.match(mine.backstory, /My workshop\./);
  assert.match(mine.backstory, /\n\nYour appearance:\nYou have green hair\.\n\n\[CyberpunkConvai profile v2:judy\]$/);
  assert.match(mine.speakingStyleDescription, /^My delivery is direct\.\n\nSpeak naturally to V/);
  assert.equal(mine.speakingStyleDescription.split('\n\n').at(-1), plain.speakingStyleDescription.split('\n\n').at(-1));
  dossiers[0].profile.backstory = 'Judy is a technician and more.';
  assert.throws(() => buildProfiles(roster, dossiers, {firstPerson}), /judy\/backstory: the third-person source changed/);
  assert.throws(() => buildProfiles(roster, fixture().dossiers, {firstPerson: {nobody: firstPerson.judy}}), /unknown character: nobody/);
});

function input() {
  return {key: 'judy', name: 'Judy Alvarez', aliases: ['Judy Álvarez'], gender: 'FEMALE',
    backstory: [{id: 'b1', kind: 'story', text: 'Judy is a braindance editor with a workshop in Lizzie\'s Bar.'},
      {id: 'b2', kind: 'relationship', text: 'evelyn-parker: Close friend; Evelyn trusts Judy\'s skill in 2077.'},
      {id: 'b3', kind: 'scope', text: 'Scope: Her craft, not a claim that V has hired her.'}],
    style: [{id: 's1', kind: 'style', text: 'Her vocabulary becomes exact around sensory tracks and edits.'}]};
}
const good = () => ({key: 'judy', backstory: [
  {id: 'b1', text: 'I\'m Judy Alvarez, a braindance editor with a workshop in Lizzie\'s Bar.'},
  {id: 'b2', text: 'evelyn-parker: Close friend; Evelyn trusts my skill in 2077.'},
  {id: 'b3', text: 'Scope: My craft, not a claim that V has hired me.'}],
  style: [{id: 's1', text: 'My vocabulary becomes exact around sensory tracks and edits.'}]});

test('the rewrite checker accepts a faithful first-person copy and flags the usual misses', () => {
  assert.deepEqual(checkRewrite(input(), good()), []);
  const flagged = (edit, pattern) => {
    const output = good(); edit(output);
    assert(checkRewrite(input(), output).some(issue => pattern.test(issue.message)), String(pattern));
  };
  flagged(o => { o.backstory[0].text = 'Judy Alvarez is a braindance editor with a workshop in Lizzie\'s Bar.'; }, /own name|first person/);
  flagged(o => { o.backstory[1].text = 'Close friend; Evelyn trusts my skill in 2077.'; }, /label/);
  flagged(o => { o.backstory[2].text = 'My craft, not a claim that V has hired me.'; }, /Scope/);
  flagged(o => { o.backstory[1].text = 'evelyn-parker: Close friend; Evelyn trusts my skill.'; }, /numbers lost/);
  flagged(o => { o.backstory[2].text = 'Scope: Her craft, not a claim that V has hired her.'; }, /pronoun/);
  flagged(o => { o.backstory[2].text = 'Scope: Here is the rewritten text: my craft, not a claim that V has hired me.'; }, /meta|length/);
  flagged(o => { o.backstory.pop(); }, /expected 3 lines/);
  flagged(o => { o.style[0].text = 'My vocabulary.'; }, /length ratio/);
});

test('every checked-in profile opens in the first person, none in the second or third', async () => {
  const roster = await json('../characters/roster.json');
  assert.equal(roster.length, 81);
  for (const row of roster) {
    assert.match(row.backstory, /^I(?:'|’)m\b/u, row.key);
    assert(!isThirdPerson(row), row.key);
  }
});

test('the checked-in first-person copies are what the roster and the profile text files hold', async () => {
  const roster = await json('../characters/roster.json'), store = await json('../characters/first-person-profiles.json');
  const keys = Object.keys(store.characters);
  assert.equal(keys.length, 81);
  for (const key of keys) {
    const row = roster.find(item => item.key === key), copy = store.characters[key];
    assert(row, key);
    assert.equal(splitBackstory(row.backstory).core, copy.backstory.text, key + '/backstory');
    assert.equal(splitStyle(row.speakingStyleDescription).core, copy.speakingStyleDescription.text, key + '/style');
    assert.match(copy.backstory.sourceSha256, /^[0-9a-f]{64}$/);
    assert.notEqual(sha256(copy.backstory.text), copy.backstory.sourceSha256, key + ' was rewritten');
    assert.equal(row.backstoryWords, row.backstory.split(/\s+/).length, key);
    const text = (await readFile(new URL(`../characters/profile-text/${key}.txt`, import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
    assert(text.includes(row.backstory) && text.includes(row.speakingStyleDescription), key + ' profile-text');
    assert(row.backstory.endsWith(`[CyberpunkConvai profile v2:${key}]`), key);
  }
  assert.equal(roster.filter(isThirdPerson).length, 0, 'nothing is left to extract');
  assert.deepEqual(keys.sort(), roster.map(row => row.key).sort(), 'every profile has a stored first-person copy');
});
