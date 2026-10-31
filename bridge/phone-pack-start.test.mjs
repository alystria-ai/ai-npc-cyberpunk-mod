// Phone Chat texts and the story packs (owner's live test of 1 Nov 2026: three texts to Judy started nothing and the log said nothing about why).
// What this pins, through the real Phone Chat parser and the real runner:
//   1. a Phone Chat text carries the bonds block and the channel `phone` to the pack logic, the same logic a holocall and a talk in person get;
//   2. a text is a valid start wherever the pack's start channels list `phone`, exactly like a holocall, and not where they do not;
//   3. the game's `busy` flag is what refused them (the open phone holds the scene tier above gameplay's), and the log says so;
//   4. in Developer mode every private turn leaves one line that says why a pack started or did not (gate, channel, party, cooldown, chance), even on the same game day.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import './story-packs-dev-on.mjs';
import {PhoneChat} from './phone-chat.mjs';
import {BondPacks} from './bond-pack-runner.mjs';
import {shippedPacks} from './bond-packs.mjs';
import {parseBonds} from './bonds.mjs';
import {parseJournalHistory} from './journal-history.mjs';

const DAY = 86400, HOUR = 3600;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const roster = new Set(JSON.parse(read('../characters/roster.json')).map(row => row.key));
const all = shippedPacks().map(({pack}) => pack);
const dress = all.find(pack => pack.id === 'judy-dinner-dress');
const T0 = 31 * DAY + 9 * HOUR;

const coverage = {status: 'complete', ageSeconds: 1, windowSeconds: 30, observed: 2, omitted: 0, unstable: false};
const journal = () => ({version: 1, status: 'ready', generation: 1, capturedAtMs: 2000, worldToken: 'w1', tracked: {status: 'untracked'}, coverage: {active: coverage, history: coverage},
  quests: ['sq026_04_hiromi', 'sq030_judy_romance'].map((id, index) => ({id: String(100 + index), nativeId: id, nativePath: `quests/side_quest/${id}`, title: 'Quest ' + index,
    state: 'succeeded', lane: 'history', observedAtMs: 1000, objectivesComplete: true, objectives: []}))});

const binding = () => ({version: 1, status: 'available', authoritative: true, confidence: 'native-live', localUserId: 'user-1', campaignId: 'a'.repeat(32),
  branchId: 'b'.repeat(32), branchEpoch: 1, ledgerSequence: 10, generation: 1, activationId: 'c'.repeat(32)});
let serial = 0;
/** The state file the game writes for one typed Phone Chat message, as mod/phone-chat.lua writes it. `bonds`: the block mod/bonds.lua attach made, or undefined. */
const state = (bonds, gameTime) => {
  const saveIdentity = binding();
  return {version: 2, world: 'world-1', updated: 100000, active: true, saveIdentity, request: {id: `world-1-${++serial}`, contact: 'judy', saveIdentity, text: 'Hey Judy!',
    turnContext: {version: 1, status: 'ready', gameTime}, journalHistory: journal(), ...(bonds ? {bonds} : {})}};
};

/** A Phone Chat whose reply hook does what the bridge does for a text: the pack logic reads the input the provider got, then the reply goes out. */
function chatOf(runner, facts = {level: 6, romance: null}) {
  const seen = [];
  const chat = new PhoneChat({contacts: [{contact: 'judy', key: 'judy-alvarez'}], ids: {'judy-alvarez': 'judy-id'}, now: () => 100000,
    reply: async ({input}) => {
      seen.push(input);
      const decision = runner.forTurn(input, facts);
      const reply = {text: decision?.note ? 'Hey. I have a thing.' : 'Hey.', sessionID: 'session'};
      runner.afterTurn(input, reply.text);
      return reply;
    }, publish: async () => {}});
  return {chat, seen};
}
async function text(chat, bonds, gameTime) { await chat.accept(state(bonds, gameTime)); await chat.active?.work; }

function make(options = {}) {
  const lines = [], awards = [];
  const runner = new BondPacks({packs: [dress], characters: roster, random: () => 0, log: line => lines.push(line), explain: () => true, debounceMs: 0, exists: () => false,
    write: async () => {}, bonds: {award: (...args) => awards.push(args), publish() {}}, ...options});
  return {runner, lines, awards};
}
// The block the game sends with a Phone Chat text (mod/bonds.lua attach with phone = true): Character bonds, Story packs and Immersive invitations on.
const BLOCK = {version: 1, on: true, packs: true, invitations: true};

