# Johnny in your head

Written 2026-10-19 on branch `johnny-in-head` (from `main` 7f74149a). Design first, then built in steps (see "Build steps" at the end). Not merged, not installed, not seen in the game.

## The request

Players on Nexus (ZeroEscape and others, 2026-10-19) asked for Johnny Silverhand to always be with V, as he is in the story: the player talks to themselves, typed or on the voice key, and Johnny answers. The user decided on 2026-10-19 that this is a setting in the main mod, not an add-on. Players asked for:

1. awareness of the active quests;
2. a tracker for Johnny's standing and relationship with V;
3. his opinions on which quest to do next;
4. his own lore (Rogue, Kerry and the rest);
5. now and then, a glitching hologram of him at moments such as V sitting down or a scripted sequence that limits movement (the Joker in *Batman: Arkham Knight*, the voices Coen hears in *Blood of Dawnwalker*).

Hard constraints: no per-frame main-thread work and nothing loaded while the setting is off; active only while Johnny is in V's head in the story; the game's own Johnny scenes, cutscenes, phone calls and dialogue choices take priority; the game's own Johnny NPC gets no system of ours beyond talk, face and audio (a popped-in Johnny must be our own spawned copy).

## What a player can do (phase 1)

Settings > Conversations > **Johnny in your head** (off by default). With it on, and once the story has put Johnny in V's head, the talk keys (text or voice) address Johnny whenever no character with a profile is under the crosshair. He answers in his own voice, heard as a voice in V's head (no position in the world, full level), with his own subtitle line, his own profile and his own memory: the same memory as the Johnny companion copy and the game's own Johnny talked to where he stands. Aiming at someone still talks to them, exactly as before.

