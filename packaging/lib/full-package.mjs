// The Full install package (owner decision 2026-10-28, docs/PACKAGING.md, "The Full install package"): the Update zip (the former Scripts zip) and the
// Runtime base zip of one game version in ONE zip, extracted into the game folder. This is the planning half of packaging/build-full.mjs and has no
// file access, so a test can run it on small fixtures: it takes the listings of the two zips and either returns the entries of the combined zip or says
// why the two cannot be combined.
//
// The two packages must not overlap (docs/PACKAGING.md, "Code in the Scripts": the Update zip carries all of the code, the base none). The only path
// both carry is the install note, and the combined zip carries one note of its own instead. Everything the two builds guard separately is guarded again
// over the union: nothing shipped is ever written by our code (packaging/lib/package-writes.mjs, the Vortex rule), no development file, no key file.
import {CODE_FOLDER, compareVersions, isCodeGamePath} from './code-payload.mjs';
import {INSTALL_NOTE_PATH} from './pack-overlap.mjs';
import {GAME_VARIANTS, LEGACY_GAME} from './game-variants.mjs';
import {BASE_MARKER, archiveEntry, forbiddenEntry} from './package-guards.mjs';
import {shippedButWritten} from './package-writes.mjs';
import {longRuntimePaths} from './runtime-prune.mjs';

// The names are the mod page's name on Nexus Mods (owner decision 2026-10-28).
//   Full install   AI-Companions-LLM-<version>[-for-2.31].zip                       (Hugging Face: AI-Companions-LLM.zip)
//   Update         AI-Companions-LLM-Update-<from>-to-<version>[-for-2.31].zip      (Hugging Face: AI-Companions-LLM-Update.zip)
// <from> is runtimeBase.required, the oldest Runtime base the update runs on. The update is the former "Scripts" zip: the same contents (the package keeps
// the internal name "scripts" in its release.json and in the build's package id). The .files.json beside each zip is named like the zip.
// Renamed from AI-NPC-LLM-Companions on 2026-10-31 (the Nexus name is "AI Companions using Large Language Models" from 0.4.0). Nothing in the mod recognises an install by this name,
// so an install made from an older zip keeps working. Only upload-packs.py still reads the old Update zip name in a build folder.
export const FULL_TITLE = 'AI-Companions-LLM';
export const UPDATE_TITLE = `${FULL_TITLE}-Update`;
export const gameSuffix = game => {
  if (!Object.hasOwn(GAME_VARIANTS, game)) throw Error(`Unknown game ${game}; expected one of ${Object.keys(GAME_VARIANTS).join(', ')}.`);
  return GAME_VARIANTS[game].suffix;
};
export const fullBaseName = (version, game) => `${FULL_TITLE}-${version}${gameSuffix(game)}`;
export const updateBaseName = (from, version, game) => `${UPDATE_TITLE}-${from}-to-${version}${gameSuffix(game)}`;

/**
 * The <from> of the update's name (owner decision 2026-10-28): the oldest Runtime base it runs on (runtimeBase.required) when that is the release just before
 * this one, so the update covers one release (Update-0.3.3-to-0.3.4), and otherwise the base with "-and-up" (owner 2026-10-30: "any" read too loose),
 * so the update for 0.3.3 and 0.3.4 is Update-0.3.3-and-up-to-0.3.5. An install older than the base takes the Full zip either way. runtimeBase.previousRelease is the release before this one.
 */
export function updateFrom(config) {
  const {required, previousRelease} = config.runtimeBase ?? {};
  const plain = value => typeof value === 'string' && /^\d+(\.\d+){1,3}$/.test(value);
  if (!plain(required)) throw Error(`runtimeBase.required in release.config.json is not a version: ${required}`);
  if (!plain(previousRelease)) throw Error('runtimeBase.previousRelease in release.config.json must name the release before this one (it names the update zip).');
  if (compareVersions(required, previousRelease) > 0) throw Error(`runtimeBase.required ${required} is newer than the previous release ${previousRelease}.`);
  return compareVersions(required, previousRelease) === 0 ? required : `${required}-and-up`;
}
export const updateBaseNameFor = (config, version, game) => updateBaseName(updateFrom(config), version, game);
export const runtimeZipName = (version, game) => `Runtime-${version}${gameSuffix(game)}.zip`;

