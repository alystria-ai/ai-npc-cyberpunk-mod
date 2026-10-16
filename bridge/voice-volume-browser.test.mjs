import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, dirname, basename} from 'node:path';
import {chromium} from 'playwright';
import {RealtimeHost} from './realtime-host.mjs';
import {ConvaiContinuousSpeech} from './convai-continuous-speech.mjs';
import {DIALOGUE_MAKEUP_DB, updateDialogueLevel, updateVoiceVolume} from './dialogue-level.mjs';
import {VLine} from './v-voice.mjs';
import {TurnClock} from './turn-clock.mjs';

// The whole chain on the real renderer page (real Edge, muted, all PCM a quiet sine, no sound reaches a device): the Voice volume the bridge
// sends in the playback control must be what the page's graph really applies, for the companion's stream and for V's line, at every setting.
// A live report (2026-10-16: "volume doesn't change") made this the question to keep answered by a test.
const LIMITER_MAKEUP_DB = 0.6 * 4 * (1 - 1 / 20);
const dbOf = ratio => 20 * Math.log10(ratio);
const packet = (profile, count) => ({version: 1, engine: 'pocket-tts', sampleRate: 24000, channels: 1, format: 'f32le',
  owner: '1'.repeat(32), id: 1, profile, modelSha256: '2'.repeat(64), index: 1, offsetFrames: 0, frames: count,
  pcm: Float32Array.from({length: count}, (_, i) => .1 * Math.sin(i / 20))});

test('real renderer page: the companion stream and V line apply the Voice volume the bridge sends', {timeout: 180000}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cyberpunk-voice-volume-'));
  for (const name of ['continuous-pcm-player.mjs', 'continuous-pcm-worklet.mjs', 'continuous-pcm-core.mjs', 'local-pcm-client.mjs'])
    await writeFile(join(root, name), await readFile(new URL(name, import.meta.url)));
  await writeFile(join(root, 'realtime-client.js'), 'throw Error("Convai must not run in the local PCM page");');
  const host = new RealtimeHost({clientAssetsDirectory: root, muteBrowser: true, launchBrowser: async options =>
    chromium.launch({...options, args: [...options.args, '--mute-audio']})});
  const lines = [];
  const origError = console.error; console.error = (...a) => { if (String(a[0]).startsWith('[VoiceVolume]')) lines.push(String(a[0])); else origError(...a); };
  try {
    const owner = {requestId: 'reply-1', entity: '11307774ULL', generation: 2};
    const companion = async percent => {
      updateVoiceVolume({voiceVolume: percent});
      let sequence = 0, level;
      const id = `continuous-${percent}`;
      const speech = new ConvaiContinuousSpeech({input: owner, profile: {key: 'alex'}, token: id, signal: new AbortController().signal,
        now: Date.now, current: async () => true,
        readControl: async () => JSON.stringify({version: 1, id, ...owner, sequence: ++sequence, updated: Date.now(), allow: true, paused: false, volume: .7, pan: 0, distance: 3}),
        writeState: async () => true, writeReply: async () => true});
      await host.playLocalPcm({token: id, text: 'Hello there, V.'}, async emit => { await emit(packet('alex', 24000)); return {}; },
        {onFrame: async snapshot => { const control = await speech.frame(snapshot); if (snapshot.level && control.allow && !snapshot.ended && snapshot.level.gain > 0) level = snapshot.level; return control; }});
      return level;
    };
    const voiceLine = async percent => {
      updateVoiceVolume({voiceVolume: percent});
      let level;
      const made = new VLine({input: {requestId: 'v', profileKey: 'alex', text: 'Hello.'}, key: 'v-male', text: 'Hello.', plan: {engine: 'pocket', language: 'en'},
        volume: .7, clock: new TurnClock(), log: () => {},
        play: (config, producer, options) => host.playVoiceLine(config, producer, {...options,
          onFrame: snapshot => { const control = options.onFrame(snapshot); if (snapshot.level && control.allow && !snapshot.ended && snapshot.level.gain > 0) level = snapshot.level; return control; }}),
        stream: async (key, text, options) => { await options.onPcm(packet(key, 24000)); return {frames: 24000}; }, render: async () => ({})});
      await made.finished;
      return level;
    };
    const companions = {}, voices = {};
    for (const percent of [50, 80, 100, 150, 200]) { companions[percent] = await companion(percent); voices[percent] = await voiceLine(percent); }
    t.diagnostic(JSON.stringify({companions, voices}));
    for (const percent of [50, 80, 100, 150, 200]) {
      const db = 20 * Math.log10(percent / 100);
      const c = companions[percent], v = voices[percent];
      assert.ok(c && v, `a level was reported at ${percent}%`);
      assert.ok(c.limiter === true, `the limiter exists in the page at ${percent}%`);
      assert.ok(Math.abs(c.makeupDb - (DIALOGUE_MAKEUP_DB + db)) < 1e-6, `companion makeup at ${percent}%: ${c.makeupDb}`);
      assert.ok(Math.abs(dbOf(c.gain / .7) - (DIALOGUE_MAKEUP_DB + db - LIMITER_MAKEUP_DB)) < .05, `companion gain at ${percent}%: ${c.gain}`);
      if (percent === 100) assert.equal(v.limited, false, 'V at 100% is the unchanged unity path');
      assert.ok(Math.abs(dbOf(v.gain / .7) - (percent === 100 ? 0 : db - LIMITER_MAKEUP_DB)) < .05, `V gain at ${percent}%: ${v.gain}`);
    }
    // The spread the player asked for really reaches the graph: 50% to 200% is 12 dB for the companion and V alike.
    assert.ok(Math.abs(dbOf(companions[200].gain / companions[50].gain) - 12.04) < .1);
    assert.ok(Math.abs(dbOf(voices[200].gain / voices[50].gain) - 12.04) < .1);
    assert.ok(lines.length >= 10 && lines.every(line => /limiter (in the path|idle)/.test(line) || /gain 0\.7/.test(line)), `one honest log line per reply: ${lines.join(' | ')}`);
    assert.ok(!lines.some(line => line.includes('MISSING')));
  } finally {
    console.error = origError; updateVoiceVolume({}); updateDialogueLevel('');
    await host.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert(basename(root).startsWith('cyberpunk-voice-volume-'));
    await rm(root, {recursive: true, force: true});
  }
});
