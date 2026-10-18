import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseInput} from './protocol.mjs';
import {encodeWav16} from './voxtral-reference.mjs';
import {parseScriptedLine, pcmFromWav, preparedVoice, engineVoice, SCRIPTED_RATE} from './scripted-line.mjs';
import {ownedLocalPcmPacket} from './local-pcm-host.mjs';
import {parseTagged, hasSpeechTags} from './natural-speech.mjs';
import {Utterance} from './voice-utterance.mjs';

test('the line file: text is required, audio must be an absolute .wav, engine one of the three', () => {
  assert.deepEqual(parseScriptedLine('{"text":" {joy}Hi V. "}'), {text: '{joy}Hi V.'});
  assert.deepEqual(parseScriptedLine('\uFEFF{"text":"Hi","audio":"C:\\\\takes\\\\a.wav","engine":"voxtral"}'),
    {text: 'Hi', audio: 'C:\\takes\\a.wav', engine: 'voxtral'});
  for (const bad of ['', 'nope', '[]', '{"text":""}', '{"text":5}', `{"text":"${'x'.repeat(1201)}"}`, '{"text":"Hi","audio":"a.wav"}',
    '{"text":"Hi","audio":"C:\\\\a.mp3"}', '{"text":"Hi","engine":"festival"}']) assert.throws(() => parseScriptedLine(bad), undefined, bad);
});

test('a request carries the scripted file only as a json path, and never in a group turn', () => {
  const base = {requestId: '1-2-3ULL', generation: 2, entity: '3ULL', name: 'Jackie', bodyType: 'x', profileKey: 'jackie-welles', text: 'scripted line'};
  assert.deepEqual(parseInput(JSON.stringify({...base, scripted: {file: 'C:\\lines\\a.json'}})).scripted, {file: 'C:\\lines\\a.json'});
  assert.equal(parseInput(JSON.stringify(base)).scripted, undefined);
  for (const file of ['C:\\a.txt', 5, 'x'.repeat(530) + '.json', 'a\nb.json']) assert.equal(parseInput(JSON.stringify({...base, scripted: {file}})).scripted, undefined);
});

const tone = (rate, seconds) => {
  const frames = Math.round(rate * seconds), out = new Float32Array(frames);
  for (let at = 0; at < frames; at++) out[at] = Math.sin(2 * Math.PI * 440 * at / rate) * .5;
  return out;
};

test('a 24 kHz mono WAV is used sample for sample; other rates are resampled to 24 kHz', () => {
  const samples = tone(SCRIPTED_RATE, 1);
  const pcm = pcmFromWav(encodeWav16(samples, SCRIPTED_RATE));
  assert.equal(pcm.length, SCRIPTED_RATE);
  for (let at = 0; at < 200; at++) assert.ok(Math.abs(pcm[at] - samples[at]) < 1 / 16000);
  assert.equal(pcmFromWav(encodeWav16(tone(16000, 1), 16000)).length, SCRIPTED_RATE);
  assert.throws(() => pcmFromWav(encodeWav16(tone(SCRIPTED_RATE, 3), SCRIPTED_RATE), {maxSeconds: 2}), /longer than/);
  assert.throws(() => pcmFromWav(Buffer.from('not a wav at all, not a wav at all, not a wav!!')), /WAV/);
});

test('a stereo WAV is mixed down to mono', () => {
  const left = tone(SCRIPTED_RATE, .1), data = Buffer.alloc(left.length * 4);
  left.forEach((value, at) => { data.writeInt16LE(Math.round(value * 32767), at * 4); data.writeInt16LE(0, at * 4 + 2); });
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22); header.writeUInt32LE(SCRIPTED_RATE, 24);
  header.writeUInt32LE(SCRIPTED_RATE * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  const pcm = pcmFromWav(Buffer.concat([header, data]));
  assert.equal(pcm.length, left.length);
  assert.ok(Math.abs(pcm[10] - left[10] / 2) < 1e-3);
});

