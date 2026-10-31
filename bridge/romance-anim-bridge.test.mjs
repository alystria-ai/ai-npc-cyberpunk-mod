import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {screenRomanceAnim} from './romance-anim-intent.mjs';
import {RomanceAnimRequests} from './romance-anim-requests.mjs';

// The talk side of the romance animations: which of V's lines ask for a pair, and the request file the game reads.

test('plain asks for each kind are read, in order of clarity', () => {
  const cases = [
    ['kiss me', 'kiss'], ['Can I kiss you?', 'kiss'], ['give me a kiss', 'kiss'], ['I want to kiss you', 'kiss'],
    ['hug me', 'hug'], ['Give me a hug, Judy', 'hug'], ['can I hug you', 'hug'], ['I need a hug', 'hug'],
    ['hold my hand', 'hands'], ['let’s hold hands', 'hands'],
    ['sit with me', 'sit'], ['come sit next to me', 'sit'], ["let's sit down together", 'sit'],
    ['cuddle with me', 'cuddle'], ['hold me', 'cuddle'], ["let's snuggle", 'cuddle'],
    ['lie down with me', 'lie'], ["let's lie down together", 'lie'], ['come lay next to me', 'lie'],
    ['stop hugging', 'stop'], ["let's get up", 'stop'], ["ok that's enough", 'stop'],
  ];
  for (const [line, kind] of cases) assert.equal(screenRomanceAnim(line), kind, line);
  // a kiss beats a hug in one line, a stop beats everything
  assert.equal(screenRomanceAnim('hug me and kiss me'), 'kiss');
  assert.equal(screenRomanceAnim('stop kissing me, hug me instead'), 'stop');
});

test('talk about other things, other people, refusals and questions about the weather start nothing', () => {
  for (const line of ['', '   ', '[Microphone]', 'how is it going', 'what do you think of the job', 'kiss my ass', 'kiss off', 'give the kiss of death',
    "don't kiss me", 'I would never hug you', 'no cuddling please', 'she kissed him at the party', 'Johnny hugged Kerry', 'sit down', 'sit over there',
    "let's go", 'lie to them', 'he told me to lie low', 'hold the door', 'hold on a second', 'I love you', 'be my girlfriend']) {
    assert.equal(screenRomanceAnim(line), null, line);
  }
  assert.equal(screenRomanceAnim(null), null);
  assert.equal(screenRomanceAnim(undefined), null);
});

test('a request is written only for a partner and only for a plain ask', () => {
  const files = [];
  const logs = [];
  const make = () => new RomanceAnimRequests({path: 'runtime/romance-anim.json', write: async (file, text) => files.push({file, text}), log: line => logs.push(line), now: () => 1000});
  const requests = make();
  assert.equal(requests.afterTurn('judy-alvarez', 'kiss me', false), null, 'not a partner');
  assert.equal(requests.afterTurn('judy-alvarez', 'how are you', true), null, 'no ask');
  assert.equal(requests.afterTurn('', 'kiss me', true), null);
  assert.equal(requests.afterTurn('judy-alvarez', 'kiss me', undefined), null, 'an unknown partner state is not a partner');
  assert.equal(files.length, 0);
  const first = requests.afterTurn('judy-alvarez', 'give me a hug', true);
  assert.deepEqual({profileKey: first.profileKey, kind: first.kind}, {profileKey: 'judy-alvarez', kind: 'hug'});
  const second = requests.afterTurn('judy-alvarez', 'sit with me', true);
  assert.ok(second.id > first.id, 'ids only grow');
  return new Promise(resolve => setImmediate(resolve)).then(() => {
    const last = JSON.parse(files.at(-1).text);
    assert.equal(last.version, 1);
    assert.deepEqual(last.requests.map(request => request.kind), ['hug', 'sit']);
    assert.equal(files.at(-1).file, 'runtime/romance-anim.json');
    // eight at most are kept
    for (let i = 0; i < 12; i++) requests.afterTurn('judy-alvarez', 'hug me', true);
    assert.equal(requests.status().requests.length, 8);
  });
});

test('a bridge that restarts never reuses an id the game has seen', () => {
  let clock = 5000;
  const requests = new RomanceAnimRequests({path: null, now: () => clock});
  const a = requests.afterTurn('judy-alvarez', 'hug me', true);
  clock = 9000;
  const later = new RomanceAnimRequests({path: null, now: () => clock}).afterTurn('judy-alvarez', 'hug me', true);
  assert.ok(later.id > a.id);
});

test('the bridge hands the request over after a reply and only through the guarded call', () => {
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /import \{RomanceAnimRequests\} from '\.\/romance-anim-requests\.mjs'/);
  assert.match(bridge, /function publishRomanceAnim\(input, result\) \{\s*if \(!input \|\| input\.reaction \|\| input\.head \|\| input\.group \|\| input\.channel === 'phone'/);
  assert.match(bridge, /romanceOf\(selection, RELATIONSHIP_PROFILES\) === 'partner'/);
  assert.match(bridge, /function publishBonds\(input, result, proposal = null\) \{\s*(?:noteOwnReply\(input, result\);\s*)?publishRomanceAnim\(input, result\);/);
});

test('the request file is classified as a runtime exchange file and the pair table ships', () => {
  const exchange = JSON.parse(readFileSync(new URL('../packaging/runtime-exchange.json', import.meta.url), 'utf8'));
  assert.ok(exchange.exchange.includes('romance-anim.json'));
  for (const file of ['packaging/release-plan.json', 'scripts/development-files.json']) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const name of ['romance-anim.lua', 'romance-pairs.lua', 'gesture-workspot.lua']) assert.ok(text.includes(`mod/${name}`), `${file} ships ${name}`);
  }
  assert.ok(existsSync(new URL('../r6/scripts/CyberpunkConvai/RomanceConfirm.reds', import.meta.url)));
});
