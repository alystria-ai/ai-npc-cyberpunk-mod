import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm, readFile, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {parseVoiceOverLanguage, readVoiceOverLanguage, loadVVoiceReferencesWithMods, installVVoiceReference, modLabel, vGenderOfKey, V_MOD_LINES_FILE, V_MOD_SWITCH} from './v-voice-mod-service.mjs';
import {vVoiceModsSection} from './support-report.mjs';
import {describeVLine, formatVoiceRoute} from './voice-routing-log.mjs';
import {encodeWav16} from './voxtral-reference.mjs';

const sine = (seconds, hz = 220) => Float32Array.from({length: Math.round(seconds * 24000)}, (_, i) => 0.2 * Math.sin(2 * Math.PI * hz * i / 24000));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const LINES = readFileSync(new URL('../assets/v-voice/v-mod-lines.json', import.meta.url), 'utf8');

/** A folder shaped like voices/v-voice: v-voice.json, two clips and (optionally) the line list. */
async function shippedFolder(root, {lines = true, genders = ['male', 'female']} = {}) {
  const directory = join(root, 'shipped'), voices = {};
  await mkdir(directory, {recursive: true});
  for (const gender of genders) {
    const bytes = encodeWav16(sine(9, gender === 'male' ? 150 : 250), 24000);
    await writeFile(join(directory, `v-${gender}.wav`), bytes);
    voices[gender] = {file: `v-${gender}.wav`, transcript: `Shipped ${gender} words.`, sha256: sha(bytes), seconds: 9};
  }
  await writeFile(join(directory, 'v-voice.json'), JSON.stringify({version: 1, voices}));
  if (lines) await writeFile(join(directory, V_MOD_LINES_FILE), LINES);
  return directory;
}

/** A stand-in for ensureVoiceModReferences that "built" the given genders into outFolder (a real one is tested in v-voice-mods.test.mjs). */
function fakeEnsure(winners, {calls = []} = {}) {
  return async options => {
    calls.push(options);
    const voices = {}, manifest = {version: 1, voices: {}};
    await mkdir(options.outFolder, {recursive: true});
    for (const [gender, relative] of Object.entries(winners)) {
      const bytes = encodeWav16(sine(11.5, gender === 'male' ? 120 : 300), 24000);
      await mkdir(options.outFolder, {recursive: true});
      await writeFile(join(options.outFolder, `v-${gender}.wav`), bytes);
      manifest.voices[gender] = {file: `v-${gender}.wav`, transcript: `Mod ${gender} words.`, sha256: sha(bytes), seconds: 11.5, sampleRate: 24000, source: {archive: relative}};
      voices[gender] = 'built';
    }
    await writeFile(join(options.outFolder, 'v-voice.json'), JSON.stringify(manifest));
    const archives = Object.entries(winners).map(([gender, relative]) => ({relative, path: join('C:/secret/place', relative), size: 5, [gender]: {probeHits: 290, probeTotal: 300, lineHits: [0, 1, 2]}}));
    return {directory: Object.keys(winners).length ? options.outFolder : null, voices, sources: {...winners}, detection: {archives, winners: Object.fromEntries(Object.entries(winners).map(([g, r]) => [g, archives.find(a => a.relative === r)])),
      stats: {total: archives.length, inspected: archives.length, cached: 0, failed: 0, ms: 12}}};
  };
}

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'vmod-service-'));
  try { return await fn(root); } finally { await rm(root, {recursive: true, force: true}); }
}
const options = (root, shipped, extra = {}) => ({shippedDirectories: [shipped], game: join(root, 'game'), stateDirectory: join(root, 'state'), project: join(root, 'app'),
  env: {}, language: async () => 'en-us', ...extra});

// ---- the game's voice-over language -----------------------------------------------------------------------------------------------------

test('the voice-over language is read from the game\'s UserSettings.json, and is unknown when the file says nothing', async () => {
  const settings = language => JSON.stringify({version: 1, data: [{group_name: '/graphics', options: []}, {group_name: '/language', options: [{name: 'VoiceOver', value: language}, {name: 'Subtitles', value: 'de-de'}]}]});
  assert.equal(parseVoiceOverLanguage(settings('en-us')), 'en-us');
  assert.equal(parseVoiceOverLanguage('\uFEFF' + settings('FR-FR')), 'fr-fr');
  for (const text of ['', 'not json', '{}', JSON.stringify({data: []}), JSON.stringify({data: [{group_name: '/language', options: [{name: 'Subtitles', value: 'de-de'}]}]})]) assert.equal(parseVoiceOverLanguage(text), null, text);
  await withRoot(async root => {
    const where = join(root, 'CD Projekt Red', 'Cyberpunk 2077');
    await mkdir(where, {recursive: true}); await writeFile(join(where, 'UserSettings.json'), settings('ja-jp'));
    assert.equal(await readVoiceOverLanguage({env: {LOCALAPPDATA: root}}), 'ja-jp');
    assert.equal(await readVoiceOverLanguage({env: {LOCALAPPDATA: join(root, 'nothing')}}), null);
    assert.equal(await readVoiceOverLanguage({env: {}}), null);
  });
});

