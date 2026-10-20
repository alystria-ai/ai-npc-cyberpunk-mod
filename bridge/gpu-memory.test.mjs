import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SPILL_LIMITS, parseCounterCsv, readGpuProcessMemory, slowReply, spillVerdict} from './gpu-memory.mjs';

const MIB = 1048576;
// What `typeperf "\GPU Process Memory(pid_N_*)\Dedicated Usage" "\GPU Process Memory(pid_N_*)\Shared Usage" -sc 1` prints: one column per adapter and counter, bytes.
const CSV = [
  '"(PDH-CSV 4.0)","\\\\HOST\\GPU Process Memory(pid_12692_luid_0x00000000_0x00017E77_phys_0)\\Dedicated Usage","\\\\HOST\\GPU Process Memory(pid_12692_luid_0x00000000_0x0001843C_phys_0)\\Dedicated Usage","\\\\HOST\\GPU Process Memory(pid_12692_luid_0x00000000_0x00017E77_phys_0)\\Shared Usage","\\\\HOST\\GPU Process Memory(pid_12692_luid_0x00000000_0x0001843C_phys_0)\\Shared Usage"',
  `"10/20/2026 12:00:00.000","${2218 * MIB}","${0}","${1103 * MIB}","${0}"`,
  'The command completed successfully.',
].join('\r\n');

test('parseCounterCsv sums the dedicated and the shared usage of a process over its adapters, in MiB', () => {
  assert.deepEqual(parseCounterCsv(CSV), {dedicatedMiB: 2218, sharedMiB: 1103});
  assert.equal(parseCounterCsv('Error: No valid counters were specified.'), null);
  assert.equal(parseCounterCsv(''), null);
  assert.equal(parseCounterCsv('"(PDH-CSV 4.0)","x"\n"t","1"'), null, 'no usage counter in the header');
});

test('readGpuProcessMemory asks typeperf for this process only and gives null off Windows, for a bad pid or a failed read', async () => {
  const calls = [];
  const run = async (file, args) => { calls.push([file, ...args]); return CSV; };
  assert.deepEqual(await readGpuProcessMemory(12692, {platform: 'win32', run}), {dedicatedMiB: 2218, sharedMiB: 1103});
  assert.equal(calls[0][0], 'typeperf');
  assert.match(calls[0][1], /pid_12692_\*/, 'the underscore keeps pid 12692 from matching 126921');
  assert.equal(await readGpuProcessMemory(12692, {platform: 'linux', run}), null);
  assert.equal(await readGpuProcessMemory(0, {platform: 'win32', run}), null);
  assert.equal(await readGpuProcessMemory('12', {platform: 'win32', run}), null);
  assert.equal(await readGpuProcessMemory(5, {platform: 'win32', run: async () => { throw Error('typeperf missing'); }}), null);
});

test('spillVerdict: a healthy model (80 to 100 MiB shared) is not spilled; 1,100 of 3,300 MiB shared is, as measured with the card over-committed (83 to 3.9 tokens a second)', () => {
  assert.deepEqual(spillVerdict({dedicatedMiB: 3151, sharedMiB: 80}), {spilled: false, spilledMiB: 0, share: 0});
  assert.equal(spillVerdict({dedicatedMiB: 3232, sharedMiB: 105}).spilled, false);
  const spilled = spillVerdict({dedicatedMiB: 2218, sharedMiB: 1103});
  assert.deepEqual([spilled.spilled, spilled.spilledMiB], [true, 975]);
  // Small amounts and small shares are not a spill: 250 MiB beyond the baseline, or 9% of a large process.
  assert.equal(spillVerdict({dedicatedMiB: 3000, sharedMiB: 128 + SPILL_LIMITS.minSpilledMiB - 1}).spilled, false);
  assert.equal(spillVerdict({dedicatedMiB: 9000, sharedMiB: 128 + 800}).spilled, false);
  assert.equal(spillVerdict({dedicatedMiB: 9000, sharedMiB: 128 + 1100}).spilled, true);
  for (const bad of [null, undefined, {}, {dedicatedMiB: 1}, {dedicatedMiB: NaN, sharedMiB: 5000}]) assert.equal(spillVerdict(bad).spilled, false);
});

test('slowReply: a reply of 20 pieces or more under 12 tokens a second is looked at, a fast or a short one is not', () => {
  assert.equal(slowReply({tokensPerSecond: 3.9, pieces: 40}), true);
  assert.equal(slowReply({tokensPerSecond: 11.9, pieces: 20}), true);
  assert.equal(slowReply({tokensPerSecond: 12, pieces: 40}), false);
  assert.equal(slowReply({tokensPerSecond: 2, pieces: 19}), false);
  assert.equal(slowReply({tokensPerSecond: 0, pieces: 40}), false);
  assert.equal(slowReply({pieces: 40}), false);
  assert.equal(slowReply(undefined), false);
});
