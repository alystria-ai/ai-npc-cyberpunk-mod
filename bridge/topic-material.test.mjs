import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve, dirname} from 'node:path';
import {splitTopicMaterial, itemLine, TOPIC_HEADING} from './topic-material.mjs';
import {leanBackstory, PersonaBook, systemHead} from './mistral-prompt.mjs';

const roster = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../characters/roster.json'), 'utf8'));
const withTopics = roster.filter(row => String(row.backstory).includes(TOPIC_HEADING));

const SAMPLE = [
  'I am a test runner.',
  '',
  'PUBLIC INTRINSIC TOPIC MATERIAL',
  'These are background and personal perspectives, not proof that V met you. Verified game facts override.',
  'I think the old net was better.',
  'Scope: My view only; I do not claim to know every event.',
  '',
  'I distrust corporate offers.',
  'Scope: A judgment, not a secret.',
  '',
  'KNOWLEDGE AND CURRENT SAVE',
  'Current game state overrides conflicting memories.',
  '',
  'Your appearance:',
  'Blue hair.',
].join('\n');

test('the section is cut out and each claim is one item with its Scope line', () => {
  const split = splitTopicMaterial(SAMPLE);
  assert.equal(split.items.length, 2);
  assert.equal(split.preface, 'These are background and personal perspectives, not proof that V met you. Verified game facts override.');
  assert.equal(split.items[0].text, 'I think the old net was better.\nScope: My view only; I do not claim to know every event.');
  assert.equal(split.items[1].text, 'I distrust corporate offers.\nScope: A judgment, not a secret.');
  assert.equal(split.core, ['I am a test runner.', '', 'KNOWLEDGE AND CURRENT SAVE', 'Current game state overrides conflicting memories.', '', 'Your appearance:', 'Blue hair.'].join('\n'));
  assert.ok(!split.core.includes(TOPIC_HEADING));
});

test('a backstory without the section is not split', () => {
  assert.equal(splitTopicMaterial('Just a bio.\n\nYour appearance:\nTall.'), null);
  assert.equal(splitTopicMaterial(''), null);
});

test('an item is a prompt line with the Scope line indented under the claim', () => {
  assert.equal(itemLine({text: 'A claim.\nScope: Its limit.'}), '- A claim.\n  Scope: Its limit.');
  assert.equal(itemLine({text: 'A claim alone.'}), '- A claim alone.');
});

test('all 77 named characters with the section split cleanly, raw and lean', () => {
  assert.equal(withTopics.length, 77);
  for (const row of withTopics) {
    for (const [mode, text] of [['raw', row.backstory], ['lean', leanBackstory(row.backstory)]]) {
      const split = splitTopicMaterial(text);
      assert.ok(split, `${row.key} ${mode}`);
      assert.ok(split.items.length >= 3, `${row.key} ${mode} items`);
      assert.ok(split.preface.length > 40, `${row.key} ${mode} preface`);
      assert.ok(!split.core.includes(TOPIC_HEADING), `${row.key} ${mode} core`);
      // The rest of the persona is untouched: the save rules, the knowledge limits and the appearance stay in the fixed core.
      for (const heading of ['KNOWLEDGE AND CURRENT SAVE', 'KNOWLEDGE LIMITS', 'Your appearance:']) {
        if (row.backstory.includes(heading)) assert.ok(split.core.includes(heading), `${row.key} ${mode} ${heading}`);
      }
      // Every item is a claim, not a heading or an intro.
      for (const item of split.items) assert.ok(!/^(?:These are background|Background and personal|PUBLIC INTRINSIC|KNOWLEDGE)/.test(item.text), `${row.key} ${mode} item ${item.text.slice(0, 40)}`);
    }
  }
});

test('nothing is lost: core plus preface plus items hold every word of the backstory', () => {
  const words = text => String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const row of withTopics) {
    const split = splitTopicMaterial(row.backstory);
    const rebuilt = words([split.core, TOPIC_HEADING, split.preface, ...split.items.map(item => item.text)].join('\n'));
    const original = words(row.backstory);
    assert.deepEqual([...rebuilt].sort(), [...original].sort(), row.key);
  }
});

test('the roster, in total: 636 items, and the fixed core is about half the lean persona', () => {
  let items = 0, lean = 0, core = 0;
  for (const row of withTopics) {
    const text = leanBackstory(row.backstory), split = splitTopicMaterial(text);
    items += split.items.length; lean += text.length; core += split.core.length;
  }
  assert.equal(items, 636);
  assert.ok(core / lean < 0.6, `core ${core} of ${lean}`);
});

test('PersonaBook with topics: the persona leaves the section out, the editor text and the raw text keep it', () => {
  const book = new PersonaBook(roster, {lean: true, topics: true}), plain = new PersonaBook(roster, {lean: true});
  const persona = book.persona('panam-palmer');
  assert.ok(!persona.backstory.includes(TOPIC_HEADING));
  assert.ok(plain.persona('panam-palmer').backstory.includes(TOPIC_HEADING));
  assert.ok(book.defaults('panam-palmer').backstory.includes(TOPIC_HEADING), 'the editor shows the shipped text whole');
  assert.ok(book.persona('panam-palmer').backstory.length < plain.persona('panam-palmer').backstory.length * 0.7);
  const lean = book.topicMaterial('panam-palmer'), raw = book.topicMaterial('panam-palmer', {raw: true});
  assert.equal(lean.items.length, raw.items.length);
  assert.match(lean.preface, /^Background and personal views/);
  assert.match(raw.preface, /^These are background and personal perspectives/);
  assert.equal(book.topicMaterial('no-such-character'), null);
  assert.equal(plain.topicMaterial('panam-palmer'), null, 'no topic split unless the book was built with topics');
});

test('a bio the player changed is sent whole and its topic material is not retrieved', () => {
  const overrides = {get: key => (key === 'panam-palmer' ? {bio: 'My own words.\n\nPUBLIC INTRINSIC TOPIC MATERIAL\nMine.'} : null)};
  const book = new PersonaBook(roster, {lean: true, topics: true, overrides});
  assert.ok(book.persona('panam-palmer').backstory.includes('PUBLIC INTRINSIC TOPIC MATERIAL'));
  assert.equal(book.topicMaterial('panam-palmer'), null);
  assert.ok(book.topicMaterial('judy-alvarez'), 'another character is unchanged');
});

test('the output rules, the hard-limit layers and the save rules are the same with the section cut out', () => {
  const book = new PersonaBook(roster, {lean: true, topics: true}), plain = new PersonaBook(roster, {lean: true});
  const a = systemHead({persona: book.persona('judy-alvarez'), mature: 'full'}), b = systemHead({persona: plain.persona('judy-alvarez'), mature: 'full'});
  const tail = text => text.slice(text.indexOf('OUTPUT RULES'));
  assert.equal(tail(a), tail(b), 'rules, Mature layer and the adults-only line follow the persona byte for byte');
  assert.ok(a.includes('Verified current-save context overrides memory.'));
  assert.ok(b.length - a.length > 1000, `the head is ${b.length - a.length} characters shorter`);
});