// ---- the references --------------------------------------------------------------------------------------------------------------------

test('with no mod the shipped references are used and labelled shipped', async () => {
  await withRoot(async root => {
    const shipped = await shippedFolder(root);
    const logs = [];
    const result = await loadVVoiceReferencesWithMods({...options(root, shipped), ensure: fakeEnsure({}), list: async () => [], log: line => logs.push(line)});
    assert.deepEqual(Object.keys(result.voices).sort(), ['female', 'male']);
    assert.equal(result.voices.male.source, 'shipped'); assert.equal(result.voices.female.source, 'shipped');
    assert.equal(result.voices.male.reference, resolve(shipped, 'v-male.wav'));
    assert.deepEqual(result.report.references, {male: 'shipped', female: 'shipped'});
    assert.deepEqual(logs, []);
  });
});

test('a mod\'s reference replaces the shipped clip of its gender only, and is labelled with the archive\'s file name', async () => {
  await withRoot(async root => {
    const shipped = await shippedFolder(root);
    const logs = [], calls = [];
    const result = await loadVVoiceReferencesWithMods({...options(root, shipped), ensure: fakeEnsure({male: 'redmod/Some Mod/JC Denton.archive'}, {calls}), list: async () => [], log: line => logs.push(line)});
    assert.equal(result.voices.male.source, 'mod:JC Denton.archive');
    assert.equal(result.voices.male.reference, resolve(root, 'state', 'v-voice-mod', 'v-male.wav'));
    assert.equal(result.voices.male.transcript, 'Mod male words.');
    assert.equal(result.voices.female.source, 'shipped', 'the other gender keeps the shipped clip');
    assert.equal(result.voices.female.reference, resolve(shipped, 'v-female.wav'));
    assert.deepEqual(result.report.references, {male: 'mod:JC Denton.archive', female: 'shipped'});
    assert.deepEqual(result.report.mods, [{archive: 'JC Denton.archive', male: 0.97, female: 0}]);
    assert.ok(logs.some(line => /male reference comes from the V voice mod JC Denton\.archive/.test(line)));
    assert.equal(calls.length, 1, 'once');
    assert.equal(calls[0].outFolder, resolve(root, 'state', 'v-voice-mod'));
    assert.equal(calls[0].cachePath, resolve(root, 'state', 'v-voice-mods-cache.json'));
    assert.equal(calls[0].decode, null, 'no decoder in this folder');
    assert.equal(result.report.decoder, 'missing');
    assert.doesNotMatch(JSON.stringify(result.report) + logs.join('\n'), /secret|state|app[\\/]/, 'no path in the report or the log');
  });
});

test('the decoder is found in app/vgmstream and handed to the build', async () => {
  await withRoot(async root => {
    const shipped = await shippedFolder(root);
    await mkdir(join(root, 'app', 'vgmstream'), {recursive: true}); await writeFile(join(root, 'app', 'vgmstream', 'vgmstream-cli.exe'), 'x');
    const calls = [];
    const result = await loadVVoiceReferencesWithMods({...options(root, shipped), ensure: fakeEnsure({female: 'x.archive'}, {calls}), list: async () => []});
    assert.equal(typeof calls[0].decode, 'function'); assert.equal(result.report.decoder, 'found');
    assert.equal(result.voices.female.source, 'mod:x.archive');
  });
});

test('a game whose voice-over is not English ignores V voice mods, with one log line and no scan', async () => {
  await withRoot(async root => {
    const shipped = await shippedFolder(root);
    const logs = [], calls = [];
    const result = await loadVVoiceReferencesWithMods({...options(root, shipped, {language: async () => 'fr-fr'}), ensure: fakeEnsure({male: 'a.archive'}, {calls}), list: async () => [], log: line => logs.push(line)});
    assert.equal(calls.length, 0);
    assert.equal(result.voices.male.source, 'shipped');
    assert.equal(logs.length, 1); assert.match(logs[0], /voice-over language is fr-fr.*English voice-over only/);
    assert.match(result.report.ignored, /fr-fr/);
  });
});

