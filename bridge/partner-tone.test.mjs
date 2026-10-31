// The partner tone (2026-10-30): the relationship block carries it in the cached part of the prompt, and a short note repeats it right after V's words.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PersonaBook, buildMessages} from './mistral-prompt.mjs';
import {relationshipContext, romanceReminder, ROMANCE_REMINDER} from './romance-context.mjs';
import {RELATIONSHIP_PROFILES} from './relationship-routing.mjs';
import {MATURE_USE} from './mature-content.mjs';
import {matureWorld} from './mature-content.mjs';

const named = JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8'));
const book = new PersonaBook(named);
const persona = book.persona('panam-palmer');
const romantic = {status: 'ready', profileKey: 'panam-palmer', style: 'romantic', saveRelationship: {status: 'confirmed', evidenceRule: RELATIONSHIP_PROFILES['panam-palmer'].rule}};

test('the closing note sits right after V\'s words and before the closing rules, only on a talk, and never moves the system message', () => {
  const parts = {now: '', notes: '', world: 'W', volatile: '', closing: 'Tone with V this reply: partner.'};
  const talkLast = buildMessages({persona, contextParts: parts, text: 'Hello there'}).at(-1).content;
  assert.match(talkLast, /V says: Hello there\n\nTone with V this reply: partner\.\n\n\(Reply as /);
  const plain = buildMessages({persona, contextParts: {...parts, closing: ''}, text: 'Hello there'});
  assert.doesNotMatch(plain.at(-1).content, /Tone with V/);
  assert.equal(buildMessages({persona, contextParts: parts, text: 'Hello there'})[0].content, plain[0].content, 'the system message is the same with and without the note');
  assert.doesNotMatch(buildMessages({persona, contextParts: parts, text: 'A fight', reaction: true}).at(-1).content, /Tone with V/, 'a reaction has no note');
  assert.doesNotMatch(buildMessages({persona, context: 'ctx', text: 'Hello there'}).at(-1).content, /Tone with V/, 'the older layout has none');
});

test('the same note, the same prefix: the system message does not change between turns and the note is the same text on every turn', () => {
  const world = relationshipContext(romantic, 'phone');
  const note = romanceReminder(romantic, 'phone');
  const a = buildMessages({persona, contextParts: {now: '', notes: '', world, volatile: 'a', closing: note}, text: 'hey'});
  const b = buildMessages({persona, contextParts: {now: '', notes: '', world, volatile: 'b', closing: note}, text: 'how was your day'});
  assert.equal(a[0].content, b[0].content, 'the system message (the cached prefix) does not change between turns');
  assert.ok(a.at(-1).content.includes('you love V'), 'the tone is in the world block, at the start of the last message');
  assert.ok(a.at(-1).content.includes(ROMANCE_REMINDER.partner) && b.at(-1).content.includes(ROMANCE_REMINDER.partner));
});

test('with Mature content on, the tone and the reminder stay, and the partner is explicit only when V leads', () => {
  const world = matureWorld(relationshipContext(romantic, 'private'), undefined);
  assert.ok(world.includes('nothing sexual happens unless V leads'));
  assert.ok(world.includes(MATURE_USE) && !world.includes('A pet name or an open word of affection is welcome'), 'the Mature wording replaced the ordinary one');
  assert.match(ROMANCE_REMINDER.partner, /partner/);
});

test('the bridge wires the note as a closing block, for private and phone turns of a turn that is not a reaction', async () => {
  const source = (await readFile(new URL('./convai-bridge.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  assert.match(source, /block\('closing', admitted && !input\.reaction \? romanceReminder\(prepared\.relationship, prepared\.route\.channel\) : ''\)/);
  assert.match(source, /\['now', 'notes', 'volatile', 'closing'\]\.map\(tier =>/);
});
