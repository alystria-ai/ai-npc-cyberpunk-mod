import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DUB_ARCHIVE_NAMES, LanguageVoiceClips, dubArchivePath, languageDownloadUrl, readLanguageManifest} from './language-clips.mjs';
import {GameVoiceClips, SerialQueue, readManifest} from './voice-clips.mjs';
import {VoiceLanguagePacks} from './voice-language-packs.mjs';
import {PocketLanguageModels} from './pocket-language-models.mjs';
import {VoxtralVoice} from './voxtral-voice.mjs';
import {MistralScheduler} from './mistral-rate.mjs';
import {createVoiceProfileRegistry} from './voice-profile-registry.mjs';
import {sha256, sineWav, writePack} from './fixtures/voice-language-pack.mjs';

// The dubbed clips made on demand (docs/VOICE_LANGUAGE_PACKS.md, "Clips on demand"): the manifest reader, the build from the player's dub, the download for a player without it, the
// English reference until a clip is ready, and the way an installed pack stays first. The real builder is replaced by a function that writes small files; the real one is proved
// against the shipped packs by scripts/voice-extract/recover_language_manifest.py (docs/VOICE_LANGUAGE_PACKS.md).

const CLIPS = {
  'panam-palmer': {file: 'picked/panam-palmer.wav', bytes: sineWav({seconds: 0.5, frequency: 200}), text: 'Ich hab mir schon ein paar Gedanken gemacht.', exact: true, gender: 'female'},
  'resident-female': {file: 'archetypes/resident-female.wav', bytes: sineWav({seconds: 0.5, frequency: 240}), text: 'Du musst mir nichts sagen.', exact: true, gender: 'female'},
  'v-male': {file: 'v-voice/v-male.wav', bytes: sineWav({seconds: 0.5, frequency: 130}), text: 'Los geht es.', exact: false, gender: 'male'},
};
function manifestOf(language = 'de', tag = 'de') {
  const voices = {};
  for (const [key, clip] of Object.entries(CLIPS)) {
    voices[key] = {kind: clip.file.split('/')[0], file: clip.file, ...(clip.gender ? {gender: clip.gender} : {}), text: clip.text, seconds: 0.5, samples: (clip.bytes.length - 44) / 2,
      sha256: sha256(clip.bytes), exact: clip.exact, ...(clip.exact ? {how: 'pack', gain: null, lines: [['content', 'vo\\x.wem'], ...(key === 'resident-female' ? [['ep1', 'vo\\y.wem']] : [])]} : {})};
  }
  return {version: 1, language, locale: 'de-de', archive: 'lang_de_voice.archive', languageTag: tag, built: '2026-10-21', voices};
}

async function rig(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'language-clips-'));
  const project = join(dir, 'project'), references = join(dir, 'state', 'voice-references'), mirror = join(dir, 'game', 'voices'), state = join(dir, 'state');
  await mkdir(join(project, 'characters', 'voice-language-clips'), {recursive: true});
  if (options.manifest !== false) await writeFile(join(project, 'characters', 'voice-language-clips', 'de.json'), JSON.stringify(options.manifest ?? manifestOf()));
  const runs = [], ready = [], fetched = [], logs = [];
  const run = async (command, args) => {
    runs.push({command, args});
    if (options.exit) return {code: options.exit, stdout: '', stderr: options.stderr ?? 'the builder stopped'};
    const out = args[args.indexOf('--out') + 1];
    for (const key of args[args.indexOf('--key') + 1].split(',')) {
      const clip = CLIPS[key];
      await mkdir(join(out, clip.file.split('/')[0]), {recursive: true});
      await writeFile(join(out, clip.file), options.builtBytes?.[key] ?? clip.bytes);
    }
    return {code: 0, stdout: '{}', stderr: ''};
  };
  const fetch = async url => {
    fetched.push(url);
    const key = url.split('/').pop().replace('.wav', '');
    if (options.offline) throw Error('getaddrinfo ENOTFOUND huggingface.co');
    if (!CLIPS[key]) return {ok: false, status: 404};
    const bytes = options.downloadBytes?.[key] ?? CLIPS[key].bytes;
    return {ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)};
  };
  let clock = 1_000_000;
  const clips = await LanguageVoiceClips.open({projectDirectory: project, gameDirectory: join(dir, 'game'), referenceRoot: references, mirrorRoots: [mirror, references], stateDirectory: state,
    python: 'python.exe', script: 'voice_clip_build.py', vgmstream: 'vgmstream-cli.exe', run, dubPresent: typeof options.dub === 'function' ? options.dub : () => options.dub ?? true, download: options.download === false ? false : {fetch},
    onReady: (tag, key) => ready.push(`${tag}/${key}`), now: () => clock, retryMs: 60_000, log: line => logs.push(line), serial: options.serial});
  return {dir, project, references, mirror, state, runs, ready, fetched, logs, clips, advance: ms => { clock += ms; }, cleanup: () => rm(dir, {recursive: true, force: true})};
}
const settle = async clips => { while (clips.running.size) await Promise.allSettled([...clips.running.values()]); };

