import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WORLD, addonsSource, runLua} from './addon-lua-harness.mjs';
import {ADDON_LIMITS} from './addons.mjs';

// handle:stock (mod/addons.lua): the game side of the bridge's prepared lines (bridge/addon-stock.mjs, docs/ADDON_API.md "Stock").
const SETUP = `${WORLD}
    M.attach(host)
    local handle = assert(M.public.register({id = 'skippy', name = 'Skippy', version = '1.0.0', requires = '1.0'}))
    assert(handle:speaker({id = 'gun', name = 'Skippy', anchor = 'player', minGap = 2}))
`;

test('stock: the arguments are checked, nothing throws, and nil clears', () => {
  runLua(`${SETUP}
    local function bad(reason, ...)
        local ok, why = handle:stock(...)
        assert(ok == false and tostring(why):find(reason, 1, true), tostring(reason) .. ' / ' .. tostring(why))
    end
    bad('unknown speaker', 'nobody', 'kill', {text = 'x'})
    bad('stock key', 'gun', nil, {text = 'x'})
    bad('stock key', 'gun', 'bad key', {text = 'x'})
    bad('stock key', 'gun', string.rep('k', 49), {text = 'x'})
    bad('table or nil', 'gun', 'kill', 'text')
    bad('text is required', 'gun', 'kill', {})
    bad('text is required', 'gun', 'kill', {text = '   '})
    bad('facts must be a table', 'gun', 'kill', {text = 'x', facts = 'no'})
    bad('facts are too large', 'gun', 'kill', {text = 'x', facts = {blob = string.rep('a', 4100)}})
    bad('slots must be a list of at most 8', 'gun', 'kill', {text = 'x', slots = {'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'}})
    bad('slots must be a list', 'gun', 'kill', {text = 'x', slots = 'fight.kills'})
    bad('slots must be a list', 'gun', 'kill', {text = 'x', slots = {name = 'fight.kills'}})
    bad('invalid slot name', 'gun', 'kill', {text = 'x', slots = {'fight kills'}})
    bad('invalid slot name', 'gun', 'kill', {text = 'x', slots = {'{fight}'}})
    bad('invalid slot name', 'gun', 'kill', {text = 'x', slots = {string.rep('s', 49)}})
    bad('invalid slot name', 'gun', 'kill', {text = 'x', slots = {7}})
    assert(handle:stock('gun', 'kill', {text = 'V is about to kill another enemy', slots = {'fight.kills', 'fight.kills'}}) == true)
    assert(handle:stock('gun', 'never-set', nil) == true, 'clearing what is not there is fine')
    assert(handle:stock(nil, 'kill', {text = 'x'}) == false)
    handle:setEnabled(false)
    bad('add-on disabled', 'gun', 'kill', {text = 'something else'})
    assert(handle:stock('gun', 'kill', nil) == true, 'a disabled add-on may still clear')
  `);
});

test('stock: at most 12 keys per speaker; the numbers are clamped; text is cut to 600', () => {
  const doc = runLua(`${SETUP}
    for index = 1, 12 do assert(handle:stock('gun', 'key' .. index, {text = 'line ' .. index}) == true) end
    local ok, why = handle:stock('gun', 'key13', {text = 'one too many'})
    assert(ok == false and why:find('too many stock entries', 1, true), tostring(why))
    assert(handle:stock('gun', 'key3', {text = 'changing an existing key is allowed'}) == true)
    assert(handle:stock('gun', 'key1', nil) == true)
    assert(handle:stock('gun', 'key13', {text = 'now there is room'}) == true)
    assert(handle:stock('gun', 'clamped', nil) == true)
    handle:stock('gun', 'key2', {text = string.rep('t', 700), maxWords = 1, want = 9, ttl = 5000})
    handle:stock('gun', 'key4', {text = 'defaults'})
    handle:stock('gun', 'key5', {text = 'low', maxWords = 400, want = 0, ttl = 1})
    tick()
    return files['runtime/addon-state.json']
  `);
  const rows = Object.fromEntries(JSON.parse(doc).addons.skippy.stock.map(row => [row.key, row]));
  assert.equal(Object.keys(rows).length, 12);
  assert.equal(rows.key1, undefined);
  assert.equal(rows.key2.text.length, 600);
  assert.deepEqual([rows.key2.maxWords, rows.key2.want, rows.key2.ttl], [3, 4, 300]);
  assert.deepEqual([rows.key4.maxWords, rows.key4.want, rows.key4.ttl], [10, 2, 90], 'the defaults');
  assert.deepEqual([rows.key5.maxWords, rows.key5.want, rows.key5.ttl], [60, 1, 10]);
});

