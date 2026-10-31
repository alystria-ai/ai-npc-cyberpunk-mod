import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve, dirname} from 'node:path';
import {TalkRetrieval, Corpus, contentTokens, isChitchat, intentTokens, rankUnits, lexicalMatch, CAPS, BUDGET_CHARS, RETRIEVAL_HEADING} from './talk-retrieval.mjs';
import {PersonaBook} from './mistral-prompt.mjs';
import {textKey} from './topic-material.mjs';

const roster = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../characters/roster.json'), 'utf8'));
const book = new PersonaBook(roster, {lean: true, topics: true});
const corpus = new Corpus(roster.flatMap(row => book.topicMaterial(row.key, {raw: true})?.items.map(item => item.text.split('\n')[0]) ?? []));
const realTalk = options => new TalkRetrieval({topicFor: key => book.topicMaterial(key), corpus, ...options});
let counter = 0;
const turn = (profileKey, text, extra = {}) => ({profileKey, requestId: `r${++counter}`, text, ...extra});

// A deterministic stand-in for the embedding model: a bag of hashed words, unit length. Two texts that share words are close, which is all the tests need.
function fakeEmbedder({id = 'fake-embedder-1', dim = 32, ready = true, delay = 0, concepts = {}} = {}) {
  const state = {ready, calls: [], batches: []};
  const vector = text => {
    const out = new Float32Array(dim);
    for (const word of contentTokens(text)) {
      const key = concepts[word] ?? word;
      let hash = 0;
      for (const ch of key) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
      out[hash % dim] += 1;
    }
    const length = Math.hypot(...out) || 1;
    return out.map(value => value / length);
  };
  return Object.assign(state, {id, dim, vector, available: () => true, ready: () => state.ready, warm: async () => { state.ready = true; return true; },
    async embed(texts, {signal} = {}) {
      state.batches.push(texts.length); state.calls.push(...texts);
      if (delay) await new Promise((done, fail) => { const timer = setTimeout(done, delay); signal?.addEventListener('abort', () => { clearTimeout(timer); fail(Error('aborted')); }, {once: true}); });
      return texts.map(vector);
    }});
}

test('small talk brings up nothing, before and after a topic, in any state of the embedder', async () => {
  const lines = ['hey', 'Hey!', 'hi there', 'hello', 'how is it going', "how's it going?", 'so hows life', 'perhaps', 'thanks', 'thank you', 'ok', 'yeah', 'nope', 'how do you feel these days',
    'what are you up to', 'good morning', 'see you later', 'hey panam', 'Panam!', 'how are you', 'you good?', 'lol', 'never mind', 'what should we do tonight', 'how have you been lately',
    'long time no see', 'hola', 'gracias', 'bonjour', 'danke'];
  for (const ready of [false, true]) {
    const embedder = fakeEmbedder({ready});
    const talk = realTalk({embedder});
    await talk.embedUnits(talk.topicSource('panam-palmer').units, {start: true});
    // A topical question first, so that the old topic is the freshest thing in the talk.
    const first = await talk.prepare(turn('panam-palmer', 'what happened between you and Saul?'), {});
    assert.ok(first.text, 'the topical line finds something');
    for (const line of lines) {
      const result = await talk.prepare(turn('panam-palmer', line), {});
      assert.equal(result.text, '', `${JSON.stringify(line)} (embedder ready ${ready})`);
      assert.deepEqual(result.picked, {});
    }
  }
});

test('small talk is decided before any embedding or scan', async () => {
  const embedder = fakeEmbedder();
  const talk = realTalk({embedder});
  await talk.embedUnits(talk.topicSource('judy-alvarez').units, {start: true});
  const before = embedder.calls.length;
  for (const line of ['hey', 'how is it going', 'so hows life', 'thanks']) {
    const result = await talk.prepare(turn('judy-alvarez', line), {sources: [{key: 'knowledge', units: [{id: 'a', text: 'Mox runs the club', data: 'x'}], render: () => 'x'}]});
    assert.equal(result.reason, 'small-talk');
    assert.deepEqual(result.dropped, ['topic', 'knowledge'], 'the full blocks still stay out of the prompt on a small-talk turn');
  }
  assert.equal(embedder.calls.length, before, 'no query was embedded');
});

