// The maths of the media channel (music beds and sound effects of a story pack, docs/BOND_QUESTS.md 19.2 and 19.3): gains, fades, ducking and pan. Pure functions with no
// imports, so the hidden browser page can load this file as it is (bridge/media-engine.mjs does) and the tests can check the numbers without a browser.
//
// The page never computes a gain per sample or per frame: a fade is a Web Audio automation (setValueAtTime and linearRampToValueAtTime points, which these functions
// return) and ducking is one setTargetAtTime. `gainAt` below evaluates the same points the way Web Audio does, for the tests and for reading a plan.

export const MEDIA = Object.freeze({
  rate: 48000,                 // the rate pack audio is decoded to for the media channel (mono)
  packetFrames: 96000,         // frames per packet to the page (2 s)
  maxItems: 8,                 // sounds playing at once
  maxFrames: 48000 * 300,      // 5 minutes of mono: the longest music bed
  maxSfxSeconds: 30,
  maxBytes: 64 * 1024 * 1024,  // decoded buffers the page keeps (32 bit float samples)
  duckGain: 0.3,               // about -10 dB under any speech
  duckAttack: 0.25,            // seconds to get down under speech (the voice's first word must be clear)
  duckRelease: 0.9,            // seconds to come back after the last speech
  minFade: 0.03,               // a stop or a change is never shorter than this (no click)
  maxFade: 10,
});

export const clamp = (value, low, high) => Math.min(high, Math.max(low, Number.isFinite(value) ? value : low));
export const clampVolume = value => clamp(value, 0, 1);
export const clampPan = value => clamp(value, -1, 1);
export const clampFade = value => clamp(value, 0, MEDIA.maxFade);

/**
 * The automation points for a sound that starts now. Points are {time, value, ramp}: ramp false = setValueAtTime, true = linearRampToValueAtTime.
 * fadeIn: seconds from silence to `volume`. duration (seconds, null for a loop or an unknown length) with fadeOut: the sound fades out to end at its last sample.
 */
export function startEnvelope({now, volume, fadeIn = 0, fadeOut = 0, duration = null, loop = false}) {
  const level = clampVolume(volume), up = clampFade(fadeIn), down = clampFade(fadeOut);
  const points = [];
  if (up >= MEDIA.minFade) { points.push({time: now, value: 0, ramp: false}, {time: now + up, value: level, ramp: true}); }
  else points.push({time: now, value: level, ramp: false});
  if (!loop && Number.isFinite(duration) && duration > 0 && down >= MEDIA.minFade) {
    const length = Math.min(down, duration), from = Math.max(now + up, now + duration - length);
    points.push({time: from, value: level, ramp: false}, {time: now + duration, value: 0, ramp: true});
  }
  return points;
}

/** Fading from where the sound is now (`current`) to `target` over `seconds` (at least MEDIA.minFade). The caller cancels earlier points first. */
export function rampTo({now, current, target, seconds}) {
  const length = Math.max(MEDIA.minFade, clampFade(seconds));
  return [{time: now, value: clamp(current, 0, 1), ramp: false}, {time: now + length, value: clampVolume(target), ramp: true}];
}

/** A stop: fade to silence, and the time the source can be stopped (the end of the fade). */
export function stopPlan({now, current, fadeOut}) {
  const points = rampTo({now, current, target: 0, seconds: fadeOut});
  return {points, stopAt: points[1].time};
}

/** The ducking bus: its target gain and the time constant of setTargetAtTime (about a third of the wanted fade, the exponential is within 5 percent after three). */
export function duckTarget(on) {
  return on ? {target: MEDIA.duckGain, timeConstant: MEDIA.duckAttack / 3} : {target: 1, timeConstant: MEDIA.duckRelease / 3};
}

/**
 * Where a sound sits: 'bed' and 'v' are centred (V's own sound, and a non-positional bed), 'copy' (the speaking copy) takes the pan the game sends (the same -1 to 1 the speech
 * lease carries), flat when it sent none. A place:<id> loop is steered by the game (fade ops carry pan); it starts flat.
 */
export function panFor(at, pan) {
  return at === 'copy' && Number.isFinite(pan) ? clampPan(pan) : 0;
}

/** The value of a gain automation at time `t`, the way Web Audio evaluates setValueAtTime and linearRampToValueAtTime points (a ramp starts at the point before it). */
export function gainAt(points, t, initial = 0) {
  let previous = {time: -Infinity, value: initial};
  for (const point of [...points].sort((a, b) => a.time - b.time)) {
    if (point.time > t) {
      if (point.ramp && previous.time > -Infinity) return previous.value + (point.value - previous.value) * (t - previous.time) / (point.time - previous.time);
      return previous.value;
    }
    previous = point;
  }
  return previous.value;
}

/** The gain of the ducking bus `seconds` after setTargetAtTime(target, 0, timeConstant) started from `from`. */
export function duckAt(from, target, timeConstant, seconds) {
  return target + (from - target) * Math.exp(-Math.max(0, seconds) / timeConstant);
}

/** How long a sound lasts, in seconds, from its frame count and rate. */
export const secondsOf = (frames, rate = MEDIA.rate) => frames / rate;
