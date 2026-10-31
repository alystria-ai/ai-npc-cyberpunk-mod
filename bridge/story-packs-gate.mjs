// Story packs are NOT part of release 0.4.0 (owner decision 31 Oct 2026, docs/STORY_PACKS_INACTIVE.md): they will return as real game quests in a later update.
// This is the one place the bridge asks whether they may run. They may only with the development switch:
//   an empty file runtime/story-packs-dev.flag in the mod folder (the game side, mod/manager.lua storyPacksAvailable, looks for the same file), or
//   the environment variable CYBERPUNK_CONVAI_STORY_PACKS=1 (the bridge only, handy for tests and scripts).
// The answer is found once and kept: nothing here polls. A saved "on" of the Story packs setting in a dev or test install cannot turn them on without the switch.
import {existsSync} from 'node:fs';

export const STORY_PACKS_ENV = 'CYBERPUNK_CONVAI_STORY_PACKS';
export const STORY_PACKS_FLAG = 'story-packs-dev.flag';
// A second, development-only switch on top of the first: an empty file runtime/story-packs-dev-fast.flag (or CYBERPUNK_CONVAI_STORY_PACKS_FAST=1) makes a pack start on the next
// eligible turn: no quiet days after the last quest, no daily rolls, a start chance of 1 (bridge/bond-pack-runner.mjs `fast`). It does nothing unless the switch above is on.
export const STORY_PACKS_FAST_ENV = 'CYBERPUNK_CONVAI_STORY_PACKS_FAST';
export const STORY_PACKS_FAST_FLAG = 'story-packs-dev-fast.flag';

let flagPath = null;
let fastPath = null;
let answer = null;
let fastAnswer = null;
let envValue = process.env;

/** The folder the game writes its runtime files in (the flag file sits there). Forgets an earlier answer. */
export function configureStoryPacksGate({runtime = null, env = process.env} = {}) {
  const folder = typeof runtime === 'string' && runtime ? runtime.replace(/[\\/]+$/, '') : null;
  flagPath = folder ? `${folder}/${STORY_PACKS_FLAG}` : null;
  fastPath = folder ? `${folder}/${STORY_PACKS_FAST_FLAG}` : null;
  answer = null; fastAnswer = null;
  envValue = env;
}

/** Whether the story packs may run in this process: the switch is on. Found at the first call, then a boolean. */
export function storyPacksAvailable() {
  if (answer === null) {
    answer = envValue?.[STORY_PACKS_ENV] === '1' || (flagPath !== null && existsSync(flagPath));
  }
  return answer;
}

/** Whether the development fast switch is on as well (and so the first one is). Found at the first call, then a boolean. */
export function storyPacksFast() {
  if (fastAnswer === null) {
    fastAnswer = storyPacksAvailable() && (envValue?.[STORY_PACKS_FAST_ENV] === '1' || (fastPath !== null && existsSync(fastPath)));
  }
  return fastAnswer;
}

/** For tests: forget the kept answer (the environment is read again). */
export function resetStoryPacksGate() {
  answer = null;
  fastAnswer = null;
  flagPath = null;
  fastPath = null;
  envValue = process.env;
}
