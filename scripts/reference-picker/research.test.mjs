import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {encodeWav} from './audio.mjs';
import {classify, defaultShownVoices, groupOf, GROUPS, RECOMMENDED, Research} from './research.mjs';

test('classify and groupOf: only allowlisted conditions are columns', () => {
  assert.deepEqual(GROUPS.map(group => group.id), ['standard', 'clips', 'decoder', 'nophone']);
  const shown = {
    'REAL-target-copy': ['standard', 'single'], 'base6-2609__cfg1': ['standard', 'single'],
    'ft6-s5000raw__cfg1': ['standard', 'single'], 'ft6-s5000raw__multiC': ['clips', 'two'], 'ft6-s5000raw__multiB': ['clips', 'three'],
    'ft6-s5000raw__decA': ['decoder', 'single'], 'ft6-s5000raw__decA_multiC': ['decoder', 'two'], 'ft6-s5000raw__decA_multiB': ['decoder', 'three'],
    'omni__s16_g2': ['standard', 'single'], 'omni__s16_g2_multiC': ['clips', 'two'], 'omni__s16_g2_multiB': ['clips', 'three'],
    'omni__s32_g2': ['standard', 'single'], 'omni__s32_g2_multiC': ['clips', 'two'], 'omni__s32_g2_multiB': ['clips', 'three'],
    'ft6-s5000raw__multiBnp': ['nophone', 'threeNp'], 'ft6-s5000raw__multiCnp': ['nophone', 'twoNp'],
    'ft6-s5000raw__decA_multiBnp': ['nophone', 'threeNp'], 'ft6-s5000raw__decA_multiCnp': ['nophone', 'twoNp'],
    'omni__s16_g2_multiBnp': ['nophone', 'threeNp'], 'omni__s16_g2_multiCnp': ['nophone', 'twoNp'],
    'omni__s32_g2_multiBnp': ['nophone', 'threeNp'], 'omni__s32_g2_multiCnp': ['nophone', 'twoNp'],
  };
  for (const [cond, [group, variant]] of Object.entries(shown)) {
    assert.equal(groupOf(cond), group, cond);
    assert.equal(classify(cond).variant, variant, cond);
    assert.ok(classify(cond).allowed, cond);
  }
  for (const cond of ['ft24-u1000raw__cfg2', 'base24-2609__cfg2', 'omni-lora1000__s16', 'omni-lora3000__s32_multiB', 'omni__s16_g2_multiD', 'omni__s32_g2_multiE', 'omni__s16_g2_selected',
    'omni__s16_g1.5', 'omni__s32_g2_multiA', 'ft6-s5000raw__multiA', 'dev__s16_multiB', 'ft6-runtime__cfg1', 'ft24-u1000raw__ref-alt1', 'pocket-codec-roundtrip',
    'pocket-codec-roundtrip-decA', 'omni-codec-roundtrip', 'omni__s16_g2_multiBnp2', 'omni__s32_g2_pocketref']) {
    assert.equal(groupOf(cond), null, cond);
    assert.equal(classify(cond).allowed, false, cond);
  }
  assert.ok(RECOMMENDED.every(cond => classify(cond).variant === 'three'));
});

test('the shown-voices file lists the 29 voices', () => {
  const keys = defaultShownVoices();
  assert.equal(keys.length, 29);
  assert.equal(new Set(keys).size, 29);
  assert.ok(keys.includes('johnny-silverhand') && keys.includes('viktor-vektor'));
});

const wav = encodeWav(new Float32Array(2400), 24000);
const table = rows => ['| Variant | condition | PLS | ECAPA guard | WER |', '|---|---|---|---|---|', ...rows.map(([name, cond, pls]) => `| ${name} | ${cond} | ${pls} | 0.5 | 4.0% |`)].join('\n');
async function research(conds, {full = [], shown = null} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'research-'));
  for (const cond of conds) { await mkdir(join(root, 'out/gen', cond), {recursive: true}); await writeFile(join(root, 'out/gen', cond, 'v__0.wav'), wav); }
  await mkdir(join(root, 'out'), {recursive: true});
  await writeFile(join(root, 'out/summary-table.md'), table(full));
  if (shown) await writeFile(join(root, 'out/summary-table-shown.md'), table(shown));
  await writeFile(join(root, 'out/panel.json'), JSON.stringify({v: {targets: [{transcript: 'Line.'}]}, w: {targets: []}}));
  return root;
}

