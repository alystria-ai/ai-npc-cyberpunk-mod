// Pocket English stored as bfloat16 (packaging/lib/pocket-bf16.mjs, docs/POCKET_BF16.md): the cast, the safetensors file it writes, the receipt edit, and that the Runtime update
// step carries the new model. Tiny fixtures in a temporary folder; no real model.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ZipWriter} from './lib/zip.mjs';
import {PLUGIN} from './runtime/apply-removals.mjs';
import {bf16Bits, bf16ReceiptText, makePocketBf16, parseSafetensors, toBf16} from './lib/pocket-bf16.mjs';
import {compareRuntimes, runtimeFiles} from './build-runtime-update.mjs';

const f32 = value => { const b = Buffer.alloc(4); b.writeFloatLE(value); return b.readUInt32LE(0); };

// A float32 safetensors file from {name: {shape, values}}, written the way the library does (name order, compact header, padded to 8).
function safetensors(tensors, metadata) {
  const names = Object.keys(tensors).sort(), header = {};
  let offset = 0;
  for (const name of names) { const bytes = tensors[name].values.length * 4; header[name] = {dtype: 'F32', shape: tensors[name].shape, data_offsets: [offset, offset + bytes]}; offset += bytes; }
  const text = JSON.stringify(metadata ? {__metadata__: metadata, ...header} : header);
  const padded = text + ' '.repeat((8 - (Buffer.byteLength(text) % 8)) % 8);
  const out = Buffer.alloc(8 + Buffer.byteLength(padded) + offset);
  out.writeBigUInt64LE(BigInt(Buffer.byteLength(padded)), 0); out.write(padded, 8);
  let at = 8 + Buffer.byteLength(padded);
  for (const name of names) for (const value of tensors[name].values) { out.writeFloatLE(value, at); at += 4; }
  return out;
}
const RECEIPT = ['{', '  "selected_step": 2000,', '  "sample_cfg": 1.0,', `  "model_sha256": "${'a'.repeat(64)}",`, '  "provenance": {', '    "run": "pocket-v2",', '    "selection_score": 0.46940817122276013', '  }', '}'];

test('the cast rounds to nearest even and keeps special values', () => {
  assert.equal(bf16Bits(f32(1)), 0x3f80);
  assert.equal(bf16Bits(f32(-2)), 0xc000);
  assert.equal(bf16Bits(f32(0)), 0);
  assert.equal(bf16Bits(0x80000000), 0x8000, 'negative zero');
  assert.equal(bf16Bits(0x3f808000), 0x3f80, 'a tie rounds to the even neighbour (down)');
  assert.equal(bf16Bits(0x3f818000), 0x3f82, 'a tie rounds to the even neighbour (up)');
  assert.equal(bf16Bits(0x3f808001), 0x3f81, 'above the tie rounds up');
  assert.equal(bf16Bits(0x3f807fff), 0x3f80, 'below the tie rounds down');
  assert.equal(bf16Bits(f32(0.1)), 0x3dcd, '0.1 is 0x3dcccccd');
  assert.equal(bf16Bits(0x7f800000), 0x7f80, 'infinity stays infinity');
  assert.equal(bf16Bits(0xff800000), 0xff80);
  const nan = bf16Bits(0x7f800001);
  assert.ok((nan & 0x7f80) === 0x7f80 && (nan & 0x7f) !== 0, 'a NaN with a payload in the low bits only stays a NaN');
});

test('the converted file is a valid bfloat16 safetensors file with the same tensors, half the data', () => {
  const source = safetensors({'b.weight': {shape: [2, 2], values: [1, -2, 0.1, 3.14159]}, 'a.bias': {shape: [3], values: [0, 1e-3, -65504]}});
  const out = toBf16(source);
  const parsed = parseSafetensors(out);
  assert.deepEqual(Object.keys(parsed.header), ['a.bias', 'b.weight']);
  assert.equal(parsed.header['a.bias'].dtype, 'BF16');
  assert.deepEqual(parsed.header['b.weight'].shape, [2, 2]);
  assert.deepEqual(parsed.header['b.weight'].data_offsets, [6, 14]);
  assert.equal(parsed.dataStart % 8, 0, 'the header is padded to a multiple of 8');
  assert.equal(out.length - parsed.dataStart, 7 * 2);
  assert.equal(source.length - parseSafetensors(source).dataStart, 7 * 4);
  const first = out.readUInt16LE(parsed.dataStart + parsed.header['b.weight'].data_offsets[0]);
  assert.equal(first, 0x3f80, '1.0');
  // widening back to float32 (what the worker does when it loads the file) gives the rounded value, never one further than half a unit in the last bf16 place
  const widened = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value << 16 >>> 0); return b.readFloatLE(0); };
  const pi = widened(out.readUInt16LE(parsed.dataStart + parsed.header['b.weight'].data_offsets[0] + 6));
  assert.ok(Math.abs(pi - 3.14159) <= 3.14159 * 2 ** -8, `3.14159 became ${pi}`);
});

