// Files a Runtime package must carry because a feature of the main mod stops working without them. The release build puts them in
// (packaging/build-release.mjs), packaging/check-runtime-contents.mjs checks a built zip, and packaging/test-release-install.mjs checks the
// extracted install. The names come from the repository, not from a list kept here:
//   - V's voice: voices/v-voice/ holds the manifest and the clips assets/v-voice/v-voice.json names. The 0.2 and 0.2.1 Runtimes shipped
//     without them, so V's typed lines had no voice to clone.
//   - The llama.cpp engine in app/<localAi.server.runtimeFolder>/ (the server, llama-fit-params and the libraries they load).
//   - The embedding model of the memory search in app/<localAi.embed.runtimeFolder>/ (every text provider's memory uses it; the engine above runs it on the CPU).
//   - vgmstream in app/<toolchain.vgmstream.runtimeFolder>/ (vgmstream-cli.exe and the ten libraries it loads) with its licence texts: the decoder of a player's V voice
//     mod (docs/PACKAGING.md, "vgmstream in the Runtime"). Without them a voice mod cannot be read.
//   - The sign-in settings in app/defaults/convai-auth.json (packaging/lib/convai-auth.mjs): the Runtime ships no Convai key, and without this file the
//     bridge has no way to reach the shared Convai account. A --dry-run build may leave it out (`signIn: false`).
//   - The two stand-in voices' Pocket clips (voices/archetypes/pocket/resident-male.wav and resident-female.wav, bridge/voice-clips.mjs STAND_IN_VOICES): with the other clips
//     built on the player's PC (voiceClips.fromGame), these are what a character speaks with for a line it needs before its own clips are built. Without them that line has no voice.
//   - The Runtime's own OmniVoice lists in app/defaults, which the launcher reads before the OmniVoice pack's older copy (packaging/runtime/
//     prepare-state.mjs; docs/PACKAGING.md, "Packs reused unchanged"). Without them a pack reused from an earlier version runs on its own
//     older lists (0.2's lack the 30 voices 0.2.1 added), and a list an earlier Runtime left in app/defaults stays in charge.
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {OMNI_CONFIGS} from '../runtime/prepare-state.mjs';
import {AUTH_FILE} from './convai-auth.mjs';
import {STAND_IN_VOICES} from '../../bridge/voice-clips.mjs';

export const V_VOICE_FOLDER = 'voices/v-voice';
export const V_MANIFEST_SOURCE = 'assets/v-voice/v-voice.json';
// The line list a V voice mod is recognised and read with (bridge/v-voice-mods.mjs): it ships beside V's clips.
export const V_MOD_LINES = 'v-mod-lines.json';

// {group: [game-relative path, ...]} for a Runtime built from the repository at `root`.
export async function requiredRuntimeFiles(root, {signIn = true} = {}) {
  const config = JSON.parse(await readFile(resolve(root, 'packaging/release.config.json'), 'utf8'));
  const plugin = config.layout.pluginDirectory, app = `${plugin}/app`;
  const manifest = JSON.parse((await readFile(resolve(root, V_MANIFEST_SOURCE), 'utf8')).replace(/^\uFEFF/, ''));
  const clips = Object.values(manifest.voices ?? {}).map(row => row?.file);
  if (!clips.length || clips.some(file => typeof file !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}\.wav$/.test(file))) {
    throw Error(`${V_MANIFEST_SOURCE} names no usable clips.`);
  }
  return {
    "V's voice clips": ['v-voice.json', ...clips, V_MOD_LINES].map(file => `${plugin}/${V_VOICE_FOLDER}/${file}`),
    'stand-in voices (Pocket clips)': Object.values(STAND_IN_VOICES).map(key => `${plugin}/voices/archetypes/pocket/${key}.wav`),
    "Runtime's OmniVoice lists": Object.values(OMNI_CONFIGS).map(name => `${app}/defaults/${name}`),
    ...(signIn ? {"Runtime's sign-in settings": [`${app}/${AUTH_FILE}`]} : {}),
    // The llama.cpp engine of Local AI (docs/LOCAL_AI.md, "The engine is in the Runtime"): the update zips deliver engine fixes only if the Runtime carries it.
    'llama.cpp engine': config.localAi.server.require.map(name => `${app}/${config.localAi.server.runtimeFolder}/${name}`),
    // The embedding model (docs/LOCAL_AI.md, "The embedding model is in the Runtime"): without it the memory search has nothing to search with unless an older pack carries the model.
    'embedding model': [`${app}/${config.localAi.embed.runtimeFolder}/${config.localAi.embed.file}`],
    // vgmstream-cli and its libraries (the decoder of a player's V voice mod), and the licence texts that must travel with them.
    'vgmstream decoder': Object.keys(config.toolchain.vgmstream.files).map(name => `${app}/${config.toolchain.vgmstream.runtimeFolder}/${name}`),
    'vgmstream licences': Object.keys(config.toolchain.vgmstream.licences).map(name => `${app}/${config.toolchain.vgmstream.licenceFolder}/${name}`),
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
