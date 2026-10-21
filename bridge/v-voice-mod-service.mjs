// V's reference clips with a player's V voice mod taken into account (docs/V_VOICE.md, "V voice mods"). Called once at service start, before the voice
// configurations are built, never during a reply and never from the game: it finds the mod archives (archive/pc/mod and REDmod's mods/<name>/archives),
// asks bridge/v-voice-mods.mjs which of them replaces V's English voice-over, and keeps <state>/v-voice-mod/ (a v-voice.json in the shape of assets/v-voice
// and one WAV per gender) built from the winning archive. The shipped references stay the base: a gender with no mod keeps the shipped clip.
//
// Precedence, from the strongest: the player's own clip for V (the editor, bridge/player-voices.mjs, merged later by the bridge), the reference built from
// the mod, the shipped reference. Every voice carries `source` ('shipped' or 'mod:<archive file name>'): the log, the routing lines and the support report
// name it that way and never give a path.
//
// What runs: file reads of the index of each archive that changed (cached by name, size and time) and, only when a reference has to be (re)built, the
// decoder (vgmstream-cli, shipped in the Runtime under app/vgmstream) once per line, each process exiting when its line is done. Nothing stays resident.
// The mods replace the English voice-over only: with another voice-over language in the game's settings they are ignored (one log line).
import {readFile} from 'node:fs/promises';
import {basename, join, resolve} from 'node:path';
import {loadVVoiceReferences, V_VOICE_KEYS} from './v-voice.mjs';
import {GENDERS, ensureVoiceModReferences, findVgmstream, listVoiceModArchives, parseModLines} from './v-voice-mods.mjs';
import {vgmstreamDecoder} from './v-voice-mod-reference.mjs';

export const V_MOD_LINES_FILE = 'v-mod-lines.json';
export const V_MOD_FOLDER = 'v-voice-mod';
export const V_MOD_CACHE_FILE = 'v-voice-mods-cache.json';
export const VGMSTREAM_EXECUTABLE = 'vgmstream-cli.exe';
/** CYBERPUNK_CONVAI_V_VOICE_MODS=off turns the whole step off (a developer's switch; there is no setting and no prompt). */
export const V_MOD_SWITCH = 'CYBERPUNK_CONVAI_V_VOICE_MODS';

/** The label of a V reference: 'shipped', 'manual', or 'mod:<archive file name>'. */
export const modLabel = relative => `mod:${basename(String(relative ?? '')).slice(0, 120)}`;

/** The game's voice-over language ('en-us', 'fr-fr', ...) from its UserSettings.json text, or null when the file does not say. */
export function parseVoiceOverLanguage(text) {
  try {
    const settings = JSON.parse(String(text).replace(/^﻿/, ''));
    for (const group of Array.isArray(settings?.data) ? settings.data : []) {
      if (group?.group_name !== '/language') continue;
      const option = (Array.isArray(group.options) ? group.options : []).find(row => row?.name === 'VoiceOver');
      return typeof option?.value === 'string' && option.value ? option.value.toLowerCase().slice(0, 12) : null;
    }
  } catch { /* unreadable: unknown */ }
  return null;
}

/** Reads the voice-over language from %LOCALAPPDATA%\CD Projekt Red\Cyberpunk 2077\UserSettings.json (the game's own settings). null: not readable, so unknown. */
export async function readVoiceOverLanguage({env = process.env, read = file => readFile(file, 'utf8')} = {}) {
  const base = env.LOCALAPPDATA;
  if (!base) return null;
  try { return parseVoiceOverLanguage(await read(join(base, 'CD Projekt Red', 'Cyberpunk 2077', 'UserSettings.json'))); } catch { return null; }
}

const coverageOf = row => row && row.probeTotal ? Math.round(row.probeHits / row.probeTotal * 100) / 100 : 0;

/**
 * Loads the shipped V references and puts the mod-built ones over them. Never throws: any failure leaves the shipped references.
 *   shippedDirectories   where loadVVoiceReferences looks (the references folders' v-voice, assets/v-voice)
 *   game, stateDirectory, project   the game folder, the service's data folder, and the app folder (the decoder's folder is <project>/vgmstream)
 * Resolves to {directory, voices: {male?, female?}: each as loadVVoiceReferences gives it plus `source`, report}. `report` is what the support report keeps:
 * counts, archive file names and a label per gender, no path.
 */
