import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {run as runStartup, managerLua} from './startup-lua-fixture.mjs';

// The setting, the game wiring and the docs of the romance animations (docs/ROMANCE_ANIMATIONS.md).
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const init = read('../mod/init.lua');
const controller = read('../mod/romance-anim.lua');
const pairs = read('../mod/romance-pairs.lua');
const build = read('../scripts/Build-GestureAssets.mjs');
const docs = read('../docs/ROMANCE_ANIMATIONS.md');

test('Romance animations is on by default, can be turned off, and the choice is saved', () => {
  const report = runStartup(`${managerLua}
    local manager = newManager()
    local player = newPlayer()
    report('first', {on = manager.romanceAnimations(), snap = manager.snapshot(player).settings.romanceAnimations})
    assert(manager.applySettings(player, {romanceAnimations = false}))
    report('off', {on = manager.romanceAnimations(), snap = manager.snapshot(player).settings.romanceAnimations, saved = json.decode(settingsText()).romanceAnimations})
    assert(manager.applySettings(player, {romanceAnimations = true}))
    report('on', {on = manager.romanceAnimations(), saved = json.decode(settingsText()).romanceAnimations})
    local ok = manager.applySettings(player, {romanceAnimations = 'yes'})
    report('bad', {accepted = ok == true})
  `);
  assert.deepEqual(report.first, {on: true, snap: true});
  assert.deepEqual(report.off, {on: false, snap: false, saved: false});
  assert.deepEqual(report.on, {on: true, saved: true});
  assert.equal(report.bad.accepted, false, 'only on or off is accepted');
});

test('the game side is wired once: armed on a private turn, ticked with nil checks, owned like a seat, setting read through the manager', () => {
  assert.equal(init.split('if convaiRomanceArm then convaiRomanceArm(context) end').length - 1, 2, 'the typed and the spoken turn');
  assert.match(init, /if worldReady and convaiRomanceTick then convaiRomanceTick\(player\) end/);
  assert.match(init, /function convaiRomanceTick\(player\)\s*if not convaiRomance and not R\.queued then return end/);
  assert.match(init, /if r and r\.owns\(entry\) then return true end/);
  assert.match(init, /if convaiRomance and convaiRomance\.observe\(entry\) then return true end/);
  assert.match(init, /if convaiRomance then pcall\(convaiRomance\.release, entry, reason\) end/);
  assert.match(init, /if convaiRomance then pcall\(convaiRomance\.abandon, reason\) end/);
  assert.match(init, /enabled = function\(\) return manager\.romanceAnimations\(\) end/);
  // the arm call does nothing for a reaction, Johnny in V's head, a group round or a character who is not a partner, and one boolean while Off
  assert.match(init, /function convaiRomanceArm\(context\)\s*if type\(context\) ~= 'table' or context\.reaction or context\.head or context\.group then return end\s*if type\(manager\.romanceAnimations\) ~= 'function' or not manager\.romanceAnimations\(\) then return end\s*if not R\.partner\(context\.profileKey\) then return end/);
  // the question is the game's box, and no question means no pair
  assert.match(init, /player:ConvaiAskOpen\(/);
  assert.match(controller, /if type\(options\.confirm\) ~= 'function' then return false, 'no-confirm' end/);
});

test('nothing in the controller or its glue runs per frame, loops over the world or polls without a request', () => {
  assert.doesNotMatch(controller, /GetNPCs|GetAllEntities|GetEntitiesInRange|OnUpdate|Observe\(|Override\(/);
  // the only tick is the party tick, and the request file is read only while armed
  assert.match(controller, /function self\.tick\(\)\s*if armedUntil then poll\(\) end\s*local phase = state\.phase\s*if phase == 'idle' then return end/);
  assert.match(controller, /local function poll\(\)\s*local t = now\(\)\s*if t > armedUntil then armedUntil = nil; return end/);
});

test('the device component names match between the controller and the build script', () => {
  assert.match(controller, /'convai_romance_' \.\. row\.id \.\. '_' \.\. half/);
  assert.match(build, /convai_romance_\$\{row\.id\}_\$\{half\}/);
  assert.match(build, /readFileSync\(path\.join\(project, 'mod', 'romance-pairs\.lua'\)|fs\.readFileSync\(path\.join\(project, 'mod', 'romance-pairs\.lua'\)/);
  // a row with a half the archive lacks is skipped, never a failure
  assert.match(build, /romanceSkipped\.push\(row\.id\)/);
});

test('the table is the only place that names the clips', () => {
  const source = [controller, init, build, read('../mod/gesture-workspot.lua')].join('\n');
  for (const needle of ['q202__synced', 'mq055__', 'mq053__', 'synced__lean_wall', 'sit_ground_lean_back']) {
    assert.ok(!source.includes(needle), `${needle} must only be in mod/romance-pairs.lua`);
  }
  assert.ok(pairs.includes('q202__synced__player__stand_ground__hug__01'));
});

test('the docs page lists every row, every kind and the live check', () => {
  const ids = [...pairs.matchAll(/^\s*\{id = '([a-z0-9_]+)'/gm)].map(match => match[1]);
  assert.ok(ids.length >= 12, `rows found: ${ids.length}`);
  for (const id of ids) assert.ok(docs.includes(`\`${id}\``), `docs lacks row ${id}`);
  for (const kind of ['kiss', 'hug', 'hands', 'sit', 'cuddle', 'lie']) assert.ok(docs.includes(`| ${kind} |`), `docs lacks the fallback row of ${kind}`);
  assert.match(docs, /## 9\. Live check for the owner/);
  assert.match(docs, /## 8\. Check for a local agent/);
  assert.ok(/verified = false/.test(docs));
});

test('the docs matrix is the one the table gives', () => {
  const rows = docs.split('\n').filter(line => /^\| (judy-alvarez|panam-palmer|river-ward|kerry-eurodyne), V player_(man|woman) \|/.test(line));
  assert.equal(rows.length, 8);
  const result = runStartup(`
    local data = (function() ${pairs} end)()
    local m = (function() ${controller} end)()
    local people = {{'judy-alvarez','woman_base'},{'panam-palmer','woman_base'},{'river-ward','man_big'},{'kerry-eurodyne','man_base'}}
    local out = {}
    for _, p in ipairs(people) do for _, v in ipairs({'player_man','player_woman'}) do
      local ctx = {vRig = v, npcRig = p[2], profileKey = p[1], supports = function() return false end, failed = {}}
      local cells = {}
      for _, k in ipairs(m.KINDS) do
        local row, kind = m.choose(data, k, ctx)
        cells[#cells + 1] = row and (kind == k and row.id or (kind .. ' (' .. row.id .. ')')) or 'none'
      end
      out[#out + 1] = '| ' .. p[1] .. ', V ' .. v .. ' | ' .. table.concat(cells, ' | ') .. ' |'
    end end
    report('matrix', out)
  `);
  assert.deepEqual(result.matrix, rows);
});
