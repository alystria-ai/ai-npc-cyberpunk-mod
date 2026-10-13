import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {WORLD, runLua} from '../../bridge/addon-lua-harness.mjs';
import {ADDON_MANIFEST, AddonHost, fixedProvider, sharedMemory, validateManifest} from '../../bridge/addons.mjs';
import {parseInput} from '../../bridge/protocol.mjs';
import {PersonaBook, joinBlocks} from '../../bridge/mistral-prompt.mjs';
import {TextProviderHost, mistralRoute} from '../../bridge/text-provider-host.mjs';
import {MistralMemory} from '../../bridge/mistral-memory.mjs';
import {evaluateScript, llmJudge, parseScript} from '../../bridge/addon-eval.mjs';

// The example add-on end to end, with no game, no network and no sound: its CET Lua registers through GetMod against the real
// mod/addons.lua, a fight makes one remark, and the request it writes is answered by the bridge side (protocol, add-on host,
// persona mode, text host on a stand-in Mistral) exactly as the bridge does it.
const dir = fileURLToPath(new URL('.', import.meta.url));
const exampleLua = readFileSync(new URL('./init.lua', import.meta.url), 'utf8');

function playFight() {
  const out = runLua(`${WORLD}
    M.attach(host)
    local events = {}
    function registerForEvent(name, fn) events[name] = fn end
    function GetMod(name) if name == 'CyberpunkConvai' then return {addons = M.public} end return nil end
    local Example = (function() ${exampleLua} end)()
    events.onInit()
    assert(Example.handle ~= nil and M.isSpeaker('addon-example-voice'))
    tick()
    assert(#submitted == 0, 'no remark before the fight')
    state.sample = {available = true, combat = true, tier = 1, vehicle = false}
    tick()
    assert(#submitted == 1, 'one remark when the fight starts')
    tick(0.6)                            -- the state file is written at most twice a second
    return json.encode(submitted[1].context) .. '\\n' .. files['runtime/addon-state.json']
  `);
  const [request, state] = out.split('\n');
  return {request, state};
}

test('the example registers a speaker and makes one remark when a fight starts', () => {
  const {request, state} = playFight();
  const context = JSON.parse(request);
  assert.equal(context.profileKey, 'addon-example-voice');
  assert.equal(context.voiceOnly, true);
  assert.deepEqual(context.reaction.kind, 'addon');
  assert.equal(context.addon.event, 'combat-start');
  assert.equal(context.addon.mode, 'dry', 'the personality setting chose the mode');
  const doc = JSON.parse(state);
  assert.deepEqual(doc.addons.example.modes, {voice: 'dry'});
  assert.equal(doc.addons.example.warm.speaker, 'voice', 'the fight warmed the speaker');
});

test('the bridge answers the example remark: the protocol, the mode persona, the hook blocks, Mistral only, one line', async () => {
  const {request, state} = playFight();
  const input = parseInput(request);
  assert(input, 'the request passes the protocol');
  const manifest = validateManifest(JSON.parse(await readFile(new URL(`./${ADDON_MANIFEST}`, import.meta.url), 'utf8')), dir);
  const host = new AddonHost({addons: [manifest], startedAt: 0});
  await host.loadModules();
  host.observeState(state);
  const roster = [];
  const ids = {};
  host.extend(roster, ids);
  assert.deepEqual(ids, {}, 'no Convai character');
  assert.equal(host.routeFor(input.profileKey, {applied: 'convai', mistralKey: true, localReady: false}), 'mistral');
  assert.equal(host.routeFor(input.profileKey, {applied: 'convai', mistralKey: false, localReady: false}), null);
  host.beginTurn(input);
  const sent = [];
  const chat = async ({messages}) => { sent.push(messages); return {text: 'Oh good. More gunfire.', model: 'stand-in', finishReason: 'stop'}; };
  const provider = {apiKey: 'stand-in-key', noteSuccess() {}, noteLimit() {}, limit: null};
  const text = new TextProviderHost({provider: fixedProvider(provider, 'mistral'), memory: sharedMemory(await MistralMemory.open({path: null})),
    personas: new PersonaBook(roster), routes: {mistral: mistralRoute({provider, chat, gapMs: 0})}});
  const blocks = host.blocks(input);
  const parts = Object.fromEntries(['now', 'notes', 'world', 'volatile'].map(tier => [tier, joinBlocks(blocks.filter(b => b.tier === tier).map(b => b.text))]));
  const reply = await text.reply({text: host.trigger(input), reaction: input.reaction, context: '', contextParts: {...parts, worldBlocks: []},
    local: {profileKey: input.profileKey, name: 'Echo', channel: 'private'}});
  assert.equal(reply.text, 'Oh good. More gunfire.');
  assert.equal(sent.length, 1);
  const prompt = sent[0].map(message => message.content).join('\n');
  assert.match(prompt, /You are Echo, a voice in V's earpiece\./);
  assert.match(prompt, /Dry, deadpan/);
  assert.doesNotMatch(prompt, /Bright, encouraging/);
  assert.match(prompt, /A fight has just started\. You hear it through V's audio/, 'the bridge module\'s block');
  assert.match(prompt, /React as Echo with one short spoken line of at most 10 words/);
  assert.equal(host.review(input, reply.text).duplicate, false);
  host.afterReply(input, reply.text);
  assert.equal(host.review(input, 'oh good, more gunfire').duplicate, true, 'the same remark next time is dropped');
});

test('the example evaluation script runs offline with a judge, and a repeated line is dropped', async () => {
  const script = await readFile(new URL('./eval/combat.json', import.meta.url), 'utf8');
  assert.equal(parseScript(script).steps.length, 5);
  assert.throws(() => parseScript({speaker: 'voice', steps: [{event: 'x', say: 'y'}]}), /either "event" or "say"/);
  const lines = ['Oh good. Gunfire. My favourite genre.', 'Ninety-five seconds. Practically a nap.', 'Adequately. Do not let it go to your head.',
    'Oh good. Gunfire. My favourite genre.', 'Oh good. Gunfire. My favourite genre.', 'Forty seconds! A new record, V!'];
  // The fourth step repeats the first line, so the host asks once more (host.produce); the model repeats it again (the second entry),
  // so the remark is still dropped.
  let index = 0;
  const chat = async ({messages}) => {
    if (messages[0].content.startsWith('You judge one spoken line')) return {text: '{"score": 7, "inCharacter": true, "fresh": true, "notes": "Dry and short."}'};
    return {text: lines[index++], model: 'stand-in', finishReason: 'stop'};
  };
  const result = await evaluateScript({addonDir: dir, script, chat, judge: llmJudge({chat, apiKey: 'stand-in-key'})});
  assert.equal(result.steps.length, 5);
  assert.deepEqual(result.steps.map(step => step.mode), ['dry', 'dry', 'dry', 'cheerful', 'cheerful']);
  assert.equal(result.steps[3].retried, true, 'a repeated remark gets one more try');
  assert.equal(result.steps[3].duplicate, true, 'the fourth line repeats the first, even on the second try, and is dropped');
  assert.equal(result.steps[4].line, 'Forty seconds! A new record, V!');
  assert.equal(result.duplicates, 1);
  assert.equal(result.steps[0].verdict.score, 7);
  assert.equal(result.average, 7);
});
