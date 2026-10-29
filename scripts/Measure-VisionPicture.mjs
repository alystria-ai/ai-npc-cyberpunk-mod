// Measures what the picture of a conversation turn costs to take and encode, per size (docs/COMPANION_VISION.md, "Cost"). It drives the native helper
// (native/vision/CyberpunkConvaiVision.exe) against ANY program's window named with --exe (a stand-in window: no game needed), alternating the profiles so a slow drift
// falls on both. It reads the helper's own timings: `encode` is the WIC scale plus the JPEG encode, `total` the whole capture, `cpu` the helper's CPU time. Nothing is
// written to disk (--save names one inspection copy per profile) and the game is never touched.
//
//   node scripts/Measure-VisionPicture.mjs --exe powershell.exe [--runs 30] [--profiles 768x80,1024x88,640x75] [--method wgc|dxgi|auto] [--save-dir <folder>]
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {helperCandidates} from '../bridge/vision-capture.mjs';

const args = process.argv.slice(2);
const value = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const exe = value('--exe'), runs = Number(value('--runs', 30)), method = value('--method', 'wgc'), saveDir = value('--save-dir');
const profiles = value('--profiles', '768x80,1024x88').split(',').map(text => { const [width, quality] = text.split('x').map(Number); return {width, quality, label: `${width} px q${quality}`}; });
if (!exe) { console.error('Name the stand-in program with --exe (for example powershell.exe).'); process.exit(2); }
const helper = helperCandidates().find(path => existsSync(path));
if (!helper) { console.error('The vision helper is not built (scripts/Build-VisionCapture.ps1), or name one with CYBERPUNK_CONVAI_VISION_HELPER.'); process.exit(1); }
const child = spawn(helper, ['--exe', exe], {windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']});
let buffer = '';
const waiting = [];
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1); if (line) waiting.shift()?.(JSON.parse(line)); }
});
const next = () => new Promise(done => waiting.push(done));
const ask = async line => { const answer = next(); child.stdin.write(line + '\n'); return answer; };
const stats = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {n: sorted.length, median: at(0.5), p95: at(0.95), max: sorted.at(-1)};
};
const round = number => Math.round(number * 10) / 10;
try {
  await next();   // the ready line
  const results = new Map(profiles.map(profile => [profile.label, {encode: [], total: [], cpu: [], bytes: [], reasons: new Map(), size: null}]));
  // One warm-up capture per profile (the first one builds the encoder and the device).
  for (const profile of profiles) await ask(`capture ${profile.width} ${profile.quality} ${method}`);
  for (let run = 0; run < runs; run++) {
    for (const profile of profiles) {
      const answer = await ask(`capture ${profile.width} ${profile.quality} ${method}`);
      const record = results.get(profile.label);
      if (!answer.ok) { record.reasons.set(answer.reason, (record.reasons.get(answer.reason) ?? 0) + 1); continue; }
      record.encode.push(answer.ms.encode); record.total.push(answer.ms.total); record.cpu.push(answer.ms.cpu); record.bytes.push(answer.bytes);
      record.size = `${answer.width}x${answer.height}`;
      if (saveDir && run === 0) { await mkdir(saveDir, {recursive: true}); await writeFile(resolve(saveDir, `picture-${profile.width}-q${profile.quality}.jpg`), Buffer.from(answer.jpeg, 'base64')); }
    }
  }
  for (const [label, record] of results) {
    const line = {profile: label, picture: record.size, bytes: stats(record.bytes), encodeMs: stats(record.encode), totalMs: stats(record.total), helperCpuMs: stats(record.cpu),
      failures: Object.fromEntries(record.reasons)};
    console.log(JSON.stringify(line, (key, v) => typeof v === 'number' ? round(v) : v));
  }
} finally {
  try { child.stdin.end('quit\n'); } catch { /* gone */ }
  setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 1000).unref();
}
