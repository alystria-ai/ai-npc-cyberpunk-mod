import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// The outfit builder spike (docs/OUTFIT_BUILDER_SPIKE.md): the proof looks in research/outfit-builder-spike/built-looks.json are checked against the pieces the game's
// own definitions hold (panam-components.json, read from the installed game with scripts/Inspect-OutfitMeshes.mjs) and against the redscript that would run them.
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const built = JSON.parse(read('../research/outfit-builder-spike/built-looks.json'));
const components = JSON.parse(read('../research/outfit-builder-spike/panam-components.json'));
const evidence = JSON.parse(read('../characters/companion-outfit-evidence.json'));
const reds = read('../research/outfit-builder-spike/OutfitBuilder.reds');
const LOOK_KINDS = ['any', 'day', 'night', 'home', 'formal'];
const definitionOf = {panam_default: 'default', panam_no_jacket: 'no_jacket', panam_no_jacket_and_harness: 'no_jacket_and_harness'};
// The meshes and mesh appearances the game ships for these pieces, as the definitions list them (a tint must name an appearance one of them uses).
const shipped = new Set(Object.values(components).flat().map(piece => piece.mesh));
const shippedAppearances = new Set(Object.values(components).flat().map(piece => `${piece.mesh}|${piece.meshAppearance}`));

test('built looks: each starts from a look of its own template, has a kind and a label, and no id repeats', () => {
  const ids = new Set();
  for (const [record, rows] of Object.entries(built.characters)) {
    const names = new Set(evidence.records[record].listedAppearances);
    for (const row of rows) {
      assert.ok(names.has(row.base), `${row.id}: ${row.base} is not a look of ${record}'s template`);
      assert.ok(definitionOf[row.base], `${row.id}: the pieces of ${row.base} were not read`);
      assert.ok(LOOK_KINDS.includes(row.kind) && row.label && row.id, row.id);
      assert.ok(!ids.has(row.id), `${row.id} repeats`);
      ids.add(row.id);
      assert.ok(row.ops.length > 0 && row.ops.length <= 6, `${row.id}: a few operations`);
    }
  }
  assert.ok(ids.size >= 2 && ids.size <= 3, 'two or three proof looks');
});

test('built looks: every operation names a piece the base look has (or adds one next to a piece it has), with a mesh the game ships', () => {
  for (const rows of Object.values(built.characters)) {
    for (const row of rows) {
      const pieces = new Map(components[definitionOf[row.base]].map(piece => [piece.name, piece]));
      for (const op of row.ops) {
        if (op.op === 'toggle') { assert.ok(pieces.has(op.name), `${row.id}: no piece ${op.name} to toggle`); assert.equal(typeof op.on, 'boolean'); }
        else if (op.op === 'tint') {
          const piece = pieces.get(op.name);
          assert.ok(piece, `${row.id}: no piece ${op.name} to tint`);
          assert.ok(shippedAppearances.has(`${piece.mesh}|${op.appearance}`), `${row.id}: the game lists no appearance ${op.appearance} for ${piece.mesh}`);
        } else if (op.op === 'add') {
          assert.ok(pieces.has(op.like), `${row.id}: no sibling ${op.like} to copy the bindings from`);
          assert.ok(!pieces.has(op.name), `${row.id}: ${op.name} is already worn in ${row.base}`);
          assert.ok(shipped.has(op.mesh), `${row.id}: ${op.mesh} is no mesh of the character's own definitions`);
          assert.ok(shippedAppearances.has(`${op.mesh}|${op.appearance}`), `${row.id}: no appearance ${op.appearance} for ${op.mesh}`);
          // The same piece is added once per look, and what is added is a garment of the same family (a copy of a skinned mesh).
          assert.ok(['entSkinnedMeshComponent', 'entGarmentSkinnedMeshComponent'].includes(pieces.get(op.like).type));
        } else assert.fail(`${row.id}: unknown operation ${op.op}`);
      }
      const added = row.ops.filter(op => op.op === 'add').map(op => op.name);
      assert.equal(new Set(added).size, added.length, `${row.id}: a piece added twice`);
    }
  }
});

test('built looks: nothing is a mesh of ours, the data stays tiny, and the proof wears no undress', () => {
  const text = read('../research/outfit-builder-spike/built-looks.json');
  assert.ok(text.length < 4000, 'a handful of lines per look');
  assert.ok(!/nude|underwear|naked|shower|undress/i.test(text));
  for (const rows of Object.values(built.characters)) for (const row of rows) for (const op of row.ops) if (op.mesh) assert.ok(op.mesh.startsWith('base\\characters\\'), op.mesh);
});

test('OutfitBuilder.reds: three on-demand operations on one entity, Codeware-gated with a plain stand-in each, nothing per frame', () => {
  for (const name of ['ConvaiOutfitToggle', 'ConvaiOutfitTint', 'ConvaiOutfitAdd']) {
    const half = guard => new RegExp(String.raw`@if\(${guard}ModuleExists\("Codeware"\)\)\n@addMethod\(GameObject\)\npublic func ${name}\(([^)]*)\) -> Bool`).exec(reds);
    const real = half(''), stand = half('!');
    assert.ok(real && stand, `${name}: both halves`);
    assert.equal(real[1], stand[1], `${name}: the stand-in has the real signature`);
  }
  assert.ok(!/OnUpdate|ScheduleEvent|DelayEvent|RegisterCallback|ScriptableSystem|persistent/.test(reds));
});
