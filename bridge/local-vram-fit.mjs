// Does the chat model really fit the graphics memory that is free? (docs/LOCAL_AI.md, "Free-memory fit")
//
// llama.cpp can say it before anything is allocated: `llama-fit-params` (shipped beside llama-server) loads only the model's metadata and prints
// "projected to use N MiB of device memory vs. M MiB of free device memory" in about 1.5 s, with no graphics memory taken. That is how Ollama sizes a load
// (it asks the same llama-server fit pass); the "file size plus fixed headroom" rule of bridge/local-model-choice.mjs overstates a Gemma 4 E4B model by about
// 3 GB, because its per-layer embedding table stays in system memory (measured 2026-10-20, RTX 4080 Laptop: Gemma 4 E4B Mature good, 5,088 MiB file,
// projected 3,734 MiB at 16,384 context, 3,398 MiB really used).
//
// Used only when the file-size rule says a model the player chose does not fit (never on a card with room: no probe is started then), and after a spill.
// Pure functions plus one injectable process runner; nothing here runs per frame or per turn.
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';

export const FIT_LIMITS = Object.freeze({
  marginMiB: 512,          // free memory that must remain beyond the projection for the whole model to be loaded on the card (the projection itself is about 330 MiB above what is used)
  refitMarginMiB: 1024,    // the same after the driver spilled the model into shared memory: the game showed it wants the room
  offloadTargetMiB: 1024,  // llama-server's own default `--fit-target`: the room its fit pass leaves when layers go to the CPU
  hopelessShare: 0.35,     // below this share of the layers on the card a model is CPU-bound (36 to 54 prompt tokens a second in the 2026-10-19 reports)
  // Partial offload (the model does not fit whole: `-fit on`, no `-ngl`; docs/LOCAL_AI.md, "Partial offload"). Context 8,192 with the 8-bit cache: the smallest placement the prompt budget still serves.
  offloadContext: 8192,
  offloadKvType: 'q8_0',
  offloadGameRoomMiB: 1792,   // the `-fitt` of an offloaded load: free memory the fit pass leaves on the card for the game (about 1.75 GiB; llama-server's own default is 1,024)
  offloadFixedMiB: 1100,      // the part of a projection that stays on the card with every layer on the CPU (compute buffers; measured 1,002 MiB Qwen3.5-4B and 1,057 MiB Gemma 4 E4B at 8,192 / q8_0)
  offloadEstimateExtraMiB: 700,   // no projection: the file plus this (Qwen3.5-4B Q4_K_M: 2,582 MiB file, 3,271 projected)
  offloadRamHeadroomMiB: 1024,   // system memory kept beyond the CPU part of an offloaded model and its cache (the process itself, the prompt cache, the game and Windows)
  offloadMaxThreads: 6,       // CPU threads of an offloaded load: the CPU part is bound by memory bandwidth, more threads only take cores from the game
  probeMs: 15_000,
  // Largest first. 16,384 is the normal context; 8,192 is what the prompt budget still serves (the persona and rules are about 4.5k tokens); q8_0 saves another 75 to 135 MiB.
  ladder: Object.freeze([
    Object.freeze({contextSize: 16384, kvType: null}),
    Object.freeze({contextSize: 8192, kvType: null}),
    Object.freeze({contextSize: 8192, kvType: 'q8_0'}),
  ]),
});

const PROJECTION = /projected to use (\d+) MiB of device memory vs\. (\d+) MiB of free device memory/;

/** The projection line of `llama-fit-params`: {projectedMiB, freeMiB}, or null when the text has none. */
export function parseProjection(text) {
  const match = PROJECTION.exec(String(text ?? ''));
  return match ? {projectedMiB: Number(match[1]), freeMiB: Number(match[2])} : null;
}

/** The fit tool beside llama-server (`llama-fit-params(.exe)` in the same folder), or null when it is not there (an older pack, a test's stand-in server). */
export function fitToolPath(serverCommand, {exists = existsSync, platform = process.platform} = {}) {
  if (typeof serverCommand !== 'string' || !serverCommand) return null;
  const path = join(dirname(serverCommand), platform === 'win32' ? 'llama-fit-params.exe' : 'llama-fit-params');
  return exists(path) ? path : null;
}

/**
 * Asks llama-fit-params for the memory a load would use: resolves the projected MiB, or null (no tool, a failure, no answer in `timeoutMs`). The tool goes on to search
 * a layer split when the model does not fit, which takes 10 s and more, so it is stopped at its first projection line.
 * `spawnImpl` and `timers` are injectable for tests.
 */
