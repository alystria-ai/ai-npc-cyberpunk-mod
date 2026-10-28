// How long the first sound of an OmniVoice reply should wait so that the rest of the reply is rendered by the time the first part has been played.
//
// OmniVoice renders one phrase at a time on one worker, and a render costs a fixed 1.4 to 1.7 s on a quiet GPU whatever its length up to about 5 s of speech
// (+0.1 s per further second); in the game the GPU is shared and a render takes 0.8 to 2.1 s (bridge-latency.json, 13 OmniVoice turns). A reply whose first part is
// short (a few words) and whose rest is long can therefore run dry between the two: the first part ends before the rest is ready. The bridge learns the speed of
// THIS reply from its first phrase (the worker's own render time and the audio it made), predicts when each later phrase will be ready, and holds the first sound
// back by exactly the shortfall, so the queue does not run dry and a reply that cannot run dry loses nothing (0 ms). No model, no I/O: a few multiplications.
export const RUNWAY_MIN_MS = 150;        // a shortfall below this is not worth a delay
export const RUNWAY_MAX_MS = 1200;       // never hold the first sound longer than this; the pacing of a reply that still runs dry takes over from there
export const RUNWAY_MARGIN = 1.1;        // render times vary by tens of percent from run to run
const PAUSE_SECONDS = 0.3;               // the pause the joins put between sentences (bridge/omni-join.mjs) is audio the queue gets to play as well

/**
 * renderMs      the worker's render time of the first phrase; firstSeconds the audio it made (after the join shaping); firstChars the characters it spoke
 * later         the texts of the phrases still to render, in the order the worker renders them (the rest of this call, then the tail of a streamed reply)
 * Returns the hold in ms (0 when the reply cannot run dry).
 */
export function runwayMs({renderMs, firstSeconds, firstChars, later = []}) {
  if (!(renderMs > 0) || !(firstSeconds > 0) || !(firstChars > 0) || !later.length) return 0;
  const secondsPerChar = firstSeconds / firstChars, render = renderMs / 1000;
  // A render is mostly a fixed cost: measured on a quiet GPU 1.4 s + 0.1 s per second of speech. A slower GPU (the game's) scales both parts by how much slower this
  // reply's first render was than that.
  const slower = Math.min(3, Math.max(1, render / (1.4 + 0.1 * firstSeconds)));
  const takes = seconds => Math.min(4 * render, Math.max(0.5 * render, render + 0.1 * slower * (seconds - firstSeconds)));
  let ready = 0, heard = firstSeconds, hold = 0;
  for (const text of later) {
    const seconds = Math.min(30, Math.max(0.3, String(text).length * secondsPerChar));
    ready += takes(seconds);
    hold = Math.max(hold, ready - heard);
    heard += seconds + PAUSE_SECONDS;
  }
  const ms = Math.round(hold * 1000 * RUNWAY_MARGIN);
  return ms < RUNWAY_MIN_MS ? 0 : Math.min(RUNWAY_MAX_MS, ms);
}
