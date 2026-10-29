// Back to the card: a Local AI model that loaded into shared system memory (the game held the graphics memory at that moment) goes back onto the card when the
// memory is free again (docs/LOCAL_AI.md, "Back to the card").
//
// Report 931d4563 (RTX 5090, 32 GB, Gemma 4 E4B uncensored): the model was loaded at the game's start with 31 GB free, the game then took the card, the driver moved 4,308 MiB of the
// model into shared memory, and the supervisor found "nothing can replace it" with 2,011 MiB free. It then stayed there for the whole session: 1.9 generated tokens a second, replies of 25 to 30 s,
// and OmniVoice (which renders V's line beside the reply's text) starved by the model's GPU work until the text was done. Nothing ever looked again.
//
// What is decided here are pure rules: when a look is allowed, how far apart looks are, how much room a return needs. The supervisor (bridge/local-llm-server.mjs) owns the
// state and the process work. Nothing here runs per frame or per turn: a look is one free-memory reading (nvidia-smi), made at an idle moment after a request ended, at most
// once per back-off step, and never while a turn is being served.

export const RETURN_LIMITS = Object.freeze({
  firstLookMs: 60_000,        // the first look comes no sooner than this after the model was found off the card
  // The gap before the next look after a look that found too little room: 1, 2, 5, 10 and then 15 minutes (the last repeats). A game that holds the card for an hour is asked 4 times an hour.
  backoffMs: Object.freeze([60_000, 120_000, 300_000, 600_000, 900_000]),
  quietMs: 20_000,            // a look waits until no request has been in flight for this long (the reply is published and its voice has been rendered)
  confirmGapMs: 30_000,       // enough room must be seen twice, this far apart, before anything is loaded (a loading screen that frees the card for a moment is not room)
  confirmReadings: 2,
  roomKeptMiB: 1024,          // free graphics memory that stays free for the game beyond the fit's own margin (FIT_LIMITS.marginMiB, 512): 1,536 MiB in all
  floorShare: 0.6,            // under this share of the model file's size a fit run is not even started
  ramNeedMiB: 3072,           // free system memory a second server needs while the first one still answers
  maxReturns: 2,              // returns per session; a model that is pushed out again after two returns stays where it is
  maxFailedLooks: 3,          // loads that failed or came up in shared memory again: the watch ends
  prepareMaxMs: 240_000,      // the new server may take this long to load, warm up and wait for an idle moment
  retireMaxMs: 60_000,        // after the grace the old server waits for the requests still on it for this long at most, then it is stopped
  releaseGraceMs: 8_000,      // the old server keeps answering this long after the switch (a caller that was handed its address a moment before), then it is stopped
});

/** The gap (ms) before the next look after `looks` looks that found too little room (1 for the first). */
export function returnBackoffMs(looks, limits = RETURN_LIMITS) {
  const steps = limits.backoffMs;
  const index = Math.max(0, Math.min(steps.length - 1, Math.floor(Number(looks) || 1) - 1));
  return steps[index];
}

/**
 * The graphics memory (MiB) the model may take on a return: what is free now, less a voice engine that is still to load, less the room kept for the game. Can be negative.
 * The old server's own graphics memory is NOT added back: it keeps answering until the new one is ready, so the new one must fit beside it.
 */
export function returnAvailableMiB({freeMiB, voiceMiB = 0, limits = RETURN_LIMITS} = {}) {
  if (!Number.isFinite(freeMiB)) return null;
  const voice = Number.isFinite(voiceMiB) && voiceMiB > 0 ? voiceMiB : 0;
  return freeMiB - voice - limits.roomKeptMiB;
}

/** Is the model, as loaded, one a return can help (a model of ours, off the card or part of it)? `spilled`: the last counters read said so. */
export function returnCandidate({loaded, external = false, spilled = false} = {}) {
  if (!loaded || external || loaded.external === true) return false;
  return spilled === true || loaded.offload === true;
}

/**
 * Why a look must wait right now, or null. `{why, retryMs}`: retryMs is when to try again (null: the end of the request that blocks will say). All times are the supervisor's clock.
 */
export function lookRefusal({now, nextAt, inflight, foregroundEndedAt, background, busy, stepping, limits = RETURN_LIMITS} = {}) {
  if (busy) return {why: 'a look or a load is already under way', retryMs: null};
  if (stepping) return {why: 'the model is being changed', retryMs: null};
  if (inflight > 0) return {why: 'a request is being served', retryMs: null};
  if (background) return {why: 'background work holds the model', retryMs: null};
  if (now < nextAt) return {why: 'not yet, the back-off has not run out', retryMs: nextAt - now};
  const quiet = foregroundEndedAt + limits.quietMs - now;
  if (quiet > 0) return {why: 'a turn ended a moment ago', retryMs: quiet};
  return null;
}

/**
 * The verdict of a look from the numbers alone. `projections`: the fit's rungs ({contextSize, kvType, projectedMiB|null}), largest context first, or null when none is known yet.
 * Returns {enough, pick, needMiB}: `pick` is the first rung whose projection plus `marginMiB` fits `availableMiB`; `needMiB` is the smallest projection plus margin (null when unknown).
 */
export function returnVerdict({availableMiB, projections, marginMiB}) {
  const known = (projections ?? []).filter(rung => Number.isFinite(rung?.projectedMiB) && rung.projectedMiB > 0);
  const needMiB = known.length ? Math.min(...known.map(rung => rung.projectedMiB)) + marginMiB : null;
  const pick = Number.isFinite(availableMiB) ? known.find(rung => rung.projectedMiB + marginMiB <= availableMiB) ?? null : null;
  return {enough: pick !== null, pick, needMiB};
}