test('an unknown voice-over language counts as English; the developer switch, a missing line list and a failing step all keep the shipped references', async () => {
  await withRoot(async root => {
    const shipped = await shippedFolder(root);
    const calls = [];
    const unknown = await loadVVoiceReferencesWithMods({...options(root, shipped, {language: async () => null}), ensure: fakeEnsure({male: 'a.archive'}, {calls}), list: async () => []});
    assert.equal(unknown.voices.male.source, 'mod:a.archive');
    const off = await loadVVoiceReferencesWithMods({...options(root, shipped, {env: {[V_MOD_SWITCH]: 'off'}}), ensure: fakeEnsure({male: 'a.archive'}, {calls}), list: async () => []});
    assert.equal(off.voices.male.source, 'shipped'); assert.equal(off.report.enabled, false); assert.equal(calls.length, 1, 'the switch skips the scan');
    const bare = await shippedFolder(join(root, 'bare'), {lines: false});
    const noLines = await loadVVoiceReferencesWithMods({...options(root, bare), ensure: fakeEnsure({male: 'a.archive'}, {calls}), list: async () => []});
    assert.equal(noLines.voices.male.source, 'shipped'); assert.match(noLines.report.ignored, /v-mod-lines\.json/); assert.equal(calls.length, 1);
    const logs = [];
    const broken = await loadVVoiceReferencesWithMods({...options(root, shipped), ensure: async () => { throw Error('disk exploded'); }, list: async () => [], log: line => logs.push(line)});
    assert.equal(broken.voices.male.source, 'shipped'); assert.deepEqual(Object.keys(broken.voices).sort(), ['female', 'male']);
    assert.ok(logs.some(line => /V voice mods were not used: disk exploded/.test(line)));
  });
});

test('a mod with no decoder says so once and V keeps the shipped voice', async () => {
  await withRoot(async root => {
    const shipped = await shippedFolder(root);
    const logs = [];
    const ensure = async () => ({directory: null, voices: {male: 'needs-decoder'}, detection: {archives: [], winners: {male: null, female: null}, stats: {total: 1, inspected: 1, cached: 0, failed: 0, ms: 3}}});
    const result = await loadVVoiceReferencesWithMods({...options(root, shipped), ensure, list: async () => [], log: line => logs.push(line)});
    assert.equal(result.voices.male.source, 'shipped');
    assert.equal(logs.filter(line => /decoder/.test(line)).length, 1);
  });
});

// ---- review A2: nothing is scanned at start, only the references an earlier scan built are read -----------------------------------------------------------------

test('at start (scan: false) nothing is listed, decoded or scanned: the shipped references and the ones an earlier scan built are read as files', async () => {
  await withRoot(async root => {
    const shipped = await shippedFolder(root);
    // An earlier session's scan left a reference for the male voice.
    await fakeEnsure({male: 'redmod/Some Mod/JC Denton.archive'})({outFolder: resolve(root, 'state', 'v-voice-mod')});
    const forbidden = name => () => { throw Error(`${name} must not run at start`); };
    const logs = [];
    const result = await loadVVoiceReferencesWithMods({...options(root, shipped), scan: false, ensure: forbidden('ensure'), list: forbidden('list'), decoder: forbidden('decoder'), log: line => logs.push(line)});
    assert.equal(result.voices.male.source, 'mod:JC Denton.archive');
    assert.equal(result.voices.male.reference, resolve(root, 'state', 'v-voice-mod', 'v-male.wav'));
    assert.equal(result.voices.female.source, 'shipped');
    assert.deepEqual(result.report.references, {male: 'mod:JC Denton.archive', female: 'shipped'});
    assert.equal(result.report.scan, null, 'no scan has run');
    assert.equal(result.changed, undefined);
  });
  // No earlier scan: the shipped clips, nothing else.
  await withRoot(async root => {
    const shipped = await shippedFolder(root);
    const forbidden = name => () => { throw Error(`${name} must not run at start`); };
    const fresh = await loadVVoiceReferencesWithMods({...options(root, shipped), scan: false, ensure: forbidden('ensure'), list: forbidden('list')});
    assert.deepEqual([fresh.voices.male.source, fresh.voices.female.source], ['shipped', 'shipped']);
  });
});

test('the scan after start lists what changed against the voices in use, and a reference built from another mod than the winner is never labelled with the winner\'s name', async () => {
  await withRoot(async root => {
    const shipped = await shippedFolder(root);
    const current = (await loadVVoiceReferencesWithMods({...options(root, shipped), scan: false})).voices;
    const found = await loadVVoiceReferencesWithMods({...options(root, shipped), current, ensure: fakeEnsure({male: 'x.archive'}), list: async () => []});
    assert.deepEqual(found.changed, ['male'], 'the male voice is the mod\'s now, the female one is as it was');
    assert.equal(found.voices.male.source, 'mod:x.archive');
    const again = await loadVVoiceReferencesWithMods({...options(root, shipped), current: found.voices, ensure: fakeEnsure({male: 'x.archive'}), list: async () => []});
    assert.deepEqual(again.changed, [], 'nothing changed: nothing to apply');
    // A manifest row left by mod A while the winner is B: the row is not B's voice.
    const stale = async options2 => { const made = await fakeEnsure({male: 'a.archive'})(options2); made.detection.winners.male = {relative: 'b.archive', size: 1}; made.sources = {male: 'a.archive'}; return made; };
    const mixed = await loadVVoiceReferencesWithMods({...options(root, shipped), ensure: stale, list: async () => []});
    assert.equal(mixed.voices.male.source, 'shipped');
  });
});

