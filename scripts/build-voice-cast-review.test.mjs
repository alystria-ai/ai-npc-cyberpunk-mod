import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AUDITION_TEXT, buildVoiceCastReview, escapeHtml, escapeMarkdown, identityProjection, identitySha256, pcmInfo, renderHtml, writeVoiceCastReview } from './Build-VoiceCastReview.mjs';

const digest = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const rosterHash = 'a'.repeat(64);
const serializerHash = '7ae9c308da2fe003220b55ce4ca9c122b51f0701a67db1618cca3ff4f7ff6738';

function pcm({ frames = 144000, sampleRate = 48000, channels = 1 } = {}) {
  const bytes = Buffer.alloc(44 + frames * channels * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(frames * channels * 2, 40);
  for (let at = 44; at < bytes.length; at += 2) bytes.writeInt16LE(1000, at);
  return bytes;
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-cast-review-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (name, contents) => {
    const filename = path.join(root, ...name.split('/'));
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, contents);
  };
  const json = async (name, value) => write(name, JSON.stringify(value, null, 2));
  const key = 'test-person'; const lane = 'test-lane';
  const directory = `runtime/voice-cast/${lane}/${key}/100-female`;
  const wave = pcm(); const transcript = 'Ordinary dialogue with the exact installed words.';
  const reference = `${directory}/reference.wav`;
  const rawPath = `runtime/voice-cast/${lane}/scenes/ordinary.scene`;
  const raw = Buffer.from('native fixture source bytes');
  const event = { $type: 'scnDialogLineEvent', screenplayLineId: { id: 1 }, voParams: { voExpression: 'Vo_Expression_Spoken', isHolocallSpeaker: 0 } };
  const sceneData = { Data: { RootChunk: {
    actors: [{ actorId: { id: 0 }, actorName: 'Test person', voicetagId: { id: '99' } }],
    screenplayStore: { lines: [{ itemId: { id: 1 }, speaker: { id: 0 }, locstringId: { ruid: '100' } }] },
    sceneGraph: { events: [event] },
    locStore: {
      vdEntries: [{ localeId: 'en_us', locstringId: { ruid: '100' }, vpeIndex: 0, variantId: { ruid: '88' } }],
      vpEntries: [{ content: transcript, variantId: { ruid: '88' } }],
    },
  } } };
  const sceneJson = Buffer.from(JSON.stringify(sceneData));
  const subtitle = Buffer.from('native installed English subtitle fixture');
  const wem = Buffer.from('RIFF original WEM fixture');
  const receipt = {
    key, stringId: '100', status: 'decoded_verified', attributionVerified: true,
    transcriptAgreement: true, listeningVerified: false, voiceCloneApproved: false,
    reference, transcript, transcriptSha256: digest(Buffer.from(transcript)), sha256: digest(wave),
    provenance: {
      rosterSha256: rosterHash, locale: 'en_us', gameVersion: '2.31', identity: { key, proof: { kind: 'exact_actor', canonicalKey: key } },
      nativeActor: {
        pointer: '/Data/RootChunk/actors/0', id: '0', name: 'Test person', voicetagId: '99',
        identityProof: { kind: 'exact_actor', canonicalKey: key },
        scene: { rawPath, rawSha256: digest(raw), jsonPath: `${rawPath}.json`, jsonSha256: digest(sceneJson), entrySha1: digest(raw, 'sha1'), depotPath: 'base\\quest\\ordinary.scene' },
        serializationVerification: { verified: true, toolSha256: serializerHash, rawSha256: digest(raw), cachedJsonSha256: digest(sceneJson), dataSha256: 'b'.repeat(64) },
      },
      nativeLine: { pointer: '/Data/RootChunk/screenplayStore/lines/0', itemId: '1', speakerId: '0', locstringId: '100', event: { pointer: '/Data/RootChunk/sceneGraph/events/0', ...event } },
      subtitle: {
        locale: 'en_us', transcript, transcriptSha256: digest(Buffer.from(transcript)),
        descriptorPointer: '/Data/RootChunk/locStore/vdEntries/0', payloadPointer: '/Data/RootChunk/locStore/vpEntries/0',
        vpeIndex: 0, variantId: '88', variant: 'femaleVariant',
        sources: [{ sha1Verified: true, sha256: digest(subtitle), archiveEntrySha1: digest(subtitle, 'sha1'), variants: { femaleVariant: transcript }, indexedSource: { rawPath: 'raw/base/subtitle.json' } }],
      },
      audio: { wavPath: reference, wemPath: `${directory}/source.wem`, sha256: digest(wem), sha1Verified: true, archiveEntrySha1: digest(wem, 'sha1'), genderVariant: 'female', depotPath: 'base\\localization\\en-us\\vo\\test_f_64.wem' },
      quality: { originalPcm: true, sha256: digest(wave), frames: 144000, channels: 1, bitsPerSample: 16, sampleRate: 48000 },
    },
  };
  const accepted = { reference: 'runtime/voice-references/accepted/judy.wav', sha256: digest(wave), transcript: 'Accepted existing words…' };
  const roster = { summary: { rosterSha256: rosterHash, profiles: 2 }, characters: [
    { key, name: 'Test person', acceptedConfiguration: null },
    { key: 'judy-alvarez', name: 'Judy Alvarez', acceptedConfiguration: accepted },
  ] };
  const lanes = { profiles: 2, lanes: [
    { name: lane, keys: [key], researchOutput: `runtime/voice-cast/${lane}` },
    { name: 'accepted-existing', keys: ['judy-alvarez'], researchOutput: 'runtime/voice-cast/accepted-existing' },
  ] };
  const manifest = { schemaVersion: 1, lane, rosterSha256: rosterHash, candidates: [receipt] };
  await Promise.all([
    json('runtime/voice-cast-inventory-20261001/cast-roster-inventory.json', roster),
    json('characters/roster.json', roster.characters.map(character => ({ key: character.key, name: character.name, backstory: 'Original prompt prose' }))),
    json('runtime/voice-cast-inventory-20261001/casting-lanes.json', lanes),
    json(`runtime/voice-cast/${lane}/manifest.json`, manifest),
    json(`${directory}/receipt.json`, receipt),
    write(`${directory}/transcript.txt`, `${transcript}\r\n`), write(reference, wave), write(`${directory}/source.wem`, wem),
    write(rawPath, raw), write(`${rawPath}.json`, sceneJson),
    write('research/cyberpunk/cache/game/localization/raw/base/subtitle.json', subtitle),
    write(accepted.reference, wave),
    json('runtime/local-voices.json', { provider: 'hybrid', voices: { 'judy-alvarez': accepted }, privateApiKey: 'DO-NOT-COPY-SECRET', providerCharacterId: 'DO-NOT-COPY-ID' }),
    json(`runtime/voice-cast/${lane}/selection-review.json`, { profiles: [{ key, proposedPrimary: { reference } }] }),
  ]);
  return { root, write, json, key, lane, directory, reference, receipt, manifest, roster, lanes, accepted, wave, sceneData, rawPath };
}

