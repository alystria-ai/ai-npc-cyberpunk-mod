// Story packs are NOT part of release 0.4.0 (owner decision 31 Oct 2026, docs/STORY_PACKS_INACTIVE.md): they will return as real game quests in a later update.
// This is the one place the bridge asks whether they may run. They may only with the development switch:
//   an empty file runtime/story-packs-dev.flag in the mod folder (the game side, mod/manager.lua storyPacksAvailable, looks for the same file), or
//   the environment variable CYBERPUNK_CONVAI_STORY_PACKS=1 (the bridge only, handy for tests and scripts).
// The answer is found once and kept: nothing here polls. A saved "on" of the Story packs setting in a dev or test install cannot turn them on without the switch.
import {existsSync} from 'node:fs';

export const STORY_PACKS_ENV = 'CYBERPUNK_CONVAI_STORY_PACKS';
export const STORY_PACKS_FLAG = 'story-packs-dev.flag';

let flagPath = null;
let answer = null;
let envValue = process.env;

/** The folder the game writes its runtime files in (the flag file sits there). Forgets an earlier answer. */
export function configureStoryPacksGate({runtime = null, env = process.env} = {}) {
  flagPath = typeof runtime === 'string' && runtime ? `${runtime.replace(/[\\/]+$/, '')}/${STORY_PACKS_FLAG}` : null;
  answer = null;
  envValue = env;
}

/** Whether the story packs may run in this process: the switch is on. Found at the first call, then a boolean. */
export function storyPacksAvailable() {
  if (answer === null) {
    answer = envValue?.[STORY_PACKS_ENV] === '1' || (flagPath !== null && existsSync(flagPath));
  }
  return answer;
}

/** For tests: forget the kept answer (the environment is read again). */
export function resetStoryPacksGate() {
  answer = null;
  flagPath = null;
  envValue = process.env;
}