test('installVVoiceReference puts the clip where the workers read it, once per root, and leaves an identical copy alone', async () => {
  await withRoot(async root => {
    const bytes = encodeWav16(sine(9, 200), 24000), source = join(root, 'v-male.wav');
    await writeFile(source, bytes);
    const voice = {key: 'v-male', reference: source, sha256: sha(bytes)};
    const logs = [];
    assert.equal(await installVVoiceReference(voice, [join(root, 'refs'), join(root, 'refs'), null, join(root, 'pocket')], {log: line => logs.push(line)}), 2);
    assert.equal(sha(await readFile(join(root, 'refs', 'addons', 'v-male.wav'))), voice.sha256);
    assert.equal(sha(await readFile(join(root, 'pocket', 'addons', 'v-male.wav'))), voice.sha256);
    assert.equal(await installVVoiceReference(voice, [join(root, 'refs')]), 0, 'the same bytes are not copied again');
    assert.deepEqual((await readdir(join(root, 'refs', 'addons'))).sort(), ['v-male.wav'], 'no temporary file is left beside the clip');
    const other = encodeWav16(sine(9, 300), 24000);
    await writeFile(source, other);
    assert.equal(await installVVoiceReference({...voice, sha256: sha(other)}, [join(root, 'refs')]), 1, 'a new clip replaces the copy');
    assert.equal(sha(await readFile(join(root, 'refs', 'addons', 'v-male.wav'))), sha(other));
    assert.equal(await installVVoiceReference({...voice, reference: join(root, 'missing.wav')}, [join(root, 'refs2')], {log: line => logs.push(line)}), 0, 'a missing clip is a log line, not an error');
    assert.equal(logs.length, 1);
  });
});

// ---- labels, the support report and the routing line ------------------------------------------------------------------------------------

test('labels carry the archive\'s file name only', () => {
  assert.equal(modLabel('redmod/My Mod/archives/Voice.archive'), 'mod:Voice.archive');
  assert.equal(modLabel('sub/x.archive'), 'mod:x.archive');
  assert.equal(vGenderOfKey('v-male'), 'male'); assert.equal(vGenderOfKey('v-female'), 'female'); assert.equal(vGenderOfKey('panam-palmer'), null);
});

test('the support report section keeps names, counts and labels, and nothing else', () => {
  assert.equal(vVoiceModsSection(null), null);
  const section = vVoiceModsSection({enabled: true, ignored: null, voiceOverLanguage: 'en-us', decoder: 'found', scan: {archives: 21, inspected: 2, cached: 19, failed: 0, ms: 49, path: 'C:/x'},
    mods: [{archive: 'JC Denton.archive', male: 1, female: 0, path: 'C:/x'}], built: {male: 'kept', female: undefined}, references: {male: 'mod:JC Denton.archive', female: 'manual'}, secret: 'C:/x'});
  assert.deepEqual(section, {enabled: true, ignored: null, voiceOverLanguage: 'en-us', decoder: 'found', scan: {archives: 21, inspected: 2, cached: 19, failed: 0, ms: 49},
    mods: [{archive: 'JC Denton.archive', male: 1, female: 0}], built: {male: 'kept', female: null}, references: {male: 'mod:JC Denton.archive', female: 'manual'}});
  assert.doesNotMatch(JSON.stringify(section), /C:/);
});

test('a V line\'s routing record names the reference and never a path', () => {
  const line = formatVoiceRoute(describeVLine({input: {profileKey: 'judy-alvarez'}, summary: {result: 'played', engine: 'omni', voice: 'v-male', reference: 'mod:JC Denton.archive'}, now: () => 0}));
  assert.match(line, /profile=V voice=v-male name="V \(typed line\)" requested="V.s voice" used="OmniVoice" ref="mod:JC Denton\.archive"/);
  assert.match(formatVoiceRoute(describeVLine({summary: {result: 'played', engine: 'pocket-helper', voice: 'v-female', reference: 'manual'}, now: () => 0})), /used="Pocket" ref="manual"/);
  assert.match(formatVoiceRoute(describeVLine({summary: {result: 'dropped', reason: 'slower-than-reply', engine: 'voxtral', voice: 'v-male', reference: 'shipped'}, now: () => 0})), /used="Mistral cloud voice" ref="shipped" fallback="V line dropped \(slower-than-reply\)"/);
});