async function generatedFixture(x) {
  const directory = 'runtime/voice-cast/auditions/test-run';
  const run = `${directory}/results.json`;
  const wave = pcm({ frames: 96000 });
  const renders = [
    { key: x.key, referenceSha256: x.receipt.sha256, transcriptSha256: x.receipt.transcriptSha256 },
    { key: 'judy-alvarez', referenceSha256: x.accepted.sha256, transcriptSha256: digest(Buffer.from(x.accepted.transcript)) },
  ].map(row => ({ ...row, status: 'generated', sample: `${row.key}.wav`, sha256: digest(wave), durationSeconds: 2, listeningVerified: false, approved: false, generationMs: 1, providerSecret: 'DO-NOT-COPY-GENERATED-SECRET' }));
  const report = { version: 1, kind: 'generated-voice-auditions', sampleText: AUDITION_TEXT, steps: 32, listeningVerified: false, approved: false, renders, state: 'complete', workerExited: true };
  for (const row of renders) await x.write(`${directory}/${row.sample}`, wave);
  await x.json(run, report);
  return { run, directory, wave, report };
}

test('all profiles are accounted for; native chain and actual PCM verified without promotion', async t => {
  const x = await fixture(t);
  const report = await buildVoiceCastReview({ projectRoot: x.root, now: 'fixed-time' });
  assert.equal(report.inventory.counts.profiles, 2);
  assert.equal(report.inventory.counts.acceptedProfiles, 1);
  assert.equal(report.inventory.counts.profilesWithVerifiedCandidates, 1);
  assert.equal(report.inventory.counts.verifiedOriginalCandidates, 1);
  assert.equal(report.inventory.counts.newListeningApprovals, 0);
  assert.equal(report.inventory.counts.newProfilesPromoted, 0);
  const candidate = report.inventory.profiles.find(p => p.key === x.key).candidates[0];
  assert.equal(candidate.pcm.durationSeconds, 3);
  assert.equal(candidate.sourceVerified, true);
  assert.equal(candidate.listeningVerified, false);
  assert.equal(candidate.approved, false);
  assert.equal(candidate.role, 'primary');
  assert.match(candidate.playback, /^\.\.\/test-lane\//);
  assert.equal(report.inventory.sharedModel.modelsPerCharacter, 0);
  const serialized = JSON.stringify(report.inventory) + report.html + report.markdown;
  assert.doesNotMatch(serialized, /DO-NOT-COPY-SECRET|DO-NOT-COPY-ID|privateApiKey|providerCharacterId/);
  assert.match(report.html, /preload="none"/);
  assert.doesNotMatch(report.html, /autoplay|<script|https:\/\//);
});

test('same immutable inputs generate identical inventory and output; runtime config remains byte-identical', async t => {
  const x = await fixture(t);
  const target = path.join(x.root, 'runtime', 'local-voices.json');
  const before = await fs.readFile(target);
  const first = await writeVoiceCastReview({ projectRoot: x.root, now: 'fixed-time' });
  const output = await fs.readFile(path.join(x.root, 'runtime', 'voice-cast', 'review', 'index.html'));
  const second = await writeVoiceCastReview({ projectRoot: x.root, now: 'fixed-time' });
  assert.deepEqual(first, second);
  assert.deepEqual(await fs.readFile(target), before);
  assert.deepEqual(await fs.readFile(path.join(x.root, 'runtime', 'voice-cast', 'review', 'index.html')), output);
});

test('tampered audio has no playback URL or transcript exposure', async t => {
  const x = await fixture(t);
  const altered = Buffer.from(x.wave); altered[50] ^= 1;
  await x.write(x.reference, altered);
  const result = await buildVoiceCastReview({ projectRoot: x.root });
  const c = result.inventory.profiles[0].candidates[0];
  assert.equal(c.playback, null); assert.equal(c.sourceVerified, false);
  assert.equal(c.transcript, undefined); assert.equal(result.inventory.counts.quarantinedCandidates, 1);
  assert.match(c.errors.join(), /SHA-256 mismatch/);
});

test('receipt mismatch, missing receipt and path traversal are quarantined', async t => {
  const x = await fixture(t);
  x.manifest.candidates[0] = { ...x.receipt, transcript: 'changed but manifest claims same receipt' };
  await x.json(`runtime/voice-cast/${x.lane}/manifest.json`, x.manifest);
  let result = await buildVoiceCastReview({ projectRoot: x.root });
  assert.equal(result.inventory.profiles[0].candidates[0].playback, null);
  assert.match(result.inventory.profiles[0].candidates[0].errors.join(), /immutable receipt mismatch/);
  x.manifest.candidates[0] = { ...x.receipt, reference: `runtime/voice-cast/${x.lane}/../outside/reference.wav` };
  await x.json(`runtime/voice-cast/${x.lane}/manifest.json`, x.manifest);
  result = await buildVoiceCastReview({ projectRoot: x.root });
  assert.match(result.inventory.profiles[0].candidates[0].errors.join(), /traversal/);
  x.manifest.candidates[0] = x.receipt;
  await x.json(`runtime/voice-cast/${x.lane}/manifest.json`, x.manifest);
  await fs.rm(path.join(x.root, x.directory, 'receipt.json'));
  result = await buildVoiceCastReview({ projectRoot: x.root });
  assert.equal(result.inventory.profiles[0].candidates[0].playback, null);
});

test('mutated source serialization, speaker and subtitle variant with updated hashes remain invalid', async t => {
  const x = await fixture(t);
  x.sceneData.Data.RootChunk.screenplayStore.lines[0].speaker.id = 1;
  const bytes = Buffer.from(JSON.stringify(x.sceneData));
  x.receipt.provenance.nativeActor.scene.jsonSha256 = digest(bytes);
  x.receipt.provenance.nativeActor.serializationVerification.cachedJsonSha256 = digest(bytes);
  await x.write(`${x.rawPath}.json`, bytes);
  await x.json(`${x.directory}/receipt.json`, x.receipt);
  await x.json(`runtime/voice-cast/${x.lane}/manifest.json`, x.manifest);
  const result = await buildVoiceCastReview({ projectRoot: x.root });
  assert.equal(result.inventory.profiles[0].candidates[0].playback, null);
  assert.match(result.inventory.profiles[0].candidates[0].errors.join(), /speaker\/line pointer mismatch/);
});

test('invalid canonical lane assignment stops generation before output writes', async t => {
  const x = await fixture(t);
  x.lanes.lanes[1].keys.push(x.key);
  await x.json('runtime/voice-cast-inventory-20261001/casting-lanes.json', x.lanes);
  await assert.rejects(writeVoiceCastReview({ projectRoot: x.root }), /duplicate lane profile/);
  await assert.rejects(fs.stat(path.join(x.root, 'runtime', 'voice-cast', 'review', 'index.html')), { code: 'ENOENT' });
});

test('partial in-progress manifest is surfaced as unprepared without preventing other lane evidence', async t => {
  const x = await fixture(t);
  await x.write(`runtime/voice-cast/${x.lane}/manifest.json`, '{ partial');
  const result = await buildVoiceCastReview({ projectRoot: x.root });
  assert.equal(result.inventory.profiles[0].status, 'unprepared');
  assert.equal(result.inventory.profiles[1].status, 'accepted');
  assert.equal(result.inventory.warnings.length, 1);
});

test('accepted existing descriptor cannot be silently replaced', async t => {
  const x = await fixture(t);
  await x.json('runtime/local-voices.json', { voices: { 'judy-alvarez': { ...x.accepted, transcript: 'different transcript' } } });
  const result = await buildVoiceCastReview({ projectRoot: x.root });
  const p = result.inventory.profiles.find(p => p.key === 'judy-alvarez');
  assert.equal(p.status, 'unprepared'); assert.equal(p.candidates[0].playback, null);
  assert.match(p.candidates[0].errors.join(), /Accepted reference configuration changed/);
  await x.json('runtime/local-voices.json', { voices: {} });
  const missing = await buildVoiceCastReview({ projectRoot: x.root });
  assert.equal(missing.inventory.profiles.find(p => p.key === 'judy-alvarez').status, 'unprepared');
});

test('canonical identity is rechecked instead of trusting the receipt key alone', async t => {
  const x = await fixture(t);
  x.receipt.provenance.nativeActor.identityProof = { kind: 'exact_actor', canonicalKey: x.key };
  x.receipt.provenance.identity.proof = x.receipt.provenance.nativeActor.identityProof;
  x.roster.characters[0].name = 'A different character';
  await x.json('runtime/voice-cast-inventory-20261001/cast-roster-inventory.json', x.roster);
  await x.json('characters/roster.json', x.roster.characters);
  const result = await buildVoiceCastReview({ projectRoot: x.root });
  assert.equal(result.inventory.profiles[0].candidates[0].playback, null);
  assert.match(result.inventory.profiles[0].candidates[0].errors.join(), /canonical roster alias/);
});

test('prompt-only roster evolution keeps historical receipts and a distinct current full fingerprint', async t => {
  const x = await fixture(t);
  const before = await buildVoiceCastReview({ projectRoot: x.root });
  await x.json('characters/roster.json', x.roster.characters.map(character => ({ key: character.key, name: character.name, backstory: 'A deeper biography', speakingStyleDescription: 'Updated portrayal prose', speakingStyleSampleDialogues: 'Updated original examples' })).reverse());
  const after = await buildVoiceCastReview({ projectRoot: x.root });
  assert.equal(after.inventory.counts.verifiedOriginalCandidates, 1);
  assert.equal(after.inventory.historicalRosterSha256, rosterHash);
  assert.equal(after.inventory.rosterSha256, rosterHash);
  assert.notEqual(after.inventory.currentRosterSha256, before.inventory.currentRosterSha256);
  assert.equal(after.inventory.identitySha256, before.inventory.identitySha256);
  assert.equal(after.inventory.canonicalIdentityVerified, true);
  assert.equal(after.inventory.fullRosterHashChanged, true);
  assert.equal(after.inventory.identityProjectionVersion, 1);
});

test('identity reassignment of key, name, alias or native record rejects the entire aggregate', async t => {
  const x = await fixture(t);
  for (const patch of [ { key: 'different-key' }, { name: 'Different person' }, { aliases: ['Other native actor'] }, { records: ['Character.Other'] } ]) {
    const current = structuredClone(x.roster.characters);
    Object.assign(current[0], patch);
    await x.json('characters/roster.json', current);
    await assert.rejects(buildVoiceCastReview({ projectRoot: x.root }), /canonical identity differs/);
  }
});

test('canonical projection matches wrapper key order, exact arrays and absent/null normalization', () => {
  const rows = [{ key: 'b-key', name: 'B', aliases: null }, { key: 'a-key', name: 'A', aliases: ['A', 'Alias'], records: ['Character.A'] }];
  const expected = '[{"aliases":["A","Alias"],"key":"a-key","name":"A","records":["Character.A"]},{"aliases":[],"key":"b-key","name":"B","records":[]}]';
  assert.equal(JSON.stringify(identityProjection(rows)), expected);
  assert.equal(identitySha256(rows), digest(Buffer.from(expected)));
  assert.notEqual(identitySha256(rows), identitySha256([{ ...rows[1], aliases: ['Alias', 'A'] }, rows[0]]));
  assert.throws(() => identityProjection([rows[0], rows[0]]), /duplicated/);
});

test('existing generated comparisons are paired with exact current originals; no timings or approval inferred', async t => {
  const x = await fixture(t); const generation = await generatedFixture(x);
  const result = await buildVoiceCastReview({ projectRoot: x.root, auditionRun: generation.run });
  assert.equal(result.inventory.counts.generatedComparisonSamples, 2);
  assert.equal(result.inventory.counts.quarantinedGeneratedSamples, 0);
  assert.equal(result.inventory.counts.newListeningApprovals, 0);
  assert.equal(result.inventory.counts.newProfilesPromoted, 0);
  const sample = result.inventory.profiles[0].generatedComparison;
  assert.equal(sample.sourceReference, x.reference);
  assert.equal(sample.referenceSha256, x.receipt.sha256);
  assert.equal(sample.transcriptSha256, x.receipt.transcriptSha256);
  assert.equal(sample.pcm.durationSeconds, 2);
  assert.equal(sample.sourceQualified, true); assert.equal(sample.listeningVerified, false); assert.equal(sample.approved, false);
  assert.equal(result.inventory.profiles[1].generatedComparison.sourceReference, x.accepted.reference);
  assert.equal((result.html.match(/class="comparison"/g) ?? []).length, 2);
  assert.match(result.html, /Source-qualified audition; listening pending/);
  assert.match(result.html, /Not a benchmark/);
  assert.doesNotMatch(JSON.stringify(result.inventory), /generationMs|providerSecret|DO-NOT-COPY-GENERATED-SECRET/);
});

test('missing optional default run does not fail original-reference review', async t => {
  const x = await fixture(t);
  const result = await buildVoiceCastReview({ projectRoot: x.root });
  assert.equal(result.inventory.auditions.status, 'missing');
  assert.equal(result.inventory.counts.generatedComparisonSamples, 0);
  assert.equal(result.inventory.counts.verifiedOriginalCandidates, 1);
  assert.equal(result.inventory.warnings.length, 0);
});

test('unknown generated profile and mismatched source hashes have no bad audio links', async t => {
  const x = await fixture(t); const generation = await generatedFixture(x);
  generation.report.renders[0].key = 'unregistered-character';
  generation.report.renders[0].sample = 'unregistered-character.wav';
  await x.json(generation.run, generation.report);
  let result = await buildVoiceCastReview({ projectRoot: x.root, auditionRun: generation.run });
  assert.equal(result.inventory.counts.generatedComparisonSamples, 1);
  assert.equal(result.inventory.counts.quarantinedGeneratedSamples, 1);
  assert.doesNotMatch(result.html, /unregistered-character\.wav/);
  generation.report.renders[0].key = x.key; generation.report.renders[0].sample = `${x.key}.wav`;
  generation.report.renders[0].referenceSha256 = 'c'.repeat(64);
  await x.json(generation.run, generation.report);
  result = await buildVoiceCastReview({ projectRoot: x.root, auditionRun: generation.run });
  assert.equal(result.inventory.profiles[0].generatedComparison.playback, null);
  assert.match(result.inventory.profiles[0].generatedComparison.errors.join(), /current chosen original/);
  generation.report.renders[0].referenceSha256 = x.receipt.sha256;
  generation.report.renders[0].transcriptSha256 = 'd'.repeat(64);
  await x.json(generation.run, generation.report);
  result = await buildVoiceCastReview({ projectRoot: x.root, auditionRun: generation.run });
  assert.equal(result.inventory.profiles[0].generatedComparison.playback, null);
});

test('a generated sample reassigned to another registered character cannot reuse its source binding', async t => {
  const x = await fixture(t); const generation = await generatedFixture(x);
  const borrowed = { ...generation.report.renders[0], key: 'judy-alvarez', sample: 'judy-alvarez.wav' };
  generation.report.renders = [borrowed];
  await x.json(generation.run, generation.report);
  const result = await buildVoiceCastReview({ projectRoot: x.root, auditionRun: generation.run });
  assert.equal(result.inventory.counts.generatedComparisonSamples, 0);
  assert.equal(result.inventory.counts.quarantinedGeneratedSamples, 1);
  const sample = result.inventory.profiles.find(profile => profile.key === 'judy-alvarez').generatedComparison;
  assert.equal(sample.playback, null);
  assert.match(sample.errors.join(), /current chosen original/);
});

test('generated duration and format are measured from PCM, not trusted from the render record', async t => {
  const x = await fixture(t); const generation = await generatedFixture(x);
  generation.report.renders[0].durationSeconds = 1.5;
  await x.json(generation.run, generation.report);
  let result = await buildVoiceCastReview({ projectRoot: x.root, auditionRun: generation.run });
  assert.match(result.inventory.profiles[0].generatedComparison.errors.join(), /actual PCM/);
  generation.report.renders[0].durationSeconds = 2;
  const bad = Buffer.from(generation.wave); bad.writeUInt16LE(3, 20);
  generation.report.renders[0].sha256 = digest(bad);
  await x.write(`${generation.directory}/${x.key}.wav`, bad);
  await x.json(generation.run, generation.report);
  result = await buildVoiceCastReview({ projectRoot: x.root, auditionRun: generation.run });
  assert.equal(result.inventory.profiles[0].generatedComparison.playback, null);
  assert.match(result.inventory.profiles[0].generatedComparison.errors.join(), /16-bit mono\/stereo PCM/);
});

test('generated run junctions do not emit external playback links', async t => {
  const x = await fixture(t); const generation = await generatedFixture(x);
  const outside = path.join(x.root, 'external-generated-run');
  await fs.rename(path.join(x.root, generation.directory), outside);
  try { await fs.symlink(outside, path.join(x.root, generation.directory), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Host does not permit symlinks'); return; } throw error; }
  const result = await buildVoiceCastReview({ projectRoot: x.root, auditionRun: generation.run });
  assert.equal(result.inventory.auditions.status, 'invalid');
  assert.equal(result.inventory.counts.generatedComparisonSamples, 0);
  assert.match(result.inventory.warnings.map(w => w.issue).join(), /Linked evidence path rejected/);
});

test('generated traversal, stale WAV and failed/partial samples are quarantined', async t => {
  const x = await fixture(t); const generation = await generatedFixture(x);
  await assert.rejects(buildVoiceCastReview({ projectRoot: x.root, auditionRun: 'runtime/voice-cast/auditions/test-run/../../outside/results.json' }), /traversal/);
  generation.report.renders[0].sample = '../outside.wav';
  await x.json(generation.run, generation.report);
  let result = await buildVoiceCastReview({ projectRoot: x.root, auditionRun: generation.run });
  assert.equal(result.inventory.profiles[0].generatedComparison.playback, null);
  generation.report.renders[0].sample = `${x.key}.wav`;
  await x.json(generation.run, generation.report);
  const stale = Buffer.from(generation.wave); stale[100] ^= 1;
  await x.write(`${generation.directory}/${x.key}.wav`, stale);
  result = await buildVoiceCastReview({ projectRoot: x.root, auditionRun: generation.run });
  assert.match(result.inventory.profiles[0].generatedComparison.errors.join(), /SHA-256 mismatch/);
  generation.report.renders[0].status = 'failed';
  await x.json(generation.run, generation.report);
  result = await buildVoiceCastReview({ projectRoot: x.root, auditionRun: generation.run });
  assert.match(result.inventory.profiles[0].generatedComparison.errors.join(), /failed, partial/);
  generation.report.state = 'running';
  await x.json(generation.run, generation.report);
  result = await buildVoiceCastReview({ projectRoot: x.root, auditionRun: generation.run });
  assert.equal(result.inventory.auditions.status, 'invalid');
  assert.equal(result.inventory.counts.generatedComparisonSamples, 0);
  assert.equal(result.inventory.profiles[0].generatedComparison, undefined);
});

test('output junctions are rejected before any external review directory is created', async t => {
  const x = await fixture(t);
  const outside = path.join(x.root, 'external');
  await fs.mkdir(outside);
  await fs.rename(path.join(x.root, 'runtime', 'voice-cast'), path.join(x.root, 'saved-cast'));
  try { await fs.symlink(outside, path.join(x.root, 'runtime', 'voice-cast'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Host does not permit symlinks'); return; } throw error; }
  await assert.rejects(writeVoiceCastReview({ projectRoot: x.root }), /Linked output directory rejected/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('linked candidate directory cannot escape the lane through a junction', async t => {
  const x = await fixture(t);
  const outside = path.join(x.root, 'outside');
  await fs.rename(path.join(x.root, x.directory), outside);
  try { await fs.symlink(outside, path.join(x.root, x.directory), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Host does not permit symlinks'); return; } throw error; }
  const result = await buildVoiceCastReview({ projectRoot: x.root });
  assert.equal(result.inventory.profiles[0].candidates[0].playback, null);
  assert.match(result.inventory.profiles[0].candidates[0].errors.join(), /Linked evidence path rejected/);
});

test('WAV parser uses frame counts and rejects truncated, duplicate or malformed PCM geometry', () => {
  assert.equal(pcmInfo(pcm({ channels: 2 })).durationSeconds, 3);
  const bytes = pcm();
  assert.throws(() => pcmInfo(bytes.subarray(0, -1)), /RIFF size mismatch/);
  const malformed = Buffer.from(bytes); malformed.writeUInt16LE(8, 32);
  assert.throws(() => pcmInfo(malformed), /PCM frame geometry/);
  const float = Buffer.from(bytes); float.writeUInt16LE(3, 20);
  assert.throws(() => pcmInfo(float), /16-bit/);
});

test('all HTML text is escaped, no role or metadata is an executable attribute', () => {
  assert.equal(escapeHtml(`<svg onload="bad()">&'`), '&lt;svg onload=&quot;bad()&quot;&gt;&amp;&#39;');
  const inventory = { generatedAt: '<script>bad</script>', counts: { profiles: 1, lanes: 1, acceptedProfiles: 0, profilesWithVerifiedCandidates: 0, verifiedOriginalCandidates: 0, unpreparedProfiles: 1, unavailableProfiles: 0, quarantinedCandidates: 0 }, warnings: [], profiles: [{ key: 'safe-key', name: '<img src=x onerror=bad()>', lane: '<script>x</script>', status: 'unprepared', gapReason: '" onmouseover="bad()', candidates: [] }], verificationBoundary: '<script>bad</script>' };
  const output = renderHtml(inventory);
  assert.doesNotMatch(output, /<script>|<img src=x/);
  assert.match(output, /&lt;img src=x onerror=bad\(\)&gt;/);
  assert.match(output, /default-src 'none'/);
  assert.equal(escapeMarkdown('![image](https://outside.example) <img>\n# heading'), '\\!\\[image\\]\\(https://outside\\.example\\) \\<img\\> \\# heading');
});
