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
// reportRoot: where the Voice report v3 would live (a fresh, empty folder unless the test builds one).
async function fixture({gpu = {status: async () => ({known: true, busy: false})}} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'picker-'));
  const data = join(root, 'data'), work = join(root, 'work'), reportRoot = join(root, 'report');
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
  const running = await startPicker({project: root, work, port: 0, pool: new Pool(index, {project: root}), store, engines, gpu, gpuRecheckMs: 30, reportRoot});
  const base = `http://127.0.0.1:${running.port}`;
  const call = async (path, body) => {
    const response = await fetch(base + path, body === undefined ? {} : {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
    return {status: response.status, body: await response.json().catch(() => null), response};
  };
  return {running, call, base, store, rendered, root, reportRoot};
}

test('the three sets (Pocket, OmniVoice short, OmniVoice long): reroll, hand-pick, keep, reject, undo, render and audio', async () => {
  const {running, call, base, store, rendered} = await fixture();
  try {
    let card = (await call('/api/voice/v')).body;
    assert.deepEqual(Object.keys(card.sets), ['pocket', 'omni-short', 'omni']);
    assert.deepEqual(Object.values(card.sets).map(set => set?.budget), [30, undefined, 18]);
    assert.deepEqual(card.sets.pocket.ids, ['v/0', 'v/1', 'v/2']);
    assert.equal(card.sets.pocket.source, 'proposed');
    assert.equal(card.sets.pocket.seconds, 12.8);                         // 3 + 4 + 5 s plus two 0.4 s gaps
    assert.equal(card.sets['omni-short'], null);                          // no proposed short set in this fixture
    assert.equal(card.text, 'Say this line.');
    assert.equal(card.samples.pocket.state, 'missing');
    assert.deepEqual(Object.keys(card.samples), ['pocket', 'omni16', 'omni32']);
    assert.equal(card.samples.omni16.seconds, 12.8);

    card = (await call('/api/voice/v/reroll', {set: 'pocket'})).body;   // Pocket's set changes, OmniVoice's does not
    assert.notDeepEqual(card.sets.pocket.ids, ['v/0', 'v/1', 'v/2']);
    assert.deepEqual(card.sets.omni.ids, ['v/0', 'v/1', 'v/2']);
    assert.ok(card.sets.pocket.seconds <= 30 && card.sets.pocket.seconds >= 18);   // fills its 30 s budget with whole clips, however many
    assert.equal(card.history.pocket.at(-1).action, 'proposed');          // the starting set stays restorable

    card = (await call('/api/voice/v/reroll', {set: 'omni-short'})).body;
    assert.ok(card.sets['omni-short'].seconds <= 10 && card.sets['omni-short'].seconds >= 6);
    for (const removed of ['pocket-short', 'pocket-single', 'omni-single']) {
      assert.equal((await call('/api/voice/v/reroll', {set: removed})).status, 400, removed);
      assert.equal((await call('/api/voice/v/set', {set: removed, clips: ['v/0']})).status, 400, removed);
      assert.equal((await call('/api/voice/v/keep', {engine: removed})).status, 400, removed);
    }
    assert.equal((await call('/api/voice/v/set', {set: 'omni-short', clips: ['v/0', 'v/1', 'v/2', 'v/3']})).status, 400);   // 16.2 s: over 10 s
    assert.equal((await call('/api/voice/v/set', {set: 'omni', clips: []})).status, 400);
    assert.equal((await call('/api/voice/v/set', {set: 'nope', clips: ['v/0']})).status, 400);
    card = (await call('/api/voice/v/set', {set: 'omni', clips: ['v/3', 'v/4']})).body;
    assert.deepEqual(card.sets.omni.ids, ['v/3', 'v/4']);
    assert.equal(card.sets.omni.source, 'chosen by hand');
    card = (await call('/api/voice/v/set', {set: 'pocket', clips: ['v/0', 'v/1', 'v/2', 'v/3', 'v/4', 'v/5', 'v/6']})).body;   // seven clips, 29.4 s: no count limit
    assert.equal(card.sets.pocket.ids.length, 7);
    assert.equal(card.sets.pocket.seconds, 29.4);
    assert.equal((await call('/api/voice/v/set', {set: 'pocket', clips: ['v/0', 'v/1', 'v/2', 'v/3', 'v/4', 'v/5', 'v/6', 'v/7']})).status, 400);   // 33.8 s: over 30 s

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
    await call('/api/play/v', {what: 'sample', target: 'omni16'});
    await call('/api/play/v', {what: 'clip', target: 'v/0'});
    assert.equal((await call('/api/play/v', {what: 'research', target: 'omni__s16_g2'})).status, 400);   // the research report is gone
    const verdict = await call('/api/voice/v/verdict', {value: 'bad'});
    assert.equal(verdict.body.verdict.value, 'bad');
    assert.equal((await call('/api/voice/v/verdict', {value: 'maybe'})).status, 400);

    await call('/api/voice/v/regenerate', {});
    for (let wait = 0; wait < 100 && (await call('/api/queue')).body.jobs.at(-1)?.status !== 'done'; wait++) await new Promise(done => setTimeout(done, 20));
    card = (await call('/api/voice/v')).body;
    assert.equal(card.samples.pocket.state, 'ready');
    assert.equal(card.samples.omni32.state, 'ready');
    assert.deepEqual(Object.keys(card.samples), ['pocket', 'omni16', 'omni32', 'omni16s', 'omni32s']);
    assert.equal(rendered.length, 5);                                    // Pocket, OmniVoice long at 16 and 32 steps, OmniVoice short at 16 and 32 steps
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
  } finally { await running.close(); }
});

test('while another process holds the GPU, Pocket renders and OmniVoice waits ("GPU busy, queued")', async () => {
  const busy = {value: true};
  const gpu = {status: async () => busy.value ? {known: true, busy: true, usedMiB: 9000, totalMiB: 12000, reason: 'GPU busy: test'} : {known: true, busy: false, usedMiB: 1000, totalMiB: 12000}};
  const {running, call, rendered} = await fixture({gpu});
  try {
    await call('/api/voice/v/regenerate', {});
    for (let wait = 0; wait < 100 && rendered.length < 1; wait++) await new Promise(done => setTimeout(done, 20));
    // Wait for the held slot to report the GPU wait (a fixed pause is too short on a busy machine).
    let card = (await call('/api/voice/v')).body;
    for (let wait = 0; wait < 250 && card.samples.omni16.state !== 'gpu-busy'; wait++) { await new Promise(done => setTimeout(done, 20)); card = (await call('/api/voice/v')).body; }
    assert.equal(card.samples.pocket.state, 'ready');                  // Pocket does not wait for the GPU
    assert.equal(card.samples.omni16.state, 'gpu-busy');
    assert.equal(card.job.status, 'waiting-gpu');
    assert.equal(rendered.length, 1);                                  // Pocket's one sample
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

test('"/" and "/v3/" serve the Voice report v3 read only; the retired report, research and Pocket v2 routes are gone', async () => {
  const {running, call, base, reportRoot} = await fixture();
  try {
    const notice = await fetch(base + '/');
    assert.equal(notice.status, 200);
    assert.match(await notice.text(), /has not been built/);               // nothing built yet
    await mkdir(join(reportRoot, 'audio/omni16'), {recursive: true});
    await writeFile(join(reportRoot, 'index.html'), '<!doctype html><title>Voice report v3</title>');
    await writeFile(join(reportRoot, 'audio/omni16/judy.wav'), encodeWav(new Float32Array(2400), 24000));
    await writeFile(join(reportRoot, 'secret.json'), '{}');
    for (const path of ['/', '/v3/']) assert.match(await (await fetch(base + path)).text(), /Voice report v3/);
    const redirect = await fetch(base + '/v3', {redirect: 'manual'});
    assert.equal(redirect.status, 302); assert.equal(redirect.headers.get('location'), '/v3/');
    for (const path of ['/audio/omni16/judy.wav', '/v3/audio/omni16/judy.wav']) {
      const audio = await fetch(base + path);
      assert.equal(audio.status, 200); assert.equal(audio.headers.get('content-type'), 'audio/wav'); assert.equal(audio.headers.get('cache-control'), 'no-store');
    }
    assert.equal((await fetch(base + '/', {method: 'HEAD'})).status, 200);
    for (const path of ['/v3/secret.json', '/v3/..%2fsecret.json', '/audio/omni16/missing.wav', '/index.html', '/app.js', '/pocket-v2/', '/api/state', '/api/research', '/audio/research/x/v/0']) {
      assert.equal((await fetch(base + path)).status, 404, path);
    }
    assert.equal((await call('/api/generate-missing', {voices: ['v']})).status, 404);
    assert.equal((await fetch(base + '/natural-speech', {redirect: 'manual'})).status, 302);       // the other listening page is untouched
    assert.equal((await fetch(base + '/%E0%A4%A')).status, 400);              // a malformed path is a client error, not a crash
  } finally { await running.close(); }
});

test('routes the Voice report v3 and the character page rely on: pool, clip audio, live audio, character page', async () => {
  const {running, call, base} = await fixture();
  try {
    const pool = (await call('/api/pool/v')).body;
    assert.equal(pool.key, 'v');
    const clip = pool.clips.find(item => item.id === 'v/3');
    assert.deepEqual([clip.d, clip.t, clip.rel, clip.s], [3, 'clip number 3 has words', 0, 'train']);
    assert.equal(clip.audio, '/audio/clip/v/v%2F3');
    for (const item of pool.clips) assert.ok(item.audio && 'id' in item && 'd' in item && 't' in item);
    assert.ok(pool.clips.some(item => item.id === 'live:omni' && item.audio === '/audio/live/omni/v'));
    for (const path of [clip.audio, `/audio/clip/v/${encodeURIComponent('v/3')}`, '/audio/live/omni/v', '/audio/live/pocket/v', '/audio/line/v/0']) {
      const audio = await fetch(base + path);
      assert.equal(audio.status, 200, path);
      assert.equal(audio.headers.get('content-type'), 'audio/wav');
    }
    assert.equal((await fetch(base + '/audio/clip/v/v%2F99')).status, 404);
    assert.equal((await fetch(base + '/audio/clip/nobody/v%2F3')).status, 404);
    assert.equal((await call('/api/pool/nobody')).status, 404);
    const page = await fetch(base + '/voice/v');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /voice\.js/);
    const script = await (await fetch(base + '/voice.js')).text();
    assert.match(script, /href: '\/', class: 'back'\}, '← Voice report'/);   // the back link goes to the report at "/"
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
    assert.equal(await raw(port, {path: '/api/queue', headers: {host: 'evil.example'}}), 403);
    assert.equal(await raw(port, {path: '/', headers: {host: 'evil.example'}}), 403);
    assert.equal(await raw(port, {path: '/api/queue', headers: {host: `localhost:${port}`}}), 200);
    assert.equal(await raw(port, {method: 'POST', path: '/api/voice/v/reroll', headers: {'content-type': 'text/plain'}, body: '{}'}), 415);
    assert.equal(await raw(port, {method: 'POST', path: '/api/voice/v/reroll', headers: {'content-type': 'application/json', origin: 'http://evil.example'}, body: '{}'}), 403);
    assert.equal(await raw(port, {path: '/..%2f..%2fpackage.json'}), 404);
  } finally { await running.close(); }
});

const settle = async (call, status = 'done') => { for (let wait = 0; wait < 150 && (await call('/api/queue')).body.jobs.at(-1)?.status !== status; wait++) await new Promise(done => setTimeout(done, 20)); };

test('character page: current clips, new clips, keep, keep current, samples of the current clips', async () => {
  const {running, call, base, store} = await fixture();
  try {
    const page = await fetch(base + '/voice/v');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /voice\.js/);
    assert.equal((await fetch(base + '/voice.js')).status, 200);
    let card = (await call('/api/voice/v')).body;
    assert.deepEqual(card.current.pocket.ids, ['v/0', 'v/1', 'v/2']);
    assert.equal(card.current.pocket.source, 'proposed');
    assert.equal(card.current.pocket.hasNew, false);
    assert.equal(card.current['omni-short'].source, 'today');                   // no proposed short set: today's reference
    assert.deepEqual(card.current['omni-short'].ids, ['live:omni']);
    assert.deepEqual(Object.keys(card.current), ['pocket', 'omni-short', 'omni']);
    assert.deepEqual(Object.keys(card.current.omni.samples), ['omni16', 'omni32']);
    assert.equal(card.current.omni.seconds, 12.8);

    card = (await call('/api/voice/v/reroll', {set: 'pocket'})).body;
    assert.equal(card.current.pocket.hasNew, true);
    assert.deepEqual(card.current.pocket.ids, ['v/0', 'v/1', 'v/2']);          // the current clips do not move when the new ones change
    const drawn = card.sets.pocket.ids;
    card = (await call('/api/voice/v/dismiss', {set: 'pocket'})).body;           // "Keep current": the new clips are rejected, the current ones shown again
    assert.deepEqual(card.sets.pocket.ids, ['v/0', 'v/1', 'v/2']);
    assert.equal(card.current.pocket.hasNew, false);
    assert.ok(store.state.voices.v.rejected.some(item => item.set === 'pocket' && item.clips.join('|') === drawn.join('|')));
    assert.equal((await call('/api/voice/v/dismiss', {set: 'pocket'})).status, 200);   // nothing to dismiss is not an error
    assert.equal((await call('/api/voice/v/dismiss', {set: 'nope'})).status, 400);

    card = (await call('/api/voice/v/reroll', {set: 'pocket'})).body;
    const chosen = card.sets.pocket.ids;
    card = (await call('/api/voice/v/keep', {engine: 'pocket'})).body;           // "Use these clips"
    assert.equal(card.current.pocket.source, 'kept');
    assert.deepEqual(card.current.pocket.ids, chosen);
    assert.equal(card.current.pocket.hasNew, false);
    card = (await call('/api/voice/v/reroll', {set: 'pocket'})).body;
    assert.deepEqual(card.current.pocket.ids, chosen);
    assert.equal(card.current.pocket.hasNew, true);

    // Samples of the current clips are rendered on request; the new clips' samples are separate.
    assert.equal(card.current.pocket.samples.pocket.exists, false);
    await call('/api/voice/v/regenerate', {slots: ['pocket'], target: 'current'});
    await settle(call);
    card = (await call('/api/voice/v')).body;
    assert.equal(card.current.pocket.samples.pocket.exists, true);
    assert.equal(card.samples.pocket.exists, false);
    assert.equal((await call('/api/queue')).body.jobs.at(-1).target, 'current');
    await call('/api/play/v', {what: 'sample', target: 'pocket', current: true});
    const logged = (await readFile(store.logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const play = logged.findLast(entry => entry.action === 'play');
    assert.equal(play.current, true);
    assert.deepEqual(play.clips, chosen);
    for (const name of ['reject', 'restore', 'keep']) assert.ok(logged.some(entry => entry.action === name), name);
  } finally { await running.close(); }
});

test('references are measured by duration: any number of clips is kept while the seconds fit, and the card reports the seconds', async () => {
  const {running, call, store} = await fixture();
  try {
    let card = (await call('/api/voice/v/set', {set: 'omni-short', clips: ['v/0', 'v/3', 'v/6']})).body;        // three 3 s clips, 9.8 s
    assert.equal(card.sets['omni-short'].seconds, 9.8);
    assert.equal((await call('/api/voice/v/set', {set: 'omni', clips: ['v/0', 'v/3', 'v/6', 'v/1', 'v/4']})).status, 400);   // 3+3+3+4+4 s, 5 clips = 18.6 s: over 18 s
    assert.deepEqual((await call('/api/voice/v')).body.sets.omni.ids, ['v/0', 'v/1', 'v/2']);                      // unchanged: the set was refused
    card = (await call('/api/voice/v/set', {set: 'omni', clips: ['v/0', 'v/3', 'v/6', 'v/1']})).body;           // 3+3+3+4 s, 4 clips = 14.2 s
    assert.equal(card.sets.omni.seconds, 14.2);
    card = (await call('/api/voice/v/keep', {engine: 'omni-short'})).body;
    assert.deepEqual(card.kept['omni-short'].clips.map(clip => clip.id), ['v/0', 'v/3', 'v/6']);
    assert.equal(card.kept['omni-short'].seconds, 9.8);
    assert.deepEqual(store.state.voices.v.kept['omni-short'].clips, ['v/0', 'v/3', 'v/6']);
    for (let run = 0; run < 10; run++) {
      card = (await call('/api/voice/v/reroll', {set: 'omni'})).body;
      assert.ok(card.sets.omni.seconds <= 18 && card.sets.omni.seconds >= 10.8);
    }
  } finally { await running.close(); }
});

test('Auto-best (schema 2): pocket <- pocket.best, omni-short <- omni.short, omni <- omni.long, offered on the card by set', async () => {
  const {running, call, root} = await fixture();
  try {
    assert.deepEqual((await call('/api/voice/v')).body.autobest, {});
    const set = (ids, seconds, extra = {}) => ({ids, seconds, ecapa: 0.75, ecapa_se: 0.02, pls: 90, ...extra});
    await writeFile(join(root, 'runtime/autobest-sets.json'), JSON.stringify({version: 2, generated: 'g', engines: {omni: {tag: 'omni16'}, pocket: {tag: 'pk'}}, voices: {v: {
      omni: {short: set(['v/0', 'v/3'], 6.4, {latency_ms: {16: 240, 32: 540}}), long: set(['v/0', 'v/3', 'v/6', 'v/1'], 14.2), best: set(['v/0'], 3), today: {ids: ['live:omni'], seconds: 4, ecapa: 0.6, pls: 80}, curve: []},
      pocket: {best: set(['v/0', 'v/1', 'v/2', 'v/3', 'v/4', 'v/5', 'v/6'], 29.4), today: {ids: ['live:pocket'], seconds: 4, ecapa: 0.65, pls: 85}, curve: []}}}}));
    const found = (await call('/api/voice/v')).body.autobest;
    assert.deepEqual(Object.keys(found).sort(), ['omni', 'omni-short', 'pocket']);
    assert.deepEqual(found.omni.ids, ['v/0', 'v/3', 'v/6', 'v/1']);
    assert.equal(found.omni.seconds, 14.2);
    assert.equal(found.pocket.ids.length, 7);
    assert.deepEqual(found['omni-short'].latencyMs, {16: 240, 32: 540});
    assert.equal(found.omni.today, 0.6);
    const loaded = (await call('/api/voice/v/set', {set: 'omni-short', clips: found['omni-short'].ids})).body;   // "Load Auto-best" is the ordinary set action
    assert.deepEqual(loaded.sets['omni-short'].ids, ['v/0', 'v/3']);
  } finally { await running.close(); }
});
