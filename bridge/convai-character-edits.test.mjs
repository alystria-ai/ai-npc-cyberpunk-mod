// The player's character edits on a Convai turn (bridge/convai-character-edits.mjs): present only for an edited character, only what the edit changed, kept within its size,
// the same words every time, built once per edit. Offline: no Convai request is made.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PersonaBook} from './mistral-prompt.mjs';
import {CharacterOverrides, EDIT_LIMITS} from './character-overrides.mjs';
import {CharacterEditor} from './character-editor.mjs';
import {ConvaiCharacterEdits, convaiEditsText, CONVAI_EDITS_HEADING, CONVAI_EDITS_LIMIT} from './convai-character-edits.mjs';

const roster = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
  ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];
const size = text => Array.from(text).length;

async function setup(limit) {
  const overrides = await CharacterOverrides.open({dir: null});
  const personas = new PersonaBook(roster, {lean: true, overrides});
  const editor = new CharacterEditor({personas, overrides, route: () => 'convai'});
  return {overrides, personas, editor, edits: new ConvaiCharacterEdits({overrides, personas, ...(limit ? {limit} : {})})};
}

test('an unedited character gets no block, and nothing is added for it on any turn', async () => {
  const {edits} = await setup();
  for (const key of ['judy-alvarez', 'johnny-silverhand', 'npc-food-vendor-male', 'no-such-person']) {
    assert.equal(edits.textFor(key), '');
    assert.deepEqual(edits.blocks(key), []);
  }
  assert.deepEqual(edits.blocks(undefined), []);
});

test('an edited character gets one block of the convai tier, headed as who the character is now, and a text provider answering the turn gets none', async () => {
  const {edits, editor} = await setup();
  await editor.save('judy-alvarez', {rules: ['Never mention Biscuit the cat unless V asks.']});
  const blocks = edits.blocks('judy-alvarez');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].tier, 'convai', 'a tier the text providers\' layout does not read');
  assert(blocks[0].text.startsWith(CONVAI_EDITS_HEADING));
  assert(/WHO YOU ARE NOW/.test(blocks[0].text) && /older text is out of date/.test(blocks[0].text));
  assert.deepEqual(edits.blocks('judy-alvarez', true), [], 'the persona carries the edits while a text provider answers');
  assert.deepEqual(edits.blocks('panam-palmer'), [], 'another character is untouched');
});

test('only what the edit changed is sent: each field, with the shipped text left out', async () => {
  const {edits, editor, personas} = await setup();
  const shown = editor.details('judy-alvarez').values;
  const mineBio = 'MY PARAGRAPH: Judy keeps a tabby cat called Biscuit on the console.';
  const shippedFirst = shown.bio.split(/\n\s*\n/)[0].trim();
  await editor.save('judy-alvarez', {
    bio: `${shown.bio}\n\n${mineBio}`, style: 'Speaks in short, dry sentences.', rules: ['Rule one.', 'Rule two.'], memories: ['V saved her once.'],
    examples: [...shown.examples, 'V: Pets? / You: Biscuit, a tabby.']});
  const text = edits.textFor('judy-alvarez');
  for (const wanted of [mineBio, 'Speaks in short, dry sentences.', '- Rule one.', '- Rule two.', '- V saved her once.', '- V: Pets? / You: Biscuit, a tabby.']) assert(text.includes(wanted), wanted);
  assert(!text.includes(shippedFirst.slice(0, 80)), 'the shipped bio is not repeated, Convai has it');
  assert(!text.includes(shown.examples[0]), 'nor the shipped example lines');
  assert(!/No longer true of you/.test(text), 'nothing was taken out');
  // Only the speaking style: nothing else is in the block.
  await editor.reset('judy-alvarez');
  await editor.save('judy-alvarez', {style: 'Only the style.'});
  const only = edits.textFor('judy-alvarez');
  assert(only.includes('How you speak now:\nOnly the style.'));
  assert(!/Your own rules|Things you always know|Your backstory now|Example lines/.test(only));
  assert.equal(personas.persona('judy-alvarez').style, 'Only the style.', 'the same store the text providers read');
});

test('a paragraph the player took out or rewrote is named as no longer true, shortly', async () => {
  const {edits, editor} = await setup();
  const shown = editor.details('judy-alvarez').values, paragraphs = shown.bio.split(/\n\s*\n/);
  assert(paragraphs.length > 3);
  const rewritten = 'Judy is now a quiet librarian who has never touched a braindance editor in her life.';
  await editor.save('judy-alvarez', {bio: [rewritten, ...paragraphs.slice(2)].join('\n\n')});
  const text = edits.textFor('judy-alvarez');
  assert(text.includes(rewritten));
  const removed = text.split('No longer true of you')[1];
  assert(removed, 'the removed list is there');
  assert(removed.includes(paragraphs[0].replace(/\s+/g, ' ').slice(0, 60)) && removed.includes(paragraphs[1].replace(/\s+/g, ' ').slice(0, 60)));
  for (const line of removed.split('\n').filter(item => item.startsWith('- '))) assert(size(line) <= 2 + 141, 'each is a short start of the paragraph');
});

