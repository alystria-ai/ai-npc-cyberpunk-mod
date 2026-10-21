import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {FIT_LIMITS, SMALL_CARD_ROOM, describeFit, fitLadder, fitToolPath, gameRoomMiB, offloadPlan, offloadRamNeedMiB, offloadThreads, parseProjection, probeProjectedMiB, smallCardRoom} from './local-vram-fit.mjs';
import {chooseLocalModel, listLocalModels} from './local-model-choice.mjs';

// The line llama-fit-params prints at -lv 4, as measured 2026-10-20 (RTX 4080 Laptop, build 11560, Gemma 4 E4B Mature good at 16,384 context; the same line and the same projections to the MiB on build 11782, 2026-10-21).
const LINE = '0.01.933.385 I common_params_fit_impl: projected to use 3734 MiB of device memory vs. 11226 MiB of free device memory';

test('parseProjection reads the projected and the free memory from the tool output, and nothing from other text', () => {
  assert.deepEqual(parseProjection(LINE), {projectedMiB: 3734, freeMiB: 11226});
  assert.deepEqual(parseProjection('noise\n' + LINE + '\nmore'), {projectedMiB: 3734, freeMiB: 11226});
  assert.equal(parseProjection('-c 16384 -ngl -1'), null);
  assert.equal(parseProjection(undefined), null);
});

test('fitToolPath finds the tool beside the server, and nothing for a stand-in server or no command', () => {
  assert.equal(fitToolPath('C:/pack/llama-vulkan/llama-server.exe', {exists: path => /llama-fit-params\.exe$/.test(path), platform: 'win32'}).replace(/\\/g, '/'), 'C:/pack/llama-vulkan/llama-fit-params.exe');
  assert.equal(fitToolPath('/pack/llama-server', {exists: () => true, platform: 'linux'}).replace(/\\/g, '/'), '/pack/llama-fit-params');
  assert.equal(fitToolPath('C:/pack/llama-server.exe', {exists: () => false}), null);
  assert.equal(fitToolPath(undefined), null);
  assert.equal(fitToolPath(''), null);
});

// A stand-in child process: emits what the test says, records the kill.
function fakeSpawn({stdout = '', stderr = '', exitAfter = null, fail = false} = {}) {
  const calls = [];
  const spawnImpl = (exe, args, options) => {
    if (fail) throw Error('no such file');
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.killed = false; child.kill = () => { child.killed = true; };
    calls.push({exe, args, options, child});
    queueMicrotask(() => {
      if (stderr) child.stderr.emit('data', stderr);
      if (stdout) child.stdout.emit('data', stdout);
      if (exitAfter !== null) child.emit('exit', exitAfter);
    });
    return child;
  };
  return {spawnImpl, calls};
}

test('probeProjectedMiB stops the tool at its first projection (the layer search that follows takes 10 s and more) and passes the context, the cache type and the device', async () => {
  const fake = fakeSpawn({stderr: LINE + '\n0.02.045.388 I common_params_fit_impl: context size set by user to 16384 -> no change\n'});
  const value = await probeProjectedMiB({exe: 'fit.exe', model: 'm.gguf', contextSize: 8192, kvType: 'q8_0', device: 'Vulkan1', spawnImpl: fake.spawnImpl});
  assert.equal(value, 3734);
  assert.equal(fake.calls[0].child.killed, true);
  const args = fake.calls[0].args;
  assert.deepEqual([args[args.indexOf('-m') + 1], args[args.indexOf('-c') + 1], args[args.indexOf('--device') + 1], args[args.indexOf('-ctk') + 1], args[args.indexOf('-ctv') + 1], args[args.indexOf('-lv') + 1]],
    ['m.gguf', '8192', 'Vulkan1', 'q8_0', 'q8_0', '4']);
  assert.equal(fake.calls[0].options.windowsHide, true);
  const plain = fakeSpawn({stdout: LINE});
  await probeProjectedMiB({exe: 'fit.exe', model: 'm.gguf', contextSize: 16384, device: 'Vulkan1', spawnImpl: plain.spawnImpl});
  assert.ok(!plain.calls[0].args.includes('-ctk'), 'the default cache type is not named');
});

