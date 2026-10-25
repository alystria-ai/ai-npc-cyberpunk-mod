# Johnny in your head

Written 2026-10-19 on branch `johnny-in-head` (from `main` 7f74149a; `main` merged in after the cast expansion). Design first, then built in steps (see "Build steps" at the end). Phase 1 and the first step of phase 2 (people, jobs, romances) are on `main`. Steps 2 to 4 of phase 2 (places, the Relic glitch, the after-fight summary) are built on branch `johnny-phase2b` (2026-10-19, from `main` after 0.2.1): not merged, not installed, not seen in the game. The live probes under "Live check owed" settle what the offline work cannot.

## The request

Players on Nexus (ZeroEscape and others, 2026-10-19) asked for Johnny Silverhand to always be with V, as he is in the story: the player talks to themselves, typed or on the voice key, and Johnny answers. The user decided on 2026-10-19 that this is a setting in the main mod, not an add-on. Players asked for:

1. awareness of the active quests;
2. a tracker for Johnny's standing and relationship with V;
3. his opinions on which quest to do next;
4. his own lore (Rogue, Kerry and the rest);
5. now and then, a glitching hologram of him at moments such as V sitting down or a scripted sequence that limits movement (the Joker in *Batman: Arkham Knight*, the voices Coen hears in *Blood of Dawnwalker*). Dropped on 2026-10-20 (owner decision D2): the hologram was built, then removed again; see "Phase 3".

Hard constraints: no per-frame main-thread work and nothing loaded while the setting is off; active only while Johnny is in V's head in the story; the game's own Johnny scenes, cutscenes, phone calls and dialogue choices take priority; the game's own Johnny NPC gets no system of ours beyond talk, face and audio (a popped-in Johnny must be our own spawned copy).

## What a player can do (phase 1)

Settings > Conversations > **Johnny in your head** (one list: **Off**, **On**, **Speaks up rarely**, **Speaks up normally**, **Speaks up often**; Off by default; since 2026-10-20 it is one row that writes both stored keys, `johnnyInHead` and `johnnyRemarks`). With it on (any choice but Off), and once the story has put Johnny in V's head, the two **Talk to Johnny** keys (by voice, by text; Companion Manager > Key bindings or Cyber Engine Tweaks) address Johnny, whoever is under the crosshair (changed 2026-10-25, `docs/TALK_FALLBACK.md`: the ordinary talk keys with nobody faced used to reach him and now go to the first party member). He answers in his own voice, heard as a voice in V's head (no position in the world, full level), with his own subtitle line, his own profile and his own memory: the same memory as the Johnny companion copy and the game's own Johnny talked to where he stands. Aiming at someone still talks to them, exactly as before.

