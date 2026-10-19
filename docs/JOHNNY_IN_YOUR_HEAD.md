# Johnny in your head

Written 2026-10-19 on branch `johnny-in-head` (from `main` 7f74149a; `main` merged in after the cast expansion). Design first, then built in steps (see "Build steps" at the end). Phase 1 and the first step of phase 2 are built. Not merged, not installed, not seen in the game.

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

With **Johnny speaks up** (right under it, Off by default) at Rare or Normal, he also speaks first now and then: a short remark after V has talked with a named character, finished a main or side job, or a romance moved on (phase 2, step 1, below).

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
| `scene` | scene tier 3 or above (limited gameplay, a cinematic), or a dialogue choice on screen while the tier is unknown: the same rule as talking to a story character (the user, 2026-10-19). Tier 2 is staged gameplay (Viktor's clinic, Misty's shop) and stays open; where the game stages its own Johnny at tier 2, his game line keeps Johnny quiet (`johnny-speaking`, below) |
| `combat` | V is in a fight |
| `johnny-speaking` | the game showed a line by Johnny in the last 10 s (the game-dialogue buffer, `mod/game-dialogue.lua`, which already attributes lines to `johnny-silverhand`; nothing new is observed) |

A dialogue choice on screen at tier 1 is the game's own "Talk" prompt on a vendor or a fixer, not a conversation, and does not refuse (the rule of `mod/world-talk.lua`).

A reply Johnny is speaking when one of these starts is ended, through the same speech hook that ends a story character's reply (`speech.storyGuard`, the refusal held 0.4 s, read only while his reply is heard). A menu pauses it as it pauses every speaker.

## Cost (FPS and latency)