// The install note of the Full zip. The standard note (build-release.mjs INSTALL_NOTE) is fixed text that the optional packs carry too, so the Full zip
// uses a file name of its own: extracting a pack, or the Update zip, over a Full install adds the standard note beside this one and Windows never asks
// about a file with the same name and other words.
export const FULL_NOTE_NAME = 'HOW TO INSTALL - AI Companions using Large Language Models full install - extract into your Cyberpunk 2077 folder.txt';
export const FULL_NOTE = [
  'AI Companions using Large Language Models - full install',
  '',
  'Extract this zip INTO your Cyberpunk 2077 folder (the folder that has bin, archive and r6 in it), and allow folders to merge.',
  'It holds everything the mod needs, so there is nothing else to download. The zip already starts with the right folders (red4ext or bin).',
  '',
  'Do not extract it into a new folder named after the zip. Windows "Extract All" and 7-Zip "Extract to <name>" do that by default:',
  'change the destination to the Cyberpunk 2077 folder itself. If it happened anyway, the mod moves its optional pack files into',
  'place by itself the next time the game starts.',
  '',
  'Using Vortex or Mod Organizer 2? Add this zip as ONE mod, and update that mod with each new copy of this zip. Remove older separate',
  'Scripts and Runtime mods first. Do not add the small Update zip to a mod manager: it is for manual installs only.',
  '',
  'You can delete this text file after installing.',
  ''].join('\r\n');

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const crcOf = entry => entry.crc >>> 0;

/**
 * `update` and `runtime`: {label, entries: [{name, crc, uncompressed}], release: the parsed release.json, extra: update: {removes} (code.json),
 * runtime: {removes} (the removal list the Runtime carries)}. `config`: release.config.json. `game`, `version`: what the build is for.
 * Returns {entries: [{from: 'update' | 'runtime' | null, entry | note}], problems: [string]}; no problems means the zips can be combined.
 */
