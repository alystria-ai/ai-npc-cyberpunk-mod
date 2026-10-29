import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {FIT_LIMITS, SMALL_CARD_ROOM, describeFit, fitAgainst, fitLadder, fitToolPath, gameRoomMiB, offloadPlan, offloadRamNeedMiB, offloadThreads, parseProjection, probeProjectedMiB, smallCardRoom} from './local-vram-fit.mjs';
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

test('offloadRamNeedMiB: the part of the model and its cache that stays on the processor plus the 512 MiB headroom; nothing when it is all on the card or the share or size is unknown', () => {
  assert.equal(offloadRamNeedMiB({share: 0, sizeMiB: 2582}), Math.ceil(2582 + 310 + 512), 'all on the processor: the file, 12% for the cache, the headroom');
  assert.equal(offloadRamNeedMiB({share: 0.5, sizeMiB: 5400}), Math.ceil(0.5 * (5400 + 648) + 512));
  assert.equal(offloadRamNeedMiB({share: 0.9, sizeMiB: 1000}), Math.ceil(0.1 * (1000 + 300) + 512), 'the cache is at least 300 MiB');
  assert.equal(offloadRamNeedMiB({share: 0, projectedMiB: 3271}), Math.ceil(3271 + 393 + 512), 'no file size: the projection stands in');
  for (const unknown of [offloadRamNeedMiB({share: 1, sizeMiB: 2582}), offloadRamNeedMiB({share: null, sizeMiB: 2582}), offloadRamNeedMiB({share: 0.4}), offloadRamNeedMiB({})]) assert.equal(unknown, null);
});

test('the game\'s room: 55% of the card between 3,000 and 4,608 MiB up to 9 GB, 62% (at most 10,240 MiB) from 10 GB to 24 GB, none above 24 GB or without a reading', () => {
  assert.equal(gameRoomMiB(8232), 4528, 'the 8 GB card of the 2026-10-22 report; the game held about 4.3 GB beside OmniVoice there');
  assert.equal(gameRoomMiB(6144), 3379);
  assert.equal(gameRoomMiB(4096), 3000, 'the floor is the old reserve');
  assert.equal(gameRoomMiB(8704), 4608, 'an 8 GB class card is capped as before');
  assert.equal(gameRoomMiB(SMALL_CARD_ROOM.bigCardAboveMiB), 4608, 'the old numbers hold up to and including 9,216 MiB');
  // Report 931d4563 (RTX 4070 12 GB, 12,010 MiB, 768 MiB used at the menu, 3,758 MiB free in the world with the model unloaded): the game held 12,010 - 3,758 - 768 = 7,484 MiB, 62% of the card.
  assert.equal(gameRoomMiB(12010), 7446);
  assert.ok(gameRoomMiB(12010) >= 7484 * 0.99 && gameRoomMiB(12010) < 7484 * 1.01, 'close to what the report measured');
  assert.equal(gameRoomMiB(11997), 7438);
  assert.equal(gameRoomMiB(12282), 7615, 'the same card as the adapter list reads it');
  assert.equal(gameRoomMiB(10240), 6349, 'a 10 GB card');
  assert.equal(gameRoomMiB(12288), 7619, 'a card of 12,288 MiB keeps the number it had: the raised cap does not touch it');
  // Report 8e09af42 (RTX 4090, 24,564 MiB, OmniVoice, the game in the world) derived about 17 GB held by the game alone (70%), and 62% of the card was kept for it (15,230 MiB). 2026-10-29: the room stops
  // growing where a 16 GB card's ends (10,240 MiB), because a model the player chose (a 12B on the report of an RTX 5090 Laptop, 24,463 MiB) was given 5.8 GB and fell back to the lite model.
  assert.equal(gameRoomMiB(24564), 10240);
  assert.equal(gameRoomMiB(24463), 10240, 'the RTX 5090 Laptop of the 2026-10-29 report');
  assert.equal(gameRoomMiB(16376), 10153, 'a 16 GB card keeps the number it had');
  assert.equal(gameRoomMiB(16384), 10158);
  assert.equal(gameRoomMiB(16516), 10240, '62% of 16,516 is the cap: the share and the cap meet on a 16 GB class card');
  assert.equal(gameRoomMiB(20480), 10240, 'a 20 GB card (62% would have been 12,698)');
  assert.equal(gameRoomMiB(SMALL_CARD_ROOM.maxCardMiB), 10240);
  assert.equal(SMALL_CARD_ROOM.bigGameCapMiB, 10240);
  assert.ok(gameRoomMiB(SMALL_CARD_ROOM.maxCardMiB) <= SMALL_CARD_ROOM.bigGameCapMiB);
  // Every card up to 16 GB is exactly what it was before the cap moved (the old cap 15,360 never applied below a 24 GB card, and 62% is under 10,240 up to 16,516 MiB).
  for (const total of [9217, 10240, 11997, 12010, 12282, 12288, 14336, 15360, 16376, 16384]) assert.equal(gameRoomMiB(total), Math.round(total * 0.62), total + ' MiB');
  for (const total of [10240, 11997, 12010, 12288]) assert.ok(gameRoomMiB(total) < 7680, total + ' MiB was never held to the old cap');
  assert.equal(SMALL_CARD_ROOM.maxCardMiB, 24576);
  assert.equal(gameRoomMiB(SMALL_CARD_ROOM.maxCardMiB + 1), 0);
  assert.equal(gameRoomMiB(32607), 0, 'a 32 GB card keeps nothing back');
  for (const unknown of [0, -1, NaN, undefined, null, '8192']) assert.equal(gameRoomMiB(unknown), 0);
});

