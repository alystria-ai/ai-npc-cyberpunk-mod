import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fnv1a32, murmur3, lz4Block, saveState, snapshotFromSave} from './save_snapshot.mjs';

test('hashes match values observed from the live game', () => {
  // FNV-1a32 is the save's fact key; Murmur3 (seed 0x5EEDBA5E) is GetEntryHash
  // as returned by JournalManager in a 2.31 capture.
  assert.equal(fnv1a32('q101_done'), 931208325);
  assert.equal(murmur3('quests/side_quest/sq004_riders_on_the_storm'), 57791510);
  assert.equal(murmur3('contacts/pepe_el_coyote/mq040/02_aftermath_forgave_wife'), 1056871993);
});

test('LZ4 blocks decode literals and overlapping back-references', () => {
  // token 0x34: 3 literals "abc", then match offset 3 length 4+4 = 8
  const block = Buffer.from([0x34, 0x61, 0x62, 0x63, 0x03, 0x00, 0x10, 0x7a]);
  assert.equal(lz4Block(block, 12).toString(), 'abcabcabcabz');
  assert.throws(() => lz4Block(Buffer.from([0x14, 0x61, 0x05, 0x00]), 9));
});

function syntheticSave({facts, journal}) {
  const vlq = n => { if (n < 64) return Buffer.from([n]); return Buffer.from([0x40 | (n & 0x3f), n >> 6]); };
  const header = Buffer.from('VASC\0\0\0\0');
  const tableAt = header.length, dataStart = tableAt + 8 + 12;
  const factsBody = Buffer.concat([Buffer.alloc(4), vlq(facts.length),
    ...facts.map(([name]) => { const b = Buffer.alloc(4); b.writeUInt32LE(fnv1a32(name)); return b; }),
    ...facts.map(([, v]) => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; })]);
  const journalBody = Buffer.concat([Buffer.alloc(4), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(journal.length); return b; })(),
    ...journal.map(([path, state]) => { const b = Buffer.alloc(15); b.writeUInt32LE(murmur3(path)); b.writeUInt32LE(state, 4); return b; })]);
  const data = Buffer.concat([factsBody, journalBody]);
  const table = Buffer.alloc(20); table.write('FZLC'); table.writeInt32LE(1, 4);
  table.writeInt32LE(dataStart, 8); table.writeInt32LE(data.length, 12); table.writeInt32LE(data.length, 16);
  const entry = (name, offset, size) => { const n = Buffer.from(name); const tail = Buffer.alloc(16);
    tail.writeInt32LE(-1); tail.writeInt32LE(-1, 4); tail.writeInt32LE(offset, 8); tail.writeInt32LE(size, 12);
    return Buffer.concat([Buffer.from([0x80 | n.length]), n, tail]); };
  const nodes = Buffer.concat([Buffer.from('EDON'), vlq(2), entry('FactsTable', dataStart, factsBody.length),
    entry('JournalManager', dataStart + factsBody.length, journalBody.length)]);
  const body = Buffer.concat([header, table, data]);
  const trailer = Buffer.alloc(8); trailer.writeInt32LE(body.length); trailer.write('ENOD', 4);
  return Buffer.concat([body, nodes, trailer]);
}

test('a save becomes the same snapshot shape the Lua collector captures', () => {
  const dir = mkdtempSync(join(tmpdir(), 'save-snapshot-'));
  try {
    writeFileSync(join(dir, 'sav.dat'), syntheticSave({facts: [['positive_fact', 2], ['zero_fact', 0]], journal: [
      ['quests/side_quest/sq_test', 3], ['quests/side_quest/sq_test/phase', 2], ['quests/side_quest/sq_test/phase/done', 3],
      ['quests/side_quest/sq_test/phase/hidden_parent/child', 3],
      ['contacts/fixer', 2], ['contacts/fixer/conv', 2], ['contacts/fixer/conv/msg', 2]]}));
    writeFileSync(join(dir, 'metadata.9.json'), JSON.stringify({Data: {metadata: {lifePath: 'Nomad'}}}));
    const types = new Map([['quests/side_quest/sq_test', 'gameJournalQuest'], ['contacts/fixer', 'gameJournalContact']]);
    const pack = {gameVersions: ['2.31'], factAllowlist: {positive_fact: {}, zero_fact: {}, absent_fact: {}}, journalAllowlist: {
      done: {questKey: 'q', nativePath: 'quests/side_quest/sq_test/phase/done', nativeClass: 'gameJournalQuestObjective'},
      hidden: {questKey: 'q', nativePath: 'quests/side_quest/sq_test/phase/hidden_parent/child', nativeClass: 'gameJournalQuestObjective'},
      quest: {questKey: 'q', nativePath: 'quests/side_quest/sq_test', nativeClass: 'gameJournalQuest'},
      message: {questKey: 'q', nativePath: 'contacts/fixer/conv/msg', nativeClass: 'gameJournalPhoneMessage'}}};
    const snap = snapshotFromSave(saveState(join(dir, 'sav.dat')), pack, types, {profileKeys: ['judy-alvarez']});
    assert.deepEqual([snap.facts.positive_fact.status, snap.facts.positive_fact.value], ['known', 2]);
    assert.equal(snap.facts.zero_fact.status, 'unknown');
    assert.equal(snap.facts.absent_fact.status, 'unknown');
    assert.equal(snap.journal.done.value, 'succeeded');
    assert.equal(snap.journal.hidden.status, 'unknown', 'an unrevealed parent hides the child, as in Lua');
    assert.equal(snap.journal.quest.value, 'succeeded');
    assert.equal(snap.journal.message.value, 'active');
    assert.equal(snap.lifepath.value, 'nomad');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
