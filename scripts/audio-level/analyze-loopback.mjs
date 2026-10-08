// Segments a loopback recording into sounding stretches and reports each one's
// ITU-R BS.1770 integrated loudness, peak, L/R balance and which application
// session was sounding (from the companion peak CSV). Development tool only.
//   node analyze-loopback.mjs <recording.wav> [sessions.csv] [--min 0.6]
import {readFileSync, existsSync} from 'node:fs';
import {kWeighting, integratedLoudness} from '../../bridge/dialogue-level.mjs';

const [wavPath, csvPath] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const minIndex = process.argv.indexOf('--min');
const minSeconds = minIndex > 0 ? Number(process.argv[minIndex + 1]) : 0.6;

function readFloatWav(path) {
  const b = readFileSync(path);
  let offset = 12, format, data;
  while (offset + 8 <= b.length) {
    const tag = b.toString('ascii', offset, offset + 4), size = b.readUInt32LE(offset + 4), start = offset + 8;
    if (tag === 'fmt ') format = {codec: b.readUInt16LE(start), channels: b.readUInt16LE(start + 2),
      rate: b.readUInt32LE(start + 4), bits: b.readUInt16LE(start + 14)};
    if (tag === 'data') data = b.subarray(start, start + size);
    offset = start + size + size % 2;
  }
  const frames = data.length / (format.bits / 8) / format.channels;
  const channels = Array.from({length: format.channels}, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) for (let c = 0; c < format.channels; c++) {
    const at = (i * format.channels + c) * format.bits / 8;
    channels[c][i] = format.codec === 3 ? data.readFloatLE(at)
      : format.bits === 16 ? data.readInt16LE(at) / 32768 : data.readInt32LE(at) / 2147483648;
  }
  return {rate: format.rate, channels};
}

const {rate, channels} = readFloatWav(wavPath);
const block = Math.round(rate * 0.05), frames = channels[0].length;
const energy = [];
for (let start = 0; start + block <= frames; start += block) {
  let sum = 0;
  for (const ch of channels) for (let i = start; i < start + block; i++) sum += ch[i] * ch[i];
  energy.push(10 * Math.log10(sum / block / channels.length + 1e-20));
}
// Sounding = above -55 dBFS RMS, joined across pauses shorter than 0.6 s.
const segments = []; let open = -1, last = -1;
energy.forEach((db, i) => {
  if (db > -55) { if (open < 0) open = i; last = i; }
  else if (open >= 0 && i - last > 12) { segments.push([open, last + 1]); open = -1; }
});
if (open >= 0) segments.push([open, last + 1]);

const sessions = csvPath && existsSync(csvPath) ? readFileSync(csvPath, 'utf8').trim().split(/\r?\n/).slice(1)
  .map(line => line.split(',')).map(([t, pid, name, , volume, , peak]) => ({t: Number(t), pid, name, volume: Number(volume), peak: Number(peak)})) : [];

const rows = [];
for (const [a, b] of segments) {
  const t0 = a * 0.05, t1 = b * 0.05;
  if (t1 - t0 < minSeconds) continue;
  const slice = channels.map(ch => ch.subarray(a * block, b * block));
  const lufs = integratedLoudness(slice.map(ch => kWeighting(ch, rate)), rate);
  const side = slice.map(ch => integratedLoudness([kWeighting(ch, rate)], rate));
  let peak = 0; for (const ch of slice) for (const v of ch) peak = Math.max(peak, Math.abs(v));
  const owners = new Map();
  for (const s of sessions) if (s.t >= t0 && s.t <= t1 && s.peak > 0.001) {
    const key = `${s.name}:${s.pid}`; owners.set(key, (owners.get(key) || 0) + s.peak);
  }
  const owner = [...owners.entries()].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}(${v.toFixed(1)})`).slice(0, 2).join(' ');
  rows.push({start: t0.toFixed(2), seconds: (t1 - t0).toFixed(2), lufs: lufs.toFixed(1),
    peakDb: (20 * Math.log10(peak + 1e-20)).toFixed(1),
    balanceLR: side.length === 2 ? (side[0] - side[1]).toFixed(1) : '', source: owner || '?'});
}
console.table(rows);
// The game process carries both vanilla Wwise dialogue and Audioware (OmniVoice)
// speech; the browser (msedge) carries Pocket and Convai. Compare by segment.
const groups = new Map();
for (const row of rows) {
  const name = row.source.split(':')[0] || '?';
  if (Number.isFinite(Number(row.lufs))) groups.set(name, [...(groups.get(name) || []), Number(row.lufs)]);
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
for (const [name, values] of groups) console.log(`${name}: ${values.length} segment(s), median ${median(values).toFixed(1)} LUFS`);
const game = groups.get('Cyberpunk2077'), edge = groups.get('msedge');
if (game && edge) console.log(`Browser voice vs game-process dialogue: ${(median(edge) - median(game)).toFixed(1)} LU `
  + '(negative = mod voice quieter; raise makeupDb in runtime/dialogue-level.json by that much).');
