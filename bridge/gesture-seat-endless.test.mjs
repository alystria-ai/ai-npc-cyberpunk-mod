import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// Sit workspots that never end by themselves (docs/COMPANION_SEATING.md, "The
// seat that ended on its own"): the verify step must reject a seat workspot
// whose fidget list runs out, and accept the endless copy.
const verify = fileURLToPath(new URL('../scripts/Verify-GestureAssets.mjs', import.meta.url));
const cname = (value) => ({$type: 'CName', $value: value});
function workspot({minClips, maxClips, repeat, facial = true}) {
  const clip = (id, name) => ({Data: {$type: 'workAnimClip', id: {id}, animName: cname(name)}});
  return {Data: {RootChunk: {
    nodesToInit: [{$type: 'animAnimNode_WorkspotHub',
      facialIdleMaleAnimation: cname(facial ? 'idle__neutral__male' : 'idle__interested__male'),
      facialIdleFemaleAnimation: cname('idle__neutral__female'),
      facialIdleKey_MaleAnimation: cname('None'), facialIdleKey_FemaleAnimation: cname('None')}],
    workspotTree: {Data: {
      animGraphSlotName: cname('WORKSPOT'), idCounter: 9,
      inertializationDurationEnter: 1, inertializationDurationExitNatural: 1, inertializationDurationExitForced: 1,
      finalAnimsets: [{rig: {DepotPath: {$value: 'rig'}}, animations: {cinematics: []}, loadingHandles: []}],
      rootEntry: {Data: {$type: 'workSequence', list: [{Data: {
        $type: 'workSequence', loopInfinitely: repeat ? 1 : 0,
        list: [{Data: {$type: 'workRandomList', minClips, maxClips, list: [clip(5, 'a'), clip(6, 'b')]}}]}}]}},
    }},
  }}};
}
const entity = (depot) => ({Data: {RootChunk: {
  entity: {Data: {$type: 'gameObject'}},
  components: [{$type: 'workWorkspotResourceComponent', name: cname('convai_sit_couch'),
    workspotResource: {DepotPath: {$value: depot}}, id: '7'}],
  compiledData: {Data: {Chunks: [{$type: 'gameObject'}, {$type: 'workWorkspotResourceComponent'}]}},
}}});
function runVerify(seat, depot = 'cyberpunk_convai\gestures\convai_seat_x') {
  const dir = mkdtempSync(join(tmpdir(), 'seat-endless-'));
  for (const folder of ['generated', 'roundtrip']) {
    mkdirSync(join(dir, folder));
    writeFileSync(join(dir, folder, 'convai_seat_x.workspot.json'), JSON.stringify(workspot(seat)));
    writeFileSync(join(dir, folder, 'device.ent.json'), JSON.stringify(entity(depot)));
  }
  return spawnSync(process.execPath, [verify, '--roundtrip', join(dir, 'roundtrip'), '--generated', join(dir, 'generated')], {encoding: 'utf8'});
}

test('verify accepts a sit workspot whose fidget list never runs out and whose sequence repeats', () => {
  const result = runVerify({minClips: 127, maxClips: 127, repeat: true});
  assert.equal(result.status, 0, result.stderr);
});

test('verify rejects a sit workspot that ends after a few fidgets (the vanilla 4-9 clips)', () => {
  const result = runVerify({minClips: 4, maxClips: 7, repeat: true});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /random list ends after 4-7 clips/);
});

test('verify rejects a sit workspot whose sequence does not repeat', () => {
  const result = runVerify({minClips: 127, maxClips: 127, repeat: false});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must repeat/);
});

test('verify rejects a sit component that plays a vanilla workspot', () => {
  const result = runVerify({minClips: 127, maxClips: 127, repeat: true}, 'base\workspots\common\couch\generic__sit_couch__sit_around__02.workspot');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /endless copies/);
});

test('the generator rewrites every random list of every seat workspot and points the sit components at the copies', () => {
  const source = readFileSync(new URL('../scripts/Build-GestureAssets.mjs', import.meta.url), 'utf8');
  assert.match(source, /minClips = ENDLESS_CLIPS/);
  assert.match(source, /parent\.loopInfinitely = 1/);
  assert.match(source, /\[`convai_sit_\$\{key\}`, seatPlayable\(depot\)\]/);
  assert.match(source, /convai_seat_\$\{base\(depot\)\}/);
});