test('probeProjectedMiB gives null for a tool that is missing, fails, exits without a projection or does not answer in time; never throws', async () => {
  const base = {exe: 'fit.exe', model: 'm.gguf', contextSize: 8192, device: 'Vulkan1'};
  assert.equal(await probeProjectedMiB({...base, spawnImpl: fakeSpawn({fail: true}).spawnImpl}), null);
  assert.equal(await probeProjectedMiB({...base, spawnImpl: fakeSpawn({stderr: 'error: model not found', exitAfter: 1}).spawnImpl}), null);
  assert.equal(await probeProjectedMiB({exe: null, model: 'm.gguf', device: 'Vulkan1'}), null);
  assert.equal(await probeProjectedMiB({exe: 'fit.exe', model: 'm.gguf', device: null}), null);
  // No answer: the timer fires (a fake timer, called at once) and the child is killed.
  const silent = fakeSpawn();
  assert.equal(await probeProjectedMiB({...base, spawnImpl: silent.spawnImpl, timeoutMs: 5, setTimer: fn => { queueMicrotask(() => queueMicrotask(fn)); return null; }}), null);
  assert.equal(silent.calls[0].child.killed, true);
  // A projection in the same chunk as an exit is still used.
  assert.equal(await probeProjectedMiB({...base, spawnImpl: fakeSpawn({stderr: LINE, exitAfter: 0}).spawnImpl}), 3734);
});

const TABLE = {16384: 3734, 8192: 3598, q8: 3520};   // Gemma 4 E4B Mature good, measured 2026-10-20
const probeOf = table => async rung => table[rung.kvType ? 'q8' : rung.contextSize] ?? null;

test('fitLadder takes the largest context whose projection plus the margin fits the free memory, then the 8-bit cache, else none and the share of the layers the card can hold', async () => {
  const at = async free => fitLadder({freeMiB: free, probe: probeOf(TABLE)});
  assert.deepEqual((await at(11000)).pick, {contextSize: 16384, kvType: null, projectedMiB: 3734});
  assert.equal((await at(4246)).pick.contextSize, 16384, '3,734 and the 512 MiB margin fit exactly');
  assert.deepEqual((await at(4245)).pick, {contextSize: 8192, kvType: null, projectedMiB: 3598});
  assert.deepEqual((await at(4100)).pick, {contextSize: 8192, kvType: 'q8_0', projectedMiB: 3520});
  const none = await at(3500);
  assert.equal(none.pick, null);
  assert.ok(Math.abs(none.share - 0.251) < 0.001, 'the 8,192 8-bit rung (3,520 MiB, 1,100 of them fixed) against what is free beyond the 1,792 MiB kept for the game');
  assert.equal((await at(231)).share, 0, 'a card with nothing free holds none of the layers');
  assert.equal((await at(11000)).share, 1);
  // A larger margin (after a spill) moves the pick.
  assert.equal((await fitLadder({freeMiB: 4300, marginMiB: FIT_LIMITS.refitMarginMiB, probe: probeOf(TABLE)})).pick, null);
  assert.equal((await fitLadder({freeMiB: 4700, marginMiB: FIT_LIMITS.refitMarginMiB, probe: probeOf(TABLE)})).pick.contextSize, 8192);
});

test('fitLadder with no projection, an unknown free memory or a probe that throws picks nothing and says so', async () => {
  const blind = await fitLadder({freeMiB: 4000, probe: async () => null});
  assert.deepEqual([blind.pick, blind.share], [null, null]);
  const throwing = await fitLadder({freeMiB: 4000, probe: async () => { throw Error('boom'); }});
  assert.deepEqual([throwing.pick, throwing.share], [null, null]);
  const unknown = await fitLadder({freeMiB: NaN, probe: probeOf(TABLE)});
  assert.equal(unknown.pick, null);
  assert.equal(unknown.projections.length, 3);
});

test('describeFit puts the projections, the free memory and the decision on one line', async () => {
  const fit = await fitLadder({freeMiB: 4100, probe: probeOf(TABLE)});
  assert.equal(describeFit(fit, 4100, 512), 'projected 3734 MiB at 16384, 3598 MiB at 8192, 3520 MiB at 8192 q8_0 against 4100 MiB free (room kept 512 MiB): the whole model fits: context 8192, q8_0 cache');
  const no = await fitLadder({freeMiB: 3000, probe: probeOf(TABLE)});
  assert.match(describeFit(no, 3000, 512), /does not fit whole, about 4% of the layers can stay on the card/);
});

