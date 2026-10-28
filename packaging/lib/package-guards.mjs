// The last check on every entry of a package a release build writes (packaging/build-release.mjs) and of the Full install package
// (packaging/build-full.mjs), kept in one place so the combined zip meets the very rules of the two it is made of.
import {CODE_FOLDER} from './code-payload.mjs';
import {SHIPPED_KEY_FILE} from './convai-auth.mjs';

// The Runtime base's marker plugin (native/autostart built with CONVAI_BASE_MARKER): a RED4ext plugin that does nothing.
export const BASE_MARKER = 'CyberpunkConvaiBase.dll';

/**
 * Why a zip entry must never ship, or null. `layout` is release.config.json "layout".
 * Only the shipped launcher and the native plugin (both in the Scripts' code folder from 0.3.4) and the base's marker may install a RED4ext plugin.
 * The development launcher (red4ext/plugins/CyberpunkConvaiLauncher) must never ship: with it, two services start.
 */
export function forbiddenEntry(name, layout) {
  if (/^misc\//.test(name)) return 'contains developer-only material';
  if (/^red4ext\//i.test(name) && /\.(?:dll|ini)$/i.test(name)
      && !name.startsWith(`${CODE_FOLDER}/`) && name !== `${layout.pluginDirectory}/${BASE_MARKER}`) {
    return 'installs an unexpected RED4ext plugin file';
  }
  if (/(?:^|\/)CyberpunkConvaiLauncher[^/]*$/i.test(name)) return 'contains the development launcher';
  if (SHIPPED_KEY_FILE.test(name)) return 'would ship a Convai key file';
  if (/(?:^|\/)(?:convai-key\.txt|kaggle-access-token\.txt|huggingface-[^/]*\.txt|\.env|(?:player|vendor)-memory[^/]*\.(?:json|bak|tmp|corrupt)|phone-sessions\.json|characters-verified\.json)$/i.test(name)) {
    return 'contains a forbidden file';
  }
  return null;
}