test('a long edit is cut to the size limit in a fixed order: the rules and the memories whole, then the style, the bio paragraphs the player wrote, the examples', async () => {
  const {edits, editor, overrides} = await setup();
  const shown = editor.details('alt-cunningham').values;
  const rules = Array.from({length: 6}, (_, i) => `Rule ${i + 1}: ${'x'.repeat(140)}`);
  const memories = Array.from({length: 6}, (_, i) => `Memory ${i + 1}: ${'y'.repeat(150)}`);
  const paragraphs = Array.from({length: 8}, (_, i) => `Paragraph ${i + 1}. ${'Alt remembers the Blackwall and the long dark behind it. '.repeat(14).trim()}`);
  await overrides.set('alt-cunningham', {bio: `${shown.bio}\n\n${paragraphs.join('\n\n')}`, style: 'S'.repeat(1200), rules, memories,
    examples: [...shown.examples, ...Array.from({length: 5}, (_, i) => `V: Q${i}? / You: A${i} ${'z'.repeat(150)}`)]});
  const text = edits.textFor('alt-cunningham');
  assert(size(text) <= CONVAI_EDITS_LIMIT, `${size(text)} characters`);
  assert(size(text) > CONVAI_EDITS_LIMIT - 400, 'the room is used');
  for (const line of [...rules, ...memories]) assert(text.includes(line), 'rules and memories are whole: ' + line.slice(0, 12));
  assert(text.includes('S'.repeat(1200)), 'the speaking style is whole');
  assert(text.includes('Paragraph 1.'), 'the player\'s first paragraph is kept');
  assert(!text.includes('Paragraph 8.'), 'the last of them did not fit');
  assert(!text.includes('Example lines in your voice'), 'the examples had no room left');
  // Every limit of the editor at once still fits.
  const full = convaiEditsText({bio: 'B'.repeat(EDIT_LIMITS.bio), style: 'S'.repeat(EDIT_LIMITS.style), rules: Array.from({length: 10}, () => 'r'.repeat(160)),
    memories: Array.from({length: 12}, () => 'm'.repeat(200)), examples: Array.from({length: 20}, () => 'e'.repeat(150))}, {backstory: 'Shipped.', samples: []});
  assert(size(full) <= CONVAI_EDITS_LIMIT, `${size(full)} characters at the editor's own limits`);
  // A small limit is kept too, and the heading alone is never sent.
  assert(size(convaiEditsText(overrides.get('alt-cunningham'), {backstory: shown.bio, samples: shown.examples}, 900)) <= 900);
  assert.equal(convaiEditsText({rules: ['A rule.']}, {backstory: 'x', samples: []}, size(CONVAI_EDITS_HEADING) + 5), '');
});

test('the same edit gives the same words, and the text is built once per edit, not per turn', async () => {
  const {edits, editor, overrides, personas} = await setup();
  await editor.save('judy-alvarez', {style: 'Dry.', rules: ['Short.']});
  const first = edits.textFor('judy-alvarez');
  let reads = 0;
  const defaults = personas.defaults.bind(personas);
  personas.defaults = (...args) => { reads++; return defaults(...args); };
  const before = reads;
  for (let i = 0; i < 50; i++) assert.equal(edits.textFor('judy-alvarez'), first);
  assert.equal(reads, before, 'a turn is a lookup');
  // The same fields rebuilt from scratch are byte for byte the same.
  const other = new ConvaiCharacterEdits({overrides, personas: new PersonaBook(roster, {lean: true, overrides})});
  assert.equal(other.textFor('judy-alvarez'), first);
  // A save changes the words on the very next turn, once.
  await editor.save('judy-alvarez', {style: 'Dry.', rules: ['Short.', 'Blunt.']});
  const built = reads, second = edits.textFor('judy-alvarez');
  assert.notEqual(second, first);
  assert(second.includes('- Blunt.'));
  assert.equal(reads, built + 1, 'built once for the new edit');
  edits.textFor('judy-alvarez'); assert.equal(reads, built + 1);
  // A reset takes the block away.
  await editor.reset('judy-alvarez');
  assert.equal(edits.textFor('judy-alvarez'), '');
  assert.deepEqual(edits.blocks('judy-alvarez'), []);
});

test('the wording is fixed (a change of it is a change of what the model reads, so it is visible here)', () => {
  assert.equal(convaiEditsText({style: 'Dry.', rules: ['Short.'], memories: ['Knows V.']}, {backstory: 'x', samples: []}), [
    'WHO YOU ARE NOW (set by the player, and current). Where this differs from your older backstory, speaking style or rules, this is true and the older text is out of date. The limits and rules you already follow still stand.',
    'How you speak now:\nDry.',
    'Your own rules of speech now:\n- Short.',
    'Things you always know:\n- Knows V.',
  ].join('\n\n'));
  assert.equal(convaiEditsText({}, {backstory: 'x', samples: []}), '');
  assert.equal(convaiEditsText(null, {}), '');
});

test('the bridge reads the edits from the store it already holds, after the world rules, with no file read of its own', async () => {
  const bridge = await readFile(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /new ConvaiCharacterEdits\(\{overrides: characterOverrides, personas: personaBook\}\)/);
  assert.match(bridge, /convaiWorldRulesBlocks\([^\n]*\),(?:\s*\/\/[^\n]*\n)+\s*\.\.\.convaiCharacterEdits\.blocks\(input\.profileKey, mistral\.active\),/);
  const module = await readFile(new URL('./convai-character-edits.mjs', import.meta.url), 'utf8');
  assert(!/node:fs|readFile|writeFile|setTimeout|setInterval/.test(module), 'no file and no timer in the module');
});
