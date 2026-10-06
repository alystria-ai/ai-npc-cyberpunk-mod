import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Writable} from 'node:stream';
import {isPocketV2Path, servePocketV2} from './pocket-v2-page.mjs';

const reply = () => {
  const chunks = [], out = new Writable({write(chunk, _e, done) { chunks.push(chunk); done(); }});
  out.writeHead = (status, headers) => { out.status = status; out.headers = headers; };
  out.finished = new Promise(done => out.on('finish', done));
  out.text = () => Buffer.concat(chunks).toString('utf8');
  return out;
};
const get = async (root, path) => { const response = reply(); servePocketV2({method: 'GET'}, response, path, root); if (response.status !== 302) await response.finished; return response; };

test('serves the page and wavs read-only, nothing else', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pocketv2-'));
  mkdirSync(join(root, 'audio/pocket'), {recursive: true});
  writeFileSync(join(root, 'index.html'), '<p>page</p>');
  writeFileSync(join(root, 'audio/pocket/a.wav'), 'RIFF');
  writeFileSync(join(root, 'secret.json'), '{}');
  assert.ok(isPocketV2Path('/pocket-v2') && isPocketV2Path('/pocket-v2/x') && !isPocketV2Path('/pocket-v2less'));
  assert.equal((await get(root, '/pocket-v2')).headers.location, '/pocket-v2/');
  const page = await get(root, '/pocket-v2/');
  assert.equal(page.status, 200); assert.equal(page.text(), '<p>page</p>');
  assert.equal((await get(root, '/pocket-v2/audio/pocket/a.wav')).headers['content-type'], 'audio/wav');
  for (const path of ['/pocket-v2/secret.json', '/pocket-v2/../secret.json', '/pocket-v2/audio/missing.wav', '/pocket-v2/..%5Csecret.html'])
    assert.equal((await get(root, path)).status, 404, path);
});