- **Setting off:** nothing. `mod/johnny-head.lua` is never loaded (`dofile` on first need, only when `manager.johnnyInHead()` is true); `selectConversation` does one boolean read on a talk key press that found nobody, which already ends in a notice today. The manager's row is not drawn.
- **Setting on:** still nothing per frame. On a talk key press that found nobody: one battle sample (as the holocall does), at most fifteen `GetFactStr` reads (one before the story start) (held 5 s, so a recording's validity poll costs nothing new) and a walk over at most 40 buffered game-dialogue rows. During a recording the head partner's validity is read about twice a second with the 0.4 s hold (the same poll the microphone already makes for any target).
- **Talk path latency:** the turn is an ordinary private turn on the holocall's audio route: the bridge warms the connection (`warmConversation`) when the composer opens or the recording starts, and the stage clock (`bridge/turn-clock.mjs`, `runtime/bridge-latency.json`) measures it with no change. The added context is one sentence in the "right now" block and one short world block (under 900 characters).

## Phase 2: Johnny speaks first (step 1 built)

### What the player asked for

ZeroEscape (Nexus, 2026-10-19, after the first request) wants Johnny to comment unprompted on what V is doing: combat, quests and romances. The triggers he named: the Relic glitch (V coughing blood), V pulling off cool combat feats, V entering specific locations, and V meeting specific people. These are wishes, not a spec: no per-frame work, FPS, latency and the game's own scenes still win, and a remark that would cost any of them is not built.

### Which turn path

Not the add-on remark system (`mod/addons.lua` `Handle.remark`, Skippy's combat remarks), although its queue, priorities, gaps and caps are the right model. It runs only while an add-on is registered (`convaiAddons.live`), and an add-on speaker's text comes only from Mistral or the local AI with a manifest persona (`docs/ADDON_API.md`): Johnny would lose his roster profile, his knowledge rules and his Convai memory, which phase 1 uses.

Instead, the main mod's automatic-turn path with a third reaction kind, `head`, beside `battle` and `loot` (`docs/BATTLE_REACTIONS.md`, `docs/LOOT_REACTIONS.md`):

- **One reply owner.** The same `automatic` slot, `reactionLease`, `cancelAutomatic` and follow-on rules as battle and loot reactions, so a Johnny remark, a companion's battle line and a manual talk never overlap.
- **The speaker** is the phase 1 head partner (V's entity, voice only, the `head` field), so the reply takes the same route (V's own sound, his subtitle line, no face). Today a battle speaker must be a body near V (`battleObserver.canSpeak`); the delivery check for `head` is `head:refusal(player)` instead, and `speech.storyGuard` already ends a head reply when a scene, a call or a game line of his starts.
- **The bridge** accepts `reaction.kind = 'head'` (`bridge/protocol.mjs` `parseReaction`, `bridge/battle-context.mjs`) with a short event text and plain facts (the place, the person, the quest title): an automatic turn carries no right-now block (`sendRequest` adds it only to manual turns), so what he remarks on travels in the event. One short line, no question back, never stored in conversation memory, like the other reactions.
- **Events feed a small queue.** Each event handler only appends `{kind, facts, at}` (bounded, newest wins per kind). The existing 0.1 s game tick drains it when the gates below are open. Nothing new runs per frame.

### The triggers

| Trigger | What already exists | Event or sample | New work | Cost and verdict |
|---|---|---|---|---|
| **Meeting a named person** | `mod/game-dialogue.lua` hooks the game's subtitle feed (`ShowDialogLines`, `OnShowDialogLine`) and attributes each line to a roster profile, with who else was present | Event-driven; already paid while Continue from game dialogue is on | A callback when a row is pushed: a roster character first heard in some hours. The remark waits until the scene is over (tier 1) | No new native reads. **First.** |
| **Quests** | `ObserveAfter('JournalNotificationQueue', 'OnJournalUpdate')` (`mod/init.lua`) triggers the knowledge rescan after a 1 s debounce; `mod/world-knowledge.lua` already computes edges (a journal entry or fact that changed) through `onEdges`, wired today only for witness receipts (off by default) | Event-driven, then one rescan | A Johnny consumer of the edges: a quest succeeded or failed, his own quests above all (Chippin' In, Blistering Love, A Like Supreme, Tapeworm) | A few table operations per rescan. The remark comes after the rescan, so its time limit is generous. **First.** |
| **Romances** | `mod/relationship-state.lua` already reads the eleven romance facts (Judy, Panam, River, Kerry, Meredith) every 2 s | Sampled, already paid | An on-change callback when a fact goes from 0 to set | Free. Fires at the end of a scene, so it waits for tier 1. **First.** |
| **Entering a location** | `currentDistrict()` (`mod/init.lua`: `PreventionSystem:GetCurrentDistrict()` and a record walk) is read only when a turn is built; `bridge/place-names.mjs` already names the Afterlife, Lizzie's and the Arasaka Tower records (not the Ebunike) | Neither: no district-change event was found | Read only the district id every 5 to 10 s on the existing 0.5 s battle tick, and resolve the record only when it changes; a short list of places he has something to say about | One native call every 5 to 10 s, nothing per frame. The perf probe must show no new row. **Second.** |
| **The Relic glitch, V coughing blood** | Nothing: no observer, status effect or fact for it in the repo | Unknown: it may be a status effect, or only a scripted animation and screen effect | First a read-only developer probe that lists V's applied status effects (`StatusEffectSystem:GetAppliedEffects`) during an open-world Relic episode (a live test). If it is a status effect, `ObserveAfter('PlayerPuppet', 'OnStatusEffectApplied')` with one table lookup | Event-driven and O(1) once the name is known. The story's own Relic episodes are scenes (tier 2 and above), where he stays quiet anyway; the open-world ones are the target. **After the probe.** |
| **Cool combat feats** | Nothing in the main mod: no kill, headshot, multi-kill, takedown or low-health event (`docs/ADDON_API.md`); battle reactions know only fighting and ended, and the opponents V looked at | Would need new hooks on the damage or death path, called for every NPC hit | O(1) counters in the handlers; the decision on the 0.1 s tick; one remark after the fight ("after the fight" is also when a battle reaction speaks) rather than mid-fight | A handler on every hit in a heavy fight is a real FPS risk, and he stays quiet in fights today (open question 1). **Deferred**, and only with a perf-probe measurement. |

### How chatty he is

A select under Johnny in your head, **Johnny speaks up**: **Off** (the default), **Rare** or **Normal**.

- **Off (the default):** no new native hook exists at all: the three collectors already run, and each hands its event to `convaiJohnnyRemarkNote` in `mod/init.lua`, which returns after two boolean reads (`manager.johnnyRemarks()`, `manager.johnnyInHead()`) while either setting is off. `mod/johnny-remarks.lua` is not loaded and no queue exists, so the 0.1 s tick does one nil check.
- **Rare:** at least 15 minutes between remarks and at most 2 an hour. **Normal:** at least 5 minutes and at most 6 an hour. A remark nobody heard does not count (the add-on rule).
- **Always:** a cooldown per kind and per subject (the same person or place not again for an hour), a time limit after which a queued remark is dropped (about 60 s for a person or a place, 120 s for a quest), never within 10 s after a scene or a game line of his, never while V talks to anyone, records, or a reply or reaction plays, and the phase 1 story and busy gates.
- **How long an event waits:** a person until 180 s after the last line they spoke (the remark comes after the scene, at least 10 s after that line), a job 240 s, a romance 300 s. At Rare most events expire before the 15-minute gap allows another remark; that is what Rare means.
- **Quota (the user, 2026-10-19):** every remark is an automatic reaction and counts as one of the day's turns on the free shared Convai key, like a battle reaction. They may use at most `REMARK_SHARE` = 0.1 of the day's limit (`remarkCap(limit)`, 10 of 100; it follows the limit the sign-in backend sets), counted apart in a signed `remark-usage.json` (two copies, the format of the turn count) by `RemarkAllowance` in `bridge/shared-key-guard.mjs`, at the one place a turn reaches Convai (`RealtimeHost.run`, which now passes the turn's config to the guard). The eleventh remark of a day is refused before it reaches Convai and just stops, with no notice (an automatic reaction never shows one). A remark answered by Mistral or Local AI is not a shared-key turn and is not counted; a player's own Convai key is never limited.

### What step 1 built

- `mod/johnny-remarks.lua` (new, pure): `personEvent`, `questEvent` and `romanceEvent` turn a collector's value into a subject and plain facts; `new` keeps the queue (`note`, `pending`, `offer`, `claim`, `release`, `reset`) with the levels, the per-subject hour, the quiet time and the waits above.
- The collectors gained one optional callback each, nil unless set: `mod/game-dialogue.lua` `options.onRow` (a recorded line), `mod/journal-history.lua` `onFinished` (jobs a history scan finds finished that the previous scan did not; the first scan of a world is a baseline and more than four at once is a rebuilt list, not news), `mod/relationship-state.lua` `onFact` (a romance fact newly set in the same world; the first capture is a baseline).
- `mod/init.lua`: `convaiJohnnyRemarksService` (lazy loader), `convaiJohnnyRemarkNote` (the collectors' entry), `convaiJohnnyRemarkTick` (on the 0.1 s tick inside `updateBattles`, after battle and loot reactions; it starts a `head` reaction with the phase 1 head partner, and keeps or releases it while it is the automatic turn), the delivery check in `reactionCanDeliver`, the release of a remark nobody heard in `cancelAutomatic`, and no battle block on a remark (`sendRequest`).
- Bridge: `parseHeadReaction` and `headTrigger` (`bridge/johnny-head.mjs`; only his profile with his head field; facts validated and quoted as data; at most 25 words, no question), wired in `bridge/protocol.mjs` and `bridge/battle-context.mjs`; `RemarkAllowance` above.
- Settings > Conversations > **Johnny speaks up** (Off, Rare, Normal; `johnnyRemarks` in `runtime/settings.json`, Off by default), right under Johnny in your head, in 15 languages.

### Order of work

1. Done: the queue, the `head` reaction kind on both sides, the select and its 15 translations, with the three free triggers (people, quests, romances).
2. Locations, after a perf-probe capture with the district read on.
3. The Relic probe (a live test), then its hook.
4. Combat feats, only if the user wants them after a measurement (and open question 1 allows remarks in fights).

## Phase 3: the glitching hologram (research, not built)

What exists (verified):
- Our own copies spawn through `DynamicEntitySystem:CreateEntity` with `persistState` and `persistSpawn` false and our tag; `DeleteEntity` refuses anything without our tag (`mod/companions.lua`). `mod/holocall.lua` `holoSpawn` is the lightest pattern (a plain record, tags `CyberpunkConvaiCompanion` and `CyberpunkConvaiHolocall`, a tag sweep after a reload).
- A Johnny copy record exists: `CyberpunkConvai.JohnnyCompanion` cloned from `Character.Silverhand` (`mod/companion-records.lua`); companions use the solid appearance `silverhand_riot__not_blendable`.
- The game's own glitch look is Johnny's "blendable" appearance with its `gamePhantomEntityComponent` (blue speckle, fades as the camera faces him). The mod switches it off on purpose for companions (`mod/companion-appearance.lua`, `docs/DEVELOPMENT_AUDIT_2026-09-30.md`).
- V sitting down is already an event (`mod/seated-look.lua`: `WorkspotEvents.OnEnter`, scene tier and seat class, nothing per frame). A scripted sequence that limits movement has no event: only the 0.5 s scene-tier sample.
- No effect files, glitch shaders or hologram assets exist in this repo; the Skippy hologram lives in its own repository.

The smallest clean version: on `WorkspotEvents.OnEnter` (V sits, tier 1, no vehicle, story gate open, busy gate clear, at most once every several minutes), spawn one tagged non-persistent `Character.Silverhand` copy two to three metres away with the blendable appearance and the phantom component left on, facing V, no AI role; delete it after about five seconds, or at once on standing up, a fight, a scene, a session end (`abandonSession`) or a sweep by tag at start-up. A short phase 2 remark can play while he is there.

Why it is not built now: the glitch look is unproven at standing distance (the phantom controller may hide the whole entity, `companion-appearance.lua`), the cost is a full puppet with a facial rig per pop-in, and a scripted sequence that limits movement cannot be told from one that stages the game's own Johnny without a quest-state rule per scene. It needs one live test of the blendable appearance on a spawned copy first (open question 4).

## Lore coverage and gaps

Covered (profile, intrinsic claims or knowledge rules): Rogue as his ex, the Rogue date and its ending, Kerry and Samurai, the reunion concert and its lineup, Nancy, Denny and Henry, Grayson spared or killed, the Porsche, his corporate army service in Mexico, Cole and the dog tags, the desertion, Alt as a netrunner he admired, the oil-field second chance, the NUSA farewell in Phantom Liberty, the endings' facts about him.

Filled 2026-10-19 on branch `johnny-lore` (merged in) through the reviewed claims process, the Alt Cunningham pack as the template (record `research/cyberpunk/native-reviews/johnny-lore-20261019.md`): nine one-to-one topic claims in his pack (24 to 33 claims, 21 to 27 sources, every source checked against the installed archives, independently reviewed in three rounds), with six topic rows and the new hash pin in `bridge/intrinsic-character-context.mjs`. The 2023 tower and the nuke: the raid, his subnet errand and his capture as his represented memory, his codex death, the in-world records that disagree about the bombing, and his own account that he did it for Alt. Soulkiller and Alt: his account of Alt escaping Soulkiller and his blame of her, both as his belief. Spider Murphy: his netrunner in the raid memory. Not supported by game data, so left out: Morgan Blackhand (no Johnny line, scene or codex text links them) and new Songbird material (his view of her is only in replies to dialogue choices no fact records; leads in the record). His view of the endings stays with the existing route-gated rules (`priority-endings.johnny.*`, `sh5.*`, `silverhand.*`): an intrinsic opinion would imply an ending happened. The arm: the game's appearance file gives every Johnny appearance only the base right-hand nail mesh, so the chrome arm is the left; `characters/appearance.json` was corrected and his roster row, profile text and build report regenerated. Convai still has the old arm sentence until his character is re-provisioned (open question 9).

## Files

| File | Change |
|---|---|
| `mod/johnny-head.lua` (new) | `story` (pure), `stage` (pure), `busy` (pure), `recentLine` (pure), `new` service: fact reads held 5 s, `refusal`, `partner`, `standing` |
| `mod/init.lua` | lazy loader `convaiJohnnyHeadService`; `selectConversation` head fallback; recording validity; head guards where the add-on voice path branches on `voiceOnly`; `convaiJohnnyStanding` for the settings page |
| `mod/speech.lua`, `mod/continuous-speech.lua` | a head reply plays as V's own sound like a holocall reply |
| `mod/manager.lua`, `mod/manager-ui.lua` | the setting `johnnyInHead` (off; a missing key counts as off), its row, help and the read-only standing row |
| `mod/locales/*.lua`, `localization/en.json` | the new strings in 15 languages |
| `bridge/protocol.mjs` | `parseHead` |
| `bridge/johnny-head.mjs` (new) | the head block: standing and next-job guidance |
| `bridge/turn-context.mjs`, `bridge/quest-context.mjs`, `bridge/mistral-prompt.mjs` | the "in V's head" sentence, the head block's place, the `HERE` pattern |
| `packaging/release-plan.json`, `scripts/development-files.json`, `packaging/runtime-layout.mjs` | ship and dev-install `johnny-head.lua`, `johnny-remarks.lua` and `bridge/johnny-head.mjs` |
| `mod/johnny-remarks.lua` (new) | phase 2: the remark events, queue and rate (pure) |
| `mod/game-dialogue.lua`, `mod/journal-history.lua`, `mod/relationship-state.lua` | one optional callback each (`onRow`, `onFinished`, `onFact`) |
| `bridge/battle-context.mjs`, `bridge/shared-key-guard.mjs`, `bridge/realtime-host.mjs`, `bridge/convai-bridge.mjs` | the remark's trigger; the remarks' share of the shared key and its wiring |
| `bridge/addons-lua.test.mjs` | the typed path's connection notice now also shows for Johnny (voice only, but with his own connection) |
| `README.md`, `docs/NOTIFICATIONS.md` | the setting and the `talk-busy` notice's second use |
| tests | `bridge/johnny-head.test.mjs` (new: the gates, stages and service in fengari, the loader, the wiring, the bridge words, shipping), `bridge/johnny-remarks.test.mjs` (new: the events, the rate and the queue, the collectors' callbacks, the loader, the automatic-turn wiring, the trigger, the shared key's share, shipping), `bridge/manager.test.mjs` (both settings and the standing row), `bridge/select-labels.test.mjs` (Rare and Normal) |

## Open questions for the user

1. **Combat.** Decided 2026-10-19: Johnny stays quiet in fights.
2. **Scene tier 2.** Decided 2026-10-19: quiet from tier 3, like story characters; the 10 s rule after a game line of his covers the game's own Johnny staged at tier 2.
3. **Phase 2, Johnny speaks first.** Decided 2026-10-19: step 1 built (people, quests, romances); locations, the Relic glitch and combat feats come later.
4. **Phase 3, the hologram.** One live test of the blendable look on a spawned copy first (recommended), or skip the hologram and keep him a voice.
5. **Lore gaps.** Decided 2026-10-19: through the reviewed claims process; done (see "Lore coverage and gaps").
6. **Chattiness levels.** Decided 2026-10-19: Off / Rare / Normal.
7. **Remarks on the shared key.** Decided 2026-10-19: they count as turns, capped at a tenth of the day's (10 of 100).
8. **Combat feats.** Decided 2026-10-19: later (after locations and the Relic probe), with a perf-probe measurement.
9. **Re-provision Johnny on Convai** for the corrected arm sentence: run `node scripts/Provision-Characters.mjs --apply --only johnny-silverhand`, `node scripts/Create-MultilingualProfiles.mjs --apply --only johnny-silverhand`, then `node packaging/Refresh-ReleaseData.mjs` (recommended, it touches only Johnny), or leave Convai's copy as it is until the next profile pass.

## Build steps

1. This document.
2. The setting, its row, help text and 15 translations; the manager test.
3. `mod/johnny-head.lua` with its unit tests.
4. The talk wiring in `mod/init.lua`, speech and subtitles; static tests (nothing in `onUpdate`, lazy load).
5. The bridge: protocol, head block, turn context; tests.
6. The read-only standing row; packaging; docs, README, TODO.
7. (After the user's answers.) Quiet from scene tier 3; `main` merged in; phase 2 step 1 (Johnny speaks up) with the shared key's remark share; the lore gaps on branch `johnny-lore`, merged in.

## Live check owed

Needs the Scripts install (all committed `mod/` files, including the new `mod/johnny-head.lua` and `mod/johnny-remarks.lua`, and the `.json` data), a CET reload and a bridge restart (the bridge runs from the main checkout, so after the merge). No archive, no redscript, no game restart. Use a save after Playing for Time and before the point of no return.

1. Settings > Conversations: **Johnny in your head** is there, Off. Turn it on and Apply. Under it **Johnny's standing** appears with a value (Wary on an early Act 2 save; Friends or Close friends after the oil fields). Turn it off: the standing row goes. Check one other language for cut-off text.
2. With it on, in open gameplay, face nobody and press the text key: the composer opens for Johnny Silverhand (a "Preparing connection" notice may show the first time). Type "Hey Johnny, you there?". His voice comes centred, as if inside V's head (no direction, same level when V turns), with the subtitle "Johnny Silverhand". `probe.log`: `Johnny in your head: conversation stage=<stage>`; the bridge log: `Turn context: ... head=<stage>`.
3. The voice key with nobody in front of V: the same, spoken. Then face a companion or a passer-by and press the key: that character answers, not Johnny.
4. Ask "What should I do next?": he names one of V's actual open jobs, in his voice, and says why. Ask about Rogue and Kerry: answers fit the save (the date, the reunion if done). Ask "What do you think of me?": the tone fits the standing row.
5. Ask "Where are you right now?": he says he is in V's head (or words to that effect), never a place or task of his own.
6. The game first: press the text key with nobody in front during (a) a dialogue choice with any NPC, (b) a phone call, (c) a fight, (d) a cutscene: each time "Johnny Silverhand is busy right now." and nothing starts; `probe.log` names the reason (`dialogue`, `call`, `combat`, `scene`). Start a reply, then walk into a scene or start a fight while he talks: his reply stops, `Johnny in your head: reply ended reason=...`. At Viktor's clinic or Misty's shop (scene tier 2) with nobody in front, he answers (tier 2 is open since the user's decision).
7. Right after the game's own Johnny says something (an ambient comment of his), press the key within 10 s: busy (`johnny-speaking`); after 10 s he answers.
8. Story gate: on a save before Playing for Time is done (the prologue or the first heist) the key behaves as with the setting off ("Face a nearby character to talk.", `Johnny in your head: not in V's head (before)`), and the standing row says "Not in your head yet".
9. FPS and latency: with the setting on, the perf probe shows no new per-frame row; `runtime/bridge-latency.json` for a Johnny turn is in line with a companion turn on the same provider.
10. Setting off: everything as before; `johnny-head.lua` is not loaded (no `Johnny in your head` line in `probe.log`).
11. **Johnny speaks up, Off:** with Johnny speaks up Off (the default) nothing below happens and `probe.log` has no `Johnny speaks up` line.
12. **A person:** set Johnny speaks up to Normal and Apply. Talk through a scene with a named character (Judy, Rogue, Kerry, Panam, Viktor). About 10 s after the scene's last line, with nothing else going on, Johnny says one short line about them in his own voice (centred, his subtitle). `probe.log`: `Johnny speaks up: noted person:<key>`, then `Automatic head reaction: person:<key> stage=<stage>`. Meet the same character again within the hour: no second remark.
13. **A job:** finish a main or side job (a gig or NCPD hustle does not count). Within a few minutes of the journal update (the history scan), one remark naming it; for one of his own (Chippin' In, Tapeworm, A Like Supreme) he treats it as his.
14. **A romance:** on a save just before a romance decision (Judy's lake, Panam's tank, River's water tower, Kerry's beach), make the choice: after the scene, one remark about it. Loading a save where the romance already happened gives no remark (baseline).
15. **The rate:** at Normal no two remarks less than 5 minutes apart and at most 6 an hour; at Rare at most 2 an hour, 15 minutes apart. A remark never starts while V types, records, talks to anyone, a battle or loot reaction plays, or in a scene, a call, a fight (`Automatic reaction released: head-<reason>` when one is dropped).
16. **Shared key:** on the free shared Convai key each remark lowers "x of y left today" by one; after 10 remarks in a day the next ones stop silently (bridge log: the daily-limit refusal for a reaction) while V's own talk goes on. With Mistral or Local AI the count does not move.
17. **Lore (after a bridge restart; Johnny in your head, or any talk with Johnny):** ask "What happened at Arasaka Tower back in 2023?", "Why did you go after Arasaka?", "What happened to Alt?" and "Who was your netrunner?": he answers as his memory and his account (Love Like Fire, the subnet errand, the capture; that he did it for Alt; Spider Murphy), says the records disagree about the bomb, and never presents it as certain history. A present-day question ("Should we hit Arasaka Tower?") does not pull the 2023 material in. Ask which arm is chrome: the left.
