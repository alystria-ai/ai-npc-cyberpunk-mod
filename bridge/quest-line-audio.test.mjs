// The line audio check (scripts/Check-QuestLineAudio.mjs): which spoken lines of the story packs have no prepared audio. Offline, reads only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {usedLines, checkPack, loadPacks, report} from '../scripts/Check-QuestLineAudio.mjs';

const pack = {id: 'test-pack', stages: [{id: 'a', script: [{when: 'stage:enter', say: 'T.1'}, {when: 'line:T.1:done', text: 'T.text'}]}],
  endings: {x: {script: [{when: 'ending:x', say: 'T.end'}]}}, calls: {c: {text: 'T.ring', steps: [{say: 'T.call'}, {hangup: true}]}},
  lines: {'T.1': {text: 'one', audio: 'audio/T.1.wav'}, 'T.text': {text: 'msg'}, 'T.end': {text: 'end'}, 'T.ring': {text: 'ring'}, 'T.call': {text: 'call'}}};

test('the spoken lines are the say rows of stages and endings and the say steps of calls; texts need no audio', () => {
  const found = usedLines(pack);
  assert.deepEqual(found.spoken, ['T.1', 'T.end', 'T.call']);
  assert.deepEqual(found.texts.sort(), ['T.ring', 'T.text']);
});

test('a line counts as prepared when its audio file is in the pack folder, when the audio folder holds it by name, or when the list names it; an undefined line is an error', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'line-audio-'));
  try {
    assert.deepEqual(checkPack(pack, {folder}).missing, ['T.1', 'T.end', 'T.call'], 'nothing on disk');
    mkdirSync(path.join(folder, 'test-pack', 'audio'), {recursive: true});
    writeFileSync(path.join(folder, 'test-pack', 'audio', 'T.1.wav'), '');
    assert.deepEqual(checkPack(pack, {folder}).prepared, ['T.1'], 'the pack\'s own audio field');
    const other = mkdtempSync(path.join(tmpdir(), 'line-audio-dir-'));
    try {
      mkdirSync(path.join(other, 'test-pack', 'audio'), {recursive: true});
      writeFileSync(path.join(other, 'test-pack', 'audio', 'T.end.ogg'), '');
      assert.deepEqual(checkPack(pack, {folder, audioDir: other}).missing, ['T.call'], 'found by line id in an audio folder');
    } finally { rmSync(other, {recursive: true, force: true}); }
    assert.deepEqual(checkPack(pack, {folder, listed: new Set(['test-pack/T.call'])}).missing, ['T.end'], 'named in a list');
    const broken = {...pack, lines: {}};
    assert.deepEqual(checkPack(broken, {folder}).undefinedLines, ['T.1', 'T.end', 'T.call']);
  } finally { rmSync(folder, {recursive: true, force: true}); }
});

test('the shipped packs: every spoken line is defined, and the report counts them (Judy\'s J4.end.03 is one of them)', () => {
  const results = loadPacks(fileURLToPath(new URL('../characters/bond-packs/', import.meta.url))).map(item => checkPack(item, {}));
  assert.equal(results.length >= 114, true);
  assert.deepEqual(results.filter(row => row.undefinedLines.length).map(row => row.pack), [], 'no pack says a line it does not have');
  const judy = results.find(row => row.pack === 'judy-claws-calling');
  assert.ok(judy.spoken.includes('J4.end.03') && judy.spoken.includes('J4.call.01'));
  assert.match(report(results), /^Spoken lines in \d+ packs: \d+\./);
});
