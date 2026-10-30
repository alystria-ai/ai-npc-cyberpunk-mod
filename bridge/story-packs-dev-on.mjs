// Import this first in a test of the story packs: it turns the development switch on for the process (docs/STORY_PACKS_INACTIVE.md, bridge/story-packs-gate.mjs).
// Story packs are not part of release 0.4.0, so without the switch the bridge drops every `packs` and `reach` flag of a request. A test that proves the
// switch is off by default must not import this.
import {STORY_PACKS_ENV, resetStoryPacksGate} from './story-packs-gate.mjs';

process.env[STORY_PACKS_ENV] = '1';
resetStoryPacksGate();
