// Intentionally empty. This file used to hold the Audioware voice playback (it imported Audioware). Every voice now plays through the
// mod's own audio path (the hidden browser renderer, mod/speech.lua, mod/continuous-speech.lua), so nothing here needs Audioware.
// The file stays, with no code, so that installing this version over an older one REPLACES the old file: an old Speech.reds left in
// place would still import Audioware and break the compile of every redscript mod when Audioware does not work with the game version.