export function probeProjectedMiB({exe, model, contextSize, kvType = null, device, timeoutMs = FIT_LIMITS.probeMs, spawnImpl = spawn, setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
  if (!exe || !model || !device) return Promise.resolve(null);
  const args = ['-m', model, '-c', String(contextSize), '-fa', 'on', '--device', device, '-fitt', '0', '-lv', '4', ...(kvType ? ['-ctk', kvType, '-ctv', kvType] : [])];
  return new Promise(resolveProbe => {
    let child, text = '', done = false, timer = null;
    const finish = value => {
      if (done) return;
      done = true;
      if (timer) clearTimer(timer);
      try { child?.kill(); } catch { /* gone */ }
      resolveProbe(value);
    };
    try { child = spawnImpl(exe, args, {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']}); } catch { finish(null); return; }
    const take = chunk => {
      text = (text + chunk).slice(-8000);
      const found = parseProjection(text);
      if (found) finish(found.projectedMiB);
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.once('error', () => finish(null));
    child.once('exit', () => finish(parseProjection(text)?.projectedMiB ?? null));
    timer = setTimer(() => finish(null), timeoutMs);
    timer?.unref?.();
  });
}

/**
 * The context ladder against the free memory: {projections: [{contextSize, kvType, projectedMiB|null}], pick, share}.
 *   pick    the first rung (largest context first) whose projection plus `marginMiB` fits `freeMiB`: the model goes whole onto the card; null when none does
 *   share   the part of the model's layers the card can hold with the game's room (FIT_LIMITS.offloadGameRoomMiB) left free (0 to 1; 1 when `pick` exists): offloadPlan of the
 *           8,192 / 8-bit rung. Null when no projection is known.
 * `probe(rung)` resolves a rung's projected MiB or null. The rungs are probed at once.
 */
export async function fitLadder({freeMiB, marginMiB = FIT_LIMITS.marginMiB, probe, ladder = FIT_LIMITS.ladder} = {}) {
  const projections = await Promise.all(ladder.map(async rung => {
    let projectedMiB = null;
    try { projectedMiB = await probe(rung); } catch { /* no projection */ }
    return {contextSize: rung.contextSize, kvType: rung.kvType, projectedMiB: Number.isFinite(projectedMiB) && projectedMiB > 0 ? projectedMiB : null};
  }));
  const pick = projections.find(rung => rung.projectedMiB !== null && Number.isFinite(freeMiB) && rung.projectedMiB + marginMiB <= freeMiB) ?? null;
  // The placement a model that does not fit whole gets is the offload one (context 8,192, the 8-bit cache, the game's room kept free): the share is worked out for it (offloadPlan).
  const reference = projections.find(rung => rung.projectedMiB !== null && rung.contextSize === FIT_LIMITS.offloadContext && rung.kvType === FIT_LIMITS.offloadKvType)
    ?? projections.find(rung => rung.projectedMiB !== null && rung.contextSize === 8192 && !rung.kvType) ?? projections.find(rung => rung.projectedMiB !== null);
  let share = null;
  if (pick) share = 1;
  else if (reference && Number.isFinite(freeMiB)) share = offloadPlan({projectedMiB: reference.projectedMiB, freeMiB}).share;
  return {projections, pick, share};
}

/**
 * Where a model that does not fit whole goes when part of it runs on the CPU: {share, projectedMiB, estimated, hopeless, ...}.
 *   projectedMiB   llama-fit-params' projection for the offload placement (FIT_LIMITS.offloadContext, offloadKvType); null when there is none
 *   sizeMiB        the model file, used for an estimate when there is no projection (file + offloadEstimateExtraMiB)
 *   share          the part of the layers the card can hold with `targetMiB` (the game's room) left free: (free - target - fixed) / (projected - fixed), 0 to 1, where `fixed` is the
 *                  part of the projection that does not shrink when layers move to the CPU. This matches llama-fit-params' own layer count to within a few percent (Qwen3.5-4B, target
 *                  leaving 1,676 MiB: 10 of 33 layers, 30%; the formula says 30%; Gemma 4 E4B: 13 of 43, 30%, formula 27%). 1 when the projection fits whole; null when it cannot be said
 *                  (no free-memory reading, or neither a projection nor a file size): then nothing is refused.
 *   hopeless       share under FIT_LIMITS.hopelessShare: the model runs mostly on the processor (36 to 54 prompt tokens a second in the 2026-10-19 reports, 200 and 2 at 0%). It is still loaded
 *                  (owner decision 2026-10-21): the player is told once that replies will be slow.
 */
export function offloadPlan({projectedMiB, sizeMiB, freeMiB, targetMiB = FIT_LIMITS.offloadGameRoomMiB} = {}) {
  const measured = Number.isFinite(projectedMiB) && projectedMiB > 0;
  const projected = measured ? projectedMiB : Number.isFinite(sizeMiB) && sizeMiB > 0 ? Math.ceil(sizeMiB) + FIT_LIMITS.offloadEstimateExtraMiB : null;
  let share = null;
  if (projected !== null && Number.isFinite(freeMiB)) {
    const room = freeMiB - targetMiB;
    const fixed = Math.min(FIT_LIMITS.offloadFixedMiB, projected / 2);
    share = projected <= room ? 1 : Math.max(0, Math.min(1, (room - fixed) / Math.max(1, projected - fixed)));
  }
  return {share, projectedMiB: projected, estimated: projected !== null && !measured, targetMiB, contextSize: FIT_LIMITS.offloadContext, kvType: FIT_LIMITS.offloadKvType,
    hopeless: share !== null && share < FIT_LIMITS.hopelessShare};
}

/**
 * System memory (MiB) an offloaded load needs for the part that stays on the processor: that part of the weights (memory-mapped from the file) and of the KV cache (about 12% of the weights at
 * 8,192 context with the 8-bit cache, at least 300 MiB for all layers), plus FIT_LIMITS.offloadRamHeadroomMiB. Null when the share or the model size is unknown (nothing is refused then).
 */
export function offloadRamNeedMiB({share, sizeMiB, projectedMiB} = {}) {
  if (!Number.isFinite(share)) return null;
  const weights = Number.isFinite(sizeMiB) && sizeMiB > 0 ? sizeMiB : Number.isFinite(projectedMiB) && projectedMiB > 0 ? projectedMiB : null;
  if (weights === null) return null;
  const cpuShare = Math.max(0, Math.min(1, 1 - share));
  if (cpuShare === 0) return null;
  return Math.ceil(cpuShare * (weights + Math.max(300, 0.12 * weights)) + FIT_LIMITS.offloadRamHeadroomMiB);
}

/**
 * CPU threads for an offloaded load: about half of the physical cores, so the game's CPU is not starved (2 to offloadMaxThreads). Node reports logical processors; a computer with
 * two threads per core (nearly every gaming CPU) has half as many cores, and half of those is a quarter of what is reported.
 */
export function offloadThreads(logicalCpus) {
  const logical = Number.isFinite(logicalCpus) && logicalCpus > 0 ? Math.floor(logicalCpus) : 8;
  return Math.max(2, Math.min(FIT_LIMITS.offloadMaxThreads, Math.round(logical / 4)));
}

/** One line for the log: the projections against the free memory and what was decided. */
export function describeFit(fit, freeMiB, marginMiB) {
  const rungs = fit.projections.map(rung => `${rung.projectedMiB === null ? '?' : rung.projectedMiB} MiB at ${rung.contextSize}${rung.kvType ? ' ' + rung.kvType : ''}`).join(', ');
  const decision = fit.pick ? `the whole model fits: context ${fit.pick.contextSize}${fit.pick.kvType ? ', ' + fit.pick.kvType + ' cache' : ''}`
    : fit.share === null ? 'no projection: the file-size rule stands' : `it does not fit whole, about ${Math.round(fit.share * 100)}% of the layers can stay on the card`;
  return `projected ${rungs} against ${Number.isFinite(freeMiB) ? Math.round(freeMiB) : '?'} MiB free (room kept ${marginMiB} MiB): ${decision}`;
}

/**
 * Room for the game on a small card, worked out when the model is first placed (2026-10-22, LordValerius's 0.2.7 report: an RTX 3070 with 8 GB; Local AI took 7,461 MiB free at the
 * game's start and loaded whole, the game and OmniVoice then took the card, 3,209 MiB of the model went into shared system memory, and a spill reload 10 minutes into play ended with 0% of
 * the layers on the card after 52 s of full CPU). The service starts with the game, before the game has allocated anything, so the free memory it reads is memory the game is about to take.
 * On a card of `maxCardMiB` or less the model is placed against what is left after the game's room and the voice engine that is still to load.
 *   gameShare / gameCapMiB / gameFloorMiB   the game's room: 55% of the card, at least 3,000 MiB (the old reserve of bridge/local-model-choice.mjs), at most 4,608 MiB. The 8 GB card of the report
 *                  (8,232 MiB) gets 4,528 MiB; the same report showed the game holding about 4.3 GB beside OmniVoice (8,232 - 659 MiB left - 2.5 GB OmniVoice - 0.77 GB used at the menu)
 *   omniVoiceMiB   OmniVoice's resident size (docs/RESOURCE_LIFECYCLE.md, about 2.5 GB); Pocket runs on the CPU and takes none
 *   desktopMiB     what the desktop and other programs hold on any card (the report's 0.77 GB at the menu, rounded up): not the game's, so not counted against its room
 *   bigCardAboveMiB / bigGameShare / bigGameCapMiB   a card ABOVE 9,216 MiB (10 and 12 GB cards; a card of 8 GB or less keeps the three numbers above, unchanged) gets a larger room: 62% of the card, at most 7,680 MiB.
 *                  2026-10-22, report 931d4563 (RTX 4070 12 GB, Qwen3.5-4B, Pocket): the card read 12,010 MiB with 11,242 MiB free at the service start (768 MiB for the desktop). In the world, with the model
 *                  unloaded, 3,758 MiB were free: 8,252 MiB used, of which about 7,480 MiB were the game (8,252 - 768), 62% of the card and about 2.9 GB more than the 4,608 MiB cap. The model, placed whole
 *                  against 11,242 - 4,608 = 6,634 MiB, then lost 993 MiB to shared system memory, stalled at the 75 s limit and was reloaded at 40% of its layers. The game takes what the card has to give, so the
 *                  room is a share of the card: 62% is 7,446 MiB on that card (7,438 on a card that reads 11,997, 6,349 on a 10 GB card), the cap 7,680 MiB. One report: the live check is the
 *                  "graphics memory of the model server after ..." lines of 12 GB installs.
 *   Reserved only for what the game has NOT taken yet (2026-10-22 review, A1): the game's footprint is measured (card total - free - a resident voice engine - desktopMiB) and subtracted from the room, so a service
 *   restarted mid-play, or a quick Continue that has the game and OmniVoice on the card already, keeps nothing back twice. Nothing depends on how long the service has run.
 */
export const SMALL_CARD_ROOM = Object.freeze({maxCardMiB: 12288, gameShare: 0.55, gameCapMiB: 4608, gameFloorMiB: 3000, omniVoiceMiB: 2500, desktopMiB: 1000,
  bigCardAboveMiB: 9216, bigGameShare: 0.62, bigGameCapMiB: 7680});

/** The game's room (MiB) on a card of this size, or 0 for a card above SMALL_CARD_ROOM.maxCardMiB or an unknown one. */
export function gameRoomMiB(totalMiB, limits = SMALL_CARD_ROOM) {
  if (!(Number.isFinite(totalMiB) && totalMiB > 0 && totalMiB <= limits.maxCardMiB)) return 0;
  // A card above 9 GB (10 and 12 GB): the game was measured holding 62% of a 12 GB card (see SMALL_CARD_ROOM); 8 GB cards and smaller keep the first, smaller numbers.
  const big = totalMiB > limits.bigCardAboveMiB;
  const share = big ? limits.bigGameShare : limits.gameShare, cap = big ? limits.bigGameCapMiB : limits.gameCapMiB;
  return Math.round(Math.max(limits.gameFloorMiB, Math.min(cap, totalMiB * share)));
}

/**
 * {totalMiB, freeMiB, reserveMiB, voiceMiB, modelMiB, gameRoomMiB, gameUsedMiB}, or null on a card with no reserve or with no free-memory reading. reserveMiB is the room the game has not taken yet
 * (the whole room at the game's start, 0 once the game holds it); modelMiB is what the model may take, never below 0. `residentVoiceMiB` is a voice engine that is already loaded (it is in the used
 * memory but is not the game's); `voiceMiB` is one still to load.
 */
export function smallCardRoom({totalMiB, freeMiB, voiceMiB = 0, residentVoiceMiB = 0, limits = SMALL_CARD_ROOM} = {}) {
  const gameRoom = gameRoomMiB(totalMiB, limits);
  if (gameRoom <= 0 || !Number.isFinite(freeMiB)) return null;
  const voice = Number.isFinite(voiceMiB) && voiceMiB > 0 ? voiceMiB : 0;
  const resident = Number.isFinite(residentVoiceMiB) && residentVoiceMiB > 0 ? residentVoiceMiB : 0;
  const gameUsedMiB = Math.max(0, Math.round(totalMiB - freeMiB - resident - (limits.desktopMiB ?? 0)));
  const reserveMiB = Math.max(0, gameRoom - gameUsedMiB);
  return {totalMiB, freeMiB, reserveMiB, voiceMiB: voice, modelMiB: Math.max(0, Math.round(freeMiB - voice - reserveMiB)), gameRoomMiB: gameRoom, gameUsedMiB};
}