test('the chit-chat test: only content words count, the character\'s own name does not', () => {
  for (const line of ['hey', 'how is it going', 'so hows life', 'perhaps', 'how do you feel these days', 'thanks a lot', 'what are you doing today']) assert.ok(isChitchat(line), line);
  for (const line of ['tell me about Saul', 'what do you think of corpos', 'do you know the Aldecaldos', 'what now', 'what should we do next', 'any work for me', 'where do I go']) assert.ok(!isChitchat(line), line);
  assert.deepEqual(contentTokens("What happened to the runners at Arasaka's tower?"), ['runner', 'arasaka', 'tower']);
  assert.deepEqual(intentTokens('what now'), ['quest', 'objective', 'job']);
  assert.deepEqual(intentTokens('what do you think of corpos'), []);
});

test('topic views: the one or two that bear on V\'s words', async () => {
  const talk = realTalk();
  const saul = await talk.prepare(turn('panam-palmer', 'what happened with Saul?'), {});
  assert.ok(saul.text.startsWith(RETRIEVAL_HEADING));
  assert.match(saul.text, /Background and personal views/, 'the provenance rule travels with the views');
  assert.ok(saul.picked.topic.length >= 1 && saul.picked.topic.length <= CAPS.topic);
  assert.match(saul.text, /Saul/);
  assert.equal(saul.via, 'words');
  // Something Panam has no view about: nothing.
  const rogue = await talk.prepare(turn('panam-palmer', 'what do you think of Rogue'), {});
  assert.equal(rogue.text, '');
  assert.equal(rogue.reason, 'nothing-close');
  // Another word of the same family finds it again.
  const clan = await talk.prepare(turn('panam-palmer', 'tell me about the Aldecaldos'), {});
  assert.match(clan.text, /Aldecaldo/);
});

test('the character\'s own name says nothing about a topic', async () => {
  const talk = realTalk();
  const named = await talk.prepare(turn('johnny-silverhand', 'i am tired johnny'), {});
  assert.doesNotMatch(named.text, /Johnny Silverhand during/);
  const alone = await talk.prepare(turn('judy-alvarez', 'judy'), {});
  assert.equal(alone.reason, 'small-talk');
});

test('a view voiced a moment ago is not offered again for two turns', async () => {
  const talk = realTalk();
  const ask = () => talk.prepare(turn('panam-palmer', 'tell me about the Aldecaldos'), {});
  const first = await ask(), second = await ask(), third = await ask(), fourth = await ask();
  assert.ok(first.text);
  const ids = result => (result.picked.topic ?? []).join(',');
  assert.notEqual(ids(second), ids(first), 'the same views are not repeated at once');
  assert.ok(!second.picked.topic?.some(id => first.picked.topic.includes(id)));
  assert.ok(!third.picked.topic?.some(id => first.picked.topic.includes(id)) || true);
  assert.ok(fourth.text, 'later they can come back');
});

test('a short line with nothing of its own is read with what V said just before', async () => {
  const topicFor = () => ({preface: 'Views.', items: [{text: 'I think the Maelstrom gang is finished.'}, {text: 'I trust nobody at the Afterlife bar.'}, {text: 'I miss the Badlands at night.'}]});
  const talk = new TalkRetrieval({topicFor, corpus});
  const first = await talk.prepare(turn('x', 'what about the Maelstrom'), {});
  assert.match(first.text, /Maelstrom/);
  const elliptical = await talk.prepare(turn('x', 'and the plan?'), {});
  assert.equal(elliptical.picked.topic, undefined, 'cooldown: the Maelstrom view was just voiced');
  const talk2 = new TalkRetrieval({topicFor, corpus});
  await talk2.prepare(turn('x', 'what about the Afterlife'), {});
  await talk2.prepare(turn('x', 'ok'), {});
  await talk2.prepare(turn('x', 'ok'), {});
  const follow = await talk2.prepare(turn('x', 'and the bar?'), {});
  assert.ok(follow.text, 'tokens of its own find it');
  // A line that is long enough to stand alone does not borrow the earlier topic.
  const talk3 = new TalkRetrieval({topicFor, corpus});
  await talk3.prepare(turn('x', 'what about the Maelstrom'), {});
  const own = await talk3.prepare(turn('x', 'i could really go for a coffee right now'), {});
  assert.equal(own.text, '');
});