test('chooseLocalModel: a model whose projection fits counts as fitting, so a pin is kept and a Mature model is not offloaded; without it the file-size rule decides as before', () => {
  const models = listLocalModels({pack: {tiers: {standard: {file: 'q4.gguf', name: 'Std'}, lite: {file: 'q2.gguf', name: 'Lite'}}},
    matureModels: [{tier: 'good', file: 'big-u.gguf', name: 'Good', present: true}, {tier: 'lite', file: 'small-u.gguf', name: 'Small', present: true}]});
  const sizes = {'q4.gguf': 5280, 'q2.gguf': 1311, 'big-u.gguf': 5400, 'small-u.gguf': 1400};
  const sizeOf = file => sizes[file] ?? 0;
  // 1,000 MiB free, only the good Mature model chosen and nothing else installed: loaded anyway, offloaded (as before) ...
  const goodOnly = models.filter(model => model.id === 'mature:good');
  const before = chooseLocalModel({models: goodOnly, pin: 'mature:good', matureOn: true, freeMiB: 4800, sizeOf});
  assert.deepEqual([before.model.id, before.offload], ['mature:good', true]);
  // ... and with its projection fitting it is loaded whole.
  const after = chooseLocalModel({models: goodOnly, pin: 'mature:good', matureOn: true, freeMiB: 4800, sizeOf, realFit: {'mature:good': {pick: {contextSize: 16384}}}});
  assert.deepEqual([after.model.id, after.offload, after.pinned, after.fellBack], ['mature:good', false, true, null]);
  // A pinned standard model that the file-size rule rejects is replaced by the default; with its projection fitting it stays.
  const replaced = chooseLocalModel({models, pin: 'standard', freeMiB: 4800, sizeOf});
  assert.deepEqual([replaced.model.id, replaced.fellBack], ['lite', 'low-memory']);
  const kept = chooseLocalModel({models, pin: 'standard', freeMiB: 4800, sizeOf, realFit: {standard: {pick: {contextSize: 8192}}}});
  assert.deepEqual([kept.model.id, kept.pinned, kept.fellBack], ['standard', true, null]);
  // The default rule ignores a fit it was not given and reads one only for the models it names: the room kept for the game on a small card still wins.
  const small = chooseLocalModel({models, freeMiB: 7000, totalMiB: 8188, sizeOf, realFit: {standard: {pick: {contextSize: 16384}}}});
  assert.equal(small.model.id, 'lite', 'the small-card reserve is judged by the file-size rule');
  // A fit with no pick (the model does not fit whole) changes nothing.
  assert.equal(chooseLocalModel({models, pin: 'standard', freeMiB: 4800, sizeOf, realFit: {standard: {pick: null, share: 0.6}}}).model.id, 'lite');
});

// ---- Partial offload: the share of the layers that stays on the card, the gate and the threads --------------------------------------------------------------------

test('offloadPlan: the share of the layers on the card follows the layer count of llama-fit-params itself (measured 2026-10-21, RTX 4080 Laptop, b11560, 8,192 context, 8-bit cache)', () => {
  // Qwen3.5-4B Q4_K_M: 3,271 MiB projected, 1,002 MiB with every layer on the CPU. A fit target of 9,500 MiB against 11,176 free left 1,676 MiB for the model: 10 of 33 layers (30%).
  const qwen = offloadPlan({projectedMiB: 3271, sizeMiB: 2582, freeMiB: 11176, targetMiB: 9500});
  assert.ok(qwen.share > 0.25 && qwen.share < 0.31, String(qwen.share));
  // Gemma 4 E4B Mature good: 3,520 projected, 1,057 fixed, 13 of 43 layers (30%) with 1,725 MiB.
  const gemma = offloadPlan({projectedMiB: 3520, sizeMiB: 5088, freeMiB: 11226, targetMiB: 9500});
  assert.ok(gemma.share > 0.25 && gemma.share < 0.31, String(gemma.share));
  assert.deepEqual([qwen.estimated, qwen.contextSize, qwen.kvType, qwen.targetMiB], [false, 8192, 'q8_0', 9500]);
});

test('offloadPlan: whole when the projection fits beside the room kept for the game, nothing when it cannot, hopeless under 35%, an estimate from the file without a projection, unknown without a reading', () => {
  const room = FIT_LIMITS.offloadGameRoomMiB;
  assert.equal(offloadPlan({projectedMiB: 3000, freeMiB: 3000 + room}).share, 1);
  assert.equal(offloadPlan({projectedMiB: 3000, freeMiB: room - 100}).share, 0);
  const limit = FIT_LIMITS.offloadFixedMiB + FIT_LIMITS.hopelessShare * (3000 - FIT_LIMITS.offloadFixedMiB);   // the room the model needs for exactly the least share
  const edge = offloadPlan({projectedMiB: 3000, freeMiB: room + Math.ceil(limit)});
  assert.equal(edge.hopeless, false);
  assert.equal(offloadPlan({projectedMiB: 3000, freeMiB: room + Math.floor(limit) - 60}).hopeless, true);
  // The 8 GB report: a 2,582 MiB Qwen3.5-4B (3,271 projected) with 3,500 MiB free is hopeless beside the game, with 4,200 it is about half on the card.
  assert.equal(offloadPlan({projectedMiB: 3271, freeMiB: 3500}).hopeless, true);
  const half = offloadPlan({projectedMiB: 3271, freeMiB: 4200});
  assert.ok(half.share > 0.55 && half.share < 0.65 && !half.hopeless, String(half.share));
  // No projection: the file plus 700 MiB stands in for it, and says so.
  const estimate = offloadPlan({sizeMiB: 2582, freeMiB: 4200});
  assert.deepEqual([estimate.projectedMiB, estimate.estimated], [3282, true]);
  // Unknown: no free-memory reading, or neither a projection nor a file size. Nothing is refused then.
  for (const unknown of [offloadPlan({projectedMiB: 3271}), offloadPlan({freeMiB: 4000}), offloadPlan({})]) assert.deepEqual([unknown.share, unknown.hopeless], [null, false]);
});

