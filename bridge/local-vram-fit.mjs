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
 *   share   the part of the model's layers the card can hold with the fit pass's own margin left (0 to 1; 1 when `pick` exists): what the 8,192 rung needs against
 *           what is free beyond FIT_LIMITS.offloadTargetMiB. Null when no projection is known.
 * `probe(rung)` resolves a rung's projected MiB or null. The rungs are probed at once.
 */
export async function fitLadder({freeMiB, marginMiB = FIT_LIMITS.marginMiB, probe, ladder = FIT_LIMITS.ladder} = {}) {
  const projections = await Promise.all(ladder.map(async rung => {
    let projectedMiB = null;
    try { projectedMiB = await probe(rung); } catch { /* no projection */ }
    return {contextSize: rung.contextSize, kvType: rung.kvType, projectedMiB: Number.isFinite(projectedMiB) && projectedMiB > 0 ? projectedMiB : null};
  }));
  const pick = projections.find(rung => rung.projectedMiB !== null && Number.isFinite(freeMiB) && rung.projectedMiB + marginMiB <= freeMiB) ?? null;
  const reference = projections.find(rung => rung.projectedMiB !== null && rung.contextSize === 8192 && !rung.kvType) ?? projections.find(rung => rung.projectedMiB !== null);
  let share = null;
  if (pick) share = 1;
  else if (reference && Number.isFinite(freeMiB)) share = Math.max(0, Math.min(1, (freeMiB - FIT_LIMITS.offloadTargetMiB) / reference.projectedMiB));
  return {projections, pick, share};
}

/** One line for the log: the projections against the free memory and what was decided. */
export function describeFit(fit, freeMiB, marginMiB) {
  const rungs = fit.projections.map(rung => `${rung.projectedMiB === null ? '?' : rung.projectedMiB} MiB at ${rung.contextSize}${rung.kvType ? ' ' + rung.kvType : ''}`).join(', ');
  const decision = fit.pick ? `the whole model fits: context ${fit.pick.contextSize}${fit.pick.kvType ? ', ' + fit.pick.kvType + ' cache' : ''}`
    : fit.share === null ? 'no projection: the file-size rule stands' : `it does not fit whole, about ${Math.round(fit.share * 100)}% of the layers can stay on the card`;
  return `projected ${rungs} against ${Number.isFinite(freeMiB) ? Math.round(freeMiB) : '?'} MiB free (room kept ${marginMiB} MiB): ${decision}`;
}
