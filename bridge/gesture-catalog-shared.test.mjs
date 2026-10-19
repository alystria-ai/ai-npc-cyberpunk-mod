// The gesture catalogue (mod/gesture-catalog.lua, 1.4 MB of generated Lua) is compiled and held once per session:
// docs/PERFORMANCE_NATIVE_PLAN.md item 14. The gesture controller loads it; seating and the holocall live picture reuse
// that copy (each used to dofile its own, two or three heap copies and compiles at load).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = (name) => readFileSync(new URL(`../mod/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('init.lua hands the gesture controller\'s catalogue to seating, and seating loads its own only without one', () => {
  const init = read('init.lua');
  const options = init.slice(init.indexOf('convaiSeatingOptions = {'), init.indexOf("dofile('companion-seating.lua').new(convaiSeatingOptions)"));
  assert.match(options, /catalog = controller and type\(controller\.catalog\) == 'table' and controller\.catalog or nil/);
  assert.ok(init.indexOf("dofile('companion-gestures.lua').new(options)") < init.indexOf('convaiSeatingOptions = {'),
    'the gesture controller exists before the seating options are built');
  assert.match(read('companion-seating.lua'), /local catalog = options\.catalog or dofile\('gesture-catalog\.lua'\)/);
  assert.match(read('companion-gestures.lua'), /catalog = options\.catalog or dofile\('gesture-catalog\.lua'\)/);
});

test('the holocall live picture prefers the gesture controller\'s catalogue', () => {
  const holocall = read('holocall.lua');
  const shared = holocall.indexOf('convaiGestures.catalog');
  const own = holocall.indexOf("pcall(dofile, 'gesture-catalog.lua')");
  assert.ok(shared > 0 && own > shared, 'the shared copy is tried before compiling one');
});
