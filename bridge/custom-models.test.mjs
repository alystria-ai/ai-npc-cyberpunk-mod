import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, truncateSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {CUSTOM_MARKER, CustomModelScanner, headerProblem, parseGgufHeader, validateEntry} from './custom-models.mjs';
import {LOCAL_AI_ENV} from './local-ai-pack.mjs';

// ---- A GGUF header builder (version 3, 64-bit counts) ----------------------------------------------------------------------------
const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
const u64 = value => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
const str = text => Buffer.concat([u64(Buffer.byteLength(text)), Buffer.from(text)]);
const kvString = (key, value) => Buffer.concat([str(key), u32(8), str(value)]);
const kvU32 = (key, value) => Buffer.concat([str(key), u32(4), u32(value)]);
const kvStringArray = (key, values) => Buffer.concat([str(key), u32(9), u32(8), u64(values.length), ...values.map(str)]);
function gguf({version = 3, pairs = [], magic = 'GGUF'} = {}) {
  return Buffer.concat([Buffer.from(magic, 'latin1'), u32(version), u64(0), u64(pairs.length), ...pairs]);
}
const chatHeader = (architecture = 'llama', extra = []) => gguf({pairs: [kvString('general.architecture', architecture), kvString('general.name', 'Test'),
  kvU32(architecture + '.context_length', 8192), kvStringArray('general.tags', ['a', 'b']), ...extra,
  kvStringArray('tokenizer.ggml.tokens', ['x'])]});

test('the GGUF header: magic, version, architecture, context length and pooling type; it stops at the tokenizer', () => {
  const header = parseGgufHeader(chatHeader('qwen3'));
  assert.deepEqual(header, {ok: true, version: 3, architecture: 'qwen3', poolingType: null, contextLength: 8192});
  assert.equal(headerProblem(header), null);
  assert.equal(parseGgufHeader(gguf({version: 2, pairs: [kvString('general.architecture', 'llama')]})).version, 2);
  // The tokenizer keys come last and are never walked: a truncated vocabulary does not matter.
  assert.equal(parseGgufHeader(chatHeader('llama').subarray(0, chatHeader('llama').length - 6)).architecture, 'llama');
  assert.equal(parseGgufHeader(chatHeader('llama', [kvU32('llama.pooling_type', 0)])).poolingType, 0);
});

test('not a GGUF: wrong magic bytes, a version llama.cpp cannot read, a short file, no architecture', () => {
  assert.equal(parseGgufHeader(Buffer.from('this is some text file with more than 24 bytes')).ok, false);
  assert.equal(parseGgufHeader(gguf({magic: 'GGML', pairs: []})).reason, 'bad-gguf');
  assert.equal(parseGgufHeader(gguf({version: 1})).ok, false);
  assert.equal(parseGgufHeader(gguf({version: 4})).ok, false);
  assert.equal(parseGgufHeader(Buffer.from('GGUF')).ok, false);
  assert.equal(parseGgufHeader(null).ok, false);
  assert.equal(headerProblem(parseGgufHeader(gguf({pairs: [kvString('general.name', 'x')]}))), 'bad-gguf');
});

test('embedding-only models are spotted from the architecture or the pooling type', () => {
  for (const architecture of ['bert', 'nomic-bert', 'jina-bert-v2', 'modern-bert', 'gemma-embedding', 'clip']) {
    assert.equal(headerProblem(parseGgufHeader(chatHeader(architecture))), 'embedding', architecture);
  }
  // A decoder used for embeddings (Qwen3-Embedding) says so with its pooling type; a chat model's is none (0) or absent.
  assert.equal(headerProblem(parseGgufHeader(chatHeader('qwen3', [kvU32('qwen3.pooling_type', 3)]))), 'embedding');
  assert.equal(headerProblem(parseGgufHeader(chatHeader('qwen3', [kvU32('qwen3.pooling_type', 0)]))), null);
  assert.equal(headerProblem(parseGgufHeader(chatHeader('llama'))), null);
});

const root = '/local-ai';
const valid = (extra = {}) => ({file: 'custom/My-Model-Q4_K_M.gguf', ...extra});