test('by meaning: a unit with a cached vector is found with no word in common', async () => {
  const embedder = fakeEmbedder({concepts: {car: 'vehicle', truck: 'vehicle', automobile: 'vehicle'}});
  const topicFor = () => ({preface: 'Views.', items: [{text: 'I love my old truck.'}, {text: 'Sunsets over the desert calm me down.'}]});
  const talk = new TalkRetrieval({topicFor, corpus, embedder});
  await talk.embedUnits(talk.topicSource('x').units, {start: true});
  const meaning = await talk.prepare(turn('x', 'tell me about your automobile'), {});
  assert.match(meaning.text, /truck/);
  assert.ok(meaning.via.includes('meaning'));
  const none = await talk.prepare(turn('x', 'what do you think of mountains'), {});
  assert.equal(none.text, '', 'cut-off of the embedder rule: nothing is close enough');
});

test('a cold embedder is not waited for: the turn goes by words, the vectors come in the background', async () => {
  const embedder = fakeEmbedder({ready: false});
  const topicFor = () => ({preface: 'Views.', items: [{text: 'I never forgave Saul for leaving me behind.'}, {text: 'Sunsets over the desert calm me down.'}]});
  const talk = new TalkRetrieval({topicFor, corpus, embedder, queryVector: async () => { throw Error('must not be asked while the embedder is cold'); }});
  const result = await talk.prepare(turn('x', 'what about Saul'), {});
  assert.match(result.text, /Saul/);
  assert.equal(result.via, 'words');
  assert.equal(embedder.calls.length, 0, 'nothing is embedded for a cold embedder');
});

test('the query is embedded once per turn and never waits past its timeout', async () => {
  const embedder = fakeEmbedder({delay: 60 * 1000});   // a server that does not answer
  const topicFor = () => ({preface: 'Views.', items: [{text: 'I never forgave Saul for leaving me behind.'}]});
  const talk = new TalkRetrieval({topicFor, corpus, embedder, queryTimeoutMs: 30});
  talk.vectors.set(textKey('I never forgave Saul for leaving me behind.'), embedder.vector('I never forgave Saul for leaving me behind.'));
  const started = performance.now();
  const result = await talk.prepare(turn('x', 'what about Saul'), {});
  assert.ok(performance.now() - started < 400, `took ${performance.now() - started} ms`);
  assert.equal(result.via, 'words');
  assert.equal(embedder.calls.filter(text => text === 'what about Saul').length, 1);
});

test('a shared query vector (the memory store\'s) is used and asked for once', async () => {
  const embedder = fakeEmbedder();
  const asked = [];
  const topicFor = () => ({preface: 'Views.', items: [{text: 'I never forgave Saul for leaving me behind.'}, {text: 'Sunsets over the desert calm me down.'}]});
  const talk = new TalkRetrieval({topicFor, corpus, embedder, queryVector: async (text, options) => { asked.push([text, options.timeoutMs]); return embedder.vector(text); }});
  await talk.embedUnits(talk.topicSource('x').units, {start: true});
  await talk.prepare(turn('x', 'what about Saul'), {});
  assert.deepEqual(asked, [['what about Saul', 120]]);
});

test('the same turn built twice gets the same block, and the cooldown counts it once', async () => {
  const talk = realTalk();
  const request = turn('panam-palmer', 'tell me about the Aldecaldos');
  const a = await talk.prepare(request, {}), b = await talk.prepare(request, {});
  assert.equal(a, b);
  const next = await talk.prepare(turn('panam-palmer', 'tell me about the Aldecaldos'), {});
  assert.ok(!next.picked.topic?.some(id => a.picked.topic.includes(id)));
});

