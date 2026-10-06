import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Writable} from 'node:stream';
import {isV3Path, serveV3} from './voice-report-page.mjs';

const reply = () => {
  const chunks = [], out = new Writable({write(chunk, _e, done) { chunks.push(chunk); done(); }});
  out.writeHead = (status, headers) => { out.status = status; out.headers = headers; };
  out.finished = new Promise(done => out.on('finish', done));
  out.text = () => Buffer.concat(chunks).toString('utf8');
  return out;
};
const get = async (root, path, method = 'GET') => {
  const response = reply();
  assert.equal(serveV3({method}, response, path, root), true);
  if (response.status !== 302) await response.finished;
  return response;
};
const built = () => {
  const root = mkdtempSync(join(tmpdir(), 'v3-'));
  mkdirSync(join(root, 'audio/omni16'), {recursive: true});
  writeFileSync(join(root, 'index.html'), '<p>report v3</p>');
  writeFileSync(join(root, 'audio/omni16/a.wav'), 'RIFF');
  writeFileSync(join(root, 'secret.json'), '{}');
  writeFileSync(join(root, 'other.html'), '<p>other</p>');
  return root;
};

test('which paths belong to the report: "/", /v3 and the two-segment /audio/<column>/<file>.wav, not the picker\'s own audio routes', () => {
  for (const path of ['/', '/v3', '/v3/', '/v3/audio/omni16/a.wav', '/audio/omni16/a.wav']) assert.ok(isV3Path(path), path);
  for (const path of ['/voice/judy', '/api/queue', '/v3less', '/audio/clip/v/x', '/audio/clip/v/0', '/audio/live/omni/v', '/audio/line/v/0', '/audio/sample/v/0/pocket-0123456789.wav', '/style.css']) assert.ok(!isV3Path(path), path);
});

test('serves index.html at "/" and "/v3/" (alias) and the wavs under both prefixes; no caching', async () => {
  const root = built();
  for (const path of ['/', '/v3/']) {
    const page = await get(root, path);
    assert.equal(page.status, 200); assert.equal(page.text(), '<p>report v3</p>');
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.match(page.headers['content-type'], /^text\/html/);
  }
  const redirect = await get(root, '/v3');
  assert.equal(redirect.status, 302); assert.equal(redirect.headers.location, '/v3/');
  for (const path of ['/audio/omni16/a.wav', '/v3/audio/omni16/a.wav']) {
    const audio = await get(root, path);
    assert.equal(audio.status, 200); assert.equal(audio.headers['content-type'], 'audio/wav'); assert.equal(audio.headers['cache-control'], 'no-store');
    assert.equal(audio.text(), 'RIFF');
  }
  const head = await get(root, '/', 'HEAD');
  assert.equal(head.status, 200); assert.equal(head.text(), '');
});

test('only index.html and .wav files inside the root are served; path escapes are refused', async () => {
  const root = built();
  for (const path of ['/v3/secret.json', '/v3/other.html', '/v3/../secret.json', '/v3/audio/../../x.wav', '/v3/audio/missing.wav', '/audio/omni16/missing.wav',
    '/v3/..%5Csecret.html', '/v3/audio\\omni16\\a.wav', '/v3/audio/omni16', '/audio/../index.html', '/audio/\0/a.wav', '/v3/..\\secret.html'])
    assert.equal((await get(root, path)).status, 404, path);
});

test('before the report is built, "/" shows a short plain notice that names build_page.py', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'v3-empty-'));
  for (const root of [empty, join(empty, 'does-not-exist')]) {
    for (const path of ['/', '/v3/']) {
      const page = await get(root, path);
      assert.equal(page.status, 200);
      assert.match(page.text(), /has not been built/); assert.match(page.text(), /build_page\.py/);
    }
    assert.equal((await get(root, '/audio/omni16/a.wav')).status, 404);
  }
});
