// One line per cause, not one per tick. The bridge polls the game's files every 50 to 500 ms; a poll that fails for a lasting reason (a
// file the game holds open, a permission error, a damaged file) used to write the same console line on every tick, thousands an hour into
// bridge.stderr.log. `repeatLimiter` writes the first line of each distinct cause at once, then at most one line per `windowMs` for that cause,
// saying how many were left out.
//
// "The same cause": the label plus the message with what differs between occurrences taken out (numbers, ids, temp-file names, folders).
// Cheap: a Map lookup and a string replace, only when a poll has failed.

const MASKS = [[/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '*'], [/\b0x[0-9a-f]+\b|\b[0-9a-f]{12,}\b/gi, '*'], [/\d+/g, 'N']];

/** The message of an error (or any value) with what changes between occurrences replaced, so one cause has one key. */
export const causeOf = value => MASKS.reduce((text, [pattern, mask]) => text.replace(pattern, mask), String(value?.message ?? value ?? '')).slice(0, 200);

/**
 * (label, error) => void. `write(line)` is the sink (console.error in the bridge). At most `maxCauses` distinct causes are remembered (the
 * table is cleared when it is full, so a stream of ever-new messages cannot grow it); `now` is for the tests.
 */
export function repeatLimiter({write, windowMs = 60_000, maxCauses = 64, now = Date.now} = {}) {
  const causes = new Map();
  return (label, error) => {
    try {
      const message = String(error?.message ?? error), key = `${label}\u0000${causeOf(message)}`, at = now();
      const known = causes.get(key);
      if (known && at - known.at < windowMs) { known.skipped++; return; }
      const skipped = known?.skipped ?? 0;
      if (!known && causes.size >= maxCauses) causes.clear();
      causes.set(key, {at, skipped: 0});
      write(`${label} ${message}${skipped ? ` (${skipped} more of the same were not logged)` : ''}`);
    } catch { /* a log line is never worth a failure */ }
  };
}