test('prepared audio is handed out as Pocket packets the local PCM host accepts, in order, with the exact samples', async () => {
  const pcm = tone(SCRIPTED_RATE, 1.05);
  const voice = preparedVoice(pcm), utterance = new Utterance(), packets = [];
  let frames = 0, index = 0, identity;
  const result = await voice.synthesizeStream('jackie-welles', 'ignored {joy} text', {utterance, onPcm: async packet => {
    const owned = ownedLocalPcmPacket(packet, {token: 'turn', frames, index, identity});   // the host's own validation
    identity = owned.identity; frames += packet.frames; index++; packets.push(packet);
  }});
  assert.equal(packets.length, 11);
  assert.equal(result.frames, pcm.length);
  assert.ok(Math.abs(result.duration - 1.05) < 1e-9);
  assert.equal(utterance.engine, 'pocket');
  const joined = new Float32Array(frames);
  let at = 0;
  for (const packet of packets) { joined.set(packet.pcm, at); at += packet.frames; }
  assert.deepEqual(joined, pcm);
});

test('prepared audio stops when the turn is cancelled', async () => {
  const controller = new AbortController(), voice = preparedVoice(tone(SCRIPTED_RATE, 2));
  let count = 0;
  await assert.rejects(voice.synthesizeStream('k', 't', {signal: controller.signal, onPcm: () => { if (++count === 3) controller.abort(); }}));
  assert.equal(count, 3);
});

test('a named engine speaks through its own voice, refused without a key or a Pocket route; no name keeps the player\'s choice', async () => {
  const heard = [];
  const cloud = {hasKey: true, synthesizeStream: async (key, text, options) => { heard.push([key, text]); await options.onPcm({pcm: new Float32Array(1)}); return {frames: 1}; }};
  const localVoice = {voxtral: cloud, inworld: {...cloud, hasKey: false}, pocketRoute: false};
  assert.equal(engineVoice(undefined, localVoice), localVoice);
  const utterance = new Utterance();
  await engineVoice('voxtral', localVoice).synthesizeStream('jackie-welles', '[sigh] Hello', {utterance, role: 'head', onPcm: () => {}, emotion: {marks: []}});
  assert.equal(heard[0][0], 'jackie-welles');
  assert.ok(!heard[0][1].includes('['), 'voice tags never reach a voice that cannot render them');
  assert.equal(utterance.engine, 'voxtral');
  assert.throws(() => engineVoice('inworld', localVoice), /no key/);
  assert.throws(() => engineVoice('pocket', localVoice), /not the active local voice/);
  assert.equal(engineVoice('pocket', {...localVoice, pocketRoute: true}).pocketRoute, true);
});

test('the pipeline reads a scripted line\'s tags like a model reply: clean text, marks at word offsets', () => {
  const line = '{joy:strong}V! Hermano, listen up. {warm}Bring me along. {joy}Preem, right?';
  assert.ok(hasSpeechTags(line));
  const parsed = parseTagged(line);
  assert.equal(parsed.display, 'V! Hermano, listen up. Bring me along. Preem, right?');
  assert.deepEqual(parsed.marks.map(mark => [mark.name, mark.strength]), [['joy', 'strong'], ['warm', 'subtle'], ['joy', 'subtle']]);
  assert.equal(parsed.marks[0].at, 0);
  assert.equal(parsed.display.slice(parsed.marks[2].at), 'Preem, right?');
});

test('the bridge only runs a scripted turn in Developer mode, and keeps the line out of the conversation', () => {
  const source = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(source, /developerMode = settings\.developerMode === true/);
  const turn = source.slice(source.indexOf('async function runScriptedTurn'), source.indexOf('async function publishScripted'));
  assert.match(turn, /if \(!developerMode\)/);
  assert.doesNotMatch(turn, /knowledgeRouter|realtime\.reply|vVoice|admitPlayerConversation|multilingual\./);
  const publish = source.slice(source.indexOf('async function publishScripted'), source.indexOf('async function runInput'));
  assert.doesNotMatch(publish, /realtimeSessions\.set|connections\.used|prefetch\.|multilingual|followUp/);
});