test('readLanguageManifest keeps well formed voices only and refuses another language\'s file', () => {
  const text = JSON.stringify(manifestOf());
  const manifest = readLanguageManifest(text, 'de');
  assert.deepEqual([...manifest.voices.keys()], ['panam-palmer', 'resident-female', 'v-male']);
  assert.equal(manifest.tag, 'de');
  assert.equal(manifest.voices.get('v-male').exact, false);
  assert.equal(readLanguageManifest(text, 'fr'), null);
  assert.equal(readLanguageManifest('{', 'de'), null);
  assert.equal(readLanguageManifest(JSON.stringify({...manifestOf(), version: 2}), 'de'), null);
  const broken = manifestOf();
  broken.voices['Bad Key'] = {...broken.voices['panam-palmer']};
  broken.voices['no-hash'] = {...broken.voices['panam-palmer'], sha256: 'x'};
  broken.voices['bad-file'] = {...broken.voices['panam-palmer'], file: '../panam.wav'};
  broken.voices['no-text'] = {...broken.voices['panam-palmer'], text: '  '};
  broken.voices['no-lines'] = {...broken.voices['panam-palmer'], lines: []};
  const kept = readLanguageManifest(JSON.stringify(broken), 'de');
  assert.deepEqual([...kept.voices.keys()].sort(), ['no-lines', 'panam-palmer', 'resident-female', 'v-male']);
  assert.equal(kept.voices.get('no-lines').exact, false, 'a recipe without lines cannot be built');
});

test('the dub archive of each pack language and the download address', () => {
  assert.deepEqual(Object.keys(DUB_ARCHIVE_NAMES).sort(), ['de', 'es-es', 'fr', 'it', 'ja', 'ko', 'pl', 'pt-br', 'ru', 'zh-cn']);
  assert.equal(DUB_ARCHIVE_NAMES['pt-br'], 'pt');
  assert.match(dubArchivePath('C:\\Games\\Cyberpunk 2077', 'pt-br', 'ep1'), /archive[\\/]pc[\\/]ep1[\\/]lang_pt_voice\.archive$/);
  assert.equal(languageDownloadUrl('de', 'picked/panam-palmer.wav'), 'https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/resolve/main/voice-clips/de/picked/panam-palmer.wav');
});

