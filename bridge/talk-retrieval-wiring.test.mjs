// The bridge's wiring of talk retrieval (docs/NATURAL_TALK_RESEARCH_2026-10-30.md, section 15), read from its source: where the turn's background is chosen, in what order, and that
// nothing of it runs outside a turn (no timer, no per-frame work) or in the game.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
const host = readFileSync(new URL('./text-provider-host.mjs', import.meta.url), 'utf8');
const at = (text, needle, from = 0) => { const index = text.indexOf(needle, from); assert.ok(index >= 0, `missing: ${needle}`); return index; };

test('one switch puts the whole blocks back: the persona book and the retrieval follow CYBERPUNK_CONVAI_TALK_RETRIEVAL', () => {
  assert.match(source, /const talkRetrievalOn = String\(process\.env\.CYBERPUNK_CONVAI_TALK_RETRIEVAL \?\? ''\)\.trim\(\)\.toLowerCase\(\) !== 'off';/);
  assert.match(source, /new PersonaBook\(roster, \{lean: true, [^;]*topics: talkRetrievalOn\}\)/);
  assert.match(source, /const retrievalFor = input => talkRetrievalOn && /);
  assert.match(source, /function startConvaiRetrieval\(input, signal\) \{\r?\n  if \(!talkRetrievalOn \|\| mistral\.active/);
});

test('the memory embedder and the memory search\'s vector are the ones the retrieval uses', () => {
  assert.match(source, /new TalkRetrieval\(\{embedder: localEmbedder, queryVector: \(text, options\) => mistralMemory\.queryVector\(text, options\)/);
  assert.match(source, /vectorsPath: resolve\(stateDirectory, 'talk-vectors\.json'\)/);
});

test('text providers: the config carries the retrieval; the host runs it beside the memory search once V\'s words are known', () => {
  assert.match(source, /\.\.\.\(mistral\.active \? \{contextParts: contextPartsOf\(blocks\), \.\.\.retrievalFor\(input\)\} : \{\}\)/);
  const asking = at(host, 'const asking = config.contextParts && typeof config.retrieval?.run');
  const memory = at(host, 'remembered = await this.memory.retrieve', asking);
  const applied = at(host, 'withRetrievedParts(config.contextParts, result)', memory);
  assert.ok(asking < memory && memory < applied, 'started before the memory search, applied after both are in');
  assert.match(host, /markStage\('retrieved'\)/);
});

test('Convai: a typed turn chooses its background beside the memory admission and before its context is built; a spoken one keeps the whole blocks', () => {
  const run = at(source, 'async function runInput(request, prepared, clock) {');
  const start = at(source, 'const retrieving = startConvaiRetrieval(input, controller.signal);', run);
  const admit = at(source, 'const admission = await admitPlayerConversation(knowledgeTurn', start);
  const wait = at(source, 'await retrieving;', admit);
  const config = at(source, 'const turnRoute = realtimeConfig(input)', wait);
  assert.ok(start < admit && admit < wait && wait < config);
  const fn = source.slice(at(source, 'function startConvaiRetrieval'), at(source, 'function startConvaiRetrieval') + 900);
  for (const guard of ['input.reaction', 'input.event', "input.source === 'microphone'", 'MIC_PLACEHOLDER', 'isAmbientProfile(input.profileKey)']) assert.ok(fn.includes(guard), guard);
});

test('the vectors are made when a text-provider talk opens and once for the roster, in the background, and kept on exit', () => {
  const warm = source.slice(at(source, 'function warmTalkTargets'), at(source, 'function warmTalkTargets') + 1600);
  assert.match(warm, /talkRetrieval\.warmFor\(profileKeys\[0\]\); scheduleTalkFill\(\)/);
  const fill = source.slice(at(source, 'function scheduleTalkFill'), at(source, 'function scheduleTalkFill') + 1200);
  assert.match(fill, /!mistral\.active \|\| !localEmbedder\.available\(\)/);
  assert.match(fill, /gate: memoryQuiet/);
  assert.match(fill, /timer\.unref\?\.\(\)/);
  assert.match(source, /await talkRetrieval\.flush\(\)\.catch\(\(\) => \{\}\);/);
});

test('retrieval makes no per-frame or in-game work: no interval, no file watch and no child process in the module', () => {
  const module = readFileSync(new URL('./talk-retrieval.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['setInterval', 'watchFile', 'fs.watch', 'child_process', 'spawn(', 'requestAnimationFrame']) assert.ok(!module.includes(forbidden), forbidden);
  assert.ok(!/\bimport .*from 'node:(?:child_process|net|http|https)'/.test(module));
});
