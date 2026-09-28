import {test} from 'node:test';
import assert from 'node:assert/strict';
import {VoiceStudioClient, validateVoiceStudioConfig} from './voice-studio.mjs';
import {silentWav} from './speech-audio.mjs';

const config = {provider: 'voicestudio', profiles: {judy: {id: 'judy-id'}, johnny: {id: 'johnny-id'}}};
test('local voice request keeps exact text and raw audio and targets the assigned profile', async () => {
  const wav = silentWav(); let request;
  const client = new VoiceStudioClient(config, {fetchImpl: async (url, options) => {
    request = {url, options, fields: Object.fromEntries(options.body)};
    return new Response(wav, {headers: {'content-type': 'audio/wav'}});
  }});
  const result = await client.synthesize('johnny', 'Hey V, ready?');
  assert.equal(request.url, 'http://127.0.0.1:3900/generate');
  assert.deepEqual(request.fields, {text: 'Hey V, ready?', profile_id: 'johnny-id', engine: 'omnivoice', num_step: '32', speed: '1',
    effect_preset: 'raw', denoise: 'false', postprocess_output: 'false', max_chunk_chars: '0',
    crossfade_ms: '0', pronounce: 'false', stream: 'false'});
  assert.deepEqual(Buffer.from(result.audio, 'base64'), wav);
  assert.equal(request.options.redirect, 'error');
});
test('missing clone does not send text or silently borrow a voice', async () => {
  let requests = 0;
  const client = new VoiceStudioClient(config, {fetchImpl: async () => { requests++; }});
  await assert.rejects(client.synthesize('smasher', 'Hello'), /no local cloned voice/);
  assert.equal(requests, 0);
});
test('generation is serialized and cancellation drops queued speech', async () => {
  let release, requests = 0;
  const client = new VoiceStudioClient(config, {fetchImpl: async () => {
    requests++;
    if (requests === 1) await new Promise(done => { release = done; });
    return new Response(silentWav());
  }});
  const first = client.synthesize('judy', 'First');
  await new Promise(done => setImmediate(done));
  const abort = new AbortController();
  const second = client.synthesize('johnny', 'Second', {signal: abort.signal});
  const rejected = assert.rejects(second, /cancelled/);
  abort.abort(Error('cancelled'));
  assert.equal(requests, 1);
  release(); await first; await rejected;
  assert.equal(requests, 1);
  await client.synthesize('judy', 'Third');
  assert.equal(requests, 2);
});
test('rejects malformed audio and a remote speech endpoint', async () => {
  const client = new VoiceStudioClient(config, {fetchImpl: async () => new Response('{}')});
  await assert.rejects(client.synthesize('judy', 'Hello'), /supported WAV/);
  assert.throws(() => validateVoiceStudioConfig({...config, baseUrl: 'https://example.com'}), /loopback/);
  assert.throws(() => validateVoiceStudioConfig({...config, baseUrl: 'http://user:secret@localhost:3900'}), /loopback/);
});
