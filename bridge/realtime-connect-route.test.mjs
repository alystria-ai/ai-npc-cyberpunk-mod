import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, resolve} from 'node:path';
import {installConvaiAudioRoute, RealtimeHost} from './realtime-host.mjs';

const endpoint = 'https://realtime-api.convai.com/connect';
const identity = {characterId: 'test-character', endUserId: 'test-user', ttsEnabled: true};
const body = () => ({character_id: identity.characterId, end_user_id: identity.endUserId,
  end_user_metadata: {name: 'test metadata'}, character_session_id: 'test-session',
  transport: 'livekit', connection_type: 'audio', default_tts_enabled: true,
  default_stt_enabled: true, blendshape_provider: 'neurosync',
  blendshape_config: {format: 'arkit', deliver_chunks_ahead: true, output_fps: 30},
  respond_modes: {context_update: 'silent'}, future_option: ['preserve', {nested: true}]});

async function fixture(owner = {...identity}) {
  let registered, currentOwner = owner;
  const page = {async route(url, handler) { registered = {url, handler}; }};
  await installConvaiAudioRoute(page, () => currentOwner);
  assert.equal(registered.url, endpoint, 'the browser route is exact, with no wildcard');
  return {setOwner(value) { currentOwner = value; }, async request(value = body(), options = {}) {
    const calls = [];
    const raw = options.raw === undefined ? JSON.stringify(value) : options.raw;
    await registered.handler({
      request: () => ({url: () => options.url ?? endpoint, method: () => options.method ?? 'POST',
        postData: () => raw, headers() { throw Error('Authentication headers must not be inspected or replaced'); }}),
      continue: async value => calls.push({method: 'continue', ...(value === undefined ? {} : {value})}),
      abort: async reason => calls.push({method: 'abort', reason}),
    });
    return calls;
  }};
}

test('the scoped route matches the actual installed SDK default connect URL', async () => {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve('@convai/web-sdk/package.json');
  const sdk = JSON.parse(readFileSync(packagePath, 'utf8'));
  const project = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(sdk.version, project.dependencies['@convai/web-sdk'], 'review this adapter when the pinned SDK changes');
  const source = readFileSync(resolve(dirname(packagePath), 'dist/core/ConvaiClient.js'), 'utf8');
  const defaultBase = /const configWithDefaults\s*=\s*\{\s*url:\s*["']([^"']+)["']/.exec(source)?.[1];
  assert.ok(defaultBase, 'the installed SDK default must be identified instead of guessed from documentation');
  assert.match(source, /fetch\(`\$\{configWithDefaults\.url\}\/connect`/);
  let registered;
  await installConvaiAudioRoute({route: async url => { registered = url; }}, () => identity);
  assert.equal(registered, defaultBase + '/connect');
});

test('scoped connect routing preserves identity, session, context, STT and every unrelated option', async () => {
  const f = await fixture(), original = body(), snapshot = structuredClone(original);
  original.audio_config = {input: {sample_rate: 16000}, other: 'retained',
    output: {audio_routing: 'both', max_chunk_duration_ms: 1000, add_wav_header: true, unrelated: 9}};
  const calls = await f.request(original);
  assert.equal(calls.length, 1); assert.equal(calls[0].method, 'continue');
  assert.deepEqual(Object.keys(calls[0].value), ['postData'], 'headers and method remain browser-owned');
  const changed = JSON.parse(calls[0].value.postData);
  assert.deepEqual(changed, {...snapshot, audio_config: {input: {sample_rate: 16000}, other: 'retained',
    output: {audio_routing: 'data_only', max_chunk_duration_ms: 100, add_wav_header: false, unrelated: 9}}});
  assert.equal(original.audio_config.output.audio_routing, 'both');
});

test('text-only and anonymous connections retain their explicit identity and voice state', async () => {
  const f = await fixture({characterId: identity.characterId, endUserId: null, ttsEnabled: false});
  const original = body(); delete original.end_user_id; original.default_tts_enabled = false;
  const calls = await f.request(original), changed = JSON.parse(calls[0].value.postData);
  assert.equal(changed.default_tts_enabled, false); assert.equal(changed.default_stt_enabled, true);
  assert.equal(Object.hasOwn(changed, 'end_user_id'), false);
  assert.deepEqual(changed.audio_config.output, {audio_routing: 'data_only', max_chunk_duration_ms: 100, add_wav_header: false});
});

test('other URLs and methods are passed through without reading or changing their body', async () => {
  const f = await fixture();
  for (const options of [{url: endpoint + '?other=1'}, {url: endpoint + '/'} ,
    {url: 'https://api.convai.com/character/getResponse'}, {url: 'https://live.convai.com/connect'},
    {url: 'https://example.test/connect'},
    {method: 'GET'}, {method: 'OPTIONS'}])
    assert.deepEqual(await f.request(null, {...options, raw: '{malformed'}), [{method: 'continue'}]);
});

test('malformed or foreign owned requests fail closed with no body in errors or diagnostics', async () => {
  const f = await fixture();
  const cases = [null, [], 2, {x: 'private-placeholder'}, {...body(), character_id: 'foreign'},
    {...body(), end_user_id: 'foreign'}, {...body(), end_user_id: undefined},
    {...body(), transport: 'websocket'}, {...body(), default_tts_enabled: false},
    {...body(), audio_config: []}, {...body(), audio_config: null},
    {...body(), audio_config: {output: []}}, {...body(), audio_config: {output: null}}];
  for (const value of cases) assert.deepEqual(await f.request(value), [{method: 'abort', reason: 'failed'}]);
  for (const raw of ['{private-placeholder', 'x'.repeat(1048577), null])
    assert.deepEqual(await f.request(null, {raw}), [{method: 'abort', reason: 'failed'}]);
});

test('a revoked page owner cannot start another provider connection', async () => {
  const f = await fixture();
  assert.equal((await f.request())[0].method, 'continue');
  f.setOwner(undefined);
  assert.deepEqual(await f.request(), [{method: 'abort', reason: 'failed'}]);
  f.setOwner({...identity, characterId: 'replacement'});
  assert.deepEqual(await f.request(), [{method: 'abort', reason: 'failed'}]);
});

test('closing a page revokes its connect identity before SDK teardown starts', async () => {
  const host = new RealtimeHost(); let close;
  const page = {isClosed: () => false, evaluate: async () => {
    assert.equal(host.connectOwners.has(page), false);
    await new Promise(resolve => { close = resolve; });
  }};
  host.connectOwners.set(page, {...identity});
  const stopped = host.disconnectPage(page);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.connectOwners.has(page), false);
  close(); await stopped;
});