test('manifest entries are validated strictly: path inside the folder, .gguf only, name length, types', () => {
  const ok = validateEntry(root, valid({name: 'My Model', uncensored: true, auto: true, family: 'llama', contextSize: 8192, chatTemplate: 'chatml'}));
  assert.deepEqual(ok.entry, {file: resolve(root, 'custom/My-Model-Q4_K_M.gguf'), name: 'My Model', uncensored: true, auto: true, family: 'llama',
    contextSize: 8192, chatTemplate: 'chatml'});
  const plain = validateEntry(root, valid()).entry;
  assert.deepEqual([plain.name, plain.uncensored, plain.auto, plain.family, plain.contextSize, plain.chatTemplate], ['My-Model-Q4_K_M', false, false, null, null, null]);
  const bad = entry => validateEntry(root, entry).error;
  assert.match(bad(null), /not an object/);
  assert.match(bad([]), /not an object/);
  assert.match(bad({}), /needs a "file"/);
  assert.match(bad({file: 42}), /needs a "file"/);
  assert.match(bad({file: 'C:/models/x.gguf'}), /relative/);
  assert.match(bad({file: '/etc/x.gguf'}), /relative/);
  assert.match(bad({file: '\\\\server\\share\\x.gguf'}), /relative/);
  assert.match(bad({file: 'custom/../../x.gguf'}), /\.\./);
  assert.match(bad({file: 'custom/model.bin'}), /\.gguf/);
  assert.match(bad({file: 'custom/model.gguf.exe'}), /\.gguf/);
  assert.match(bad(valid({name: ''})), /name/);
  assert.match(bad(valid({name: 'x'.repeat(61)})), /longer than 60/);
  assert.equal(validateEntry(root, valid({name: 'x'.repeat(60)})).error, undefined);
  assert.match(bad(valid({name: 'two\nlines'})), /control/);
  assert.match(bad(valid({name: 5})), /name/);
  assert.match(bad(valid({uncensored: 'yes'})), /uncensored/);
  assert.match(bad(valid({auto: 1})), /auto/);
  assert.match(bad(valid({family: '--bad'})), /family/);
  assert.match(bad(valid({contextSize: 100})), /contextSize/);
  assert.match(bad(valid({contextSize: 8192.5})), /contextSize/);
  assert.match(bad(valid({contextSize: '8192'})), /contextSize/);
  assert.match(bad(valid({chatTemplate: '--jinja'})), /chatTemplate/);
  assert.match(bad(valid({chatTemplate: 'a b'})), /chatTemplate/);
});

