import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {LANGUAGES, parseAmountIn, warmLanguagesNow} from './eddies-languages.mjs';
import {screenWords} from './eddies.mjs';

warmLanguagesNow();   // the bridge warms the grammars in the background; a test reads at once

// Money asks in the menu languages other than English (docs/EDDIES.md "Languages"): per language a set of real asks (intent and sum), near-misses
// (idioms, other uses of the same verbs, refusals, the past and the future: no intent allowed) and sums in that language's number words and digits.
// bridge/eddies-languages/<code>.cases.json holds `dev` (the grammar was written and tuned on it), `held` (written first, looked at once, then fixed for
// general rules) and `blind` (written by someone who never saw the grammar, then used for a second tuning round, so it is training data by now);
// <code>.blind2.json is the honest exam: a fresh set read once, before any tuning on it (docs/EDDIES.md has its first-run numbers). Near-misses in every set
// must stay at zero false offers; the exam set only guards against a recall regression (the floor is below the first-run 76%).
// The near-misses must give no intent at all: every transfer still needs V's Yes, but a false offer is noise.
const sets = code => {
  const file = new URL(`./eddies-languages/${code}.cases.json`, import.meta.url);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
};

for (const code of LANGUAGES) {
  test(`${code}: asks, near-misses and sums`, t => {
    const cases = sets(code);
    assert.ok(cases, `${code}.cases.json`);
    const report = [];
    const exam = new URL(`./eddies-languages/${code}.blind2.json`, import.meta.url);
    if (existsSync(exam)) cases.blind2 = JSON.parse(readFileSync(exam, 'utf8'));
    for (const name of ['dev', 'held', 'blind', 'blind2']) {
      const set = cases[name] ?? {asks: [], near: [], amounts: []};
      const missed = [], falseOffers = [], wrongSums = [];
      for (const [text, intent, amount] of set.asks) {
        const screen = screenWords(text);
        if (screen.intent !== intent || (screen.amount ?? null) !== amount) missed.push(`${text} => ${screen.intent}:${screen.amount ?? null} (want ${intent}:${amount})`);
      }
      for (const text of set.near) {
        const screen = screenWords(text);
        if (screen.intent) falseOffers.push(`${text} => ${screen.intent}:${screen.amount ?? null}`);
      }
      for (const [text, amount] of set.amounts) {
        const got = parseAmountIn(code, text.normalize('NFKC').toLowerCase());
        if (got !== amount) wrongSums.push(`${text} => ${got} (want ${amount})`);
      }
      report.push(`${name}: asks ${set.asks.length - missed.length}/${set.asks.length}, near-misses ${set.near.length - falseOffers.length}/${set.near.length} clean, sums ${set.amounts.length - wrongSums.length}/${set.amounts.length}`);
      assert.deepEqual(falseOffers, [], `${code} ${name}: false offers`);
      assert.ok(missed.length <= Math.floor(set.asks.length * (name === 'blind2' ? 0.4 : 0.15)), `${code} ${name}: asks missed\n${missed.join('\n')}`);
      assert.ok(wrongSums.length <= Math.floor(set.amounts.length * 0.1), `${code} ${name}: sums wrong\n${wrongSums.join('\n')}`);
    }
    t.diagnostic(report.join(' | '));
  });
}

// English chatter must not wake any other language's grammar: shared words ("ten", "toma", "pago") and numbers are not money asks.
test('English lines and street slang give no foreign intent', () => {
  const lines = JSON.parse(readFileSync(new URL('./eddies-languages.english.json', import.meta.url), 'utf8'));
  const wrong = lines.map(text => [text, screenWords(text)]).filter(([, screen]) => screen.intent).map(([text, screen]) => `${text} => ${screen.intent}:${screen.amount ?? null}`);
  assert.deepEqual(wrong, []);
});

// The warm-up is stall-free: no single slice of work (building or first-running one regular expression) blocks the event loop for long. Measured on a quiet
// machine the worst slice is 3 to 6 ms; the bound here leaves room for a busy one. warmLanguagesNow ran every language already (top of this file), so this
// warms a second set of rules in a child process.
test('warming a language takes small slices', () => {
  const script = `
    const m = await import(${JSON.stringify(new URL('./eddies-languages.mjs', import.meta.url).href)});
    const worst = {};
    for (const code of m.LANGUAGES) { let max = 0; m.warmLanguagesNow([code], ms => { max = Math.max(max, ms); }); worst[code] = max; }
    console.log(JSON.stringify(worst));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {encoding: 'utf8'});
  const worst = JSON.parse(out.trim().split('\n').pop());
  const slow = Object.entries(worst).filter(([, ms]) => ms > 30);
  assert.deepEqual(slow, [], `slices over 30 ms: ${JSON.stringify(worst)}`);
});

// Only the languages that matter are compiled: a typed line in Spanish warms Spanish (and nothing else), the line itself is read in English only, the next
// ones by the Spanish grammar. A line in a language that is not warm never goes through another language's grammar.
test('a language warms on demand, in the background, and only that one', () => {
  const script = `
    const e = await import(${JSON.stringify(new URL('./eddies.mjs', import.meta.url).href)});
    const m = await import(${JSON.stringify(new URL('./eddies-languages.mjs', import.meta.url).href)});
    const first = e.screenWords('Hermano, me prestas quinientos eddies para el ripperdoc?');
    m.warmFor('Hermano, me prestas quinientos eddies para el ripperdoc?');
    const before = m.LANGUAGES.filter(code => m.isWarm(code));
    await new Promise(resolve => setTimeout(resolve, 400));
    const later = e.screenWords('Hermano, me prestas quinientos eddies para el ripperdoc?');
    const other = e.screenWords('500エディ貸してくれない？');
    console.log(JSON.stringify({first: first.intent, before, warm: m.LANGUAGES.filter(code => m.isWarm(code)), later: [later.intent, later.amount], other: other.intent}));`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {encoding: 'utf8'}).trim().split('\n').pop());
  assert.equal(result.first, null, 'the first line is read in English only');
  assert.deepEqual(result.before, [], 'nothing is compiled inside the call');
  assert.deepEqual(result.warm, ['es'], 'only the line\'s own language warms');
  assert.deepEqual(result.later, ['borrow', 500]);
  assert.equal(result.other, null, 'Japanese is not warm: that line is not read by any other grammar');
});
