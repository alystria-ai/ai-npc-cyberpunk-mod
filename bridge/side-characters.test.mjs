// Side characters to invite (docs/SIDE_CHARACTERS.md): the invite flags come from the record check, and every invitable one has a Convai
// original and a twin in the release data, so Convai players can talk to the copy they invite.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const url = path => new URL(`../${path}`, import.meta.url);
const json = path => JSON.parse(readFileSync(url(path), 'utf8').replace(/^﻿/u, ''));
const roster = json('characters/roster.json');
const minors = roster.filter(row => row.minor === true);
const checks = json('scripts/cast-sweep/side-invite-records.json').rows;
const AGE_DOUBT = ['doris-soto', 'marcus-barros', 'sofia-ramirez', 'randy-kutcher'];

test('the invite flags are what the record check makes, and the script finds nothing to change', () => {
  const run = spawnSync(process.execPath, [fileURLToPath(url('scripts/cast-sweep/side-invite.mjs')), '--check'], {encoding: 'utf8'});
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test('a side character can be invited only when its record is in both game versions and it is not a child', () => {
  assert.equal(minors.length, 575);
  assert.equal(minors.filter(row => row.invite === true).length, 557);
  for (const row of minors) {
    assert.equal(typeof row.invite, 'boolean', row.key);
    const check = checks[row.key];
    assert.ok(check, `${row.key} has a record check`);
    if (!row.invite) continue;
    assert.ok(check.v25 && check.v231 && check.v25Template && check.v231Template, `${row.key}: record in both versions`);
    assert.equal(check.isChild, false, `${row.key}: not a child`);
    assert.ok(!AGE_DOUBT.includes(row.key), `${row.key}: age doubt`);
    assert.ok(row.records[0] && row.records[0] === check.record, `${row.key}: the checked record is the first one`);
  }
  for (const row of minors.filter(item => !item.invite)) {
    assert.ok(checks[row.key].isChild || AGE_DOUBT.includes(row.key), `${row.key} is left out only as a child or possible child`);
  }
});

test('every invitable side character has a Convai original and a verified twin in the release data', () => {
  const originals = json('packaging/release-data/characters.json'), twins = json('packaging/release-data/multilingual-profiles.json').characters;
  for (const row of minors.filter(item => item.invite === true)) {
    assert.match(originals[row.key] ?? '', /^[0-9a-f-]{36}$/u, `${row.key} original`);
    const twin = twins[row.key];
    assert.match(twin?.multilingualCharacterId ?? '', /^[0-9a-f-]{36}$/u, `${row.key} twin`);
    assert.equal(twin.originalCharacterId, originals[row.key], `${row.key} twin points at the original`);
    assert.equal(twin.verified, true, `${row.key} twin verified`);
  }
});

test('the routing registry takes the whole release mapping, side characters and their twins included', async () => {
  const {relationshipRegistry} = await import('./relationship-routing.mjs');
  const originals = json('packaging/release-data/characters.json'), twins = json('packaging/release-data/multilingual-profiles.json').characters;
  const twinIds = Object.fromEntries(Object.entries(twins).filter(([key, row]) => originals[key] && row.verified === true)
    .map(([key, row]) => [key, row.multilingualCharacterId]));
  assert.ok(Object.keys(originals).length > 700, 'originals: ' + Object.keys(originals).length);
  const registry = relationshipRegistry(originals, twinIds);
  assert.ok(registry.providerIds['aaron-mccarlson']);
});