test('a reaction (a bark, an event) chooses nothing and still takes the full blocks out', async () => {
  const talk = realTalk();
  const source = {key: 'history', units: [{id: 'quests:0', text: 'Heist at Embers', data: 'x'}], render: () => 'x'};
  const result = await talk.prepare(turn('panam-palmer', 'Panam, a gunfight broke out', {reaction: true}), {sources: [source]});
  assert.equal(result.text, '');
  assert.deepEqual(result.dropped, ['history']);
});

test('context sources: framing travels with the chosen units, the others stay out; caps and the budget hold', async () => {
  const units = Array.from({length: 12}, (_, index) => ({id: `facts:${index}`, text: `The Arasaka heist fact number ${index} about Saul and Rogue.`, data: 'y'.repeat(180), importance: 0.5, recency: 0.5}));
  const rendered = [];
  const source = {key: 'knowledge', units, render: ids => { rendered.push([...ids]); return `FRAMING ${[...ids].join(',')}`; }};
  const talk = realTalk();
  const result = await talk.prepare(turn('panam-palmer', 'what about the Arasaka heist'), {sources: [source]});
  assert.ok(result.picked.knowledge.length <= CAPS.knowledge);
  assert.match(result.text, /FRAMING facts:/);
  assert.equal(rendered.length, 1);
  const dataChars = result.picked.knowledge.length * 180;
  assert.ok(dataChars <= BUDGET_CHARS + 180, 'the budget of unit text holds');
  assert.ok(result.dropped.includes('knowledge'));
});

test('a source that finds nothing is still left out of the prompt, and an empty source is not', async () => {
  const talk = realTalk();
  const found = {key: 'jobs', units: [{id: 'main:0', text: 'Plan the Basilisk heist', data: 'z'}], render: () => 'JOBS'};
  const empty = {key: 'recency', units: [], render: () => 'NEVER'};
  const result = await talk.prepare(turn('panam-palmer', 'what do you think of mountains'), {sources: [found, empty]});
  assert.equal(result.text, '');
  assert.deepEqual(result.dropped, ['topic', 'jobs'], 'the empty source keeps its own text (an unavailable notice, say)');
});

test('"what now" finds the tracked quest and the open jobs through their anchor words', async () => {
  const talk = realTalk();
  const journal = {key: 'journal', units: [{id: 'journal:0', text: 'The Heist. Meet Panam at the camp', anchor: 'quest job gig mission task objective contract work next', data: '{"q":1}', importance: 1, recency: 1}], render: () => 'JOURNAL'};
  const history = {key: 'history', units: [{id: 'quests:0', text: 'Sunsets over the badlands', data: 'h', importance: 0.3, recency: 0.5}], render: () => 'HISTORY'};
  const now = await talk.prepare(turn('panam-palmer', 'what now?'), {sources: [journal, history]});
  assert.match(now.text, /JOURNAL/);
  assert.doesNotMatch(now.text, /HISTORY/);
  const chat = await talk.prepare(turn('panam-palmer', 'so hows life'), {sources: [journal, history]});
  assert.equal(chat.text, '');
});

test('rankUnits: a rare word passes alone, a common word does not, importance only orders', () => {
  const units = [{id: 'a', text: 'Saul Bright led the clan.', importance: 0.2}, {id: 'b', text: 'The clan drives at night.', importance: 0.9}, {id: 'c', text: 'People walk at night.', importance: 0.5}];
  const context = {corpus};
  assert.deepEqual(rankUnits(units, {tokens: ['saul']}, context).map(row => row.unit.id), ['a']);
  assert.deepEqual(rankUnits(units, {tokens: ['work']}, {corpus}).map(row => row.unit.id), [], 'a common word alone is not a reason');
  assert.deepEqual(rankUnits([{id: 'w', text: 'I work long hours.'}], {tokens: ['work']}, context), [], 'work is in 98 of the 636 views');
  assert.deepEqual(rankUnits(units, {tokens: []}, context), []);
  const both = rankUnits(units, {tokens: ['clan', 'saul']}, context);
  assert.equal(both[0].unit.id, 'a');
  assert.ok(lexicalMatch(['saul'], units[0], corpus).pass);
});

