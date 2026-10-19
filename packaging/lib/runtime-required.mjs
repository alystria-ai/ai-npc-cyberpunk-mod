// Files a Runtime package must carry because a feature of the main mod stops working without them. The release build puts them in
// (packaging/build-release.mjs), packaging/check-runtime-contents.mjs checks a built zip, and packaging/test-release-install.mjs checks the
// extracted install. The names come from the repository, not from a list kept here:
//   - V's voice: voices/v-voice/ holds the manifest and the clips assets/v-voice/v-voice.json names. The 0.2 and 0.2.1 Runtimes shipped
//     without them, so V's typed lines had no voice to clone.
//   - "Make support report.bat" (release.config.json, layout.supportReportBatch) and the bridge modules it starts with the bundled Node,
//     for a player the mod never loads for (a support report made with the game closed).
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

export const V_VOICE_FOLDER = 'voices/v-voice';
export const V_MANIFEST_SOURCE = 'assets/v-voice/v-voice.json';
// The wrapper the batch file starts, the report code it calls and what that code imports (packaging/support-report-packaging.test.mjs
// checks the same set against the bridge closure).
export const OFFLINE_REPORT_MODULES = Object.freeze(['make-support-report', 'offline-support-report', 'support-report', 'setup-check',
  'key-codec', 'zip-writer', 'guarded-file', 'system-browser']);

// {group: [game-relative path, ...]} for a Runtime built from the repository at `root`.
export async function requiredRuntimeFiles(root) {
  const config = JSON.parse(await readFile(resolve(root, 'packaging/release.config.json'), 'utf8'));
  const plugin = config.layout.pluginDirectory, app = `${plugin}/app`;
  const manifest = JSON.parse((await readFile(resolve(root, V_MANIFEST_SOURCE), 'utf8')).replace(/^\uFEFF/, ''));
  const clips = Object.values(manifest.voices ?? {}).map(row => row?.file);
  if (!clips.length || clips.some(file => typeof file !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}\.wav$/.test(file))) {
    throw Error(`${V_MANIFEST_SOURCE} names no usable clips.`);
  }
  return {
    "V's voice clips": ['v-voice.json', ...clips].map(file => `${plugin}/${V_VOICE_FOLDER}/${file}`),
    'support report batch file': [`${plugin}/${config.layout.supportReportBatch}`],
    'offline report code': OFFLINE_REPORT_MODULES.map(item => `${app}/bridge/${item}.mjs`),
  };
}

// The groups with files absent from `names` (Windows compares names without regard to case, so this does too): {group: [path, ...]}.
export function missingRuntimeFiles(names, required) {
  const present = new Set([...names].map(name => name.toLowerCase()));
  const missing = {};
  for (const [group, files] of Object.entries(required)) {
    const absent = files.filter(file => !present.has(file.toLowerCase()));
    if (absent.length) missing[group] = absent;
  }
  return missing;
}
