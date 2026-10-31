# Romance animations

Branch `feat/romance-animations` (from main 17a5313, for the update after 0.4.0). V and a romance partner can kiss, hug, stand close, sit together, cuddle or lie together, using only the game's own two person animations on the invisible workspot device the body gestures already use (`convai_gesture_device.ent`, docs/COMPANION_GESTURES.md). No other mod is needed.

**Status: built and tested offline, not yet seen in the game.** Every row of the clip table is a candidate (`verified = false` in `mod/romance-pairs.lua`). The paths come from the game's workspot path list and the game's own clip names as other tools list them. Nobody has opened the game files yet. Section 8 is the check a local agent runs on the owner's PC with WolvenKit, section 9 is the live check for the owner.

## 1. What the player gets

* A setting **Romance animations** (Settings > Companions, right after Companions change outfits). **On by default.** It only ever does anything for a romance partner, only on V's request, and only after one yes. Off, a private turn pays one boolean and nothing else is loaded or read.
* Ask in a talk ("kiss me", "give me a hug", "hold my hand", "sit with me", "cuddle with me", "lie down with me", and "let's get up" or "stop hugging" to end it), typed or spoken, or pick it from the list under each partner in Companion Manager > Current party (Kiss, Hug, Stand close, Sit together, Cuddle, Lie together, Stop). English is read in talk for now, the list works in every language.
* The game asks once ("Hug Judy?" with Confirm and Cancel, and a line that the screen blinks and V ends up back where V stands). Nothing plays without that yes.
* Then the screen blinks, V and the partner play the pair, the screen blinks again, and both are back where they stood.

The old Gameplay section of Settings no longer exists (docs/SETTINGS_MATRIX.md section 7), so the row sits on the Companions page with the other things that happen with a party member. This is the documented decision.

## 2. The rules