test('with the dub installed a clip is built once, in a process of its own, and the English reference speaks until it is ready', async () => {
  const r = await rig();
  try {
    assert.equal(r.clips.active, true);
    assert.equal(r.clips.supports('de'), true);
    assert.equal(r.clips.supports('fr'), false, 'a language with no manifest is not served');
    assert.equal(r.clips.supports('en'), false);
    assert.equal(r.clips.entry('de', 'panam-palmer'), null, 'not ready: the English reference speaks this reply');
    assert.equal(r.clips.entry('de', 'panam-palmer'), null);
    assert.equal(r.clips.running.size, 1, 'asked once, however many lookups');
    await settle(r.clips);
    assert.equal(r.runs.length, 1);
    assert.deepEqual(r.runs[0].args.slice(0, 2), ['voice_clip_build.py', 'build-language']);
    assert.equal(r.runs[0].args[r.runs[0].args.indexOf('--key') + 1], 'panam-palmer');
    assert.equal(r.runs[0].args[r.runs[0].args.indexOf('--out') + 1], join(r.references, 'multilingual', 'de'));
    assert.equal(r.runs[0].args[r.runs[0].args.indexOf('--manifest') + 1], join(r.project, 'characters', 'voice-language-clips', 'de.json'));
    assert.equal(r.fetched.length, 0, 'nothing is downloaded when the dub gives the clip');
    assert.deepEqual(r.ready, ['de/panam-palmer']);
    const entry = r.clips.entry('de', 'panam-palmer');
    assert.equal(entry.set, 'multilingual/de/picked/panam-palmer');
    assert.equal(entry.sha256, sha256(CLIPS['panam-palmer'].bytes));
    assert.equal(entry.kind, 'picked');
    assert.equal(entry.text, CLIPS['panam-palmer'].text);
    assert.equal(entry.path, join(r.references, 'multilingual', 'de', 'picked', 'panam-palmer.wav'));
    assert.equal(entry.preparedDirectory, join(r.references, 'multilingual', 'de', 'prepared'));
    for (const root of [r.references, r.mirror]) {
      assert.equal(existsSync(join(root, 'multilingual', 'de', 'picked', 'panam-palmer.wav')), true, 'the clip is in every folder a worker reads');
      assert.equal(existsSync(join(root, 'multilingual', 'de', 'generated.json')), true, 'the folder says it is not a pack');
      assert.equal(existsSync(join(root, 'multilingual', 'de', 'manifest.json')), false);
    }
    // a new service reads the index and does not build again
    const again = await LanguageVoiceClips.open({projectDirectory: r.project, referenceRoot: r.references, stateDirectory: r.state, run: async () => { throw Error('no build'); }});
    assert.equal(again.entry('de', 'panam-palmer')?.sha256, entry.sha256);
    assert.equal(again.running.size, 0);
    assert.equal(again.canMake, false);
    assert.equal(again.supports('de'), true, 'clips that are ready are served even where no new one can be made');
  } finally { await r.cleanup(); }
});

test('without the dub the one clip is downloaded and checked against the manifest', async () => {
  const r = await rig({dub: false});
  try {
    assert.equal(r.clips.entry('de', 'resident-female'), null);
    await settle(r.clips);
    assert.equal(r.runs.length, 0, 'no builder without the dub');
    assert.deepEqual(r.fetched, ['https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/resolve/main/voice-clips/de/archetypes/resident-female.wav']);
    assert.equal(r.clips.entry('de', 'resident-female')?.sha256, sha256(CLIPS['resident-female'].bytes));
    assert.equal(r.clips.report().clips.de.downloaded, 1);
    assert.equal(r.clips.report().clips.de.built, 0);
    // only the character that speaks is fetched, not the others
    assert.equal(r.fetched.length, 1);
  } finally { await r.cleanup(); }
});

test('a clip that uses Phantom Liberty\'s lines is downloaded when only the base game\'s dub is installed, with no process started', async () => {
  const r = await rig({dub: (language, part) => part !== 'ep1'});
  try {
    r.clips.want('de', 'resident-female');
    r.clips.want('de', 'panam-palmer');
    await settle(r.clips);
    assert.equal(r.runs.length, 1, 'only the clip that needs the base game alone is built');
    assert.equal(r.runs[0].args[r.runs[0].args.indexOf('--key') + 1], 'panam-palmer');
    assert.equal(r.fetched.length, 1);
    assert.match(r.fetched[0], /archetypes\/resident-female\.wav$/);
    assert.equal(r.clips.entry('de', 'resident-female')?.sha256, sha256(CLIPS['resident-female'].bytes));
  } finally { await r.cleanup(); }
});

test('a download that does not match the manifest is refused and the English reference keeps speaking', async () => {
  const r = await rig({dub: false, downloadBytes: {'resident-female': sineWav({seconds: 0.5, frequency: 999})}});
  try {
    assert.equal(r.clips.entry('de', 'resident-female'), null);
    await settle(r.clips);
    assert.equal(r.clips.entry('de', 'resident-female'), null);
    assert.equal(existsSync(join(r.references, 'multilingual', 'de', 'archetypes', 'resident-female.wav')), false, 'a refused clip is never kept');
    assert.match(r.logs.join('\n'), /download does not match the manifest/);
  } finally { await r.cleanup(); }
});