test('smallCardRoom keeps back only the room the game has not taken yet (review A1): a restart mid-play and a quick Continue get a sensible model share', () => {
  // 8 GB card, the service restarted mid-play: 3,000 MiB free, Pocket on the CPU. The game holds about 4.2 GB, so almost none of its room is left to keep: the model had 0 MiB before.
  const midPlay = smallCardRoom({totalMiB: 8232, freeMiB: 3000});
  assert.equal(midPlay.gameUsedMiB, 4232);
  assert.equal(midPlay.reserveMiB, 296);
  assert.equal(midPlay.modelMiB, 2704);
  // The same card, the game has taken its whole room and more: nothing is kept back at all.
  const settled = smallCardRoom({totalMiB: 8232, freeMiB: 2000});
  assert.deepEqual([settled.reserveMiB, settled.modelMiB], [0, 2000]);
  // 12 GB card, OmniVoice loaded (2,500 MiB resident) and a quick Continue: about 4.8 GB free, the game holds about 3.7 GB. The model had about 0.2 GB before.
  const quick = smallCardRoom({totalMiB: 11997, freeMiB: 4800, residentVoiceMiB: SMALL_CARD_ROOM.omniVoiceMiB});
  assert.equal(quick.gameUsedMiB, 3697);
  assert.equal(quick.reserveMiB, 3741, 'the game will take about 7.4 GB of a 12 GB card: the rest of its room is kept');
  assert.equal(quick.modelMiB, 1059);
  // Report 931d4563 on a reload in the world (12,010 MiB card, 3,758 MiB free, model unloaded): the game already holds its room (7,252 MiB measured), so only 194 MiB are kept back, never the room twice.
  const reload = smallCardRoom({totalMiB: 12010, freeMiB: 3758});
  assert.deepEqual([reload.gameUsedMiB, reload.reserveMiB, reload.modelMiB], [7252, 194, 3564]);
  // At the service start of the same install (11,242 MiB free, game not started): the whole room is kept and the model gets 3,796 MiB instead of the 6,634 MiB the game then took.
  const start = smallCardRoom({totalMiB: 12010, freeMiB: 11242});
  assert.deepEqual([start.gameUsedMiB, start.reserveMiB, start.modelMiB], [0, 7446, 3796]);
  // Without counting the resident engine the game would look 2.5 GB larger than it is: the engine is never charged to the game's room.
  assert.equal(smallCardRoom({totalMiB: 11997, freeMiB: 4800}).gameUsedMiB, 6197);
  // The menu: only the desktop is on the card, the whole room is kept, as in the first report.
  const menu = smallCardRoom({totalMiB: 8232, freeMiB: 7461});
  assert.deepEqual([menu.reserveMiB, menu.modelMiB], [4528, 2933]);
  assert.equal(smallCardRoom({totalMiB: 8232, freeMiB: 7900}).gameUsedMiB, 0, 'free memory above the card total minus the baseline never goes negative');
  assert.equal(SMALL_CARD_ROOM.settleSeconds, undefined, 'no dependence on the service age');
});

