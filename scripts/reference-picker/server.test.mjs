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

// A voice with 8 clips of 3-5 s, one held-out line, today's reference, and a proposed three-clip set.
async function fixture() {
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
  const engines = {state: {pocket: 'idle', omni: 'idle'}, close: async () => {},
    materialize: async items => ({path: join(work, 'refs', `${items.map(i => i.id).join('_').replaceAll('/', '-')}.wav`), sha256: createHash('sha256').update(items.map(i => i.id).join()).digest('hex')}),
    materializeLive: async entry => ({path: entry.reference, sha256: entry.sha256}),
    sampleId: async (item, reference, transcript, text) => createHash('sha1').update([item.slot, reference.sha256, transcript, text].join()).digest('hex').slice(0, 10),
    runPocket: async (items, {onItem}) => { for (const item of items) { await mkdir(join(item.out, '..'), {recursive: true}); await writeFile(item.out, tone(1)); rendered.push(item.out); await onItem(item, {seconds: 1, tookMs: 5}); } },
    renderOmni: async item => { await mkdir(join(item.out, '..'), {recursive: true}); await writeFile(item.out, tone(1)); rendered.push(item.out); return {seconds: 1, tookMs: 5}; }};
  const store = new PickStore({logPath: join(root, 'picks.jsonl'), jsonPath: join(root, 'picks.json')});
  await store.load();
  const running = await startPicker({project: root, work, port: 0, pool: new Pool(index, {project: root}), store, engines});
  const base = `http://127.0.0.1:${running.port}`;
  const call = async (path, body) => {
    const response = await fetch(base + path, body === undefined ? {} : {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
    return {status: response.status, body: await response.json().catch(() => null), response};
  };
  return {running, call, base, store, rendered};
}

test('card, reroll, manual set, keep, reject, regenerate and audio', async () => {
  const {running, call, base, store, rendered} = await fixture();
  try {
    const state = await call('/api/state');
    assert.deepEqual(state.body.voices.map(voice => voice.key), ['v']);
    let card = (await call('/api/voice/v')).body;
    assert.deepEqual(card.sets.full.ids, ['v/0', 'v/1', 'v/2']);
    assert.equal(card.sets.full.source, 'proposed');
    assert.equal(card.text, 'Say this line.');
    assert.equal(card.samples.pocket.state, 'missing');

    card = (await call('/api/voice/v/reroll', {set: 'full'})).body;
    assert.notDeepEqual(card.sets.full.ids, ['v/0', 'v/1', 'v/2']);
    assert.ok(card.sets.full.seconds <= 18);
    assert.equal(card.history.full.at(-1).action, 'proposed');          // the starting set stays restorable

    const tooLong = await call('/api/voice/v/set', {set: 'short', clips: ['v/0', 'v/1', 'v/2', 'v/3']});
    assert.equal(tooLong.status, 400);
    card = (await call('/api/voice/v/set', {set: 'full', clips: ['v/3', 'v/4']})).body;
    assert.deepEqual(card.sets.full.ids, ['v/3', 'v/4']);
    assert.equal(card.sets.full.source, 'chosen by hand');

    card = (await call('/api/voice/v/keep', {engine: 'pocket', note: 'nice'})).body;
    assert.equal(card.kept.pocket.isCurrent, true);
    assert.equal((await call('/api/voice/v/keep', {engine: 'nope'})).status, 400);
    card = (await call('/api/voice/v/reject', {set: 'full'})).body;
    assert.equal(card.rejectedNow.full, true);
    await call('/api/play/v', {what: 'sample', target: 'omni16'});

    await call('/api/voice/v/regenerate', {});
    for (let wait = 0; wait < 100 && (await call('/api/queue')).body.jobs.at(-1)?.status !== 'done'; wait++) await new Promise(done => setTimeout(done, 20));
    card = (await call('/api/voice/v')).body;
    assert.equal(card.samples.pocket.state, 'ready');
    assert.equal(card.samples['live-omni32'].state, 'ready');
    assert.equal(rendered.length, 6);                                  // pocket, omni16, omni32 and the three live ones (no short set here)
    const audio = await fetch(base + card.samples.omni16.url, {headers: {range: 'bytes=0-99'}});
    assert.equal(audio.status, 206);
    assert.equal((await audio.arrayBuffer()).byteLength, 100);
    assert.equal((await fetch(base + '/audio/sample/v/0/..%2f..%2fx.wav')).status, 404);

    // Every action is in the log with a timestamp, voice, engine, clips and action; replaying it gives the kept set.
    const actions = store.state.voices.v;
    assert.deepEqual(actions.kept.pocket.clips, ['v/3', 'v/4']);
    const entries = (await readFile(store.logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    for (const entry of entries) assert.ok(entry.ts && entry.voice === 'v' && entry.action && 'seq' in entry);
    assert.ok(['reroll', 'manual-set', 'keep', 'reject', 'play', 'regenerate', 'regenerate-done'].every(name => entries.some(entry => entry.action === name)));
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