He knows what a companion knows: the "right now" facts, V's tracked quest and open jobs, the story facts of this save that concern him (the `silverhand.*` and related knowledge rules), the last game dialogue (including his own lines in the game), V's gear and his intrinsic claims. On top of that he gets two things nobody else gets: where he is (in V's head, not standing anywhere) and where he and V stand (the standing, below). When V asks what to do next, he picks from V's open jobs and says which one he would do and why.

He stays quiet (the talk key shows "Johnny Silverhand is busy right now.") during a scene, a quest conversation or dialogue choice, a phone call, a fight, while V is replaced by someone else (a flashback where the player is Johnny), and for a few seconds after the game itself gave Johnny a line. Before the story puts him in V's head, and after an ending removes him, the setting does nothing and the talk keys behave as if it were off.

With **Speaks up rarely** (about 2 an hour), **Speaks up normally** (about 4) or **Speaks up often** (about 6) (the last three choices of the same list), he also speaks first now and then: a short remark after V has talked with a named character, finished a main or side job, or a romance moved on (phase 2, step 1, below). Since 2026-10-25 he may also follow up on a companion's own speak-up and on a reply in a conversation V is having, and the pacing is shared with the companions' speak-up (section "Unprompted lines, one scheduler", at the end; `docs/COMPANION_SPEAK_UP.md`).

## Where each piece comes from (reuse, not rebuild)

| Request | How | New or reused |
|---|---|---|
| Talk to Johnny anywhere | A "head" partner returned by `selectConversation` in `mod/init.lua` when no profiled character is targeted; it takes the holocall's audio route (a partner whose `npc` is V, no face, no gaze, no actions) with its own marker `head` | New marker; the route is the holocall's |
| Active quests | The companion knowledge path (`bridge/quest-context.mjs`: knowledge rules, recency, history, open jobs, journal, game dialogue) already serves every named profile, `johnny-silverhand` included | Reused, unchanged |
| Standing with V | `mod/johnny-head.lua` reads a few verified quest facts of the save on the key press and derives a stage; the bridge words it for Johnny | New |
| Next-quest opinions | The open-jobs block (`availableQuestsContext`) already lists V's jobs; the head block tells Johnny to pick from them in his own voice | Reused data, new guidance sentence |
| His lore | Profile `johnny-silverhand` (7,033-character backstory), 24 intrinsic claims (`research/cyberpunk/native-character-claims/johnny-silverhand.json`, pinned in `bridge/intrinsic-character-context.mjs`, up to 3 relevant ones per turn) and the save-bound `silverhand.*`, `jr-priority.*`, `sh5.*`, `core-arcs.johnny.*`, `priority-endings.johnny.*` rules | Reused; gaps listed below, no new lore text written here |
| Hologram pop-in | Built in phase 3, removed again on 2026-10-20 (see "Phase 3") | Dropped |

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

The shared milestones he has been through with V are listed to him by name after the stage sentence (one short sentence). Settings used to show the stage as a read-only "Johnny's standing" line under the setting; that row was removed on 2026-10-20, so the stage now only reaches Johnny's words.

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
| `choices` | the game's own dialogue choice list is on screen, at any scene tier (and in a vehicle). 2026-10-23, the owner's 0.2.9 test: with the setting on, the game's own choice list for Johnny in V's car did not show. Nothing of ours suppresses a choice list (no wrap of the hub, no blackboard write, no input capture); the gap was that a list at tier 1 or 2 was read as a vendor's "Talk" prompt and did not make Johnny yield, so a remark, a reply, his subtitle line or the text box could come up over the game's own conversation. Now Johnny, typed or on the voice key, and every remark of his wait until the list is answered, and a reply he is speaking is ended when a list appears (the same guard as for the other reasons). The one exception is V's plain sit (`sitting`), whose own scene flags keep the choice flag up |
| `scene` | scene tier 5 (a full cinematic), or tier 3 or 4 (limited gameplay, an FPP interaction: a lift, a seat, a ride) together with a game voice line of any character in the last 6 s. Tier 3 or 4 alone no longer refuses (2026-10-22: a lift ride told a player Johnny was busy with nothing happening). The in-reply guard and the recording poll use the same rule. Tier 2 is staged gameplay (Viktor's clinic, Misty's shop) and stays open; where the game stages its own Johnny at tier 2, his game line keeps Johnny quiet (`johnny-speaking`, below) |
| `combat` | V is in a fight |
| `johnny-speaking` | the game showed a line by Johnny in the last 10 s (the game-dialogue buffer, `mod/game-dialogue.lua`, which already attributes lines to `johnny-silverhand`; nothing new is observed) |

A dialogue choice on screen refuses Johnny in your head at every tier (2026-10-23). It still does not refuse a character V aims at (`mod/world-talk.lua`, where the tier-1 and tier-2 "Talk" prompt on a vendor or a fixer is not a conversation): the setting's own paths, the Talk to Johnny keys and his remarks, are the ones that yield. A side effect: while a "Talk" prompt of some vendor is on screen, the Talk to Johnny keys say he is busy.

Every refusal writes one probe-log line with the facts it rests on (2026-10-21, after a player's "busy right now" with no quest running): `Johnny in your head: refused reason=<reason> facts[tier=.. dialogue=.. choices=.. call=.. replacer=.. combat=.. sitting=.. vehicle=.. scene=.. workspot=.. lastLine=<n>s]`, where `workspot` is whether V is in a workspot (read only for a scene refusal, `?` otherwise) and `lastLine` is the age of his last game line (`none` when the buffer holds none of his). Only on a refusal; the support report carries it with the rest of probe.log.

When the game's own Johnny stands in the world (the passenger seat of V's car, V's apartment) and V aims at him, the talk key takes the story-character path of `mod/world-talk.lua`, not this one; there a scene-commanded AI or a ride does not refuse him (docs/WORLD_CHARACTERS.md, "Johnny Silverhand is a projection").

A reply Johnny is speaking when one of these starts is ended, through the same speech hook that ends a story character's reply (`speech.storyGuard`, the refusal held 0.4 s, read only while his reply is heard). A menu pauses it as it pauses every speaker.

## Cost (FPS and latency)

- **Setting off:** nothing. `mod/johnny-head.lua` is never loaded (`dofile` on first need, only when `manager.johnnyInHead()` is true); `selectConversation` does one boolean read on a Talk to Johnny key press, which then ends in a notice. The manager's row is not drawn.
- **Setting on:** still nothing per frame. On a Talk to Johnny key press: one battle sample (as the holocall does), at most fifteen `GetFactStr` reads (one before the story start) (held 5 s, so a recording's validity poll costs nothing new) and a walk over at most 40 buffered game-dialogue rows. During a recording the head partner's validity is read about twice a second with the 0.4 s hold (the same poll the microphone already makes for any target).
- **Talk path latency:** the turn is an ordinary private turn on the holocall's audio route: the bridge warms the connection (`warmConversation`) when the composer opens or the recording starts, and the stage clock (`bridge/turn-clock.mjs`, `runtime/bridge-latency.json`) measures it with no change. The added context is one sentence in the "right now" block and one short world block (under 900 characters).

## Phase 2: Johnny speaks first (steps 1 to 4 built)

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
| **Entering a location** | `PreventionSystem:GetCurrentDistrict()` and the District records (`TweakDBInterface.GetDistrictRecord`, `ParentDistrict`); the game has a district event too (`PreventionSystem.OnDistrictAreaEntered`, fires on entering and on leaving) | A sample, every 6 s, on the existing 0.5 s battle sample, only while both settings are on | A table of twelve places, an arrival tracker, per-place cooldowns, a second note where the save has what the game's rule needs | One native call every 6 s (three on a change), nothing per frame, no observer. **Built (step 2).** |
| **The Relic glitch, V coughing blood** | An episode is a status effect on V with the gameplay tag `JohnnySickness` (`johnny_sickness.tweak`), applied by the quest graphs and handled by `PlayerPuppet.OnStatusEffectApplied` / `OnStatusEffectRemoved` | Event-driven: two observers on the player's class | `mod/johnny-relic.lua`: one tag check per effect on V, an episode tracker, one event at the end of an episode | O(1) per effect applied to V (the callbacks only ever run for the player), nothing per frame; registered once and only while both settings are on. **Built (step 3), needs the live probe to confirm the open-world episodes are status effects at all.** |
| **Cool combat feats** | The game's own counters (`gmpl_npcs_killed_by_player` and three more, quest facts saved with the game) | Read twice per fight (at its start and its end) on the 0.5 s battle sample's combat flag | A small fight tracker; one remark after a fight that counts | Four quest-fact reads at each edge, one nil check per 0.5 s while off. **Built (step 4): the after-fight summary only. Per-hit feats (headshots, multi-kills, quickhack chains) are not built: see "Combat feats: the recommendation".** |

### How chatty he is

The last three choices of the **Johnny in your head** list (a separate select, **Johnny speaks up**, until 2026-10-20; the stored key `johnnyRemarks` is unchanged): **Speaks up rarely** (stored `rare`), **Speaks up normally** (stored `medium`, added 2026-10-25) and **Speaks up often** (stored `normal`); Off and On both store `off`. An old file with `johnnyInHead` off reads as Off whatever `johnnyRemarks` held; on-saves map `true` + `off` to On, `rare` to rarely, `normal` to often.

- **Off (the default):** no new native hook exists at all: the three collectors already run, and each hands its event to `convaiJohnnyRemarkNote` in `mod/init.lua`, which returns after two boolean reads (`manager.johnnyRemarks()`, `manager.johnnyInHead()`) while either setting is off. `mod/johnny-remarks.lua` is not loaded and no queue exists, so the 0.1 s tick does one nil check.
- **Pace (changed 2026-10-25):** the numbers are TARGET rates of calm play, not caps: **Rarely** about 2 an hour, **Normally** about 4, **Often** about 6, with random gaps around the rate (`mod/speak-up.lua`), shared with the companions' speak-up, which adds its own rate (the two add up and take turns; at least 150 seconds between any two unprompted lines). Until 2026-10-25 this was "at least 15 minutes and at most 2 an hour" (rare) and "at least 5 minutes and at most 6 an hour" (normal), counted in `mod/johnny-remarks.lua` (`M.LEVELS`, now only a list of the levels that exist: with `paced = true` its `allowed` does not count). A remark nobody heard does not count (the add-on rule).
- **Always:** a cooldown per kind and per subject (the same person or place not again for an hour), a time limit after which a queued remark is dropped (about 60 s for a person or a place, 120 s for a quest), never within 10 s after a scene or a game line of his, never while V talks to anyone, records, or a reply or reaction plays, and the phase 1 story and busy gates.
- **How long an event waits:** a person until 180 s after the last line they spoke (the remark comes after the scene, at least 10 s after that line), a job 240 s, a romance 300 s. At Rarely most events expire before the schedule allows another remark (about 30 minutes apart on average); that is what Rarely means.
- **Quota (the user, 2026-10-19):** every remark is an automatic reaction and counts as one of the day's turns on the free shared Convai key, like a battle reaction. They may use at most `REMARK_SHARE` = 0.1 of the day's limit (`remarkCap(limit)`, 10 of 100; it follows the limit the sign-in backend sets), counted apart in a signed `remark-usage.json` (two copies, the format of the turn count) by `RemarkAllowance` in `bridge/shared-key-guard.mjs`, at the one place a turn reaches Convai (`RealtimeHost.run`, which now passes the turn's config to the guard). The eleventh remark of a day is refused before it reaches Convai and just stops, with no notice (an automatic reaction never shows one). A remark answered by Mistral or Local AI is not a shared-key turn and is not counted; a player's own Convai key is never limited. Since feature 4 (docs/COMPANION_SPEAK_UP.md) the same pool counts every line nobody asked for: Johnny's remarks and follow-ons (reaction kind `head`) and a companion's speak-ups (kind `speakup`), so one share of `REMARK_SHARE` of the day's turns covers all of them (`UNPROMPTED_KINDS` in `bridge/shared-key-guard.mjs`). A line prepared ahead and then dropped was still a provider interaction and stays counted.

### What step 1 built

- `mod/johnny-remarks.lua` (new, pure): `personEvent`, `questEvent` and `romanceEvent` turn a collector's value into a subject and plain facts; `new` keeps the queue (`note`, `pending`, `offer`, `claim`, `release`, `reset`) with the levels, the per-subject hour, the quiet time and the waits above.
- The collectors gained one optional callback each, nil unless set: `mod/game-dialogue.lua` `options.onRow` (a recorded line), `mod/journal-history.lua` `onFinished` (jobs a history scan finds finished that the previous scan did not; the first scan of a world is a baseline and more than four at once is a rebuilt list, not news), `mod/relationship-state.lua` `onFact` (a romance fact newly set in the same world; the first capture is a baseline).
- `mod/init.lua`: `convaiJohnnyRemarksService` (lazy loader), `convaiJohnnyRemarkNote` (the collectors' entry), `convaiJohnnyRemarkTick` (on the 0.1 s tick inside `updateBattles`, after battle and loot reactions; it starts a `head` reaction with the phase 1 head partner, and keeps or releases it while it is the automatic turn), the delivery check in `reactionCanDeliver`, the release of a remark nobody heard in `cancelAutomatic`, and no battle block on a remark (`sendRequest`).
- Bridge: `parseHeadReaction` and `headTrigger` (`bridge/johnny-head.mjs`; only his profile with his head field; facts validated and quoted as data; at most 25 words, no question), wired in `bridge/protocol.mjs` and `bridge/battle-context.mjs`; `RemarkAllowance` above.
- Settings > Conversations > **Johnny speaks up** (Off, Rare, Normal; `johnnyRemarks` in `runtime/settings.json`, Off by default), right under Johnny in your head, in 15 languages. (Merged into the one **Johnny in your head** list on 2026-10-20.)

### What steps 2 to 4 built (branch `johnny-phase2b`)

All three feed the same queue as step 1 (the same rate, quiet time, shared-key share, busy gates and one reply owner), only while both settings are on, and nothing is loaded while either is off.

**Places (step 2).** `mod/johnny-remarks.lua` `M.PLACES` lists twelve places by the `gamedataDistrict` record names that put V there (a venue is one record, a district any record under it, the most specific on V's chain wins; Dogtown is a top-level record of its own, the Badlands are three). `init.lua` `convaiJohnnyPlaceSample` reads the district id every `PLACE_SECONDS` (6 s) on the existing 0.5 s battle sample, resolves the record chain only when the id changed, and a tracker counts an arrival after two readings in a row (the first reading of a world is where V already was). Where the game's own district event would fire on entering and on leaving, a sample stays simpler and needs no observer that outlives the setting. The research behind every row (sources, evidence, rejected places, hierarchy notes) is `research/cyberpunk/native-reviews/johnny-places-20261019.json`; a test holds that file, the Lua table (districts, cooldown, vehicle rule, the facts and journal entries read for the second note) and the bridge table (phrase, note, second note, gate) together.

| Key | Where | Cooldown | Johnny knows |
|---|---|---|---|
| `afterlife` | Afterlife (venue) | 4 h | second note: V paid Rogue for the Hellman lead there (`jr-priority.rogue.commission`) |
| `arasaka-tower` | Corpo Plaza and the nine tower interiors | 6 h | his own account of 2023, the records disagree (`johnny.history.*`); second note when V has lived his memory of the raid |
| `embers` | Embers (venue) | 3 h | second note: Hanako's offer, once V has talked with her there |
| `pacifica` | Pacifica | 6 h | the dive to Alt, once V reached Alt (milestone `alt`) |
| `badlands` | Badlands, North and South Badlands | 8 h | the name alone |
| `oil-field` | North Sunrise oil field | 3 h | the second chance, once V gave it (milestone `second-chance`) |
| `dogtown` | Dogtown, Brooklyn | 6 h | second note: Songbird's first bargain, once V agreed to it |
| `viktors-clinic` | Viktor's clinic | 6 h | the Relic diagnosis |
| `kerry-estate` | Kerry's estate | 3 h | his view of Kerry; second note once Holdin' On is done |
| `denny-estate` | Denny's estate | 3 h | his respect for her |
| `totentanz` | Totentanz | 3 h | second note: Nancy got out alive |

A place whose record sits under a vehicle-unfriendly volume (interiors and estates, `vehicle = false`) does not count while V is mounted; the first reading on foot is the arrival. The second note is chosen where the arrival is noted: `M.altMet` reads the row's facts (`GetFactStr`) and journal entries (`GetEntryByString`, state Succeeded), all of them, once per arrival (hours apart); a failed read means the plain note, never the one that needs more. Not worth a remark and left out: Lizzie's, the Riot Club, Kabuki, the drive-in, Pistis Sophia, the Ebunike, V's own apartment (see the research file's `rejected` list for why).

**The Relic glitch (step 3).** An episode of the Relic's sickness is a status effect on V with the gameplay tag `JohnnySickness` (`tweaks/base/.../status_effect/johnny_sickness.tweak`: Low, Medium, MediumQuest, Heavy, and Phantom Liberty's `q304_songbird_relic_shock`), applied by quest graphs and turned into the breathing camera and the fullscreen distortion. `mod/johnny-relic.lua` observes `PlayerPuppet.OnStatusEffectApplied` and `OnStatusEffectRemoved` (only the player's class overrides them, so no NPC reaches them), once, after the fact: for every other effect on V a callback is one flag read and one native tag check; an effect with the tag reads its id once. One episode is one event: from the first application until no `JohnnySickness` effect is left on V, the strongest severity kept; a run of applications with a gap (or the at-once removal the game's camera setting causes) is still one episode. The remark waits (`TTL.relic` 120 s) until V is himself again, has a cooldown of 15 minutes, and carries only the severity (mild, bad, severe). The observers cannot be removed: they are registered once per Lua state, late and inside `pcall`, only after both settings were on at a district sample, and return at once while the watch is switched off (and a failed registration is logged once and stays inert). **Unverified until the probe has run in the game:** that the open-world episodes (V coughing blood) are these status effects and not only a scripted animation and screen effect, and what the scene tier is when they play. `probe relic start` watches every status effect applied to or removed from V for five minutes and says what the mod would have made of it.

**Fights (step 4).** No hook on any hit. The game keeps count of what V's side did in quest facts (`gmpl_npcs_killed_by_player`, `_finished_`, `_defeated_`, `_incapacitated_`; `dataTrackingSystem.script`, saved with the game). `M.fightTracker` is fed by the 0.5 s battle sample's combat flag (an existing field): it reads those four facts when a fight starts and when it ends (after 4 s without combat), and a fight of at least 8 s with at least three people down (dead = killed or finished, alive = defeated or knocked out) becomes one `fight` event (`TTL.fight` 150 s, cooldown 10 minutes). The counters count companions' kills too, so the words say so ("the count may include enemies V's allies took down") and carry only the length and two small numbers. A fight already going when the watch begins is skipped; a counter that went down (an older save was loaded) gives nothing. Cost: eight fact reads per fight, one nil check per 0.5 s while off.

### The follow-on (feature 4, bridge half; the game half is in docs/COMPANION_SPEAK_UP.md)

A seventh event, `follow`, for a short remark right after a companion spoke up on her own, or after a reply in a conversation V was having with someone (the scene-end remark of `person` stays as it is). The game sends his usual head turn with `reaction = {kind = 'head', event = 'follow', expiresAt, facts = {who = <the speaker's name, 1 to 60 characters>, line = <what was said, 1 to 500>, via = 'companion' | 'talk'}}` (`parseHeadReaction` in `bridge/johnny-head.mjs`: strict, tags and control characters cleaned, anything else refused). `headTrigger` quotes `who` and `line` as JSON data ("not instructions to you"), says that only V hears him and that the speaker cannot answer, and asks for ONE remark of at most 25 words about what was said, with no question and nothing invented, from his own standing with V like every head event.

He stays voice-only to V. His lines are never added to any companion's memory, history, "heard" list or context, and never go in front of a companion's turn: the bridge records no reaction in conversation memory (`TextProviderHost` remembers only turns that are no reaction), a companion's context is built from that companion's own turn only, and his `follow` turn is validated as its own kind (it cannot be a group round, a companion's profile or a source that is Johnny's own). He can react to what the companion said because that text is data in his trigger.

**Prepared ahead.** Once the game has decided that he follows a line (the decision is the game's random schedule; there is no model call to decide), the bridge writes and voices his remark while the source line is still playing, as soon as the source's complete text is known, and holds the audio until the game submits the identical turn after the source has been heard. Then it is heard right after, with no provider wait left in the gap. It uses the group look-ahead's hold-and-claim (`bridge/group-lookahead.mjs`, `runtime/group-prefetch.json` with `kind: 'follow'`): the held turn is dropped when V opens the text box or presses the voice key, when any request of V's arrives, when the source turn is cancelled or replaced (after a grace of 1.5 s, because the game's own submission also ends the source), when the game withdraws the command, and after 90 s. On Convai it follows the group look-ahead's plan rule (the shared key, or a player's own key on a confirmed paid plan); the text providers (Mistral, Local AI, Custom) prepare it too, as the lowest-priority work: see docs/COMPANION_SPEAK_UP.md, "Bridge side". Measured silence between the source's last audio and his first, serial against prepared, with simulated providers: the same document.

### Combat feats: the recommendation

**Do not build per-hit feats** (headshots, multi-kills, takedowns, Sandevistan and Kerenzikov kills, quickhack chains), and keep the after-fight summary as the whole feature for now. Every signal for them other than the counters is an observer on a hot path: `NPCPuppet.OnHit` and `GameObject.OnDamageReceived` fire for every hit by anyone (the cost study assumes 10 to 100 a second in a heavy fight), the per-effect hooks fire for every status effect on any NPC, and each dispatch crosses the CET boundary about twice and runs a Lua callback (the study's estimate is about 50 microseconds: the plan's 25 microseconds a crossing, twice, plus the callback). That is small on paper (a peak of 100 calls a second is about 5 ms of main-thread time per second, about a quarter of a frame per second at 48 fps) but it is an estimate, it lands in the heaviest moments of play, and the rule is that latency and FPS come first. The one signal that is per kill and not per hit is `DataTrackingSystem.OnNPCKillDataTrackingRequest` (about one a second at most, civilians excluded, with the last hit's flags, so headshot, finisher and quickhack kills could be told apart): if a feats remark is wanted later, that is the hook to take, one hook with an O(1) counter, and only after `probe feats start` has measured it in a real fight (the study ranks every candidate and gives a verdict under 1 ms per second: negligible).

`mod/combat-feats-probe.lua` is that measurement: Developer mode, a bounded run of at most five minutes, hooks registered late and inside `pcall`, each with a call counter and an estimated cost from a calibrated per-call time; plus the counters at start and stop, and the time dilation seen on the 0.5 s tick. CET cannot remove an observer, so reload CET or restart the game after the study.

### Order of work

1. Done (0.2.1): the queue, the `head` reaction kind on both sides, the select and its 15 translations, with the three free triggers (people, quests, romances).
2. Done on `johnny-phase2b`: places (twelve, from the research file), with the live read of the district as `probe place read`.
3. Done on `johnny-phase2b`: the Relic watch (two observers, one event per episode), with `probe relic start` to see the live effects.
4. Done on `johnny-phase2b`: the after-fight summary from the game's counters, no per-hit work; the cost study of per-hit hooks as `probe feats start`.
5. Built on `johnny-phase2b`, then removed completely on 2026-10-20 (owner decision D2): the glitching hologram (phase 3).

## Unprompted lines, one scheduler (2026-10-25)

Johnny's remarks are no longer paced alone. A party companion can now speak up on her own too (Settings > Conversations > **Companions speak up**, Rarely by default), and one scheduler (`mod/speak-up.lua`, documented in `docs/COMPANION_SPEAK_UP.md`) paces both. What changed for him:

- **Rates.** Rarely, Normally (new, stored `medium`) and Often are target rates of about 2, 4 and 6 an hour of calm play, random around the rate and not counted while a fight, scene, call, menu or conversation is on. They are not caps. With the companions' list on too the two rates add up (rare + rare is 4 an hour, normal + normal 8, often + often 12) and any two unprompted lines are at least 150 seconds apart.
- **The arbiter.** One unprompted speaker at a time. His queued remarks (person, job, romance, place, Relic, fight) and a companion's candidate compete through `sched:pick`; he never cuts in on a companion's line and a companion never starts while he talks; nobody speaks twice in a row because of the merge. The scene-end remark ("meeting a named person") is kept and goes through the same arbiter. His queue, quiet time (10 s), cooldowns and time limits are as before.
- **Follow-on.** Sometimes (half the time, and only when his own timer is due, so it counts towards his rate) he comments after a companion's speak-up has finished, or after a reply in a conversation V is having with a named character, never in the middle of one. The line is written and voiced while the source line is still playing and held until it has been heard (`### The follow-on` above and `docs/COMPANION_SPEAK_UP.md`).
- **Only V hears him.** His lines are voice-only to V; they never reach a companion's context, memory or history, and the companions never answer them (tested in `bridge/speakup-context.test.mjs` and `bridge/speak-up-bridge.test.mjs`). He can react to what a companion said: her line is quoted to him as data.
- **Off and plain On** mean no unprompted lines of any kind, as before; the follow-on needs Rarely, Normally or Often.

## Phase 3: the glitching hologram (removed 2026-10-20)

Built on `johnny-phase2b` behind its own setting (**Johnny's hologram**, off by default) and removed completely on 2026-10-20 (owner decision D2): the setting, the row, its Lua service and probe, the tests and the seat hooks it used are gone, and an old saved `johnny-hologram` value is ignored. Johnny in your head and Johnny speaks up are separate features and are unchanged.

One finding of that work stays true and is still used: V's chairs and couches are scene sits (the game's scene tier is 3 and the dialogue flag or the choice-hub flag is up), so the Companion Manager's shortcut answered "Finish the scene first." on a couch. `mod/seated-look.lua` (`M.plain`) says V sits plainly when the controller holds a sit, the tier is 3 or below and readable, there is no call, fight, replacer or vehicle, and no game line that is not the crowd's has come since V sat; the observer puts that in `sample.sitting`, and the manager's shortcut (`mod/nsui-entry.lua`, `mod/mcm-host.lua`, through `convaiPlainSitting` in `init.lua`) opens on it. A refusal on a seat that should have counted logs `Plain sit check: no (...)`.

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
| `mod/johnny-remarks.lua` (steps 2 to 4) | `M.PLACES`, `placeOf`, `placeEvent`, `altMet`, `placeTracker` (places); `relicEvent` (the Relic); `fightCounts`, `fightEvent`, `fightTracker` (fights); the cooldown per subject, `TTL` for the new kinds |
| `mod/johnny-relic.lua` (new) | the Relic watch: classifier, episode tracker, the two observers on the player, registered once |
| `mod/init.lua` (steps 2 to 4) | `convaiJohnnyPlaceSample` (the district read on the 0.5 s battle sample), `convaiJohnnyRelicEnsure`, `convaiJohnnyFightSample` and `convaiJohnnyFightCounters`, the developer mailbox's `johnny-probe:` requests |
| `mod/manager.lua`, `mod/manager-ui.lua`, `bridge/startup-lua-fixture.mjs` | the changed help of Johnny speaks up (the hologram setting added here was removed again on 2026-10-20) |
| `mod/johnny-probe.lua`, `mod/johnny-relic-probe.lua`, `mod/combat-feats-probe.lua` (new), `scripts/Send-JohnnyProbe.ps1` (new) | the developer probes: `place`, `relic`, `feats`; `runtime/johnny-probe.json` is classified in `packaging/runtime-exchange.json` |
| `bridge/johnny-head.mjs` (steps 2 to 4) | `PLACES` (twelve rows), `RELIC_SEVERITY`, the `place`, `relic` and `fight` events: validation and words |
| `bridge/johnny-head.mjs`, `bridge/speakup-context.mjs` (new), `bridge/group-lookahead.mjs`, `bridge/convai-bridge.mjs`, `bridge/text-provider-host.mjs`, `bridge/local-llm-server.mjs`, `bridge/shared-key-guard.mjs` (feature 4) | the `follow` event, the follow-on prepared while the line plays, the one shared-key pool for every unprompted line (docs/COMPANION_SPEAK_UP.md, "Bridge side") |
| `research/cyberpunk/native-reviews/johnny-places-20261019.json` | the sources, gates and evidence behind the twelve places and the places rejected |
| tests (steps 2 to 4) | `bridge/johnny-places.test.mjs`, `bridge/johnny-relic.test.mjs`, `bridge/johnny-fights.test.mjs`, `bridge/johnny-probe.test.mjs`, `bridge/combat-feats-probe.test.mjs` |
| tests | `bridge/johnny-head.test.mjs` (new: the gates, stages and service in fengari, the loader, the wiring, the bridge words, shipping), `bridge/johnny-remarks.test.mjs` (new: the events, the rate and the queue, the collectors' callbacks, the loader, the automatic-turn wiring, the trigger, the shared key's share, shipping), `bridge/manager.test.mjs` (both settings and the standing row), `bridge/select-labels.test.mjs` (Rare and Normal) |

## Open questions for the user

1. **Combat.** Decided 2026-10-19: Johnny stays quiet in fights.
2. **Scene tier 2.** Decided 2026-10-19: quiet from tier 3, like story characters; the 10 s rule after a game line of his covers the game's own Johnny staged at tier 2.
3. **Phase 2, Johnny speaks first.** Decided 2026-10-19: step 1 built (people, quests, romances); locations, the Relic glitch and combat feats come later. Built since on `johnny-phase2b`: places, the Relic watch and the after-fight summary (see "What steps 2 to 4 built").
4. **Phase 3, the hologram.** Decided 2026-10-20 (D2): removed completely, with V talks on their own.
5. **Lore gaps.** Decided 2026-10-19: through the reviewed claims process; done (see "Lore coverage and gaps").
6. **Chattiness levels.** Decided 2026-10-19: Off / Rare / Normal.
7. **Remarks on the shared key.** Decided 2026-10-19: they count as turns, capped at a tenth of the day's (10 of 100).
8. **Combat feats.** Decided 2026-10-19: later, with a perf-probe measurement. Built: the after-fight summary, no per-hit work. Recommended: no per-hit feats; if a feats remark is wanted, take only the per-kill hook `DataTrackingSystem.OnNPCKillDataTrackingRequest`, after `feats start` has measured it (see "Combat feats: the recommendation").
9. **Re-provision Johnny on Convai** for the corrected arm sentence: run `node scripts/Provision-Characters.mjs --apply --only johnny-silverhand`, `node scripts/Create-MultilingualProfiles.mjs --apply --only johnny-silverhand`, then `node packaging/Refresh-ReleaseData.mjs` (recommended, it touches only Johnny), or leave Convai's copy as it is until the next profile pass.
10. **The Relic episodes in the open world.** The offline data says an episode is a status effect with the tag `JohnnySickness`; whether the open-world coughing episodes are those effects is only known after `relic start` in a game session. If the probe finds none, the Relic remark has nothing to trigger on and is dropped (a scripted animation would need a quest-graph hook per episode, not worth it).
11. **Places worth adding.** The research file lists the places left out and why. V's own apartment has a grounded note (Johnny's proposal in the apartment, `sh5.resurrection.johnny-proposal`) but V is home constantly, so a remark there would repeat; add it only with a long cooldown if wanted.

## Build steps

1. This document.
2. The setting, its row, help text and 15 translations; the manager test.
3. `mod/johnny-head.lua` with its unit tests.
4. The talk wiring in `mod/init.lua`, speech and subtitles; static tests (nothing in `onUpdate`, lazy load).
5. The bridge: protocol, head block, turn context; tests.
6. The read-only standing row; packaging; docs, README, TODO.
7. (After the user's answers.) Quiet from scene tier 3; `main` merged in; phase 2 step 1 (Johnny speaks up) with the shared key's remark share; the lore gaps on branch `johnny-lore`, merged in.
8. (Branch `johnny-phase2b`, 2026-10-19.) Places (twelve, from the research file), the Relic watch, the after-fight summary and the developer probes `place`, `relic` and `feats` (the glitching hologram built here was removed again on 2026-10-20); `main` (0.2.1) merged in first.

## Live check owed

### Quick live check for `johnny-phase2b` (short; the long list below is the full one)

Branch state: `main` (7ec1232d) merged in on 2026-10-19; the two new rows live in `mod/manager-ui.lua` and show in both hosts (Native Settings UI and Mod Configuration Menu). Setup: the Scripts install (every committed `mod/` file, Lua and `.json`, never `diagnostics.lua`), a CET reload, a bridge restart, a save after Playing for Time and before the point of no return, Developer mode on only for step 9.

1. Open the Companion Manager (Native Settings UI: Mods > the tab > Settings; Mod Configuration Menu: the mod's page). Conversations shows, in this order, **Johnny in your head**, **Johnny speaks up** (one list, Off by default, since 2026-10-20; read the checks below with that in mind). In MCM nothing is purple at the defaults; **Restore defaults** (twice) puts both back to Off. Check both hosts.
2. All Off: sit down, walk into the Afterlife, fight. `probe.log` has no `Johnny speaks up`.
3. Turn on **Johnny in your head** and **Johnny speaks up: Normal**, Apply. Walk into the Afterlife (or Pacifica, the Badlands): about 10 s after arriving, with nothing else going on, Johnny says one short line about the place in his voice (centred, his subtitle). `probe.log`: `Johnny speaks up: noted place:<key>`. The same place again: nothing.
4. A fight with three or more enemies lasting 8 s or more: after it ends (4 s of calm and 10 s of quiet) one remark about it. Not during the fight.
5. Quiet: open the text box, hold the voice key, start a call or a cutscene, or have a dialogue choice open: no remark starts; one that was running stops (`Automatic reaction released: head-...`).
6. Story gate: on a save before Playing for Time is done, nothing of the above happens (no remark), with the settings on.
7. Free shared key: each remark lowers "x of y left today" by one; after 10 remarks in a day the next stop silently.
8. Developer mode on, then `powershell -File scriptsSend-JohnnyProbe.ps1 relic start`, play until V coughs blood in the open world, `relic status`: report what `candidates` shows (the open-world episode may not be a status effect).
9. Turn everything Off and Apply: no further remark. Perf probe with the settings on: no new per-frame row.

### The full list

Needs the Scripts install (all committed `mod/` files, including the new `mod/johnny-head.lua` and `mod/johnny-remarks.lua`, and the `.json` data), a CET reload and a bridge restart (the bridge runs from the main checkout, so after the merge). No archive, no redscript, no game restart. Use a save after Playing for Time and before the point of no return.

1. Settings > Conversations: **Johnny in your head** is there, Off. Turn it on and Apply. (The standing row this check used to look for was removed on 2026-10-20.) Check one other language for cut-off text.
2. With it on, in open gameplay, press the Talk to Johnny text key (bind it first): the composer opens for Johnny Silverhand (a "Preparing connection" notice may show the first time). Type "Hey Johnny, you there?". His voice comes centred, as if inside V's head (no direction, same level when V turns), with the subtitle "Johnny Silverhand". `probe.log`: `Johnny in your head: conversation stage=<stage>`; the bridge log: `Turn context: ... head=<stage>`.
3. The Talk to Johnny voice key: the same, spoken, also while facing a companion or a passer-by. The ordinary talk keys with nobody in front of V go to the first party member, not to Johnny.
4. Ask "What should I do next?": he names one of V's actual open jobs, in his voice, and says why. Ask about Rogue and Kerry: answers fit the save (the date, the reunion if done). Ask "What do you think of me?": the tone fits the standing row.
5. Ask "Where are you right now?": he says he is in V's head (or words to that effect), never a place or task of his own.
6. The game first: press the Talk to Johnny text key during (a) a dialogue choice with any NPC, (b) a phone call, (c) a fight, (d) a cutscene: each time "Johnny Silverhand is busy right now." and nothing starts; `probe.log` names the reason (`dialogue`, `call`, `combat`, `scene`). Start a reply, then walk into a scene or start a fight while he talks: his reply stops, `Johnny in your head: reply ended reason=...`. At Viktor's clinic or Misty's shop (scene tier 2) with nobody in front, he answers (tier 2 is open since the user's decision).
6b. Ambient Johnny, no quest running: ride in V's car with the game's own Johnny in the passenger seat, or stand in V's apartment with him visible, aim at him and press the key: he answers (it was "busy right now" for a scene-commanded AI or a ride). During a quest cutscene or a dialogue choice with him it is still busy. Any "busy" with no quest: send the support report; `probe.log` has `World conversation refused: profile=johnny-silverhand reason=...` or `Johnny in your head: refused reason=...` with the facts.
7. Right after the game's own Johnny says something (an ambient comment of his), press the key within 10 s: busy (`johnny-speaking`); after 10 s he answers.
8. Story gate: on a save before Playing for Time is done (the prologue or the first heist) the key behaves as with the setting off ("Face a nearby character to talk.", `Johnny in your head: not in V's head (before)`).
9. FPS and latency: with the setting on, the perf probe shows no new per-frame row; `runtime/bridge-latency.json` for a Johnny turn is in line with a companion turn on the same provider.
10. Setting off: everything as before; `johnny-head.lua` is not loaded (no `Johnny in your head` line in `probe.log`).
11. **Johnny speaks up, Off:** with Johnny speaks up Off (the default) nothing below happens and `probe.log` has no `Johnny speaks up` line.
12. **A person:** set Johnny speaks up to Normal and Apply. Talk through a scene with a named character (Judy, Rogue, Kerry, Panam, Viktor). About 10 s after the scene's last line, with nothing else going on, Johnny says one short line about them in his own voice (centred, his subtitle). `probe.log`: `Johnny speaks up: noted person:<key>`, then `Automatic head reaction: person:<key> stage=<stage>`. Meet the same character again within the hour: no second remark.
13. **A job:** finish a main or side job (a gig or NCPD hustle does not count). Within a few minutes of the journal update (the history scan), one remark naming it; for one of his own (Chippin' In, Tapeworm, A Like Supreme) he treats it as his.
14. **A romance:** on a save just before a romance decision (Judy's lake, Panam's tank, River's water tower, Kerry's beach), make the choice: after the scene, one remark about it. Loading a save where the romance already happened gives no remark (baseline).
15. **The rate:** at Normal no two remarks less than 5 minutes apart and at most 6 an hour; at Rare at most 2 an hour, 15 minutes apart. A remark never starts while V types, records, talks to anyone, a battle or loot reaction plays, or in a scene, a call, a fight (`Automatic reaction released: head-<reason>` when one is dropped).
16. **Shared key:** on the free shared Convai key each remark lowers "x of y left today" by one; after 10 remarks in a day the next ones stop silently (bridge log: the daily-limit refusal for a reaction) while V's own talk goes on. With Mistral or Local AI the count does not move.
17. **Lore (after a bridge restart; Johnny in your head, or any talk with Johnny):** ask "What happened at Arasaka Tower back in 2023?", "Why did you go after Arasaka?", "What happened to Alt?" and "Who was your netrunner?": he answers as his memory and his account (Love Like Fire, the subnet errand, the capture; that he did it for Alt; Spider Murphy), says the records disagree about the bomb, and never presents it as certain history. A present-day question ("Should we hit Arasaka Tower?") does not pull the 2023 material in. Ask which arm is chrome: the left.

18. **The probes.** Developer mode ON in the mod's settings (it is off for players: with it off the mod reads the request and drops it), a world loaded and unpaused, the Scripts install and a CET reload. From the repo: `powershell -File scripts\Send-JohnnyProbe.ps1 <feature> <action>`. It writes the mod's existing developer mailbox (`runtime\diagnostic-request.txt`), never sends input to the game, waits for `runtime\johnny-probe.json` and prints it. The probes: `place read` (the district chain V is read in, the place it would match, the queue, whether the rate and the busy gates allow a remark) and `place note:<key>` (queues one test arrival with its cooldown cleared); `relic start`, `relic status`, `relic stop`, `relic snapshot`; `feats start` (or `feats start:60`), `feats status`, `feats stop`.
19. **Places:** Johnny in your head On, Johnny speaks up at Normal. Walk or drive into the Afterlife, Pacifica, the Badlands, Dogtown, Corpo Plaza, the oil field, Viktor's clinic, Kerry's or Denny's estate, the Totentanz: about 10 s after the arrival, with nothing else going on, one short remark about the place in his voice (in the busy gates' terms: not in a scene, call or fight). `place read` at each place names the expected key (`afterlife`, `pacifica`, `badlands`, `dogtown`, `arasaka-tower`, `oil-field`, `viktors-clinic`, `kerry-estate`, `denny-estate`, `totentanz`). `probe.log`: `Johnny speaks up: noted place:<key>`, then `Automatic head reaction: place:<key>`. The same place again within its cooldown (3 to 8 h): nothing. A save loaded inside a place gives no remark (baseline). Estates and interiors do not count while driving.
20. **Relic:** `relic start`, then play until V coughs blood in the open world (a Relic episode with the camera sway and the glitch); `relic status`: `candidates` lists the Relic effects with the scene tier, `wouldNote` what the mod would have noted. No candidate means the open-world episode is not a status effect: tell me what `records` and `events` show. With Johnny speaks up On, one remark after the episode ends (cooldown 15 minutes).
21. **Fights:** a fight with at least three enemies that lasts at least 8 s: after it ends (4 s without combat) and 10 s of quiet, one remark about the fight (how long, how many); `probe.log`: `Johnny speaks up: fight over seconds=<n> dead=<n> alive=<n>`. A skirmish with one or two enemies: nothing. Within ten minutes of the last fight remark: nothing.
22. **Cost study:** `feats start`, play one heavy fight (up to five minutes), `feats stop`; send me `runtime\johnny-probe.json` (its `summary` ranks the hooks with a verdict each). Then reload CET: observers cannot be removed.
23. **FPS and latency:** with every new setting on, the perf probe shows no new per-frame row (the only new hooks are the two observers on the player's status effects, registered once, and they do nothing per frame); `runtime/bridge-latency.json` for a remark is in line with a companion turn on the same provider. With the settings off nothing is loaded (no `Johnny speaks up` lines in `probe.log`).