test('a 24 GB card: the room is kept at the start and not counted twice once the game and OmniVoice are on the card (report 8e09af42)', () => {
  // The service starts with the game: 24,564 MiB, 864 MiB used by the desktop (23,700 free), OmniVoice still to load. 10,240 MiB are kept for the game (15,230 before 2026-10-29) and 2,500 for the voice: 10,960 for the model (5,970 before).
  const start = smallCardRoom({totalMiB: 24564, freeMiB: 23700, voiceMiB: SMALL_CARD_ROOM.omniVoiceMiB});
  assert.deepEqual(start, {totalMiB: 24564, freeMiB: 23700, reserveMiB: 10240, voiceMiB: 2500, modelMiB: 10960, gameRoomMiB: 10240, gameUsedMiB: 0});
  // A restart in the world with OmniVoice resident: the report read 3,900 MiB free with the model unloaded, so the game holds 24,564 - 3,900 - 2,500 - 1,000 = 17,164 MiB, more than its room: nothing is kept back
  // again and the model gets everything that is free (the 3.9 GB the step-down used in the report).
  const world = smallCardRoom({totalMiB: 24564, freeMiB: 3900, residentVoiceMiB: SMALL_CARD_ROOM.omniVoiceMiB});
  assert.equal(world.gameUsedMiB, 17164); assert.equal(world.reserveMiB, 0); assert.equal(world.modelMiB, 3900);
  // A game that has taken most of its room: only the rest is kept (7,615 MiB held, 2,625 MiB of the 10,240 still reserved).
  const half = smallCardRoom({totalMiB: 24564, freeMiB: 24564 - 1000 - 7615 - 2500, residentVoiceMiB: SMALL_CARD_ROOM.omniVoiceMiB});
  assert.equal(half.gameUsedMiB, 7615); assert.equal(half.reserveMiB, 2625); assert.equal(half.modelMiB, 13449 - 2625);
  assert.equal(smallCardRoom({totalMiB: 32607, freeMiB: 31000}), null, 'a card above 24 GB has no reserve');
});

test('smallCardRoom takes the game\'s room and a voice engine still to load out of the free memory, never below 0', () => {
  assert.deepEqual(smallCardRoom({totalMiB: 8232, freeMiB: 7461}), {totalMiB: 8232, freeMiB: 7461, reserveMiB: 4528, voiceMiB: 0, modelMiB: 2933, gameRoomMiB: 4528, gameUsedMiB: 0});
  assert.equal(smallCardRoom({totalMiB: 8232, freeMiB: 7461, voiceMiB: SMALL_CARD_ROOM.omniVoiceMiB}).modelMiB, 433);
  assert.equal(smallCardRoom({totalMiB: 8232, freeMiB: 3000, voiceMiB: 2500}).modelMiB, 204, 'the game already holds 4.2 GB of its room: only the rest is kept back');
  assert.equal(smallCardRoom({totalMiB: 8232, freeMiB: 3000, voiceMiB: 2500, limits: {...SMALL_CARD_ROOM, desktopMiB: 0}}).modelMiB, 500, 'with no desktop baseline the game would look larger and nothing would be kept back');
  assert.equal(smallCardRoom({totalMiB: 32607, freeMiB: 31000}), null, 'a card above 24 GB keeps no reserve');
  assert.equal(smallCardRoom({totalMiB: 8232, freeMiB: null}), null, 'no free-memory reading: nothing is decided from it');
  assert.equal(smallCardRoom({totalMiB: 8232, freeMiB: 7461, voiceMiB: NaN}).voiceMiB, 0);
  // The placement the report's numbers give: 2,933 MiB for a model projected at 3,520 MiB (8,192, 8-bit cache) keeps about three quarters of the layers on the card.
  const room = smallCardRoom({totalMiB: 8232, freeMiB: 7461});
  const plan = offloadPlan({projectedMiB: 3520, freeMiB: room.freeMiB, targetMiB: room.reserveMiB});
  assert.equal(Math.round(plan.share * 100), 76);
  assert.equal(plan.hopeless, false);
});