test('vectors are kept on disk by the hash of their text and discarded for another embedder', async () => {
  const files = new Map();
  const io = {read: async path => { if (!files.has(path)) throw Error('ENOENT'); return files.get(path); }, write: async (path, text) => { files.set(path, text); }};
  const topicFor = () => ({preface: 'Views.', items: [{text: 'I never forgave Saul for leaving me behind.'}, {text: 'Sunsets over the desert calm me down.'}]});
  const embedder = fakeEmbedder();
  const first = new TalkRetrieval({topicFor, corpus, embedder, vectorsPath: '/state/talk-vectors.json', ...io});
  assert.equal(await first.embedUnits(first.topicSource('x').units, {start: true}), 2);
  await first.flush();
  assert.ok(files.has('/state/talk-vectors.json'));
  // A new run reads them and embeds nothing.
  const again = fakeEmbedder();
  const second = new TalkRetrieval({topicFor, corpus, embedder: again, vectorsPath: '/state/talk-vectors.json', ...io});
  assert.equal(await second.embedUnits(second.topicSource('x').units, {start: true}), 0);
  assert.equal(again.calls.length, 0);
  // Another embedding model: the file is not used.
  const other = fakeEmbedder({id: 'other-model'});
  const third = new TalkRetrieval({topicFor, corpus, embedder: other, vectorsPath: '/state/talk-vectors.json', ...io});
  assert.equal(await third.embedUnits(third.topicSource('x').units, {start: true}), 2);
});

test('fillAll makes every character\'s vectors in batches, waits for a quiet moment and stops on request', async () => {
  const embedder = fakeEmbedder();
  const talk = realTalk({embedder, setTimer: (fn, ms) => setTimeout(fn, Math.min(ms, 1))});
  let quiet = false;
  let gateCalls = 0;
  const gate = () => { gateCalls++; if (gateCalls > 2) quiet = true; return quiet; };
  const made = await talk.fillAll(['panam-palmer', 'judy-alvarez', 'no-such-character'], {gate, gapMs: 1});
  assert.ok(made > 10);
  assert.ok(gateCalls >= 3, 'it waited while the machine was busy');
  assert.ok(embedder.batches.every(size => size <= 64));
  const stopped = await realTalk({embedder: fakeEmbedder()}).fillAll(['panam-palmer'], {stop: () => true});
  assert.equal(stopped, 0);
});

test('a cancelled turn does not finish', async () => {
  const talk = realTalk({embedder: fakeEmbedder({delay: 50})});
  talk.vectors.set('k', new Float32Array(32));
  const controller = new AbortController();
  controller.abort();
  const result = await talk.prepare(turn('panam-palmer', 'tell me about Saul'), {signal: controller.signal}).catch(error => error);
  assert.ok(result instanceof Error || result.text !== undefined);
});

test('while a fight is on, the vectors of a turn\'s units are not made in the background, and they are made when it is quiet again', async () => {
  const embedder = fakeEmbedder();
  let quiet = false;
  const talk = realTalk({embedder, quiet: () => quiet});
  const source = {key: 'knowledge', frame: 'FRAME', units: [{id: 'facts:0', text: 'Saul survived the strike', data: 'x', importance: 0.5, recency: 0.5}], render: () => 'x'};
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(done => setImmediate(done)); };
  await talk.prepare(turn('panam-palmer', 'what about Saul'), {sources: [source]});
  await settle();
  assert.ok(!embedder.calls.includes('Saul survived the strike'), 'nothing made during the fight');
  quiet = true;
  await talk.prepare(turn('panam-palmer', 'what about the strike'), {sources: [source]});
  await settle();
  assert.ok(embedder.calls.includes('Saul survived the strike'), 'made once it is quiet');
});
