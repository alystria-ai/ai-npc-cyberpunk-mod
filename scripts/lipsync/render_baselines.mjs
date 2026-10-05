// Research harness: render the production local lip-sync paths for saved audio.
// Input JSON lines: {key, pcm24: <path to f32le 24 kHz mono>, phones?: [...], cues?: [...]}
// Output JSON lines: {key, pocket?: {tracks, frames}, omni?: {tracks, frames}}
// Pocket uses the real PocketFacialStream with a final resident phone result
// (ideal availability: no late analysis). Omni uses buildFacialTimeline with
// Rhubarb cues, exactly like phrase replies. No game, network or GPU work.
import {readFileSync, writeFileSync} from 'node:fs';
import {PocketFacialStream} from '../../bridge/pocket-facial-stream.mjs';
import {buildFacialTimeline} from '../../bridge/facial-timeline.mjs';

const [input, output] = process.argv.slice(2);
const out = [];
for (const line of readFileSync(input, 'utf8').split('\n').filter(Boolean)) {
  const job = JSON.parse(line), raw = readFileSync(job.pcm24);
  const pcm = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const owner = {requestId: 'eval-' + job.key, entity: 'eval', generation: 1};
  const result = {key: job.key};
  if (job.phones) {
    let deliver;
    const phoneAnalysis = {beginTurn: (_input, {onPhones}) => { deliver = onPhones; return {push() {}, finish() {}, close() {}}; }};
    const stream = new PocketFacialStream({input: owner, lipsync: undefined, phoneAnalysis});
    for (let at = 0, index = 1; at < pcm.length; at += 1920, index++) {
      const piece = pcm.slice(at, Math.min(pcm.length, at + 1920));
      stream.push({sampleRate: 24000, channels: 1, offsetFrames: at, index, frames: piece.length, pcm: piece});
    }
    stream.finish();
    deliver({type: 'finished', owner, receivedFrames: pcm.length, duration: pcm.length / 24000, segments: job.phones});
    const face = stream.snapshot(pcm.length, true, 0);
    result.pocket = {tracks: face.tracks, frames: face.frames, source: face.source};
    await stream.close();
  }
  if (job.cues) {
    const bytes = Buffer.alloc(44 + pcm.length * 2);
    bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
    bytes.write('data', 36); bytes.writeUInt32LE(pcm.length * 2, 40);
    pcm.forEach((v, i) => bytes.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), 44 + i * 2));
    const timeline = buildFacialTimeline({audio: bytes.toString('base64'), mouthCuesFormat: 'rhubarb-phonetic-v1',
      mouthCues: job.cues}, owner);
    result.omni = {tracks: timeline.tracks, frames: timeline.frames, source: timeline.source};
  }
  out.push(JSON.stringify(result));
}
writeFileSync(output, out.join('\n') + '\n');