test('stock: a changed spec bumps the revision, an equal one does not, and a cleared key never gets an old revision back', () => {
  const lines = runLua(`${SETUP}
    local function rev() tick(1); local doc = json.decode(files['runtime/addon-state.json']); return doc.addons.skippy.stock[1].rev end
    local spec = {text = 'V is about to kill another enemy', facts = {enemies = 4}, maxWords = 8, want = 3, ttl = 60, slots = {'fight.kills'}}
    assert(handle:stock('gun', 'kill', spec))
    local first = rev()
    assert(handle:stock('gun', 'kill', {text = 'V is about to kill another enemy', facts = {enemies = 4}, maxWords = 8, want = 3, ttl = 60, slots = {'fight.kills'}}))
    assert(rev() == first, 'an equal spec is not a change')
    spec.facts = {enemies = 3}
    assert(handle:stock('gun', 'kill', spec))
    local second = rev()
    assert(second > first, 'new facts')
    spec.want = 4
    assert(handle:stock('gun', 'kill', spec))
    local third = rev()
    assert(third > second, 'a new want')
    spec.slots = {'fight.kills', 'fight.headshots'}
    assert(handle:stock('gun', 'kill', spec))
    local fourth = rev()
    assert(fourth > third, 'new slots')
    assert(handle:stock('gun', 'kill', nil))
    assert(handle:stock('gun', 'kill', spec))
    local fifth = rev()
    assert(fifth > fourth, 'cleared and set again: a new revision')
    return table.concat({first, second, third, fourth, fifth}, ',')
  `);
  const revs = lines.split(',').map(Number);
  assert.equal(new Set(revs).size, 5);
  assert.deepEqual([...revs].sort((a, b) => a - b), revs, 'the revision only grows');
});

test('stock: the state document carries every row with its context blocks (at most 4, 3000 characters) and is written only when dirty', () => {
  const doc = runLua(`${SETUP}
    assert(handle:setContext('gun', 'mode', 'Puppy-Loving Pacifist mode.', 'world'))
    assert(handle:setContext('gun', 'fight', string.rep('f', 1500), 'volatile'))
    assert(handle:setContext('gun', 'extra', string.rep('e', 1400), 'notes'))
    assert(handle:setContext('gun', 'big', string.rep('b', 1000), 'world'))      -- would pass 3000 characters: skipped
    assert(handle:setContext('gun', 'last', 'Fits.', 'notes'))
    assert(handle:setContext('gun', 'sixth', 'Beyond four blocks.', 'notes'))
    assert(handle:stock('gun', 'kill', {text = 'V is about to kill another enemy', facts = {enemies = 4}, maxWords = 8, want = 3, ttl = 60,
        slots = {'fight.kills'}}))
    assert(handle:stock('gun', 'fight-end', {text = 'The fight is over', slots = {}}))
    assert(files['runtime/addon-state.json'] == nil, 'nothing is written between ticks')
    tick()
    local first = files['runtime/addon-state.json']
    files['runtime/addon-state.json'] = 'sentinel'
    tick(1); tick(1)
    assert(files['runtime/addon-state.json'] == 'sentinel', 'not written again while nothing changed')
    handle:setContext('gun', 'mode', 'Stone Cold Killer mode.', 'world')
    tick(1)
    assert(files['runtime/addon-state.json'] ~= 'sentinel', 'a changed context block of a speaker with stock is written')
    return first .. '\\n' .. files['runtime/addon-state.json']
  `);
  const [first, second] = doc.split('\n').map(line => JSON.parse(line));
  const rows = first.addons.skippy.stock;
  assert.deepEqual(rows.map(row => [row.speaker, row.key]), [['gun', 'kill'], ['gun', 'fight-end']]);
  assert.deepEqual({...rows[0], blocks: undefined, rev: undefined}, {speaker: 'gun', key: 'kill', text: 'V is about to kill another enemy',
    facts: {enemies: 4}, maxWords: 8, want: 3, ttl: 60, slots: ['fight.kills'], rev: undefined, blocks: undefined});
  assert.equal(typeof rows[0].rev, 'number');
  assert.deepEqual(rows[1].slots, []);
  assert.deepEqual(rows[0].blocks.map(block => block.key), ['mode', 'fight', 'extra', 'last']);
  const total = rows[0].blocks.reduce((sum, block) => sum + block.text.length, 0);
  assert.ok(rows[0].blocks.length <= ADDON_LIMITS.stockBlocks && total <= ADDON_LIMITS.stockBlocksText, `${rows[0].blocks.length} blocks, ${total} characters`);
  assert.ok(!rows[0].blocks.some(block => block.key === 'big' || block.key === 'sixth'));
  assert.deepEqual(rows[0].blocks[0], {key: 'mode', text: 'Puppy-Loving Pacifist mode.', tier: 'world'});
  assert.equal(second.addons.skippy.stock[0].blocks[0].text, 'Stone Cold Killer mode.');
});

