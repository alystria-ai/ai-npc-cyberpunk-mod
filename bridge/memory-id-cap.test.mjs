// The shipped Convai ids (packaging/release-data: about 900 originals and 900 twins since the side characters of 2026-10-30) fit every
// place that holds the id map: the routing, the player memory provider and the player memory registry. Each once refused more than 1024
// (or 256/512) ids, and the bridge then stopped at start with INVALID_CONFIGURATION.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RelationshipRouting} from './relationship-routing.mjs';
import {multilingualTwins} from './multilingual.mjs';
import {PlayerMemoryApi} from './player-memory-api.mjs';
import {PlayerMemory} from './player-memory.mjs';

const data = name => JSON.parse(readFileSync(new URL(`../packaging/release-data/${name}`, import.meta.url), 'utf8'));

test('the shipped id map fits the routing, the memory provider and the memory registry', async () => {
  const ids = data('characters.json');
  const {twins} = multilingualTwins(data('multilingual-profiles.json'), {ordinaryIds: ids});
  const routes = new RelationshipRouting({ordinaryIds: ids, multilingual: twins});
  assert.ok(Object.keys(ids).length > 700, 'the side characters are in the shipped ids');
  const provider = new PlayerMemoryApi({characterIds: routes.providerIds, markerKeys: routes.markerKeys, credential: () => null});
  assert.ok(provider);
  const folder = mkdtempSync(join(tmpdir(), 'memory-id-cap-'));
  try {
    const memory = await PlayerMemory.open({path: join(folder, 'player-memory.json'), characterIds: routes.providerIds,
      characterFamilies: routes.providerFamilies, provider});
    assert.ok(memory);
  } finally { rmSync(folder, {recursive: true, force: true}); }
});