test('metadata is kept, and anything that is not float32 is refused', () => {
  const withMeta = toBf16(safetensors({w: {shape: [1], values: [1]}}, {format: 'pt'}));
  assert.deepEqual(parseSafetensors(withMeta).metadata, {format: 'pt'});
  const wrong = Buffer.from(toBf16(safetensors({w: {shape: [2], values: [1, 2]}})));
  assert.throws(() => toBf16(wrong), /only float32/, 'a bfloat16 file is not converted twice');
  assert.throws(() => parseSafetensors(Buffer.from('nope')), /safetensors/);
  const cut = safetensors({w: {shape: [2], values: [1, 2]}}).subarray(0, -2);
  assert.throws(() => parseSafetensors(cut), /past the file|end of the file/);
});

test('the receipt is edited as text: the new model hash, a provenance entry, everything else untouched', () => {
  for (const eol of ['\r\n', '\n']) {
    const text = RECEIPT.join(eol);
    const edited = bf16ReceiptText(text, 'b'.repeat(64));
    assert.match(edited, new RegExp(`"model_sha256": "${'b'.repeat(64)}"`));
    assert.ok(!edited.includes('a'.repeat(64)) || edited.includes(`"from_model_sha256": "${'a'.repeat(64)}"`));
    assert.match(edited, /"sample_cfg": 1\.0,/, 'numbers keep their spelling');
    assert.match(edited, /"selection_score": 0\.46940817122276013/);
    const parsed = JSON.parse(edited);
    assert.equal(parsed.provenance.bfloat16.from_model_sha256, 'a'.repeat(64));
    assert.equal(parsed.provenance.run, 'pocket-v2');
    assert.equal(edited.includes('\r\n'), eol === '\r\n');
    assert.ok(!edited.replace(/\r\n/g, '\n').split('\n').some(line => /\r/.test(line)), 'one kind of line ending');
    assert.throws(() => bf16ReceiptText(edited, 'c'.repeat(64)), /already records/);
  }
  assert.throws(() => bf16ReceiptText('{"model_sha256": "x"}', 'b'.repeat(64)), /exactly once/);
});

test('makePocketBf16 writes the model and receipt and returns the pins the configuration needs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pocket bf16 '));
  try {
    await writeFile(join(dir, 'model.safetensors'), safetensors({w: {shape: [4], values: [1, 2, 3, 4]}}));
    await writeFile(join(dir, 'receipt.json'), RECEIPT.join('\r\n'));
    const made = await makePocketBf16({modelPath: join(dir, 'model.safetensors'), receiptPath: join(dir, 'receipt.json'), directory: join(dir, 'out')});
    assert.equal(made.bytes < made.sourceBytes, true);
    const {createHash} = await import('node:crypto');
    const sha = path => readFile(path).then(bytes => createHash('sha256').update(bytes).digest('hex'));
    assert.equal(made.pins.sha256, await sha(made.modelPath));
    assert.equal(made.pins.receiptSha256, await sha(made.receiptPath));
    assert.equal(JSON.parse(await readFile(made.receiptPath, 'utf8')).model_sha256, made.pins.sha256, 'the receipt names the file next to it');
    assert.equal(made.fromSha256, await sha(join(dir, 'model.safetensors')));
    // deterministic: the same input gives the same bytes
    const again = await makePocketBf16({modelPath: join(dir, 'model.safetensors'), receiptPath: join(dir, 'receipt.json'), directory: join(dir, 'out2')});
    assert.deepEqual(again.pins, made.pins);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('the Runtime update step carries the new model, its receipt and the new pins', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pocket bf16 step '));
  try {
    const app = `${PLUGIN}/app`;
    const source = safetensors({w: {shape: [64], values: Array.from({length: 64}, (_, i) => i / 7)}});
    const model = `${app}/models/pocket/model.safetensors`, receipt = `${app}/models/pocket/receipt.json`, defaults = `${app}/defaults/pocket-voices.autobest.json`;
    const keep = {[`${app}/models/pocket/inference.yaml`]: 'yaml', [`${app}/models/pocket/tokenizer.json`]: '{}', [`${app}/bridge/convai-bridge.mjs`]: 'bridge'};
    const make = async (path, files) => { const w = await ZipWriter.create(path); for (const name of Object.keys(files).sort()) await w.add(name, {buffer: Buffer.isBuffer(files[name]) ? files[name] : Buffer.from(files[name])}); await w.close(); return path; };
    const old = await make(join(dir, 'old.zip'), {...keep, [model]: source, [receipt]: RECEIPT.join('\r\n'), [defaults]: '{"model":{"sha256":"old"}}'});
    const next = await make(join(dir, 'new.zip'), {...keep, [model]: toBf16(source), [receipt]: bf16ReceiptText(RECEIPT.join('\r\n'), 'b'.repeat(64)), [defaults]: '{"model":{"sha256":"new"}}'});
    const change = compareRuntimes(await runtimeFiles([old]), await runtimeFiles([next]));
    assert.deepEqual(change.changed.map(item => item.name).sort(), [defaults, model, receipt].sort());
    assert.deepEqual(change.added, []);
    assert.deepEqual(change.removed, []);
  } finally { await rm(dir, {recursive: true, force: true}); }
});