test('the 24,463 MiB RTX 5090 Laptop of the 2026-10-29 report: the model\'s room at the service start is 10.7 GB with OmniVoice loaded or still to load, 13.2 GB with it off (it was 5.8 and 8.3 GB)', () => {
  const total = 24463, desktop = 1000;
  const at = (voice, limits) => smallCardRoom({totalMiB: total, freeMiB: total - desktop - (voice === 'resident' ? 2500 : 0), voiceMiB: voice === 'to-load' ? 2500 : 0, residentVoiceMiB: voice === 'resident' ? 2500 : 0, ...(limits ? {limits} : {})});
  const before = {...SMALL_CARD_ROOM, bigGameCapMiB: 15360};
  // Before: 62% of the card, 15,167 MiB, kept for the game.
  assert.equal(gameRoomMiB(total, before), 15167);
  assert.deepEqual(['resident', 'to-load', 'off'].map(voice => at(voice, before).modelMiB), [5796, 5796, 8296], 'the numbers of the report: a 12B with 8,800 MiB (file plus headroom) did not fit any of them');
  // Now: the room a 16 GB card gets.
  assert.equal(gameRoomMiB(total), 10240);
  assert.deepEqual(['resident', 'to-load', 'off'].map(voice => at(voice).modelMiB), [10723, 10723, 13223]);
  // The voice engine is counted once: resident (in the used memory, not the game's) or still to load (taken out of the free memory), never both.
  assert.equal(at('resident').voiceMiB, 0);
  assert.equal(at('to-load').voiceMiB, 2500);
  // The game already in the world, OmniVoice resident, the model unloaded (a restart): the game's footprint is measured, nothing is kept twice.
  const inWorld = smallCardRoom({totalMiB: total, freeMiB: 3900, residentVoiceMiB: 2500});
  assert.deepEqual([inWorld.gameUsedMiB, inWorld.reserveMiB, inWorld.modelMiB], [17063, 0, 3900]);
  // Cards up to 16 GB keep exactly the numbers they had.
  assert.equal(smallCardRoom({totalMiB: 16376, freeMiB: 15000}).modelMiB, smallCardRoom({totalMiB: 16376, freeMiB: 15000, limits: before}).modelMiB);
  assert.equal(smallCardRoom({totalMiB: 11997, freeMiB: 11229}).modelMiB, 3791, 'the 12 GB card of the tests is untouched');
  assert.equal(smallCardRoom({totalMiB: 8232, freeMiB: 7461}).modelMiB, 2933, 'and so is the 8 GB card');
});

test('the ladder worked out again for less room keeps its projections and picks the rung that still fits (a vision projector takes memory first)', () => {
  const projections = [{contextSize: 16384, kvType: null, projectedMiB: 3734}, {contextSize: 8192, kvType: null, projectedMiB: 3598}, {contextSize: 8192, kvType: 'q8_0', projectedMiB: 3520}];
  const fit = {projections, pick: projections[0], share: 1, marginMiB: 512};
  assert.equal(fitAgainst(fit, 4246).pick.contextSize, 16384, 'with the room it had');
  const less = fitAgainst(fit, 4246 - 100);
  assert.deepEqual([less.pick.contextSize, less.pick.kvType], [8192, null], '100 MiB less: the next rung');
  assert.deepEqual([fitAgainst(fit, 4246 - 180).pick.contextSize, fitAgainst(fit, 4246 - 180).pick.kvType], [8192, 'q8_0'], '180 MiB less: the 8-bit cache');
  assert.equal(fitAgainst(fit, 4031).pick, null, 'no rung fits');
  assert.equal(fitAgainst(fit, 4031).share < 1, true, 'and the share of the layers on the card is worked out for the offload placement');
  assert.deepEqual(fitAgainst(fit, 4246).projections, projections);
  assert.equal(fitAgainst(fit, 5000, 100).marginMiB, 100);
  assert.equal(fitAgainst(fit, 4300).marginMiB, 512, 'the margin of the first look is kept');
  assert.deepEqual(fitAgainst(null, 5000), {projections: [], pick: null, share: null, marginMiB: FIT_LIMITS.marginMiB});
  assert.deepEqual(fitAgainst(fit, NaN).pick, null);
});
