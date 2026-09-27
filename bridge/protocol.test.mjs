import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseInput, profileFor} from './protocol.mjs';

const turn = {requestId: '1790540998-1-10969620ULL', generation: 1, entity: '10969620ULL',
  name: 'Alena Xenakis', bodyType: 'WomanAverage', profileKey: 'alex', text: 'hey\nhow are you?'};
test('a game display-name alias and multiline input retain managed identity', () => {
  const parsed = parseInput(JSON.stringify(turn));
  assert.equal(parsed.text, turn.text);
  assert.equal(profileFor(parsed, [{key: 'resident-female'}, {key: 'alex'}]).key, 'alex');
});
test('an unconfigured named companion cannot become a generic resident', () => {
  assert.equal(profileFor(turn, [{key: 'resident-female'}]), undefined);
});
test('reject corrupt, mismatched, empty and oversized requests', () => {
  for (const raw of ['broken', 'null', '[]', JSON.stringify({...turn, generation: 2}),
    JSON.stringify({...turn, text: ' '}), JSON.stringify({...turn, text: 'a'.repeat(1201)}),
    JSON.stringify({...turn, profileKey: null}), JSON.stringify({...turn, entity: 42})]) {
    assert.equal(parseInput(raw), null);
  }
});
