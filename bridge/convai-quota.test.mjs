import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classifyFailure, QuotaWatch} from './convai-quota.mjs';

const keys = source => ({source});

test('failures are classified by their message only', () => {
  const kinds = [
    ['Convai usage limit reached [convai-quota:interaction]', 'quota'],
    ['Convai usage limit reached [convai-quota:tts]', 'quota'],
    ['Convai usage limit reached [convai-quota:plan]', 'quota'],
    ['You have exceeded usage limits for your plan', 'quota'],
    ['LTM speaker limit reached', 'speaker'], ['speaker limit reached', 'speaker'],
    ['LTM speaker allowance is not configured for this plan', 'speaker'],
    ['Missing end_user_id. end_user_id is required when the character has Long Term Memory enabled. Provide end_user_id or disable Long Term Memory.', 'memory'],
    ['Realtime access not allowed', 'rejected'],
    ['Concurrency limit reached', 'busy'],
    ['Invalid API key', 'rejected'],
    ['HTTP 404', null], ['Invalid Convai data message', null], ['', null], [undefined, null],
  ];
  for (const [text, expected] of kinds) assert.equal(classifyFailure(Error(text ?? '')), expected, String(text));
  assert.equal(classifyFailure('Invalid API key'), 'rejected');
  assert.equal(classifyFailure({name: 'AbortError', message: 'usage limit reached'}), null);
  assert.equal(classifyFailure(null), null);
});

test('a used-up shared plan and a used-up own key give different notice codes', () => {
  const quotaError = Error('Convai usage limit reached [convai-quota:interaction]');
  for (const [source, code] of [['shared', 'quota-shared'], ['player', 'quota-own']]) {
    const watch = new QuotaWatch({keys: keys(source)});
    assert.equal(watch.codeFor(quotaError), code);
    assert.equal(watch.codeFor(Error('Concurrency limit reached')), undefined);
    assert.equal(watch.codeFor(Error('HTTP 500')), undefined);
  }
});

test('a refused key is reported only for the player\'s own key', () => {
  const rejected = Error('Invalid API key');
  assert.equal(new QuotaWatch({keys: keys('player')}).codeFor(rejected), 'key-rejected');
  assert.equal(new QuotaWatch({keys: keys('shared')}).codeFor(rejected), undefined);
});

test('a later failure that lost its text still maps to a recent limit, an old one does not', () => {
  let now = 1000;
  const watch = new QuotaWatch({keys: keys('shared'), now: () => now});
  assert.equal(watch.observe(Error('Convai usage limit reached [convai-quota:tts]')), 'quota');
  assert.equal(watch.codeFor(Error('Voice conversation failed')), 'quota-shared');
  now += 20000;
  assert.equal(watch.codeFor(Error('Voice conversation failed')), undefined);
});

test('the limit is remembered for the settings page until a reply succeeds or the key changes', () => {
  const changes = [];
  const watch = new QuotaWatch({keys: keys('player'), onChange: () => changes.push(watch.snapshot())});
  assert.equal(watch.snapshot(), null);
  watch.observe(Error('HTTP 500'));
  assert.equal(watch.snapshot(), null);
  watch.observe(Error('Convai usage limit reached [convai-quota:interaction]'));
  assert.deepEqual(watch.snapshot(), {state: 'used-up', own: true, kind: 'quota'});
  watch.succeeded();
  assert.equal(watch.snapshot(), null);
  watch.observe(Error('Invalid API key'));
  assert.deepEqual(watch.snapshot(), {state: 'rejected', own: true});
  watch.clear(); watch.clear();
  assert.equal(watch.snapshot(), null);
  assert.equal(changes.length, 4, 'one change per real transition');
});

test('a speaker limit is never reported as a used-up plan', () => {
  for (const source of ['shared', 'player']) {
    const changes = [];
    const watch = new QuotaWatch({keys: keys(source), onChange: () => changes.push(1)});
    const error = Error('LTM speaker limit reached');
    assert.equal(watch.observe(error), 'speaker');
    assert.equal(watch.snapshot(), null, 'the settings page must not say the plan is used up');
    assert.equal(changes.length, 0);
    assert.notEqual(watch.codeFor(error), 'quota-own'); assert.notEqual(watch.codeFor(error), 'quota-shared');
  }
  // An unrecovered speaker limit on a player's key says memory, on the shared key nothing special.
  assert.equal(new QuotaWatch({keys: keys('player')}).codeFor(Error('LTM speaker limit reached')), 'key-memory');
  assert.equal(new QuotaWatch({keys: keys('shared')}).codeFor(Error('LTM speaker limit reached')), undefined);
});

test('a key that needs an identity it cannot have is its own state and code', () => {
  const watch = new QuotaWatch({keys: keys('player')});
  const error = Error('Missing end_user_id. end_user_id is required when the character has Long Term Memory enabled.');
  assert.equal(watch.observe(error), 'memory');
  assert.deepEqual(watch.snapshot(), {state: 'memory-needed', own: true});
  assert.equal(watch.codeFor(error), 'key-memory-needed');
  watch.succeeded();
  assert.equal(watch.snapshot(), null);
  assert.equal(new QuotaWatch({keys: keys('shared')}).codeFor(error), undefined);
});
