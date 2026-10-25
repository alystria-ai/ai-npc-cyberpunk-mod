import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// mod/init.lua is too large to run in a test, so the invariants of the immersive-invitation wiring are pinned on its source: what runs while the
// setting is Off, where the hooks are, and the order of the teardown.
const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const block = init.slice(init.indexOf('convaiImmersiveService = nil'), init.indexOf('function convaiMeetGreeting(info)'));

test('with the setting Off the tick is one table read: no module is loaded and no game call is made before the early return', () => {
  const tick = block.slice(block.indexOf('function convaiImmersiveTick(delta)'), block.indexOf('function convaiImmersiveReset'));
  const early = tick.slice(0, tick.indexOf('local glue = service()'));
  assert.match(early, /manager\.immersive and manager\.immersive\(\)/);
  assert.match(early, /not convaiImmersiveService then return end/);
  assert.doesNotMatch(early, /Game\.|dofile|pcall/);
  // the glue module is loaded on demand, never at start
  assert.doesNotMatch(init.replace(block, ''), /dofile\('immersive-(service|invitations|world|car)\.lua'\)/);
  assert.match(block, /pcall\(dofile, 'immersive-service\.lua'\)/);
});

test('the glue drops itself when the setting goes Off, so nothing stays loaded', () => {
  assert.match(block, /if not \(manager\.immersive and manager\.immersive\(\)\.enabled\) then convaiMeetGreetingWaiting, convaiImmersiveService = nil, nil end/);
});

test('what holds V uses the scene tier, not IsEntityInScene, which stays true in ordinary gameplay', () => {
  const held = block.slice(block.indexOf('local function held()'), block.indexOf('local function notify'));
  assert.match(held, /sample\.tier ~= nil and sample\.tier ~= 1/);
  assert.doesNotMatch(held, /sample\.scene/);
  assert.match(held, /sample\.combat/);
});

test('the tick runs inside the world-ready part of onUpdate, after the companions', () => {
  const at = init.indexOf('if worldReady then companions.update(player, elapsedPoll, focusEntity) end');
  assert.ok(at > 0);
  assert.match(init.slice(at, at + 400), /pcall\(convaiImmersiveTick, elapsedPoll\)/);
});

test('a world change drops the references after the party\'s own, and a fast travel keeps the appointments', () => {
  const abandon = init.slice(init.indexOf('local function abandonSession('));
  assert.ok(abandon.indexOf('companions.abandon(preserveTransit==true)') < abandon.indexOf('convaiImmersiveReset(reason, preserveTransit == true)'));
  assert.match(block, /function convaiImmersiveReset\(reason, preserve\)/);
});

test('the Contacts J key and the manager route through the appointment only while the setting is On, and take the old path otherwise', () => {
  assert.match(init, /local immersive = convaiImmersiveGet and convaiImmersiveGet\(\) or nil/);
  assert.match(init, /local taken, why = immersive\.requestInvite\(key\)\s+if taken ~= nil then/);
  const ui = readFileSync(new URL('../mod/manager-ui.lua', import.meta.url), 'utf8');
  assert.equal((ui.match(/function\(\) return inviteKey\(key\) end/g) || []).length, 2, 'the Characters and Model browser buttons');
  assert.doesNotMatch(ui, /function\(\) return queue\.invite\(key\) end/);
});

test('her greeting is a reaction of its own kind: no combat context, and it is checked before the other automatic kinds', () => {
  assert.match(init, /if context\.reaction and context\.reaction\.kind == 'meet' then context\.battle = nil end/);
  const chain = init.slice(init.indexOf("if automatic and automatic.reaction.kind == 'meet' then"), init.indexOf('local busy = not worldReady'));
  assert.match(chain, /elseif automatic and automatic\.reaction\.kind == 'head' then/);
  assert.match(chain, /convaiMeetGreetingTick\(player, now, worldReady, outputs, manual\)/);
});

test('the appointment note and the offer ride only on turns that carry a turn context, on a copy', () => {
  assert.match(init, /context\.turnContext = convaiAppointmentTurn\(context\.turnContext, context\.profileKey\)/);
  assert.match(init, /microphone\.captureTurnContext = function\(profileKey\)/);
});

test('every new notice id is a literal at its call site', () => {
  for (const id of ['immersive-text', 'immersive-on-the-way', 'immersive-greeting']) assert.ok(init.includes(`'${id}'`), id);
});