test('offline: no clip, no error, and it is tried again only after the wait', async () => {
  const r = await rig({dub: false, offline: true});
  try {
    assert.equal(r.clips.entry('de', 'panam-palmer'), null);
    await settle(r.clips);
    assert.equal(r.fetched.length, 1);
    assert.equal(r.clips.entry('de', 'panam-palmer'), null);
    await settle(r.clips);
    assert.equal(r.fetched.length, 1, 'not asked again at every line');
    assert.match(r.logs.join('\n'), /not made: download failed.*the English reference speaks/);
    r.advance(61_000);
    assert.equal(r.clips.entry('de', 'panam-palmer'), null);
    await settle(r.clips);
    assert.equal(r.fetched.length, 2, 'asked again after the wait');
    assert.equal(r.clips.report().failed, 1);
  } finally { await r.cleanup(); }
});

test('a clip the recipe cannot repeat exactly is downloaded even when the dub is installed', async () => {
  const r = await rig();
  try {
    r.clips.want('de', 'v-male');
    await settle(r.clips);
    assert.equal(r.runs.length, 0);
    assert.equal(r.fetched.length, 1);
    assert.equal(r.clips.entry('de', 'v-male')?.kind, 'v-voice');
  } finally { await r.cleanup(); }
});

test('a build that fails, or a game that has no voice files of the language, falls back to the download', async () => {
  for (const exit of [2, 3]) {
    const r = await rig({exit, stderr: 'the ep1 voice archive of this language is not installed'});
    try {
      r.clips.want('de', 'panam-palmer');
      await settle(r.clips);
      assert.equal(r.runs.length, 1);
      assert.equal(r.fetched.length, 1);
      assert.equal(r.clips.entry('de', 'panam-palmer')?.sha256, sha256(CLIPS['panam-palmer'].bytes));
      assert.equal(r.clips.report().clips.de.downloaded, 1);
    } finally { await r.cleanup(); }
  }
  const none = await rig({exit: 2, download: false});
  try {
    none.clips.want('de', 'panam-palmer');
    await settle(none.clips);
    assert.equal(none.clips.entry('de', 'panam-palmer'), null, 'no dub clip, no download: the English reference');
  } finally { await none.cleanup(); }
});

