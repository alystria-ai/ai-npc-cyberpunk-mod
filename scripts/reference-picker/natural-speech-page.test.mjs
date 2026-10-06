import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Writable} from 'node:stream';
import {isNaturalSpeechPath, serveNaturalSpeech} from './natural-speech-page.mjs';

const reply = () => {
  const chunks = [], out = new Writable({write(chunk, _e, done) { chunks.push(chunk); done(); }});
  out.writeHead = (status, headers) => { out.status = status; out.headers = headers; };
  out.finished = new Promise(done => out.on('finish', done));
  out.text = () => Buffer.concat(chunks).toString('utf8');
  return out;
};
const get = async (root, path) => { const response = reply(); serveNaturalSpeech({method: 'GET'}, response, path, root); if (response.status !== 302) await response.finished; return response; };

test('serves the page and wavs read-only, nothing else', async () => {
  const root = mkdtempSync(join(tmpdir(), 'natural-'));
  mkdirSync(join(root, 'audio/pocket'), {recursive: true});
  writeFileSync(join(root, 'index.html'), '<p>page</p>');
  writeFileSync(join(root, 'audio/pocket/a.wav'), 'RIFF');
  writeFileSync(join(root, 'secret.json'), '{}');
  assert.ok(isNaturalSpeechPath('/natural-speech') && isNaturalSpeechPath('/natural-speech/x') && !isNaturalSpeechPath('/natural-speechless'));
  assert.equal((await get(root, '/natural-speech')).headers.location, '/natural-speech/');
  const page = await get(root, '/natural-speech/');
  assert.equal(page.status, 200); assert.equal(page.text(), '<p>page</p>');
  assert.equal((await get(root, '/natural-speech/audio/pocket/a.wav')).headers['content-type'], 'audio/wav');
  for (const path of ['/natural-speech/secret.json', '/natural-speech/../secret.json', '/natural-speech/audio/missing.wav', '/natural-speech/..%5Csecret.html'])
    assert.equal((await get(root, path)).status, 404, path);
});