test('columns: allowlist only, phone-free next to the original, placeholders only for the original variants', async () => {
  const root = await research(['REAL-target-copy', 'base6-2609__cfg1', 'ft6-s5000raw__decA_multiB', 'ft6-s5000raw__decA_multiBnp', 'omni__s16_g2_multiB', 'omni__s16_g2_multiBnp',
    'omni__s32_g2_multiBnp', 'omni-lora1000__s16', 'ft24-u1000raw__cfg2', 'pocket-codec-roundtrip', 'omni__s16_g2_multiD'], {full: [['Original line', 'REAL-target-copy', 105.8], ['LoRA', 'omni-lora1000__s16', 70]]});
  const data = new Research({root, ttlMs: 0, shownVoices: []}).describe();
  const conds = data.columns.filter(column => column.cond).map(column => column.cond);
  assert.deepEqual(conds, ['REAL-target-copy', 'base6-2609__cfg1', 'ft6-s5000raw__decA_multiB', 'ft6-s5000raw__decA_multiBnp', 'omni__s16_g2_multiB', 'omni__s16_g2_multiBnp', 'omni__s32_g2_multiBnp']);
  const placeholders = data.columns.filter(column => column.placeholder);
  // 3 families x (1 | 2 | 3) = 9 slots, minus the omni16 3-clip column that exists
  assert.equal(placeholders.length, 8);
  assert.ok(placeholders.every(column => ['single', 'two', 'three'].includes(column.variant)));
  assert.ok(!placeholders.some(column => column.family === 'pocket-dec'));
  const at = cond => data.columns.findIndex(column => column.cond === cond);
  assert.equal(at('omni__s16_g2_multiBnp'), at('omni__s16_g2_multiB') + 1);
  assert.equal(data.columns[at('omni__s16_g2_multiBnp')].label, '3 clips (18 s), phone-free');
  assert.equal(data.columns[at('omni__s16_g2_multiBnp')].spanLabel, 'OmniVoice 16 steps');
  assert.deepEqual(data.columns.filter(column => column.recommended).map(column => column.cond), ['ft6-s5000raw__decA_multiB', 'ft6-s5000raw__decA_multiBnp', 'omni__s16_g2_multiB', 'omni__s16_g2_multiBnp', 'omni__s32_g2_multiBnp']);
  assert.equal(data.columns[0].role, 'original');
  assert.equal(data.columns.filter(column => column.role === 'original').length, 1);
  assert.ok(data.recommended.includes('omni__s32_g2_multiB') && data.recommended.includes('omni__s32_g2_multiBnp'));
});

test('header scores prefer out/summary-table-shown.md and fall back to summary-table.md', async () => {
  const conds = ['REAL-target-copy', 'omni__s16_g2_multiB', 'omni__s16_g2_multiBnp'];
  const full = [['Original line', 'REAL-target-copy', 100], ['Omni 16 three-clip', 'omni__s16_g2_multiB', 90]];
  const without = new Research({root: await research(conds, {full}), ttlMs: 0, shownVoices: []}).describe();
  assert.equal(without.scoresShown, false);
  assert.equal(without.evaluationVoices, 2);
  assert.equal(without.columns.find(column => column.cond === 'omni__s16_g2_multiB').metrics.pls, 90);
  // The shown table wins, and its rows can add columns the full table has not got (free-text variant label).
  const withShown = new Research({root: await research(conds, {full, shown: [['Original line', 'REAL-target-copy', 111], ['whatever', 'omni__s16_g2_multiB', 95], ['no phone', 'omni__s16_g2_multiBnp', 96]]}), ttlMs: 0, shownVoices: []}).describe();
  assert.equal(withShown.scoresShown, true);
  const pls = cond => withShown.columns.find(column => column.cond === cond).metrics.pls;
  assert.deepEqual([pls('REAL-target-copy'), pls('omni__s16_g2_multiB'), pls('omni__s16_g2_multiBnp')], [111, 95, 96]);
  // A condition only the full table knows still becomes a column (no scores of its own over the shown voices).
  const partial = new Research({root: await research(conds, {full, shown: [['Original line', 'REAL-target-copy', 111]]}), ttlMs: 0, shownVoices: []}).describe();
  assert.equal(partial.columns.find(column => column.cond === 'omni__s16_g2_multiB').metrics.pls, null);
});

test('describe lists only the shown voices', async () => {
  const root = await research(['REAL-target-copy'], {});
  await writeFile(join(root, 'out/gen/REAL-target-copy/w__0.wav'), wav);
  assert.deepEqual(Object.keys(new Research({root, ttlMs: 0, shownVoices: ['w']}).describe().voices), ['w']);
  assert.deepEqual(Object.keys(new Research({root, ttlMs: 0, shownVoices: []}).describe().voices).sort(), ['v', 'w']);
  assert.deepEqual(Object.keys(new Research({root, ttlMs: 0}).describe().voices), []);       // default: the 29-voice file
});