test('a clip built from a patched game (another hash) is kept, a voice the manifest does not know is not tried again, and a language with no manifest does nothing', async () => {
  const patched = sineWav({seconds: 0.5, frequency: 201});
  const r = await rig({builtBytes: {'panam-palmer': patched}});
  try {
    r.clips.want('de', 'panam-palmer');
    r.clips.want('de', 'somebody-new');
    await settle(r.clips);
    assert.equal(r.clips.entry('de', 'panam-palmer')?.sha256, sha256(patched));
    assert.match(r.logs.join('\n'), /differs from the pack's clip/);
    assert.equal(r.clips.entry('de', 'somebody-new'), null);
    await settle(r.clips);
    assert.equal(r.runs.length, 1);
    assert.equal(r.fetched.length, 0);
    r.clips.want('fr', 'panam-palmer');
    r.clips.want('en', 'panam-palmer');
    assert.equal(r.clips.running.size, 0);
  } finally { await r.cleanup(); }
  const empty = await rig({manifest: false});
  try {
    assert.equal(empty.clips.active, false);
    assert.equal(empty.clips.entry('de', 'panam-palmer'), null);
    assert.equal(empty.clips.running.size, 0);
  } finally { await empty.cleanup(); }
});

test('the switch: a service that is turned off, or has neither a builder nor a download, serves nothing', async () => {
  const off = await rig({});
  try {
    const clips = new LanguageVoiceClips({projectDirectory: off.project, referenceRoot: off.references, enabled: false});
    clips.available.add('de');
    assert.equal(clips.active, false);
    assert.equal(clips.entry('de', 'panam-palmer'), null);
    const bare = new LanguageVoiceClips({projectDirectory: off.project, referenceRoot: off.references});
    bare.available.add('de');
    assert.equal(bare.active, false, 'no builder and no download');
  } finally { await off.cleanup(); }
});

test('one build at a time, and the same queue as the English clips', async () => {
  const serial = new SerialQueue();
  let live = 0, peak = 0;
  const r = await rig({serial});
  try {
    const slow = r.clips.run;
    r.clips.run = async (...args) => { live++; peak = Math.max(peak, live); await new Promise(done => setTimeout(done, 20)); try { return await slow(...args); } finally { live--; } };
    const english = new GameVoiceClips({manifest: readManifest(JSON.stringify({version: 1, voices: {}})), serial, referenceRoot: r.references});
    const order = [];
    const englishJob = serial.run(async () => { order.push('english start'); live++; peak = Math.max(peak, live); await new Promise(done => setTimeout(done, 30)); live--; order.push('english end'); });
    r.clips.want('de', 'panam-palmer');
    r.clips.want('de', 'resident-female');
    await englishJob;
    await settle(r.clips);
    assert.equal(peak, 1, 'never two builds at once');
    assert.deepEqual(order, ['english start', 'english end']);
    assert.equal(r.runs.length, 2);
    assert.ok(english);
  } finally { await r.cleanup(); }
});

test('VoiceLanguagePacks: an installed pack is used first, the on-demand clip fills what the pack lacks and a language with no pack, and a generated folder is not a broken pack', async () => {
  const r = await rig();
  try {
    // a real pack for zh in the first root, and clips made on demand for de (no manifest.json there, a generated.json instead)
    await writePack(r.references, {language: 'zh-cn', languageTag: 'zh', withHash: true});
    const packs = new VoiceLanguagePacks({roots: [r.references], demand: r.clips, log: line => r.logs.push(line)});
    assert.equal(packs.active, true);
    assert.equal(packs.installed, false);
    await packs.scan();
    assert.equal(packs.installed, true);
    assert.deepEqual(packs.languages(), ['zh']);
    assert.equal(packs.entry('zh', 'panam-palmer').language, 'zh-cn', 'the pack\'s entry');
    assert.equal(packs.entry('zh', 'panam-palmer').generated, undefined);
    assert.equal(packs.entry('en', 'panam-palmer'), null);
    assert.equal(packs.entry('de', 'panam-palmer'), null, 'not ready');
    await settle(r.clips);
    const entry = packs.entry('de', 'panam-palmer');
    assert.equal(entry.generated, true);
    const descriptor = await packs.omniDescriptor('de', 'panam-palmer');
    assert.deepEqual(descriptor, {reference: 'runtime/voice-references/multilingual/de/picked/panam-palmer.wav', sha256: sha256(CLIPS['panam-palmer'].bytes), transcript: CLIPS['panam-palmer'].text});
    assert.equal(packs.setOf('de', 'panam-palmer'), 'multilingual/de/picked/panam-palmer');
    // the folder the clips were made in is not looked at as an incomplete pack
    await packs.scan();
    assert.deepEqual(packs.report().problems, []);
    assert.equal(packs.pack('de'), null);
    const report = packs.report();
    assert.equal(report.onDemand.active, true);
    assert.equal(report.onDemand.clips.de.ready, 1);
    // a folder with clips but neither a manifest nor the marker still is a problem
    await mkdir(join(r.references, 'multilingual', 'fr'), {recursive: true});
    await packs.scan();
    assert.equal(packs.report().problems.length, 1);
    // a pack that is installed later wins over the clips made here
    await writePack(r.references, {language: 'de', languageTag: 'de', voices: {'panam-palmer': {file: 'picked/panam-palmer.wav', text: 'Pack words.', gender: 'female', frequency: 300}}, withHash: true});
    await packs.scan();
    assert.equal(packs.entry('de', 'panam-palmer').text, 'Pack words.');
    assert.equal(packs.entry('de', 'panam-palmer').generated, undefined);
    assert.equal(packs.entry('de', 'resident-female'), null, 'a voice the pack lacks is made on demand');
    assert.equal(r.clips.running.size, 1);
    await settle(r.clips);
    assert.equal(packs.entry('de', 'resident-female')?.generated, true);
  } finally { await r.cleanup(); }
});

test('VoiceLanguagePacks without a demand source behaves as before', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'language-clips-'));
  try {
    const packs = new VoiceLanguagePacks({roots: [dir]});
    await packs.scan();
    assert.equal(packs.active, false);
    assert.equal(packs.entry('de', 'panam-palmer'), null);
    assert.equal('onDemand' in packs.report(), false);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('Pocket with a language model speaks from the on-demand clip once it is ready, and shows text until then', async () => {
  const r = await rig({dub: false});
  try {
    const packs = new VoiceLanguagePacks({roots: [r.references], demand: r.clips});
    await packs.scan();
    const pocket = new PocketLanguageModels({roots: [r.mirror], packs});
    pocket.models.set('de', {tag: 'de', language: 'de', directory: join(r.mirror, 'multilingual-pocket', 'de'), bytes: 1, version: 'x', expected: {}});
    assert.equal(pocket.speaks('de'), true);
    assert.equal(pocket.entry('de', 'panam-palmer'), null, 'not ready: shown as text');
    await settle(r.clips);
    assert.equal(pocket.entry('de', 'panam-palmer')?.set, 'multilingual/de/picked/panam-palmer');
    assert.equal(existsSync(join(r.mirror, 'multilingual', 'de', 'picked', 'panam-palmer.wav')), true, 'the Pocket folder has the clip');
    assert.equal(pocket.speaks('fr'), false);
  } finally { await r.cleanup(); }
});

test('the Mistral voice: English until the clip is ready, then the made clip, with its slot kept in the language folder (made on demand, nothing shipped)', async () => {
  const r = await rig();
  try {
    const english = sineWav({seconds: 0.5, frequency: 330});
    const packs = new VoiceLanguagePacks({roots: [r.references], demand: r.clips});
    await packs.scan();
    const seen = [];
    const voice = new VoxtralVoice({getKey: () => 'k'.repeat(40), referenceRoot: join(r.dir, 'shipped'), languagePacks: packs, scheduler: new MistralScheduler({spacingMs: 0}),
      registry: createVoiceProfileRegistry({version: 2, provider: 'hybrid', engine: 'omnivoice', voices: {'panam-palmer': {reference: 'runtime/voice-references/picked/autobest/omni-long/panam-palmer.wav', sha256: sha256(english), transcript: 'English words.'}}}),
      read: async path => (String(path).includes('multilingual') ? readFile(path) : english), prepare: async (bytes, options) => { seen.push(options); return null; }});
    assert.equal(voice.languageEntry('panam-palmer', 'de'), null, 'not ready: the English reference');
    await settle(r.clips);
    const entry = voice.languageEntry('panam-palmer', 'de');
    assert.equal(voice.languageSet('panam-palmer', 'de'), 'multilingual/de/picked/panam-palmer');
    const made = await voice.buildFromPack('panam-palmer', entry);
    assert.ok(made.base64);
    assert.equal(seen.at(-1).slots, join(r.references, 'multilingual', 'de', 'prepared'));
    assert.equal(seen.at(-1).sha256, sha256(CLIPS['panam-palmer'].bytes));
    assert.equal(made.source, 'language-pack:de');
  } finally { await r.cleanup(); }
});

test('a clip that was written is not trusted when its file is gone: it is made again', async () => {
  const r = await rig();
  try {
    r.clips.want('de', 'resident-female');
    await settle(r.clips);
    assert.equal(r.runs.length, 1);
    const index = JSON.parse(await readFile(join(r.state, 'voice-language-clips.json'), 'utf8'));
    assert.equal(index.clips.de['resident-female'].bytes, CLIPS['resident-female'].bytes.length);
    await rm(join(r.references, 'multilingual', 'de', 'archetypes', 'resident-female.wav'));
    const again = await LanguageVoiceClips.open({projectDirectory: r.project, referenceRoot: r.references, stateDirectory: r.state, python: 'p', script: 's', gameDirectory: r.dir, dubPresent: () => true,
      run: async (command, args) => { const out = args[args.indexOf('--out') + 1]; await mkdir(join(out, 'archetypes'), {recursive: true}); await writeFile(join(out, 'archetypes', 'resident-female.wav'), CLIPS['resident-female'].bytes); return {code: 0, stdout: '', stderr: ''}; }});
    assert.equal(again.entry('de', 'resident-female'), null);
    await settle(again);
    assert.equal(again.entry('de', 'resident-female')?.sha256, sha256(CLIPS['resident-female'].bytes));
  } finally { await r.cleanup(); }
});

