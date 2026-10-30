// The roster file the game decodes (characters/game-roster.json, shipped as conversation-characters.json): the cast sweep's minor
// profiles are cut to the fields the game side reads, everything else is the full roster row (docs/CAST_SWEEP.md).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {render, lean, LEAN_FIELDS} from '../scripts/Build-GameRoster.mjs';

const read = rel => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
const json = rel => JSON.parse(read(rel));
const roster = json('characters/roster.json'), game = json('characters/game-roster.json');

test('the checked-in game roster is what the builder makes from the roster', () => {
  assert.equal(read('characters/game-roster.json'), render(roster), 'run node scripts/Build-GameRoster.mjs');
});

test('every row is there once, in order; minor rows keep only the lean fields and everything else is unchanged', () => {
  assert.deepEqual(game.map(row => row.key), roster.map(row => row.key));
  let minors = 0;
  game.forEach((row, index) => {
    const full = roster[index];
    if (full.minor === true) {
      minors++;
      for (const field of Object.keys(row)) assert(LEAN_FIELDS.includes(field), `${row.key} carries ${field}`);
      assert.equal(row.name, full.name); assert.deepEqual(row.records, full.records);
      assert.equal(typeof row.invite, 'boolean', `${row.key}: a minor profile says whether it can be invited`);
      assert.equal(row.invite, full.invite);
      assert.equal(row.minor, true); assert.equal(row.kind, 'named');
      for (const dropped of ['backstory', 'speakingStyleDescription', 'speakingStyleSampleDialogues', 'sources', 'uncertainty', 'voice', 'voiceName', 'model', 'summary'])
        assert(!(dropped in row), `${row.key} keeps ${dropped}`);
    } else assert.deepEqual(row, full, `${row.key} is a full row`);
  });
  assert(minors >= 500, 'the roster holds the cast sweep: ' + minors);
  // Side characters (docs/SIDE_CHARACTERS.md): all but the children and possible children can be invited.
  const invitable = game.filter(row => row.minor === true && row.invite === true).length;
  assert(invitable >= 550 && invitable <= minors, 'side characters that can be invited: ' + invitable);
});

test('the lean file is a fraction of the roster the bridge reads', () => {
  const lean = Buffer.byteLength(read('characters/game-roster.json')), full = Buffer.byteLength(JSON.stringify(roster));
  assert(lean < full / 2, `${lean} bytes against ${full}`);
  assert(lean < 2 * 1024 * 1024, 'the game decodes at most 2 MB at start: ' + lean);
});

test('a lean row without a repeated alias list still resolves by name and by record', () => {
  const row = lean({key: 'mateo-lorenzo', name: 'Mateo Lorenzo', aliases: ['Mateo Lorenzo'], records: ['Character.q000_kid_bar_patron_male_03'], kind: 'named', invite: false, minor: true,
    summary: 's', voice: 'v'});
  assert.deepEqual(Object.keys(row), ['key', 'name', 'records', 'kind', 'invite', 'minor']);
  const kept = lean({key: 'x', name: 'X', aliases: ['Y'], records: [], kind: 'named', minor: true});
  assert.deepEqual(kept.aliases, ['Y'], 'a different alias is kept');
  assert.equal(lean({key: 'judy', name: 'Judy', backstory: 'b'}).backstory, 'b', 'a row that is not minor is untouched');
});

test('packaging and the development installer ship the lean file as conversation-characters.json, and the bridge keeps reading the full roster', () => {
  const config = json('packaging/release.config.json'), plan = json('packaging/release-plan.json'), dev = json('scripts/development-files.json');
  const all = [];
  const walk = value => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      if (typeof value.target === 'string' && value.target.endsWith('conversation-characters.json')) all.push(value.source);
      Object.values(value).forEach(walk);
    }
  };
  [config, plan, dev].forEach(walk);
  assert(all.length >= 3, 'three places name the file: ' + all.length);
  assert(all.every(source => source === 'characters/game-roster.json'), JSON.stringify(all));
  assert.match(readFileSync(new URL('../bridge/convai-bridge.mjs', import.meta.url), 'utf8'), /requiredJson\('characters\/roster\.json'\)/);
});
