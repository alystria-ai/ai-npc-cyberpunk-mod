// Did the driver move the model out of the graphics card into shared system memory? (docs/LOCAL_AI.md, "Free-memory fit")
//
// Windows keeps a counter for every process: "GPU Process Memory" > "Dedicated Usage" (on the card) and "Shared Usage" (in system memory the card reaches
// over PCIe). A model that spilled shows a large shared figure; one that lives on the card has about 80 to 100 MiB (measured 2026-10-20, RTX 4080 Laptop,
// llama.cpp Vulkan). Measured with the card over-committed by other models: the spilled one fell from 83 to 3.9 generated tokens a second and from 3,400 to
// 680 prompt tokens a second with 1,100 MiB of its 3,300 shared, which is the 1 to 5 tokens a second of the player reports.
// One short `typeperf` process, only when asked (a slow turn, a stall, a reload decision): never per frame, never per turn. Null off Windows or when it fails.
import {execFile} from 'node:child_process';

const MIB = 1048576;
export const SPILL_LIMITS = Object.freeze({
  baselineSharedMiB: 128,   // shared usage a healthy process has (80 to 100 MiB measured)
  minSpilledMiB: 300,       // shared beyond the baseline that counts as a spill ...
  minSpilledShare: 0.10,    // ... when it is also this share of everything the process holds
  slowTokensPerSecond: 12,  // a reply written slower than this (20 or more pieces) is looked at; a card with room writes 35 and more even beside the game
  slowMinPieces: 20,
  checkEveryMs: 180_000,    // at most one reading in this long
  // Two more moments to look, so a spill is found before a turn is lost to it (2026-10-21: an RTX 3080 10 GB with the Mature good model spilled 0.7 to 1 GB every session and the
  // first turn waited 60 to 75 s for the stall that was the only thing that read the counters): once after each load, at the first request the model gets (a persona warm-up
  // or a turn), and when a turn's request has had no answer after noHeadersMs. The second is rate-limited by earlyCheckEveryMs, not by checkEveryMs: a turn that is stuck
  // must not wait three minutes for its reading.
  noHeadersMs: 10_000,
  earlyCheckEveryMs: 20_000,
});

/** Parses `typeperf ... -sc 1` CSV of Dedicated and Shared Usage counters into {dedicatedMiB, sharedMiB} (summed over the process's adapters), or null. */
export function parseCounterCsv(text) {
  const rows = String(text ?? '').split(/\r?\n/).filter(line => line.startsWith('"'));
  if (rows.length < 2) return null;
  const cells = line => line.slice(1, -1).split('","');
  const head = cells(rows[0]), row = cells(rows[1]);
  let dedicated = 0, shared = 0, seen = 0;
  for (let i = 1; i < head.length; i++) {
    const value = Number(row[i]);
    if (!Number.isFinite(value)) continue;
    if (/Dedicated Usage/i.test(head[i])) { dedicated += value; seen++; } else if (/Shared Usage/i.test(head[i])) { shared += value; seen++; }
  }
  return seen ? {dedicatedMiB: Math.round(dedicated / MIB), sharedMiB: Math.round(shared / MIB)} : null;
}

/** Reads one process's counters: {dedicatedMiB, sharedMiB} or null. `run(file, args, timeoutMs)` is injectable (resolves stdout). */
export async function readGpuProcessMemory(pid, {platform = process.platform, run = defaultRun} = {}) {
  if (platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const text = await run('typeperf', [`\\GPU Process Memory(pid_${pid}_*)\\Dedicated Usage`, `\\GPU Process Memory(pid_${pid}_*)\\Shared Usage`, '-sc', '1'], 15_000);
    return parseCounterCsv(text);
  } catch { return null; }
}

function defaultRun(file, args, timeout) {
  return new Promise((resolveRun, rejectRun) => {
    execFile(file, args, {timeout, windowsHide: true, maxBuffer: 1 << 20}, (error, stdout) => (error && !stdout ? rejectRun(error) : resolveRun(String(stdout))));
  });
}

/** {spilled, spilledMiB, share} from a reading: spilled when the shared usage beyond the healthy baseline is at least minSpilledMiB and minSpilledShare of what the process holds. */
export function spillVerdict(memory) {
  if (!memory || !Number.isFinite(memory.dedicatedMiB) || !Number.isFinite(memory.sharedMiB)) return {spilled: false, spilledMiB: 0, share: 0};
  const spilledMiB = Math.max(0, memory.sharedMiB - SPILL_LIMITS.baselineSharedMiB);
  const total = memory.dedicatedMiB + memory.sharedMiB;
  const share = total > 0 ? spilledMiB / total : 0;
  return {spilled: spilledMiB >= SPILL_LIMITS.minSpilledMiB && share >= SPILL_LIMITS.minSpilledShare, spilledMiB, share: Math.round(share * 100) / 100};
}

/** Is a finished reply slow enough to look at the counters? ({tokensPerSecond, pieces} of the turn's trace) */
export const slowReply = trace => Number.isFinite(trace?.tokensPerSecond) && trace.tokensPerSecond > 0 && trace.tokensPerSecond < SPILL_LIMITS.slowTokensPerSecond
  && Number(trace?.pieces) >= SPILL_LIMITS.slowMinPieces;
