import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {TextProviderHost, mistralRoute, promptUsage} from './text-provider-host.mjs';
import {MistralMemory} from './mistral-memory.mjs';
import {MistralProvider} from './mistral-key.mjs';
import {PersonaBook} from './mistral-prompt.mjs';

const roster = JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8'));

test('promptUsage reads the OpenAI-style and Gemini field names, bounds the cached count and says nothing when there is no count', () => {
  assert.deepEqual(promptUsage({prompt_tokens: 6000, prompt_tokens_details: {cached_tokens: 5200}}), {total: 6000, cachedTokens: 5200, newTokens: 800});
  assert.deepEqual(promptUsage({prompt_tokens: 6000}), {total: 6000, cachedTokens: 0, newTokens: 6000});
  assert.deepEqual(promptUsage({promptTokenCount: 4000, cachedContentTokenCount: 3000}), {total: 4000, cachedTokens: 3000, newTokens: 1000});
  assert.deepEqual(promptUsage({input_tokens: 3000, input_tokens_details: {cached_tokens: 2048}}), {total: 3000, cachedTokens: 2048, newTokens: 952});
  assert.deepEqual(promptUsage({prompt_tokens: 3000, prompt_cache_hit_tokens: 1000}), {total: 3000, cachedTokens: 1000, newTokens: 2000});
  assert.deepEqual(promptUsage({prompt_tokens: 100, prompt_tokens_details: {cached_tokens: 900}}), {total: 100, cachedTokens: 100, newTokens: 0}, 'never more cached than the prompt');
  assert.deepEqual(promptUsage({prompt_tokens: 100, prompt_tokens_details: {cached_tokens: -5}}), {total: 100, cachedTokens: 0, newTokens: 100});
  for (const none of [undefined, null, {}, {prompt_tokens: 0}, {prompt_tokens: 'many'}, 'x']) assert.equal(promptUsage(none), null);
});

test('a cloud turn logs how much of its prompt the provider answered from its prefix cache', async () => {
  const usages = [{prompt_tokens: 4200, prompt_tokens_details: {cached_tokens: 0}}, {prompt_tokens: 4300, prompt_tokens_details: {cached_tokens: 3900}}, {prompt_tokens: 100}];
  let count = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.write(`data: ${JSON.stringify({choices: [{index: 0, delta: {content: 'Sure thing, V.'}}]})}\n\n`);
      response.end(`data: ${JSON.stringify({choices: [{delta: {}, finish_reason: 'stop'}], usage: usages[Math.min(count++, usages.length - 1)]})}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => 'api-key=aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL\n', writeText: async () => {}});
  await provider.load(); provider.setPreference('mistral'); provider.apply();
  const logs = [];
  const route = mistralRoute({provider, endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, gapMs: 0, cacheScope: 's'});
  const host = new TextProviderHost({provider, memory: await MistralMemory.open({path: null}), personas: new PersonaBook(roster), routes: {mistral: route}, log: line => logs.push(line)});
  try {
    for (const text of ['one', 'two', 'three']) await host.reply({text, context: 'CURRENT PERSON', sessionId: 's', local: {profileKey: 'judy-alvarez', name: 'Judy Alvarez', channel: 'private'}});
    const lines = logs.filter(line => line.startsWith('[CloudTurn]'));
    assert.equal(lines.length, 3, logs.join('\n'));
    assert.match(lines[0], /prompt 4200 new \+ 0 cached tokens \(0% from the provider's prefix cache\)/);
    assert.match(lines[1], /prompt 400 new \+ 3900 cached tokens \(91% from/);
    assert.match(lines[2], /prompt 100 new \+ 0 cached tokens/);
  } finally { host.close(); await new Promise(done => { server.closeAllConnections?.(); server.close(done); }); }
});

test('a cloud Custom endpoint is asked for the prompt usage in the closing chunk, a server on this computer is not', async () => {
  const {customRoute} = await import('./text-provider-host.mjs');
  const {CustomEndpoint, parseEndpointUrl} = await import('./custom-endpoint.mjs');
  const route = async url => { const custom = new CustomEndpoint({path: null}); await custom.setUrl(parseEndpointUrl(url)); await custom.setModel('m'); return customRoute({provider: null, custom}); };
  assert.deepEqual((await route('https://generativelanguage.googleapis.com/v1beta/openai')).cacheBody('judy-alvarez'), {stream_options: {include_usage: true}});
  assert.deepEqual((await route('http://localhost:11434/v1')).cacheBody('judy-alvarez'), {});
});