test('a Phone Chat text reaches the pack logic as the channel phone with the bonds block, and starts a pack whose start channels list phone, like a holocall', async () => {
  const {runner, lines} = make();
  const {chat, seen} = chatOf(runner);
  await text(chat, BLOCK, T0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].channel, 'phone', 'the channel name a Phone Chat text gets');
  assert.deepEqual(seen[0].bonds, {on: true, copy: null, packs: true, invitations: true}, 'the bonds block survived the phone path');
  assert.equal(seen[0].holocall, undefined, 'and it is not a holocall');
  assert.equal(runner.entries.get('judy-dinner-dress')?.status, 'active', 'the pack started on the text');
  assert.equal(runner.entries.get('judy-dinner-dress').via, 'phone');
  assert.ok(lines.some(line => /pack=judy-dinner-dress started on phone/.test(line)), lines.join(' | '));
  // A holocall gets the same decision from the same pack and the same state.
  const call = make();
  const input = {requestId: 'h-1', profileKey: 'judy-alvarez', name: 'Judy', text: 'hey', entity: 'e1', turnContext: {gameTime: T0}, journalHistory: parseJournalHistory(journal()),
    holocall: {contact: 'judy-alvarez', mode: 'audio'}, bonds: parseBonds(BLOCK)};
  call.runner.forTurn(input, {level: 6}); call.runner.afterTurn(input, 'ok');
  assert.equal(call.runner.entries.get('judy-dinner-dress').via, 'holocall');
});

test('a pack starts on a text only where its start channels list phone: every shipped pack follows its own list, a text and a holocall alike', () => {
  const listed = all.filter(pack => pack.start.channels.includes('phone'));
  assert.ok(listed.length >= 90, `${listed.length} packs start on a phone text`);
  for (const pack of all) {
    const {runner} = make({packs: [pack]});
    const input = {id: 'p-1', profileKey: pack.character, channel: 'phone', text: 'hey', turnContext: {gameTime: T0}, bonds: parseBonds(BLOCK)};
    const decision = runner.forTurn(input, {level: 10});
    // The gate may still say no for its own reasons (a quest not finished), but never for the channel.
    const notes = []; const probe = make({packs: [pack], log: line => notes.push(line)});
    probe.runner.forTurn({...input, id: 'p-2'}, {level: 10});
    const channelNo = notes.some(line => /phone does not start it/.test(line));
    assert.equal(channelNo, !pack.start.channels.includes('phone'), `${pack.id}: the phone channel ${pack.start.channels.includes('phone') ? 'is' : 'is not'} listed`);
    void decision;
  }
});

test('the game called the text busy (the open phone holds the scene tier): the pack waits, and the log names the game and what it saw', async () => {
  const {runner, lines} = make();
  const {chat} = chatOf(runner);
  await text(chat, {...BLOCK, busy: true, busyWhy: 'scene tier 3'}, T0);
  assert.equal(runner.entries.get('judy-dinner-dress'), undefined, 'no start while the block says busy');
  const turnLine = lines.find(line => /^\[dev\] turn judy-alvarez on a Phone Chat text/.test(line));
  assert.ok(turnLine, lines.join(' | '));
  assert.match(turnLine, /the game is busy \(scene tier 3\)/);
  assert.match(turnLine, /judy-dinner-dress waits: the game is busy \(scene tier 3\)/);
  // The same text with the game calm starts it.
  const calm = make();
  await text(chatOf(calm.runner).chat, BLOCK, T0);
  assert.equal(calm.runner.entries.get('judy-dinner-dress')?.status, 'active');
});