export async function loadVVoiceReferencesWithMods({shippedDirectories, game, stateDirectory, project, log = () => {}, env = process.env, files = {readFile}, ensure = ensureVoiceModReferences, list = listVoiceModArchives, language = readVoiceOverLanguage, decoder = vgmstreamDecoder} = {}) {
  const shipped = await loadVVoiceReferences(shippedDirectories, {log});
  const voices = {};
  for (const gender of GENDERS) if (shipped.voices[gender]) voices[gender] = {...shipped.voices[gender], source: 'shipped'};
  const report = {enabled: true, ignored: null, voiceOverLanguage: null, decoder: null, scan: null, mods: [], built: {}, references: {}};
  const finish = () => { for (const gender of GENDERS) report.references[gender] = voices[gender]?.source ?? null; return {directory: shipped.directory, voices, report}; };
  try {
    if (String(env[V_MOD_SWITCH] ?? '').toLowerCase() === 'off') { report.enabled = false; report.ignored = 'switched off'; return finish(); }
    const spoken = await language({env});
    report.voiceOverLanguage = spoken;
    if (spoken && !spoken.startsWith('en')) {
      report.ignored = `the game's voice-over language is ${spoken}`;
      log(`V voice mods are ignored: the game's voice-over language is ${spoken}, and V voice mods replace the English voice-over only`);
      return finish();
    }
    // The line list ships beside the shipped references (voices/v-voice in an install, assets/v-voice in a checkout).
    let modLines = null;
    for (const directory of shippedDirectories.filter(Boolean)) {
      try { modLines = parseModLines(await files.readFile(resolve(directory, V_MOD_LINES_FILE), 'utf8')); break; } catch (error) { if (error?.code !== 'ENOENT') log(`${V_MOD_LINES_FILE} in a references folder is unusable: ${String(error?.message ?? error).slice(0, 100)}`); }
    }
    if (!modLines) { report.ignored = `no ${V_MOD_LINES_FILE}`; return finish(); }
    const executable = await findVgmstream({candidates: [resolve(project, 'vgmstream', VGMSTREAM_EXECUTABLE), resolve(project, 'vendor', 'vgmstream', VGMSTREAM_EXECUTABLE)], env});
    report.decoder = executable ? 'found' : 'missing';
    const outFolder = resolve(stateDirectory, V_MOD_FOLDER);
    const made = await ensure({list: () => list({game}), outFolder, modLines, decode: executable ? decoder(executable) : null, cachePath: resolve(stateDirectory, V_MOD_CACHE_FILE), log: line => log(line)});
    const {stats, archives} = made.detection;
    report.scan = {archives: stats.total, inspected: stats.inspected, cached: stats.cached, failed: stats.failed, ms: stats.ms};
    report.mods = archives.filter(a => GENDERS.some(g => coverageOf(a[g]) > 0)).slice(0, 12).map(a => ({archive: basename(a.relative), male: coverageOf(a.male), female: coverageOf(a.female)}));
    report.built = made.voices;
    if (Object.values(made.voices).includes('needs-decoder')) log("a V voice mod is installed but the decoder (app/vgmstream) is missing, so V keeps the shipped voice");
    if (made.directory) {
      const mod = await loadVVoiceReferences([made.directory], {log});
      for (const gender of GENDERS) {
        const row = mod.voices[gender], winner = made.detection.winners[gender];
        if (!row || !winner) continue;
        voices[gender] = {...row, source: modLabel(winner.relative)};
        log(`V's ${gender} reference comes from the V voice mod ${basename(winner.relative)}`);
      }
    }
  } catch (error) {
    report.ignored = `failed: ${String(error?.code ?? error?.message ?? 'error').slice(0, 60)}`;
    log(`V voice mods were not used: ${String(error?.message ?? error).slice(0, 120)}`);
  }
  return finish();
}

/** The key of a gender's V voice ('v-male'), and the gender of a key (or null): the two are the only keys the V rows and the labels know. */
export const vKeyOf = gender => V_VOICE_KEYS[gender];
export const vGenderOfKey = key => GENDERS.find(gender => V_VOICE_KEYS[gender] === key) ?? null;
