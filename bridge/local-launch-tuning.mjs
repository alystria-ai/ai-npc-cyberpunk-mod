// Extra llama-server launch flags that can be switched on without a new build, for measuring and for undoing (docs/LOCAL_AI_PERFORMANCE.md).
//
// The mod's own flags (bridge/local-llm-server.mjs buildServerArgs: -fa on, --swa-full when the card has room, one slot, --cache-ram, --ctx-checkpoints, -fit, the
// threads of an offloaded load) are not touched here. This module only adds flags the research in docs/LOCAL_AI_PERFORMANCE.md found worth a measurement on the
// player's own machine, each one off until the measurement (scripts/Bench-LocalAiLaunch.mjs) says it helps:
//
//   CYBERPUNK_CONVAI_LOCAL_TUNING = "name=value,name=value"      (commas or spaces between entries, unknown names and bad values are ignored)
//
//   checkpoint-step=N   -cms N       the least spacing in tokens between saved context checkpoints, 0 to 1,000,000 (llama-server's own default is 8,192)
//   cache-reuse=N       --cache-reuse N   reuse chunks of at least N tokens by KV shifting, 16 to 4,096 (only a model whose cache can shift; others ignore it)
//   threads=N           -t N -tb N   CPU threads of a load that is wholly on the card, 1 to 32 (an offloaded load keeps its own cap)
//   poll=N              --poll N     how long idle CPU threads spin before they sleep, 0 to 100 (llama-server's default is 50)
//   ubatch=N            -ub N        the physical batch of the prompt read, 64 to 4,096 (llama-server's default is 512)
//   backend-sampling    -bs          sampling on the card (llama.cpp marks it experimental)
//
// Nothing here runs per frame or per turn: the flags are read once when the model server is started.

export const TUNING_VARIABLE = 'CYBERPUNK_CONVAI_LOCAL_TUNING';

// What is on by default. Empty until a measurement on the player's kind of machine shows a gain (docs/LOCAL_AI_PERFORMANCE.md, "Decisions").
export const DEFAULT_TUNING = Object.freeze({});

const INTEGER = (name, flags, min, max, {gpuOnly = false} = {}) => ({name, flags, min, max, gpuOnly});
const KNOBS = Object.freeze([
  INTEGER('checkpoint-step', ['-cms'], 0, 1_000_000),
  INTEGER('cache-reuse', ['--cache-reuse'], 16, 4096),
  INTEGER('threads', ['-t', '-tb'], 1, 32, {gpuOnly: true}),
  INTEGER('poll', ['--poll'], 0, 100),
  INTEGER('ubatch', ['-ub'], 64, 4096),
]);
const SWITCHES = Object.freeze({'backend-sampling': ['-bs']});

/** The text of the variable as {name: number | true}, with unknown names, bad numbers and out of range values left out. */
export function parseTuning(text) {
  const out = {};
  for (const part of String(text ?? '').split(/[,\s]+/)) {
    if (!part) continue;
    const [rawName, rawValue] = part.split('=', 2);
    const name = rawName.trim().toLowerCase();
    if (rawValue === undefined) { if (SWITCHES[name]) out[name] = true; continue; }
    const knob = KNOBS.find(item => item.name === name);
    if (!knob || !/^\d{1,7}$/.test(rawValue.trim())) continue;
    const value = Number(rawValue);
    if (value >= knob.min && value <= knob.max) out[name] = value;
  }
  return out;
}

/**
 * The extra arguments for one load.
 * `environment`: the process environment (the variable above). `defaults`: DEFAULT_TUNING (a test passes its own). `offload`: the load keeps layers on the CPU and
 * already sets its own `-t`, so `threads` is left out of it. `taken`: flags buildServerArgs already puts on the command line; a knob that would repeat one is dropped.
 * Returns {args: string[], applied: {name: value}, text: string}: `text` is one log phrase ('' when nothing is applied).
 */
export function resolveLaunchTuning({environment = process.env, defaults = DEFAULT_TUNING, offload = false, taken = []} = {}) {
  const wanted = {...defaults, ...parseTuning(environment?.[TUNING_VARIABLE])};
  const args = [], applied = {};
  for (const knob of KNOBS) {
    const value = wanted[knob.name];
    if (!Number.isInteger(value) || value < knob.min || value > knob.max) continue;
    if (knob.gpuOnly && offload) continue;
    if (knob.flags.some(flag => taken.includes(flag))) continue;
    args.push(...knob.flags.flatMap(flag => [flag, String(value)]));
    applied[knob.name] = value;
  }
  for (const [name, flags] of Object.entries(SWITCHES)) {
    if (wanted[name] !== true || flags.some(flag => taken.includes(flag))) continue;
    args.push(...flags);
    applied[name] = true;
  }
  const text = Object.entries(applied).map(([name, value]) => value === true ? name : `${name}=${value}`).join(', ');
  return {args, applied, text};
}
