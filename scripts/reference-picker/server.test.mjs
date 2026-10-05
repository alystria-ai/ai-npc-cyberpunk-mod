import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {encodeWav} from './audio.mjs';
import {Pool} from './pool.mjs';
import {PickStore} from './picks.mjs';
import {startPicker} from './server.mjs';
import {Research} from './research.mjs';

// A voice with 8 clips of 3-5 s, one held-out line, today's reference, and a proposed three-clip set.
async function fixture({gpu = {status: async () => ({known: true, busy: false})}, research = new Research({root: null})} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'picker-'));
  const data = join(root, 'data'), work = join(root, 'work');
  await mkdir(join(data, 'audio/v'), {recursive: true}); await mkdir(join(root, 'runtime'), {recursive: true});
  const tone = seconds => encodeWav(Float32Array.from({length: Math.round(seconds * 48000)}, (_, at) => Math.sin(at / 20) * 0.3), 48000);
  const clips = [];
  for (let n = 0; n < 8; n++) {
    await writeFile(join(data, `audio/v/c${n}.wav`), tone(3 + (n % 3)));
    clips.push({id: `v/${n}`, d: 3 + (n % 3), t: `clip number ${n} has words`, ty: 40 + n, g: null, k: null, s: 'train', p: `audio/v/c${n}.wav`, lv: -20});
  }
  await writeFile(join(data, 'audio/v/line.wav'), tone(2));
  await writeFile(join(root, 'runtime/live.wav'), tone(4));
  const live = {exists: true, d: 4, transcript: 'live words', reference: 'runtime/live.wav', sha256: 'f'.repeat(64), lv: -20};
  const index = {dataRoot: data, voices: {v: {clips, loudMedian: -20, live: {pocket: live, omni: live},
    lines: [{id: 'v/line', t: 'Say this line.', d: 2, split: 'test', path: join(data, 'audio/v/line.wav'), exists: true}],
    proposed: {pocket: {clips: ['v/0', 'v/1', 'v/2'], seconds: 12}, omni: {clips: ['v/0', 'v/1', 'v/2'], seconds: 12}}}}};
  const rendered = [];
  const engines = {state: {pocket: 'idle', omni: 'idle'}, omniResident: false, close: async () => {},
    materialize: async items => ({path: join(work, 'refs', `${items.map(i => i.id).join('_').replaceAll('/', '-')}.wav`), sha256: createHash('sha256').update(items.map(i => i.id).join()).digest('hex')}),
    materializeLive: async entry => ({path: entry.reference, sha256: entry.sha256}),
    sampleId: async (item, reference, transcript, text) => createHash('sha1').update([item.slot, reference.sha256, transcript, text].join()).digest('hex').slice(0, 10),
    runPocket: async (items, {onItem}) => { for (const item of items) { await mkdir(join(item.out, '..'), {recursive: true}); await writeFile(item.out, tone(1)); rendered.push(item.out); await onItem(item, {seconds: 1, tookMs: 5}); } },
    renderOmni: async item => { await mkdir(join(item.out, '..'), {recursive: true}); await writeFile(item.out, tone(1)); rendered.push(item.out); return {seconds: 1, tookMs: 5}; }};
  const store = new PickStore({logPath: join(root, 'picks.jsonl'), jsonPath: join(root, 'picks.json')});
  await store.load();
  const running = await startPicker({project: root, work, port: 0, pool: new Pool(index, {project: root}), store, engines, gpu, research, gpuRecheckMs: 30});
  const base = `http://127.0.0.1:${running.port}`;
  const call = async (path, body) => {
    const response = await fetch(base + path, body === undefined ? {} : {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
    return {status: response.status, body: await response.json().catch(() => null), response};
  };
  return {running, call, base, store, rendered};
}

test('every engine variant has its own set: reroll, hand-pick, keep, reject, undo, render and audio', async () => {
  const {running, call, base, store, rendered} = await fixture();
  try {
    let card = (await call('/api/voice/v')).body;
    assert.deepEqual(Object.keys(card.sets), ['pocket', 'pocket-short', 'omni', 'omni-short']);
    assert.deepEqual(card.sets.pocket.ids, ['v/0', 'v/1', 'v/2']);
    assert.equal(card.sets.pocket.source, 'proposed');
    assert.equal(card.sets['omni-short'], null);                       // no proposed 10 s set in this fixture
    assert.equal(card.text, 'Say this line.');
    assert.equal(card.samples.pocket.state, 'missing');
    assert.deepEqual(Object.keys(card.samples), ['pocket', 'omni16', 'omni32']);

    card = (await call('/api/voice/v/reroll', {set: 'pocket'})).body;   // Pocket's set changes, OmniVoice's does not
    assert.notDeepEqual(card.sets.pocket.ids, ['v/0', 'v/1', 'v/2']);
    assert.deepEqual(card.sets.omni.ids, ['v/0', 'v/1', 'v/2']);
    assert.ok(card.sets.pocket.seconds <= 18);
    assert.equal(card.history.pocket.at(-1).action, 'proposed');          // the starting set stays restorable

    card = (await call('/api/voice/v/reroll', {set: 'pocket-short'})).body;
    assert.ok(card.sets['pocket-short'].seconds <= 10);
    assert.equal((await call('/api/voice/v/set', {set: 'omni-short', clips: ['v/0', 'v/1', 'v/2', 'v/3']})).status, 400);
    assert.equal((await call('/api/voice/v/set', {set: 'nope', clips: ['v/0']})).status, 400);
    card = (await call('/api/voice/v/set', {set: 'omni', clips: ['v/3', 'v/4']})).body;
    assert.deepEqual(card.sets.omni.ids, ['v/3', 'v/4']);
    assert.equal(card.sets.omni.source, 'chosen by hand');

    card = (await call('/api/voice/v/keep', {engine: 'omni', note: 'nice'})).body;
    assert.equal(card.kept.omni.isCurrent, true);
    assert.equal(card.kept.pocket, undefined);                            // Pocket was not kept
    assert.equal((await call('/api/voice/v/keep', {engine: 'nope'})).status, 400);
    card = (await call('/api/voice/v/reject', {set: 'omni'})).body;
    assert.equal(card.rejectedNow.omni, true);
    card = (await call('/api/voice/v/unreject', {set: 'omni'})).body;
    assert.equal(card.rejectedNow.omni, false);
    card = (await call('/api/voice/v/unkeep', {engine: 'omni'})).body;
    assert.deepEqual(Object.keys(card.kept), []);
    card = (await call('/api/voice/v/keep', {engine: 'omni'})).body;
    assert.deepEqual(card.kept.omni.clips.map(clip => clip.id), ['v/3', 'v/4']);
    await call('/api/play/v', {what: 'research', target: 'omni__s16_g2'});
    await call('/api/play/v', {what: 'sample', target: 'omni16'});
    const verdict = await call('/api/voice/v/verdict', {value: 'bad'});
    assert.equal(verdict.body.verdict.value, 'bad');
    assert.equal((await call('/api/voice/v/verdict', {value: 'maybe'})).status, 400);

    await call('/api/voice/v/regenerate', {});
    for (let wait = 0; wait < 100 && (await call('/api/queue')).body.jobs.at(-1)?.status !== 'done'; wait++) await new Promise(done => setTimeout(done, 20));
    card = (await call('/api/voice/v')).body;
    assert.equal(card.samples.pocket.state, 'ready');
    assert.equal(card.samples.omni32.state, 'ready');
    assert.equal(rendered.length, 4);                                    // pocket, pocket 10 s (rerolled above), omni16, omni32; Omni short has no set
    const audio = await fetch(base + card.samples.omni16.url, {headers: {range: 'bytes=0-99'}});
    assert.equal(audio.status, 206);
    assert.equal((await audio.arrayBuffer()).byteLength, 100);
    assert.equal((await fetch(base + '/audio/sample/v/0/..%2f..%2fx.wav')).status, 404);

    // Every action is in the log with a timestamp, voice, engine, clips and action; replaying it gives the kept set.
    assert.deepEqual(store.state.voices.v.kept.omni.clips, ['v/3', 'v/4']);
    assert.equal(store.state.voices.v.verdict.value, 'bad');
    const entries = (await readFile(store.logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    for (const entry of entries) assert.ok(entry.ts && entry.voice === 'v' && entry.action && 'seq' in entry);
    for (const name of ['reroll', 'manual-set', 'keep', 'unkeep', 'reject', 'unreject', 'verdict', 'play', 'regenerate', 'regenerate-done']) {
      assert.ok(entries.some(entry => entry.action === name), `no ${name} entry`);
    }
    assert.ok(entries.some(entry => entry.action === 'play' && entry.what === 'research'));
  } finally { await running.close(); }
});

test('while another process holds the GPU, Pocket renders and OmniVoice waits ("GPU busy, queued")', async () => {
  const busy = {value: true};
  const gpu = {status: async () => busy.value ? {known: true, busy: true, usedMiB: 9000, totalMiB: 12000, reason: 'GPU busy: test'} : {known: true, busy: false, usedMiB: 1000, totalMiB: 12000}};
  const {running, call, rendered} = await fixture({gpu});
  try {
    await call('/api/voice/v/regenerate', {});
    for (let wait = 0; wait < 100 && rendered.length < 1; wait++) await new Promise(done => setTimeout(done, 20));
    await new Promise(done => setTimeout(done, 100));
    let card = (await call('/api/voice/v')).body;
    assert.equal(card.samples.pocket.state, 'ready');                  // Pocket does not wait for the GPU
    assert.equal(card.samples.omni16.state, 'gpu-busy');
    assert.equal(card.job.status, 'waiting-gpu');
    assert.equal(rendered.length, 1);
    busy.value = false;                                                // the GPU frees up: the held renders go ahead
    for (let wait = 0; wait < 200 && card.samples.omni32.state !== 'ready'; wait++) { await new Promise(done => setTimeout(done, 25)); card = (await call('/api/voice/v')).body; }
    assert.equal(card.samples.omni16.state, 'ready');
    assert.equal(card.samples.omni32.state, 'ready');
    busy.value = true;                                                 // a Pocket-only request never waits
    await call('/api/voice/v/set', {set: 'pocket', clips: ['v/5']});
    await call('/api/voice/v/regenerate', {slots: ['pocket']});
    for (let wait = 0; wait < 100 && (await call('/api/voice/v')).body.samples.pocket.state !== 'ready'; wait++) await new Promise(done => setTimeout(done, 20));
    assert.equal((await call('/api/voice/v')).body.samples.pocket.state, 'ready');
  } finally { await running.close(); }
});

test('research columns, audio and voices without a picker panel', async () => {
  const research = await mkdtemp(join(tmpdir(), 'research-'));
  for (const cond of ['REAL-target-copy', 'omni__s16_g2', 'omni__s16_g2_multiC']) {
    await mkdir(join(research, 'out/gen', cond), {recursive: true});
    for (const voice of ['v', 'solo']) await writeFile(join(research, 'out/gen', cond, `${voice}__0.wav`), encodeWav(new Float32Array(2400), 24000));
  }
  await mkdir(join(research, 'page'), {recursive: true});
  await writeFile(join(research, 'out/summary-table.md'), ['| Variant | condition | PLS | ECAPA guard | WER |', '|---|---|---|---|---|',
    '| Original line | REAL-target-copy | 105.8 | 0.697 | 6.0% |', '| Omni 16 single | omni__s16_g2 | 86.5 | 0.62 | 5.1% |',
    '| Omni 16 10s two-clip | omni__s16_g2_multiC | 97.4 | 0.654 | 5.0% |'].join('\n'));
  await writeFile(join(research, 'out/panel.json'), JSON.stringify({v: {targets: [{transcript: 'Say this line.'}]}, solo: {targets: [{transcript: 'Solo line.'}]}}));
  const {running, call, base} = await fixture({research: new Research({root: research, ttlMs: 0})});
  try {
    const data = (await call('/api/research')).body;
    assert.deepEqual(data.columns.filter(column => column.cond).map(column => column.cond), ['REAL-target-copy', 'omni__s16_g2', 'omni__s16_g2_multiC']);
    const single = data.columns.find(column => column.cond === 'omni__s16_g2');
    assert.deepEqual([single.metrics.pls, single.metrics.ecapa, single.metrics.wer], [86.5, 0.62, 5.1]);
    assert.equal(single.spanLabel, 'OmniVoice 16 steps');
    assert.equal(data.columns.find(column => column.cond === 'omni__s16_g2_multiC').label, '2 clips (10 s)');
    assert.ok(data.columns.some(column => column.placeholder && column.spanLabel === 'Pocket student FT'));   // Pocket's 1 | 2 | 3 block stays aligned
    assert.deepEqual(Object.keys(data.voices).sort(), ['solo', 'v']);
    assert.equal((await call('/api/state')).body.voices.find(voice => voice.key === 'solo').picker, false);
    assert.equal((await fetch(base + '/audio/research/omni__s16_g2/v/0')).status, 200);
    assert.equal((await fetch(base + '/audio/research/omni__s16_g2/v/1')).status, 404);
    assert.equal((await fetch(base + '/audio/research/..%2fx/v/0')).status, 404);
    assert.equal((await call('/api/voice/solo/verdict', {value: 'fine'})).status, 200);   // verdicts work without a panel
    // A new condition lands on disk (for example Pocket through a new Mimi decoder): it appears on the next scan.
    await mkdir(join(research, 'out/gen/ft6-mimi-a__multiC'), {recursive: true});
    await writeFile(join(research, 'out/gen/ft6-mimi-a__multiC/v__0.wav'), encodeWav(new Float32Array(2400), 24000));
    const later = (await call('/api/research?rescan=1')).body;
    const decoder = later.columns.find(column => column.cond === 'ft6-mimi-a__multiC');
    assert.equal(decoder.group, 'decoder');
    assert.equal(decoder.variant, 'two');
  } finally { await running.close(); }
});

// fetch() will not let a script forge Host or Origin, so these go through node:http.
const raw = (port, {method = 'GET', path, headers = {}, body}) => new Promise((done, reject) => {
  const request = httpRequest({host: '127.0.0.1', port, method, path, headers}, response => { response.resume(); response.on('end', () => done(response.statusCode)); });
  request.on('error', reject); request.end(body);
});

test('only loopback hosts and JSON posts are accepted', async () => {
  const {running} = await fixture();
  const {port} = running;
  try {
    assert.equal(await raw(port, {path: '/api/state', headers: {host: 'evil.example'}}), 403);
    assert.equal(await raw(port, {path: '/api/state', headers: {host: `localhost:${port}`}}), 200);
    assert.equal(await raw(port, {method: 'POST', path: '/api/voice/v/reroll', headers: {'content-type': 'text/plain'}, body: '{}'}), 415);
    assert.equal(await raw(port, {method: 'POST', path: '/api/voice/v/reroll', headers: {'content-type': 'application/json', origin: 'http://evil.example'}, body: '{}'}), 403);
    assert.equal(await raw(port, {path: '/..%2f..%2fpackage.json'}), 404);
  } finally { await running.close(); }
});