| Rule | How it is kept |
|---|---|
| Only with a romance partner | The mod asks twice. The bridge writes a request only when the turn's relationship selection says partner (`romanceOf(...) === 'partner'`, a game romance or a romance V started through talk, never a casual encounter or one V ended). The game checks again when it is asked and when V says yes: a romance V started through talk is a saved fact (`mod/romance-registry.lua`, `ended` beats everything), otherwise the game's own romance fact (`sq030_judy_lover`, `sq027_panam_lover`, `sq029_river_lover`, `sq028_kerry_relationship`). |
| Only when V asks | Two ways in: a plain ask in V's talk (`bridge/romance-anim-intent.mjs`, a few regular expressions, no model) or a pick from the Current party list. Nothing starts from a timer, from the character, from a mood or from the model. Ticking the controller with nothing asked touches nothing (tested). |
| One confirmation | `request` asks, the answer comes from the game's own message box (`r6/scripts/CyberpunkConvai/RomanceConfirm.reds`). No box, no pair. A yes is gated again before anything moves, so danger since the question cancels it. The question names what will really happen, a fallback says so ("That does not fit here with Judy. Instead: Sit together with Judy?"). |
| Never in combat, in a car, in a scene or during a mission | The gate reads the battle sample the 0.5 s observer already holds: combat, a vehicle, a call, a dialogue or choice, a scene tier other than 1 (cutscenes and game scenes), a replacer. Also a fight the battle module reports, a bond quest stage in play (`convaiQuestPlay.armed()`), an open menu, pause or text box. While a pair plays, only combat and an incoming call end it (the scene flags are the workspot's own then). A mission that is only a tracked job, with no scene running, is not detected, see section 10. |
| Only the mod's own copies | The partner comes from `companions.ownEntryFor(profileKey)`, which knows party members, invited visitors and housemates. A game-placed story character has no entry, so it is never moved. The experimental Talk during missions setting is not in this branch, so there is nothing to allow here. |
| Her speech and lip sync | Nothing starts while a reply is playing or due: a request made while she speaks waits up to 25 s for the reply to end. Short pairs (`speech = 'hold'`, kiss and hug) end early when a reply starts, after at least 1.5 s, so she answers standing. Long poses (`speech = 'fit'`) let a reply play. The device components are built on copies with the plain neutral face, like the seat workspots, so lips are not fought by the workspot's own face. |
| FPS first | Everything is on request. Idle the tick is two nil checks. After a private turn with a partner the request file is read once a second for 90 s. While a pair plays a watch runs every 0.5 s (two "is in workspot" reads and the gates, which only read the sample already held). The device exists only while a pair plays. No per frame work, no new observers. |

## 3. How it works

```
request(entry, kind)   gate, choose a row for the two rigs (or a fallback kind), ask V once
answer(yes)            gate again, save V's and her pose, let gestures and seating go of her, blink
enter                  spawn the device at V, check both components exist, PlayInDeviceSimple for V and for her in the same call,
                       SendJumpToAnimEnt on each half when the row names an entry, check after 1.2 s that both are inside
playing                hold the row's time, re-jump both together when the row loops, watch every 0.5 s
exit                   blink, SendFastExitSignal on both, StopInDevice on both, delete the device, teleport V and her back, cooldown 4 s
```

* **Roots.** The row is tried at the workspot's own authored position first (`PlayAtResourcePosition`), so the two clip roots line up as the quest did. After entry the controller measures the gap between V and the partner. If it is under 0.15 m or over 2.4 m the roots did not line up: both leave, the row is remembered as an offset row for the session, and it is entered again with `DontPlayAtResourcePosition` and the per row offset (forward and right in metres from V, yaw relative to V). Rows that are two separate workspots (sit and lie on the ground) are offset rows from the start.
* **Loops.** A row with `loopEvery` and a `jump` entry on both halves is re-jumped on both halves in the same call. Rows without it rely on the game's own looping idle sequence.
* **Ending.** The hold time of the row (kiss 8 s, hug 9, hands 30, sit 45, cuddle 50, lie 50 by default), or sooner: V asks to stop (talk or the list), danger, a reply on a short pair, one half leaving the workspot, the partner dismissed or sent away, the world ending. The world ending makes no native call (the device is not persistent).
* **Clean exit from any phase.** `finish` is idempotent and always signals both out, force stops, deletes the device and puts V and her back at their saved poses. The exit follows the rule of docs/COMPANION_GESTURES.md: the native fast exit with default arguments, never `StopNpcInWorkspot`.
* **Ownership.** While a pair plays the partner is owned like a seated copy (`companions.bodyAnimation.owns`), so recovery never teleports her and the gestures do not touch her. At the start gestures and seating are asked to release her.

## 4. Pairs for which rig

V's rigs: `player_man` and `player_woman` (`GetResolvedGenderName`). Partner rigs, from the gesture catalog: `woman_base` (Judy, Panam), `man_base` (Kerry), `man_big` (River). A pair is offered only when both rigs match a row (a half made for a person is only offered for them). Otherwise the fallback chain runs and the question says so:

| asked | tries in order |
|---|---|
| kiss | kiss, hug, hands, sit |
| hug | hug, hands, sit |
| hands | hands, sit |
| cuddle | cuddle, sit, hands |
| lie | lie, cuddle, sit, hands |
| sit | sit, hands |

What the table gives today, per partner and V (the kind that is really played, and the row, for each ask). The offline test pins this matrix.

| partner / V | kiss | hug | hands | sit | cuddle | lie |
|---|---|---|---|---|---|---|
| judy-alvarez, V player_man | hug (hug_judy) | hug_judy | sit (sit_ground) | sit_ground | sit (sit_ground) | lie_ground |
| judy-alvarez, V player_woman | hug (hug_judy) | hug_judy | sit (sit_ground) | sit_ground | sit (sit_ground) | lie_ground |
| panam-palmer, V player_man | sit (sit_ground) | sit (sit_ground) | sit (sit_ground) | sit_ground | sit (sit_ground) | lie_ground |
| panam-palmer, V player_woman | sit (sit_ground) | sit (sit_ground) | sit (sit_ground) | sit_ground | sit (sit_ground) | lie_ground |
| river-ward, V player_man | sit (sit_ground) | sit (sit_ground) | sit (sit_ground) | sit_ground | sit (sit_ground) | lie_ground |
| river-ward, V player_woman | sit (sit_ground) | sit (sit_ground) | sit (sit_ground) | sit_ground | cuddle_river | lie_ground |
| kerry-eurodyne, V player_man | hands (close_kerry) | hands (close_kerry) | close_kerry | sit_ground | cuddle_kerry | lie_ground |
| kerry-eurodyne, V player_woman | hands (close_kerry) | hands (close_kerry) | close_kerry | sit_ground | cuddle_kerry | lie_ground |

A kiss has no complete pair in the table yet (see the rows kept for the record), so every kiss falls back for now. The cuddle rows that lie across V's lap need a seat under V (`needs = 'seat'`), which nothing confirms yet, so Judy and Panam cuddle falls back to sitting on the ground.

## 5. The clip table

`mod/romance-pairs.lua` is the one file that names the clips. Everything else reads it: the controller, `scripts/Build-GestureAssets.mjs` (components) and `bridge/romance-anim.test.mjs`. Workspot names are shortened here, the full depot paths are in the file. All rows are `verified = false`.

| id | kind | V rigs | partner rigs | made for | V half (workspot) | partner half (workspot) | hold s | placement | speech | needs | offered |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `hug_judy` | hug | player_man, player_woman | woman_base | judy-alvarez | `q202__synced__player__stand_ground__hug__01` | `q202__synced__judy__stand_ground__hug__01` | 9 | resource | hold | none | yes |
| `hold_judy` | hug | player_man, player_woman | woman_base | judy-alvarez | `q202__synced__player__stand_ground__hold__01` | `q202__synced__judy__stand_ground__hold__01` | 12 | resource | fit | none | yes |
| `cuddle_kerry` | cuddle | player_man, player_woman | man_base | kerry-eurodyne | `mq055__player__synced__hangouts_cuddle_with_kerry__01` | `mq055__kerry__synced__hangouts_cuddle_with_player__01` | 50 | resource | fit | none | yes |
| `cuddle_river` | cuddle | player_woman | man_big | river-ward | `mq055__female_player__synced__hangouts_cuddle_with_river__01` | `mq055__river__synced__hangouts_cuddle_with_female_player__01` | 50 | resource | fit | none | yes |
| `lap_judy` | cuddle | player_man | woman_base | judy-alvarez | `mq053__player_male__synced__judy_lies_on_v_lap__01` | `mq053__judy__synced__judy_lies_on_v_lap__01` | 50 | resource | fit | seat | yes |
| `lap_woman` | cuddle | player_man, player_woman | woman_base | any | `mq055__player__synced__lie_idle_on_v_lap__01` | `mq055__female_average__synced__lie_idle_on_v_lap__01` | 50 | resource | fit | seat | yes |
| `sit_ground` | sit | player_man, player_woman | woman_base, man_base, man_big | any | `player__sit_ground_lean_back__idle__01` | `generic__sit_ground_lean_back__sit_around__01` | 45 | offset | fit | none | yes |
| `lie_ground` | lie | player_man, player_woman | woman_base, man_base, man_big | any | `q116__player__lie_ground__lie_around__01` | `generic__lie_ground_lean_left__lie_around__01` | 50 | offset | fit | none | yes |
| `close_kerry` | hands | player_man, player_woman | man_base | kerry-eurodyne | `synced__player__stand__idle__01` | `synced__kerry__stand__idle__01` | 30 | resource | fit | none | yes |
| `kiss_judy_chair` | kiss | player_man | woman_base | judy-alvarez | none | `sq030__judy__sit_chair__try_kissing__01` | 8 | resource | hold | none | no |
| `kiss_wall` | kiss | player_man | woman_base | any | clip `synced__lean_wall_female_kiss_player__01_man_player` | clip `synced__lean_wall_female_kiss_player__01_female_average` | 7 | offset | hold | none | no |
| `kiss_pool_table` | kiss | player_man | woman_base | any | clip `synced__v_kiss_pool_table__01` | clip `synced__v_kiss_pool_table__01` | 8 | resource | hold | table | no |
| `car_hood_panam` | lie | player_man | woman_base | panam-palmer | `mq052__player_male__synced__panam_v_lie_on_car_hood__01` | `mq052__panam__synced__panam_v_lie_on_car_hood__01` | 50 | resource | fit | car | no |
| `cliff_panam` | sit | player_man, player_woman | woman_base | panam-palmer | `q114__synced__player__sit_cliff__embrace__01` | `q114__synced__panam__sit_cliff__embrace__01` | 50 | resource | fit | ledge | no |

Where the candidates come from:

* `hug_judy`, `hold_judy`: the convoy scene of the epilogue (q202_05), Judy and V on open ground, standing, no prop.
* `cuddle_kerry`, `cuddle_river`, `lap_judy`, `lap_woman`: the apartment hangouts and the lounge scenes (mq055, mq053). The Kerry and River cuddles have idle halves (`mq055__kerry__synced__hangouts_cuddle_with_player_idle__01`, `mq055__river__synced__hangouts_cuddle_with_female_player_idle__01`) that the loop may need. The lap rows lie across V on a seat.
* `sit_ground`, `lie_ground`: two separate single actor workspots side by side on open ground, so they work for every rig. The partner half is the generic one, V's half is the player's own.
* `close_kerry`: Kerry and V standing close in the premiere scene (sq017_18).
* Kept for the record and never offered (`offer = false`): `kiss_judy_chair` (only Judy's half is known and it sits on a chair), `kiss_wall` and `kiss_pool_table` (clip names of the game's kiss animations as other tools list them, `synced__lean_wall_female_kiss_player__01_*` and `synced__v_kiss_pool_table__01`, with no known workspot that lists them), `car_hood_panam` (needs a car), `cliff_panam` (needs a ledge). The Somi hand holding and Songbird embrace pairs of the expansion belong to a character that is not a romance partner.

## 6. Building the device

`scripts/Build-GestureAssets.mjs` reads the pair table and, for each offered row whose two halves are in the archive listing and were extracted, copies each half's workspot under `cyberpunk_convai\gestures\convai_romance_<name>` with the plain neutral face and adds a component `convai_romance_<id>_v` and `convai_romance_<id>_n` to `convai_gesture_device.ent`. A row with a half that is not in the listing is skipped with a warning (not a failure), and the generated catalog lists `romance.built` and `romance.skipped`. The controller never plays a component the device lacks: before every entry it asks the spawned device for the component by name (`native.hasComponent`), because a wrong name is not a quiet no-op in the engine.

The archive has to be rebuilt and `gesture-catalog.lua` regenerated on a PC with the game data (docs/COMPANION_GESTURES.md, the build steps). Until then the device has no romance components, every row is skipped as `component-missing`, and a request ends with a notice and nothing moves.

## 7. When a row fails

A row that fails in the game is skipped for the session, written to the developer log (Developer mode, line `Romance row-failed {"row":...,"reason":...}`), and the next choice is tried, at most three per request: another row of the kind, then the fallback kinds. Reasons: `component-missing` (the device lacks it), `play-refused` (the call raised or returned an error), `not-entered` (one of the two is not inside the workspot 1.2 s later, which is what a path or entry the game does not have looks like), `device-not-spawned`, `device-missing`, `no-device-template`. Placement is not a failure: `placement` lines say a row moved to the offset. When nothing is left the request ends cleanly (`end` with reason `no-row`), V and the partner are put back, and V gets a notice.

## 8. Check for a local agent (WolvenKit, game files)

For each row of `mod/romance-pairs.lua`:

1. Open both halves in the game archives. Confirm the path exists. Fix the depot path in the table if not, and find the real one with the archive listing (`scripts/` build inputs).
2. Which rig does each half use (player male, player female, `woman_base`, `man_base`, `man_big`)? Set `vRigs` and `npcRigs` to exactly that. A V half made only for a male V must not list `player_woman`.
3. List the entries (`animName`) of each half's sequences. If a half has a separate intro and loop, put the intro in `jump` and the loop in `loop`, with `loopEvery` as the loop's length. If the first sequence already loops, leave `jump` empty.
4. Read the root positions of the two halves. If they share a root (a synced quest workspot), keep `placement = 'resource'`. If they do not, use `'offset'` and measure the `offset` (forward, right in metres, yaw in degrees) from the roots.
5. Does the clip assume a prop (a sofa, a bed, a car hood, a ledge)? Put it in `needs`. A prop free clip has `needs = nil`.
6. Check that nothing in the clip is a weapon draw, a handshake for a camera, a step or a turn that moves the actors away from the device. Mark the row `offer = false` with the reason in `note` if so.
7. For the kiss: find the workspot that lists the kiss entries (or build one, like the talk families of `Build-GestureAssets.mjs`), fill `kiss_wall` with real halves, remove `offer = false`.
8. Set `verified = true` and correct `hold`. Run `node --test bridge/romance-anim.test.mjs` (the table test accepts verified rows). Rebuild the archive with `scripts/Build-GestureAssets.mjs` and check its `romance` lines.

## 9. Live check for the owner

Needs the rebuilt archive and a CET reload (Lua) and a game restart (the new redscript `RomanceConfirm.reds`). Developer mode on, to read `probe.log` for `Romance` lines.

1. Settings > Companions: **Romance animations** is on by default. Turn it off, talk to a partner and say "give me a hug": no question, nothing. Turn it on again.
2. With Judy as a partner (or any character V is together with) standing about 2 m away on open ground, no fight, no car: say "give me a hug". After her reply a box asks "Hug Judy?". Cancel: nothing moves. Ask again and Confirm: the screen blinks, V and Judy hug, the screen blinks, both stand where they stood. Read the log lines `asked`, `entered` (mode `resource` or `offset`), `end` (reason `done`).
3. During a hug, speak so that she answers: she should step out of it and answer standing (short pair). During "sit with me" she may answer sitting and the lips should move.
4. Ask for each kind with each partner you have (the matrix in section 4 says what plays). Note for each: do the two bodies line up (hands and faces where they should be), does the loop run, does the exit leave no one floating, does V stand at the saved spot. Send the log lines `placement` and `row-failed`.
5. Ask for a kiss: the question must say that a hug (or sitting) is offered instead, until the kiss row exists.
6. Gates: ask in a fight, in a car, in a scene, with the menu open, with a non partner (a friend), with a game-placed character: no question each time (a notice, or nothing for the non partner). Walk 6 m away and ask: "too far away".
7. Start a pair and begin a fight (or have an enemy see you): both leave the pair, no one is stuck in a pose. Start a pair and dismiss the partner, fast travel, or load a save: no leftover device, the player moves normally.
8. From Current party, pick a kind, close the menu: the question appears after the menu closes. Pick Stop during a pair: it ends.
9. FPS: with no pair, frame times are the same as before. During a pair, nothing but the half second watch (check with the developer frame timing).

## 10. Limits and decisions

* A tracked job alone is not a mission here. A mission is a scene tier above 1, a dialogue, a call, a fight, or a bond quest stage in play. If the owner wants a stricter rule, `options.blocked` in `mod/init.lua` is the one place.
* The seat and bed clips (`needs`) wait for a way to confirm a real seat or bed under V. The seating controller knows when V sits (docs/COMPANION_SEATING.md), a later step can offer lap cuddles there.
* English is read in talk. The other fourteen languages ask from the list. Adding a language is a row of patterns in `bridge/romance-anim-intent.mjs`.
* V cannot be steered while in the workspot. The pair ends by its hold time, by Stop, by danger or by V asking in talk. The talk request is read while the window is armed (90 s after a private turn with a partner).
* The question is the game's message box, which needs the new redscript. Without it (an old script install) no question can be shown, so nothing plays.

## 11. Files

* new: `mod/romance-pairs.lua` (the table), `mod/romance-anim.lua` (the controller), `r6/scripts/CyberpunkConvai/RomanceConfirm.reds` (the question), `bridge/romance-anim-intent.mjs`, `bridge/romance-anim-requests.mjs`
* changed: `mod/gesture-workspot.lua` (PlayInDeviceSimple, component lookup, teleport, blink, pose, player rig), `mod/init.lua` (the do-block, the arm calls, the tick, the body owner hooks), `mod/companions.lua` (`ownEntryFor`, `ownEntries`), `mod/manager.lua` and `mod/manager-ui.lua` (the setting, the list), `scripts/Build-GestureAssets.mjs`, `bridge/convai-bridge.mjs`, `packaging/runtime-exchange.json`, `packaging/release-plan.json`, `scripts/development-files.json`, `localization/en.json` and the 15 locale files
* tests: `bridge/romance-anim.test.mjs` (the table, gating, the confirmation, the fallback, a failing row, placement, loops, talk requests, the clean exit), `bridge/romance-anim-bridge.test.mjs` (the intent, the request file, the wiring), `bridge/romance-anim-wiring.test.mjs` (the setting and the game wiring)