test('offloadThreads: about half the physical cores (a quarter of the logical processors), at least 2 and at most 6', () => {
  assert.deepEqual([4, 8, 12, 16, 24, 32, 64].map(offloadThreads), [2, 2, 3, 4, 6, 6, 6]);
  assert.deepEqual([offloadThreads(1), offloadThreads(undefined), offloadThreads(NaN)], [2, 2, 2]);
});

test('offloadRamNeedMiB: the part of the model and its cache that stays on the processor plus 1 GiB; nothing when it is all on the card or the share or size is unknown', () => {
  assert.equal(offloadRamNeedMiB({share: 0, sizeMiB: 2582}), Math.ceil(2582 + 310 + 1024), 'all on the processor: the file, 12% for the cache, the headroom');
  assert.equal(offloadRamNeedMiB({share: 0.5, sizeMiB: 5400}), Math.ceil(0.5 * (5400 + 648) + 1024));
  assert.equal(offloadRamNeedMiB({share: 0.9, sizeMiB: 1000}), Math.ceil(0.1 * (1000 + 300) + 1024), 'the cache is at least 300 MiB');
  assert.equal(offloadRamNeedMiB({share: 0, projectedMiB: 3271}), Math.ceil(3271 + 393 + 1024), 'no file size: the projection stands in');
  for (const unknown of [offloadRamNeedMiB({share: 1, sizeMiB: 2582}), offloadRamNeedMiB({share: null, sizeMiB: 2582}), offloadRamNeedMiB({share: 0.4}), offloadRamNeedMiB({})]) assert.equal(unknown, null);
});

test('the game\'s room on a small card: 55% of the card between 3,000 and 4,608 MiB, none above 12 GB or without a reading', () => {
  assert.equal(gameRoomMiB(8232), 4528, 'the 8 GB card of the 2026-10-22 report; the game held about 4.3 GB beside OmniVoice there');
  assert.equal(gameRoomMiB(6144), 3379);
  assert.equal(gameRoomMiB(4096), 3000, 'the floor is the old reserve');
  assert.equal(gameRoomMiB(11997), 4608, 'capped');
  assert.equal(gameRoomMiB(SMALL_CARD_ROOM.maxCardMiB), 4608);
  assert.equal(gameRoomMiB(SMALL_CARD_ROOM.maxCardMiB + 1), 0);
  for (const unknown of [0, -1, NaN, undefined, null, '8192']) assert.equal(gameRoomMiB(unknown), 0);
});

test('smallCardRoom takes the game\'s room and a voice engine still to load out of the free memory, never below 0', () => {
  assert.deepEqual(smallCardRoom({totalMiB: 8232, freeMiB: 7461}), {totalMiB: 8232, freeMiB: 7461, reserveMiB: 4528, voiceMiB: 0, modelMiB: 2933});
  assert.equal(smallCardRoom({totalMiB: 8232, freeMiB: 7461, voiceMiB: SMALL_CARD_ROOM.omniVoiceMiB}).modelMiB, 433);
  assert.equal(smallCardRoom({totalMiB: 8232, freeMiB: 3000, voiceMiB: 2500}).modelMiB, 0);
  assert.equal(smallCardRoom({totalMiB: 24564, freeMiB: 23000}), null, 'a large card keeps no reserve');
  assert.equal(smallCardRoom({totalMiB: 8232, freeMiB: null}), null, 'no free-memory reading: nothing is decided from it');
  assert.equal(smallCardRoom({totalMiB: 8232, freeMiB: 7461, voiceMiB: NaN}).voiceMiB, 0);
  // The placement the report's numbers give: 2,933 MiB for a model projected at 3,520 MiB (8,192, 8-bit cache) keeps about three quarters of the layers on the card.
  const room = smallCardRoom({totalMiB: 8232, freeMiB: 7461});
  const plan = offloadPlan({projectedMiB: 3520, freeMiB: room.freeMiB, targetMiB: room.reserveMiB});
  assert.equal(Math.round(plan.share * 100), 76);
  assert.equal(plan.hopeless, false);
});
