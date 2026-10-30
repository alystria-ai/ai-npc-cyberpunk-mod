// Which reference clips the packages leave out when voiceClips.fromGame is on (packaging/release.config.json, docs/VOICE_EXTRACTION.md).
//
// A clip is left out when every character that uses it is one characters/voice-clips-manifest.json can rebuild on the player's PC. Kept: Lucy (a web clip, not game
// audio), the two clips that cannot be rebuilt (spider-murphy omni-long, npc-kang-tao-male omni-short: those two voices are not complete in the manifest) and the stand-in
// voices (STAND_IN_VOICES in bridge/voice-clips.mjs: resident-male and resident-female, which a character speaks with for a line it needs before its own clips are built).
import {STAND_IN_VOICES, readManifest} from '../../bridge/voice-clips.mjs';

/**
 * `manifestText` = the manifest file's text, `configs` = parsed voice configurations ({voices: {key: {reference, status}}}: Pocket's, OmniVoice's short and long ones).
 * Returns rel => boolean for the paths below runtime/voice-references/ (picked/autobest/pocket/judy-alvarez.wav). With `fromGame` false nothing is left out.
 */
export function clipsLeftOut({fromGame, manifestText, configs}) {
  if (!fromGame) return () => false;
  const manifest = readManifest(manifestText);
  const stays = new Set(Object.values(STAND_IN_VOICES));
  const rebuilt = key => Object.hasOwn(manifest, key) && !stays.has(key);
  const users = new Map();
  for (const value of configs) {
    for (const [key, descriptor] of Object.entries(value?.voices ?? {})) {
      if ((descriptor.status ?? 'ready') !== 'ready') continue;
      const rel = descriptor.reference.replace(/^runtime\/voice-references\//, '');
      if (!users.has(rel)) users.set(rel, []);
      users.get(rel).push(key);
    }
  }
  return rel => (users.get(rel) ?? []).length > 0 && users.get(rel).every(rebuilt);
}