He knows what a companion knows: the "right now" facts, V's tracked quest and open jobs, the story facts of this save that concern him (the `silverhand.*` and related knowledge rules), the last game dialogue (including his own lines in the game), V's gear and his intrinsic claims. On top of that he gets two things nobody else gets: where he is (in V's head, not standing anywhere) and where he and V stand (the standing, below). When V asks what to do next, he picks from V's open jobs and says which one he would do and why.

He stays quiet (the talk key shows "Johnny Silverhand is busy right now.") during a scene, a quest conversation or dialogue choice, a phone call, a fight, while V is replaced by someone else (a flashback where the player is Johnny), and for a few seconds after the game itself gave Johnny a line. Before the story puts him in V's head, and after an ending removes him, the setting does nothing and the talk keys behave as if it were off.

## Where each piece comes from (reuse, not rebuild)

| Request | How | New or reused |
|---|---|---|
| Talk to Johnny anywhere | A "head" partner returned by `selectConversation` in `mod/init.lua` when no profiled character is targeted; it takes the holocall's audio route (a partner whose `npc` is V, no face, no gaze, no actions) with its own marker `head` | New marker; the route is the holocall's |
| Active quests | The companion knowledge path (`bridge/quest-context.mjs`: knowledge rules, recency, history, open jobs, journal, game dialogue) already serves every named profile, `johnny-silverhand` included | Reused, unchanged |
| Standing with V | `mod/johnny-head.lua` reads a few verified quest facts of the save on the key press and derives a stage; the bridge words it for Johnny | New |
| Next-quest opinions | The open-jobs block (`availableQuestsContext`) already lists V's jobs; the head block tells Johnny to pick from them in his own voice | Reused data, new guidance sentence |
| His lore | Profile `johnny-silverhand` (7,033-character backstory), 24 intrinsic claims (`research/cyberpunk/native-character-claims/johnny-silverhand.json`, pinned in `bridge/intrinsic-character-context.mjs`, up to 3 relevant ones per turn) and the save-bound `silverhand.*`, `jr-priority.*`, `sh5.*`, `core-arcs.johnny.*`, `priority-endings.johnny.*` rules | Reused; gaps listed below, no new lore text written here |
| Hologram pop-in | Not built in phase 1 (see "Phase 3") | Research only |

### The standing tracker

`mod/relationship-state.lua` already exists, but it is a receipt of eleven romance facts for Judy, Panam, River, Kerry and Meredith (the Auto relationship style). It has nothing about Johnny. The game itself keeps a hidden Johnny affinity (the 70 percent that unlocks the secret ending), but no fact for it is verified in the repo data, and the research rules say explicitly not to derive a percentage (`research/cyberpunk/NATIVE_CROSS_REVIEW.md`, `core-arcs.json`). So the tracker is the story arc, from facts with verified writers in the 2.31 quest files, read from the save itself: nothing is stored, it is right for every save and it follows a save load.

| Fact | What it means (rule in the knowledge pack) |
|---|---|
| `q101_done` | Playing for Time is done: V woke with Johnny in her head (name verified from the live game, `mod/knowledge-probe.lua`) |
| `q110_made_contact_with_alt` | V and Johnny reached Alt beyond the Blackwall (`ahe-native.alt-contact`) |
| `sq031_cool_metal_fire_done` | Johnny used V's body for a night and handed it back (`jr-priority.bender.completed`) |
| `sq031_porsche_unlocked` | V recovered Johnny's Porsche (`silverhand.porsche-recovered`) |
| `sq032_johnny_friend` | At the oil fields V gave Johnny one last chance and he committed to trying (`core-arcs.johnny.second-chance`; the game's own Phantom Liberty farewell reads it too) |
| `sq031_rogue_date_done` | Johnny's date with Rogue is over (`silverhand.movie-completed`) |
| `sq031_samurai_concert_done` | The Samurai reunion concert took place (`silverhand.reunion-performed`) |

The stage, from those facts:

| Stage | When | What Johnny is told |
|---|---|---|
| `wary` | in V's head, none of the shared milestones yet | stuck with each other, the Relic is killing V, no trust yet |
| `grudging` | at least one shared milestone, but no second chance at the oil fields | grudging respect, not friendship; neither has said so |
| `friends` | `sq032_johnny_friend` | V gave him a last chance and he meant it; friends in his abrasive way |
| `close` | `sq032_johnny_friend` and at least two of Alt, the Porsche, the Rogue date, the reunion | trusts V, on V's side, still gives V hell |

The shared milestones he has been through with V are listed to him by name after the stage sentence (one short sentence). Settings > Conversations shows the stage under the setting, read-only ("Johnny's standing: Grudging respect"), read only while that page is drawn.

Not in the stage: V's choices that the knowledge rules already tell him (Grayson spared or killed, the tattoo, the Swedenborg outcome), and the tone of V's talk with him (his memory already carries that). A V who refused the second chance stays at `grudging` (no fact for a refusal is verified).

### The story gate

Active while `q101_done` is set and none of these ending facts is (each has a verified writer, `research/cyberpunk/native-rules/priority-endings-20261004.json`, `priority-phantom-20261004.json`):

| Fact | Ending |
|---|---|
| `q201_active`, `q201_done` | The Devil (Arasaka) epilogue |
| `q202_active`, `q202_done` | The Star (Aldecaldos) epilogue |
| `q203_active` | The Sun epilogue |
| `q204_active`, `q204_done` | Temperance: Johnny keeps the body (the player is Johnny; nobody is in his head) |
| `q307_2079` | Phantom Liberty, The Tower: V wakes in 2079 after the NUSA surgery removed Johnny |

After the credits the game returns the player to a save before the point of no return, where these facts are absent again and Johnny is back in V's head, so the gate opens again there, as in the story. The game's own "Don't Fear the Reaper" and Path of Glory routes run through the same epilogue quests. An unreadable fact closes the gate (Johnny stays quiet rather than talk before his time).

`q101_done` marks the end of Playing for Time, a little after Johnny's first appearance in V's apartment (`q101_07c_johnny_triggers`, no named fact). Using the quest's end is the safe side: he never talks before the game introduced him.

### The busy gate (the game first)

Read once on the key press, from a fresh `battleObserver.sample(player)` (the same native reads every other system uses), and again while the recording runs (the validity poll the microphone already makes; the result is held 0.4 s):

| Reason | When |
|---|---|
| `unreadable` | the sample could not be read |
| `replacer` | V is replaced by another character (a flashback where the player is Johnny) |
| `call` | a phone call is incoming or running |
| `dialogue` | V is in a quest conversation |
| `scene` | scene tier 2 or above (staged gameplay, limited gameplay, a cinematic), or a dialogue choice on screen while the tier is unknown. Stricter than talking to a character (tier 3): the game's own Johnny appearances are often staged at tier 2 |
| `combat` | V is in a fight |
| `johnny-speaking` | the game showed a line by Johnny in the last 10 s (the game-dialogue buffer, `mod/game-dialogue.lua`, which already attributes lines to `johnny-silverhand`; nothing new is observed) |

A dialogue choice on screen at tier 1 is the game's own "Talk" prompt on a vendor or a fixer, not a conversation, and does not refuse (the rule of `mod/world-talk.lua`).

A reply Johnny is speaking when one of these starts is ended, through the same speech hook that ends a story character's reply (`speech.storyGuard`, the refusal held 0.4 s, read only while his reply is heard). A menu pauses it as it pauses every speaker.

## Cost (FPS and latency)

- **Setting off:** nothing. `mod/johnny-head.lua` is never loaded (`dofile` on first need, only when `manager.johnnyInHead()` is true); `selectConversation` does one boolean read on a talk key press that found nobody, which already ends in a notice today. The MCM row is not drawn.
- **Setting on:** still nothing per frame. On a talk key press that found nobody: one battle sample (as the holocall does), at most fourteen `GetFactStr` reads (held 5 s, so a recording's validity poll costs nothing new) and a walk over at most 40 buffered game-dialogue rows. During a recording the head partner's validity is read about twice a second with the 0.4 s hold (the same poll the microphone already makes for any target).
- **Talk path latency:** the turn is an ordinary private turn on the holocall's audio route: the bridge warms the connection (`warmConversation`) when the composer opens or the recording starts, and the stage clock (`bridge/turn-clock.mjs`, `runtime/bridge-latency.json`) measures it with no change. The added context is one sentence in the "right now" block and one short world block (under 900 characters).

## Phase 2: Johnny speaks first (not built)

Short unprompted remarks at moments that already raise an event, with a cooldown of several minutes and a cap per hour, never in a scene, a call, a fight or after a game Johnny line: a quest objective finished (the journal event the knowledge collector already gets), V sitting down (the `WorkspotEvents.OnEnter` observer `mod/seated-look.lua` already installs), a long quiet drive. They would go through the automatic-reaction route (`docs/BATTLE_REACTIONS.md`: a reaction turn, its own lease, the subtitles' reaction line), as a second switch under the setting, off by default. Open question 3 below.

## Phase 3: the glitching hologram (research, not built)

What exists (verified):
- Our own copies spawn through `DynamicEntitySystem:CreateEntity` with `persistState` and `persistSpawn` false and our tag; `DeleteEntity` refuses anything without our tag (`mod/companions.lua`). `mod/holocall.lua` `holoSpawn` is the lightest pattern (a plain record, tags `CyberpunkConvaiCompanion` and `CyberpunkConvaiHolocall`, a tag sweep after a reload).
- A Johnny copy record exists: `CyberpunkConvai.JohnnyCompanion` cloned from `Character.Silverhand` (`mod/companion-records.lua`); companions use the solid appearance `silverhand_riot__not_blendable`.
- The game's own glitch look is Johnny's "blendable" appearance with its `gamePhantomEntityComponent` (blue speckle, fades as the camera faces him). The mod switches it off on purpose for companions (`mod/companion-appearance.lua`, `docs/DEVELOPMENT_AUDIT_2026-09-30.md`).
- V sitting down is already an event (`mod/seated-look.lua`: `WorkspotEvents.OnEnter`, scene tier and seat class, nothing per frame). A scripted sequence that limits movement has no event: only the 0.5 s scene-tier sample.
- No effect files, glitch shaders or hologram assets exist in this repo; the Skippy hologram lives in its own repository.

The smallest clean version: on `WorkspotEvents.OnEnter` (V sits, tier 1, no vehicle, story gate open, busy gate clear, at most once every several minutes), spawn one tagged non-persistent `Character.Silverhand` copy two to three metres away with the blendable appearance and the phantom component left on, facing V, no AI role; delete it after about five seconds, or at once on standing up, a fight, a scene, a session end (`abandonSession`) or a sweep by tag at start-up. A short remark (phase 2) can play while he is there.

Why it is not built now: the glitch look is unproven at standing distance (the phantom controller may hide the whole entity, `companion-appearance.lua`), the cost is a full puppet with a facial rig per pop-in, and a scripted sequence that limits movement cannot be told from one that stages the game's own Johnny without a quest-state rule per scene. It needs one live test of the blendable appearance on a spawned copy first (open question 4).

## Lore coverage and gaps

Covered (profile, intrinsic claims or knowledge rules): Rogue as his ex, the Rogue date and its ending, Kerry and Samurai, the reunion concert and its lineup, Nancy, Denny and Henry, Grayson spared or killed, the Porsche, his corporate army service in Mexico, Cole and the dog tags, the desertion, Alt as a netrunner he admired, the oil-field second chance, the NUSA farewell in Phantom Liberty, the endings' facts about him.

Thin or missing (from the survey of the profile, claims and rules): the 2023 Arasaka Tower raid and the nuke, Soulkiller and Alt beyond the Blackwall, Morgan Blackhand, Spider Murphy, Saburo and the Relic project, Mikoshi, Songbird, his opinion of the endings. Also a contradiction: the profile says his chrome arm is the left one, `characters/appearance.json` says right (it is his left arm in the game). These belong in the reviewed claims and rules pipeline (the Alt Cunningham pack is the template), not in ad-hoc prompt text; the parallel `cast-expansion` work edits profiles, so this branch leaves Johnny's profile and packs untouched. Open question 5.

## Files

| File | Change |
|---|---|
| `mod/johnny-head.lua` (new) | `story` (pure), `stage` (pure), `busy` (pure), `recentLine` (pure), `new` service: fact reads held 5 s, `refusal`, `partner`, `standing` |
| `mod/init.lua` | lazy loader `convaiJohnnyHeadService`; `selectConversation` head fallback; recording validity; head guards where the add-on voice path branches on `voiceOnly`; `convaiJohnnyStanding` for the settings page |
| `mod/speech.lua`, `mod/continuous-speech.lua` | a head reply plays as V's own sound like a holocall reply |
| `mod/manager.lua`, `mod/mcm.lua` | the setting `johnnyInHead` (off; a missing key counts as off), its row, help and the read-only standing row |
| `mod/locales/*.lua`, `localization/en.json` | the new strings in 15 languages |
| `bridge/protocol.mjs` | `parseHead` |
| `bridge/johnny-head.mjs` (new) | the head block: standing and next-job guidance |
| `bridge/turn-context.mjs`, `bridge/quest-context.mjs`, `bridge/mistral-prompt.mjs` | the "in V's head" sentence, the head block's place, the `HERE` pattern |
| `packaging/release-plan.json`, `scripts/development-files.json` | ship and dev-install `johnny-head.lua` |
| tests | `bridge/johnny-head.test.mjs` (new), `bridge/manager.test.mjs` |

## Open questions for the user

1. **Combat.** Johnny stays quiet in fights (default), or he may answer in a fight like a voice in V's ear.
2. **Scene tier 2.** Quiet at tier 2 too (default: the game's Johnny is often staged there, at the cost of Viktor's clinic and Misty's shop), or only at tier 3 like story characters.
3. **Phase 2, Johnny speaks first.** Build it now behind a second switch (default off), or wait for feedback on phase 1.
4. **Phase 3, the hologram.** One live test of the blendable look on a spawned copy first (recommended), or skip the hologram and keep him a voice.
5. **Lore gaps.** Fill them through the reviewed claims pipeline after `cast-expansion` lands (recommended), or a short in-head primer written now.

## Build steps

1. This document.
2. The setting, its row, help text and 15 translations; the manager test.
3. `mod/johnny-head.lua` with its unit tests.
4. The talk wiring in `mod/init.lua`, speech and subtitles; static tests (nothing in `onUpdate`, lazy load).
5. The bridge: protocol, head block, turn context; tests.
6. The read-only standing row; packaging; docs, README, TODO.

## Live check owed

Written at the end of the build (see the last section of the branch's TODO entry).