export function planFull({update, runtime, config, game, version}) {
  const problems = [];
  const layout = config.layout;
  const check = (ok, message) => { if (!ok) problems.push(message); };

  // The two packages are the ones they say they are, for the same game, and the base is new enough for the update.
  const ru = update.release ?? {}, rr = runtime.release ?? {};
  check(ru.package === 'scripts', `${update.label} is not the update package (release.json package "${ru.package}").`);
  check(rr.package === 'runtime' && rr.kind === 'base', `${runtime.label} is not a Runtime base (release.json package "${rr.package}", kind "${rr.kind}").`);
  check(ru.version === version, `${update.label} is version ${ru.version}, not ${version}.`);
  check((ru.game ?? LEGACY_GAME) === game, `${update.label} is built for game ${ru.game ?? LEGACY_GAME}, not ${game}.`);
  check((rr.game ?? LEGACY_GAME) === game, `${runtime.label} is built for game ${rr.game ?? LEGACY_GAME}, not ${game}.`);
  check(typeof ru.runtimeBase === 'string' && ru.runtimeBase !== '', `${update.label} names no Runtime base it needs (release.json runtimeBase).`);
  if (typeof ru.runtimeBase === 'string' && typeof rr.version === 'string') {
    check(compareVersions(rr.version, ru.runtimeBase) >= 0, `The Runtime base ${rr.version} is older than the ${ru.runtimeBase} that the update ${ru.version} needs.`);
  }

  // No overlap. Windows compares names without regard to case, so this does too. The install note is the one path both carry.
  const notes = [update, runtime].map(part => part.entries.find(entry => entry.name === INSTALL_NOTE_PATH));
  check(notes[0] && notes[1] && crcOf(notes[0]) === crcOf(notes[1]) && notes[0].uncompressed === notes[1].uncompressed,
    `Both packages must carry the same install note (${INSTALL_NOTE_PATH}), which the Full zip replaces with its own.`);
  const seen = new Set(update.entries.filter(entry => entry.name !== INSTALL_NOTE_PATH).map(entry => entry.name.toLowerCase()));
  const shared = runtime.entries.filter(entry => entry.name !== INSTALL_NOTE_PATH && seen.has(entry.name.toLowerCase())).map(entry => entry.name);
  if (shared.length) {
    problems.push(`The update and the Runtime base overlap in ${shared.length} path(s), which the split must prevent (docs/PACKAGING.md, "Code in the Scripts"): ${shared.slice(0, 8).join(', ')}${shared.length > 8 ? ', ...' : ''}.`);
  }
  // The split itself: the Runtime base carries no code, the update carries nothing under the Runtime's plugin folder (they are the two halves of one install).
  const strayCode = runtime.entries.filter(entry => entry.name.startsWith(`${CODE_FOLDER}/`) || isCodeGamePath(entry.name)).map(entry => entry.name);
  if (strayCode.length) problems.push(`The Runtime base carries code that belongs to the update: ${strayCode.slice(0, 5).join(', ')}.`);
  const plugin = `${layout.pluginDirectory.toLowerCase()}/`;
  const strayRuntime = update.entries.filter(entry => entry.name.toLowerCase().startsWith(plugin)).map(entry => entry.name);
  if (strayRuntime.length) problems.push(`The update carries files in the Runtime's plugin folder: ${strayRuntime.slice(0, 5).join(', ')}.`);

  // The guards of both builds, over the union.
  const union = [...update.entries, ...runtime.entries].filter(entry => entry.name !== INSTALL_NOTE_PATH);
  for (const entry of union) {
    const why = forbiddenEntry(entry.name, layout);
    if (why) problems.push(`${entry.name} ${why}.`);
    const archive = archiveEntry(entry.name, null);
    if (archive) problems.push(`${entry.name} ${archive}: the main file holds no archive.`);
    if (entry.name.length > layout.maxPathLength - layout.maxGameRootLength - 1) problems.push(`${entry.name} is too long for a typical game folder.`);
  }
  const longRuntime = longRuntimePaths(runtime.entries.map(entry => entry.name), layout.maxRuntimeEntryPath);
  if (longRuntime.length) problems.push(`The Runtime base has ${longRuntime.length} path(s) over ${layout.maxRuntimeEntryPath} characters (a mod manager folder named after the mod would pass Windows' limit): ${longRuntime.slice(0, 3).join(', ')}.`);
  const written = shippedButWritten(union.map(entry => entry.name), {layout, game, codeRemoves: update.extra?.removes ?? [], removes: runtime.extra?.removes ?? []});
  if (written.length) problems.push(`The Full package would ship files our own code writes or deletes (the Vortex rule): ${written.slice(0, 5).map(item => `${item.name} (${item.why})`).join('; ')}.`);

  // The Runtime base's do-nothing marker plugin is left out: it exists only so Vortex accepts the base installed on its own, and the Full zip
  // already carries the launcher plugin. Two machine-learning scanners flagged the marker (Cynet, Deep Instinct on VirusTotal) and Nexus Mods
  // quarantined the 0.3.4 Full zips that carried it (2026-10-28), while the update zip (launcher and native plugin, no marker) passed.
  const marker = `${layout.pluginDirectory}/${BASE_MARKER}`.toLowerCase();
  const entries = [
    ...update.entries.filter(entry => entry.name !== INSTALL_NOTE_PATH).map(entry => ({from: 'update', entry})),
    ...runtime.entries.filter(entry => entry.name !== INSTALL_NOTE_PATH && entry.name.toLowerCase() !== marker).map(entry => ({from: 'runtime', entry})),
    {from: null, note: FULL_NOTE_NAME},
  ].sort((a, b) => byName(a.entry?.name ?? a.note, b.entry?.name ?? b.note));
  return {entries, problems};
}