test('in Developer mode every turn leaves one line, even on the same game day and the same reason: channel, party, bond level, clock, busy, and the reason of each pack', async () => {
  let roll = 0.9;
  const {runner, lines} = make({random: () => roll});
  const {chat} = chatOf(runner);
  for (let i = 0; i < 3; i++) await text(chat, BLOCK, T0 + i * 300);
  const turns = lines.filter(line => /^\[dev\] turn /.test(line));
  assert.equal(turns.length, 3, 'one line per text, not one per pack per game day');
  for (const line of turns) {
    assert.match(line, /^\[dev\] turn judy-alvarez on a Phone Chat text: she is apart from V, not in V's party, bond level 6, day 31 09:\d\d, the game is not busy\. /);
  }
  assert.match(turns[0], /judy-dinner-dress waits: the dice said no \(chance 0\.35, roll 1 of 5 today\)/);
  assert.match(turns[1], /judy-dinner-dress waits: the next roll comes after 1 more talk turns/);
  assert.match(turns[2], /judy-dinner-dress waits: the dice said no \(chance 0\.35, roll 2 of 5 today\)/);
  // The roll that wins starts it, and the line says so.
  roll = 0;
  await text(chat, BLOCK, T0 + 900); await text(chat, BLOCK, T0 + 1200);
  assert.ok(lines.some(line => /^\[dev\] turn judy-alvarez on a Phone Chat text: .*\. started judy-dinner-dress$/.test(line)), lines.slice(-4).join(' | '));
  // A running pack says so on the next text.
  await text(chat, BLOCK, T0 + 1500);
  assert.match(lines.filter(line => /^\[dev\] turn /.test(line)).at(-1), /judy-dinner-dress is running \(stage invite\), so no new pack starts/);
});

test('the gate, the channel, the party, the quiet days and an abandoned pack each say so in the turn line', () => {
  const calls = all.find(pack => pack.id === 'judy-claws-calling');
  const gate = make({packs: [{...structuredClone(dress), requires: {...dress.requires, bond: 9}}]});
  gate.runner.forTurn({id: 'g-1', profileKey: 'judy-alvarez', channel: 'phone', text: 'hey', turnContext: {gameTime: T0}, journalHistory: parseJournalHistory(journal()), bonds: parseBonds(BLOCK)}, {level: 3});
  assert.match(gate.lines.at(-1), /judy-dinner-dress waits: bond level 3 is under 9/, 'gate');
  const channel = make({packs: [{...structuredClone(dress), start: {...dress.start, channels: ['own']}}]});
  channel.runner.forTurn({id: 'c-1', profileKey: 'judy-alvarez', channel: 'phone', text: 'hey', turnContext: {gameTime: T0}, journalHistory: parseJournalHistory(journal()), bonds: parseBonds(BLOCK)}, {level: 6});
  assert.match(channel.lines.at(-1), /phone does not start it \(it starts on own\)/, 'channel');
  const party = make({packs: [calls]});
  party.runner.forTurn({id: 'p-1', profileKey: 'judy-alvarez', channel: 'phone', text: 'hey', turnContext: {gameTime: T0}, journalHistory: parseJournalHistory(journal()), bonds: parseBonds({...BLOCK, eddies: true})}, {level: 7, near: true});
  assert.match(party.lines.at(-1), /she is beside V/, 'party and place');
  assert.match(party.lines.at(-1), /opens with a call and she is beside V/, 'the reason');
  // The quiet days after a quest, and the day after V abandoned one.
  const quiet = make();
  const turnOf = (id, at) => ({id, profileKey: 'judy-alvarez', channel: 'phone', text: 'hey', turnContext: {gameTime: at}, journalHistory: parseJournalHistory(journal()), bonds: parseBonds(BLOCK)});
  quiet.runner.forTurn(turnOf('q-0', T0 - DAY), {level: 6});
  quiet.runner.meta.get('judy-alvarez').endedAt = T0 - DAY;
  quiet.runner.forTurn(turnOf('q-1', T0), {level: 6});
  assert.match(quiet.lines.at(-1), /judy-dinner-dress waits: quiet days after the last quest \(7 game days\)/, 'cooldown');
  const dropped = make();
  const first = turnOf('d-1', T0); dropped.runner.forTurn(first, {level: 6}); dropped.runner.afterTurn(first, 'hi');
  assert.equal(dropped.runner.abandon('judy-dinner-dress', {gameSeconds: T0 + 60}), true);
  dropped.runner.forTurn(turnOf('d-2', T0 + HOUR), {level: 6});
  assert.match(dropped.lines.at(-1), /judy-dinner-dress waits: V abandoned it less than a game day ago/, 'abandoned');
});

test('a turn that never reached the pack logic says why: no bonds block, or a block without Story packs', async () => {
  const {runner, lines} = make();
  runner.noDecision({id: 'n-1', profileKey: 'judy-alvarez', channel: 'phone', text: 'hey'});
  assert.match(lines.at(-1), /^\[dev\] turn judy-alvarez on a Phone Chat text: no pack decision, the game sent no bonds block/);
  runner.noDecision({id: 'n-2', profileKey: 'judy-alvarez', channel: 'phone', text: 'hey', bonds: {on: true, copy: null}});
  assert.match(lines.at(-1), /no pack decision, the bonds block has no Story packs flag/);
  const count = lines.length;
  runner.noDecision({id: 'n-2', profileKey: 'judy-alvarez', channel: 'phone', text: 'hey', bonds: {on: true, copy: null}});
  assert.equal(lines.length, count, 'said once per turn');
  runner.noDecision({id: 'n-3', profileKey: 'npc-vendor', channel: 'phone', text: 'hey'});
  runner.noDecision({id: 'n-4', profileKey: 'judy-alvarez', reaction: {kind: 'x'}, text: 'hey'});
  assert.equal(lines.length, count, 'an ordinary NPC and a reaction are no turn of V\'s with a named character');
  const quiet = make({explain: () => false});
  quiet.runner.noDecision({id: 'n-5', profileKey: 'judy-alvarez', channel: 'phone', text: 'hey'});
  quiet.runner.forTurn({id: 'n-6', profileKey: 'judy-alvarez', channel: 'phone', text: 'hey', turnContext: {gameTime: T0}, bonds: parseBonds(BLOCK)}, {level: 6});
  assert.deepEqual(quiet.lines, [], 'nothing is logged without Developer mode');
});

test('the bridge asks the runner to explain a turn that has no pack block (packTurn), so the live text cannot be silent', () => {
  const bridge = read('./convai-bridge.mjs');
  assert.match(bridge, /if \(!input\.bonds\?\.packs\) \{ if \(input\.bonds\) bondPacks\.on = false; bondPacks\.noDecision\(input\); return null; \}/);
});