test('stock: an add-on with stock and nothing else still appears in the state document, and reset clears the stock', () => {
  const lines = runLua(`${SETUP}
    assert(handle:stock('gun', 'kill', {text = 'V is about to kill another enemy'}))
    tick()
    local written = files['runtime/addon-state.json']
    M.reset('load')
    local cleared = files['runtime/addon-state.json']
    -- After the reset the add-on asks again and gets a new, higher revision.
    assert(handle:stock('gun', 'kill', {text = 'V is about to kill another enemy'}))
    tick(1)
    return written .. '\\n' .. cleared .. '\\n' .. files['runtime/addon-state.json']
  `);
  const [written, cleared, again] = lines.split('\n').map(line => JSON.parse(line));
  assert.equal(written.addons.skippy.stock.length, 1);
  assert.equal(cleared.addons.skippy, undefined, 'the reset removed it');
  assert.equal(again.addons.skippy.stock.length, 1);
  assert.ok(again.addons.skippy.stock[0].rev > written.addons.skippy.stock[0].rev);
});

test('stock: a remark with stock = true says so in the request, and without it the flag is absent', () => {
  runLua(`${SETUP}
    assert(handle:remark('gun', {event = 'kill', text = 'V killed one.', priority = 4, stock = true}))
    tick()
    assert(#submitted == 1)
    assert(submitted[1].context.addon.stock == true, 'the flag reaches context.addon')
    assert(submitted[1].context.addon.event == 'kill')
    -- Finish it, then a remark without the flag.
    state.pendingId, state.speechId = nil, submitted[1].context.requestId
    tick(); state.speechId = nil; tick(); tick(35)
    assert(handle:remark('gun', {event = 'kill', priority = 4, stock = false}))
    tick(3)
    assert(#submitted == 2, 'second request ' .. #submitted)
    assert(submitted[2].context.addon.stock == nil, 'false is not sent')
    state.pendingId, state.speechId = nil, submitted[2].context.requestId
    tick(); state.speechId = nil; tick(); tick(35)
    assert(handle:remark('gun', {event = 'kill', priority = 4}))
    tick(3)
    assert(#submitted == 3 and submitted[3].context.addon.stock == nil, 'absent stays absent')
  `);
});

test('stock: the limits in mod/addons.lua match the bridge', () => {
  const table = /local STOCK = \{([^}]*)\}/.exec(addonsSource)?.[1] ?? '';
  const value = name => Number(new RegExp(`${name} = (\\d+)`).exec(table)?.[1]);
  assert.equal(value('keys'), ADDON_LIMITS.stockKeys);
  assert.equal(value('text'), ADDON_LIMITS.stockText);
  assert.equal(value('slots'), ADDON_LIMITS.stockSlots);
  assert.equal(value('slotName'), ADDON_LIMITS.stockSlotName);
  assert.equal(value('blocks'), ADDON_LIMITS.stockBlocks);
  assert.equal(value('blocksText'), ADDON_LIMITS.stockBlocksText);
});