// ---- The scanner, on a real folder with small fake model files ---------------------------------------------------------------------
function folder(t) {
  const directory = mkdtempSync(join(tmpdir(), 'custom-models-test-'));
  mkdirSync(join(directory, 'custom'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  // A "model": the header, padded to a size (sparse; only the first bytes are ever read).
  const model = (name, header, mib = 2) => {
    const path = join(directory, 'custom', name);
    writeFileSync(path, header);
    truncateSync(path, Math.max(header.length, Math.round(mib * 1048576)));
    return path;
  };
  const manifest = value => writeFileSync(join(directory, CUSTOM_MARKER), typeof value === 'string' ? value : JSON.stringify(value));
  const logs = [];
  const scanner = (options = {}) => new CustomModelScanner({project: directory, environment: {[LOCAL_AI_ENV.root]: directory}, log: line => logs.push(line), ...options});
  return {directory, model, manifest, logs, scanner};
}

test('the scanner lists usable models with ids, sizes and the memory they need; bad entries and files are logged once each', t => {
  const f = folder(t);
  f.model('good.gguf', chatHeader('llama'), 4000);
  f.model('embed.gguf', chatHeader('bert'));
  f.model('notgguf.gguf', Buffer.from('x'.repeat(100)));
  f.model('tiny.gguf', chatHeader('llama'), 0);   // smaller than the header: padded to its length only
  f.manifest({version: 1, models: [
    {file: 'custom/good.gguf', name: 'Good One', uncensored: true, auto: true, family: 'llama', contextSize: 4096, chatTemplate: 'chatml'},
    {file: 'custom/embed.gguf', name: 'Embedder'},
    {file: 'custom/notgguf.gguf', name: 'Fake'},
    {file: 'custom/absent.gguf', name: 'Gone'},
    {file: 'custom/tiny.gguf', name: 'Tiny'},
    {file: '../escape.gguf'},
    {file: 'custom/good.gguf', name: 'Again'},
    'nonsense']});
  const scanner = f.scanner();
  const result = scanner.scan({totalVramMiB: 12000});
  assert.equal(result.present, true);
  assert.deepEqual(result.models.map(model => [model.id, model.name, model.uncensored, model.auto, model.tooLarge]), [['custom:good', 'Good One', true, true, false]]);
  const [good] = result.models;
  assert.equal(good.sizeMiB, 4000);
  assert.equal(good.needMiB, 4000 + 1200);   // a file of 3000 MiB or more gets the standard headroom
  assert.deepEqual([good.contextSize, good.chatTemplate, good.family, good.architecture], [4096, 'chatml', 'llama', 'llama']);
  assert.deepEqual(result.problems.map(problem => [problem.name, problem.reason]),
    [['Embedder', 'embedding'], ['Fake', 'bad-gguf'], ['Gone', 'missing'], ['Tiny', 'bad-gguf']]);
  assert.equal(f.logs.length, 7, f.logs.join('\n'));
  assert.ok(f.logs.some(line => /"Embedder" is not usable: .*embedding model \(bert\)/.test(line)));
  assert.ok(f.logs.some(line => /"Gone" is not usable: .*not found/.test(line)));
  assert.ok(f.logs.some(line => /skipped "\.\.\/escape\.gguf".*\.\./.test(line)));
  assert.ok(f.logs.some(line => /listed twice/.test(line)));
  assert.ok(f.logs.some(line => /skipped entry 8: is not an object/.test(line)));
  // A second look reads nothing again and logs nothing again.
  scanner.scan({totalVramMiB: 12000});
  assert.equal(f.logs.length, 7);
});

test('the header is read once per file change, not at every look', t => {
  const f = folder(t);
  const path = f.model('a.gguf', chatHeader('llama'));
  f.manifest({version: 1, models: [{file: 'custom/a.gguf'}]});
  let reads = 0, stats = 0;
  const scanner = f.scanner({head: (file, length) => { reads++; return chatHeader('llama'); },
    stat: file => { stats++; return {size: 2 * 1048576, mtimeMs: 1000}; }});
  for (let index = 0; index < 5; index++) assert.equal(scanner.scan().models.length, 1);
  assert.equal(reads, 1);
  assert.equal(stats, 5);
  // A changed file (size or time) is read again.
  const changing = f.scanner({head: () => { reads++; return chatHeader('llama'); }, stat: () => ({size: 2 * 1048576, mtimeMs: ++stats})});
  const before = reads;
  changing.scan(); changing.scan();
  assert.equal(reads - before, 2);
  // And a real change on disk: the file becomes an embedder, and the answer changes.
  const real = f.scanner();
  assert.equal(real.scan().models.length, 1);
  writeFileSync(path, chatHeader('bert'));
  truncateSync(path, 2 * 1048576 + 7);
  utimesSync(path, new Date(), new Date(Date.now() + 5000));
  const again = real.scan();
  assert.deepEqual([again.models.length, again.problems[0]?.reason], [0, 'embedding']);
});

test('a model too large for the card is listed and marked, never dropped; an unknown card marks nothing', t => {
  const f = folder(t);
  f.model('huge.gguf', chatHeader('llama'), 16000);
  f.model('small.gguf', chatHeader('llama'), 1300);
  f.manifest({version: 1, models: [{file: 'custom/huge.gguf', name: 'Huge'}, {file: 'custom/small.gguf', name: 'Small'}]});
  const scanner = f.scanner();
  const mark = total => scanner.scan({totalVramMiB: total}).models.map(model => [model.name, model.tooLarge]);
  assert.deepEqual(mark(12000), [['Huge', true], ['Small', false]]);
  assert.deepEqual(mark(null), [['Huge', false], ['Small', false]]);
  assert.deepEqual(mark(16000), [['Huge', true], ['Small', false]], 'the headroom counts: 16000 MiB of file does not fit a 16000 MiB card');
  assert.deepEqual(mark(17300), [['Huge', false], ['Small', false]]);
  assert.ok(f.logs.some(line => /"Huge" is too large for this graphics card/.test(line)));
});

test('a contextSize beyond what the model supports is cut to it, with one line', t => {
  const f = folder(t);
  f.model('a.gguf', chatHeader('llama'));
  f.manifest({version: 1, models: [{file: 'custom/a.gguf', contextSize: 65536}]});
  const [model] = f.scanner().scan().models;
  assert.equal(model.contextSize, 8192);
  assert.ok(f.logs.some(line => /contextSize 65536 is more than the model supports \(8192\)/.test(line)));
});

test('a split model counts all its parts for the size', t => {
  const f = folder(t);
  f.model('big-00001-of-00002.gguf', chatHeader('llama'), 3000);
  f.model('big-00002-of-00002.gguf', Buffer.from('x'), 2500);
  f.manifest({version: 1, models: [{file: 'custom/big-00001-of-00002.gguf'}]});
  assert.equal(f.scanner().scan().models[0].sizeMiB, 5500);
});

test('a missing, unreadable, foreign or empty manifest means no custom models and never throws', t => {
  const f = folder(t);
  assert.deepEqual(f.scanner().scan(), {present: false, root: f.directory, models: [], problems: []});
  f.manifest('{ not json');
  assert.deepEqual(f.scanner().scan().models, []);
  assert.ok(f.logs.some(line => /not valid JSON/.test(line)));
  f.manifest({version: 2, models: []});
  assert.deepEqual(f.scanner().scan().models, []);
  f.manifest({version: 1});
  assert.deepEqual(f.scanner().scan().models, []);
  f.manifest({version: 1, models: []});
  assert.deepEqual(f.scanner().scan().models, []);
  // An unreadable header (the read throws) is reported, not thrown.
  f.model('a.gguf', chatHeader('llama'));
  f.manifest({version: 1, models: [{file: 'custom/a.gguf', name: 'A'}]});
  const broken = f.scanner({head: () => { throw Error('EACCES'); }}).scan();
  assert.deepEqual(broken.problems.map(problem => problem.reason), ['unreadable']);
});

test('at most 16 models are used', t => {
  const f = folder(t);
  const models = [];
  for (let index = 0; index < 20; index++) { f.model('m' + index + '.gguf', chatHeader('llama')); models.push({file: 'custom/m' + index + '.gguf'}); }
  f.manifest({version: 1, models});
  const result = f.scanner().scan();
  assert.equal(result.models.length, 16);
  assert.ok(f.logs.some(line => /only the first 16/.test(line)));
});

test('the manifest is looked for in the dev Local AI folder when the real folder has none', t => {
  const real = mkdtempSync(join(tmpdir(), 'custom-real-'));
  const dev = mkdtempSync(join(tmpdir(), 'custom-dev-'));
  t.after(() => { rmSync(real, {recursive: true, force: true}); rmSync(dev, {recursive: true, force: true}); });
  mkdirSync(join(dev, 'custom'));
  writeFileSync(join(dev, 'custom', 'a.gguf'), chatHeader('llama')); truncateSync(join(dev, 'custom', 'a.gguf'), 2 * 1048576);
  writeFileSync(join(dev, CUSTOM_MARKER), JSON.stringify({version: 1, models: [{file: 'custom/a.gguf'}]}));
  // Via the project folder (<project>/local-ai) as the real folder.
  mkdirSync(join(real, 'local-ai'));
  const viaDev = new CustomModelScanner({project: real, environment: {[LOCAL_AI_ENV.dev]: dev}}).scan();
  assert.deepEqual([viaDev.root, viaDev.models.length], [dev, 1]);
  // The real folder's own manifest wins; with LOCAL_AI set the dev folder is never read.
  writeFileSync(join(real, 'local-ai', CUSTOM_MARKER), JSON.stringify({version: 1, models: []}));
  assert.equal(new CustomModelScanner({project: real, environment: {[LOCAL_AI_ENV.dev]: dev}}).scan().root, join(real, 'local-ai'));
  assert.equal(new CustomModelScanner({project: real, environment: {[LOCAL_AI_ENV.root]: join(real, 'local-ai'), [LOCAL_AI_ENV.dev]: dev}}).scan().models.length, 0);
});
