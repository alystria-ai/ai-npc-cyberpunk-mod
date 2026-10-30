# Quest primitives: how a bond quest plays in the game

Branch `feat/quest-primitives` (worktree `wt-questprim`), 2026-10-29. This is the build of the gameplay half of [BOND_QUESTS.md](BOND_QUESTS.md) (section 21
lists the primitives, section 22 the build order, [BOND_QUEST_LINES.md](BOND_QUEST_LINES.md) holds the scripted lines). It sits on the pack runner of
[RELATIONSHIPS_AND_QUESTS.md](RELATIONSHIPS_AND_QUESTS.md) (phase 2). How to turn a quest into pack data is [QUEST_PACK_RECIPE.md](QUEST_PACK_RECIPE.md).
Nothing here has been seen running in the game: the status of each piece is in the table at the end.

## 1. The split

The **bridge** owns the quest: which stage is current, the gap, the choices, the timers, the endings, the history, all stamped with the game clock and
rolled back on an earlier save (the phase 2 runner, `bridge/bond-pack-runner.mjs`). The **game** executes the stage's primitives and reports what
happened. They talk through two small files in the mod's `runtime` folder, like every other feature:

```
bridge/bond-pack-runner.mjs  writes  runtime/quest-play.json    and  mod/quest-play.lua reads it   (the stage to execute, written when it changes)
mod/quest-play.lua           writes  runtime/quest-events.json  and  bridge/quest-link.mjs reads it (what the game saw, written when something happened)
```

* **Nothing per frame.** `mod/quest-play.lua` has one entry, `update(player, delta)`, called from the existing 0.1 s tick. With no quest it is a nil
  check. With a quest it runs its work at 1 s (presence at 10 s), and the place watch reads V's position at 1 Hz only while a stage waits on a place and
  V is in that place's district, 0.2 Hz farther away. The play file is read at 1 Hz while a quest is armed, and once at session start.
* **Latency.** No quest adds a model call to a turn. A turn carries one more short volatile note (the stage's and an open gap's, 600 characters at
  most). A scripted line is a request with no model: it starts as fast as the renderer can start prepared audio.
* **One cleanup owner.** `mod/quest-play.lua` holds a `ctx` per active quest. Every spawn, pin, timer, lock and tagged entity a primitive makes is
  registered on it, and `ctx:reap()` removes them LIFO on a stage end, an ending, a failure, a load, the setting going off and the quest being
  rolled back. Spawns carry the tag `CyberpunkConvaiQuest` and the quest's own tag, and the tag is swept once at session start. Entity handles are
  never cached across ticks (an entity id is kept and looked up each time, and used only when `IsAttached()`).
* **Game characters.** A quest moves, seats, arms or drives only the mod's own copies and its own tagged spawns. A game-placed character gets talk,
  face and audio only.

## 2. Format 2 (pack data)

`format: 2` is `format: 1` plus the fields below. Format 1 packs run unchanged. All new fields are optional. `bridge/bond-packs.mjs` validates them with
the registry in `bridge/quest-primitives.mjs`.

```jsonc
{
  "format": 2, "id": "panam-sunset-coffee", "character": "panam-palmer", "title": "...", "requires": {...}, "start": {...},
  "places": {                         // fixed places, captured in game (the developer probe `quest capture:<id>`), shipped with the pack
    "sunset": {"name": "the Sunset Motel forecourt", "x": 0, "y": 0, "z": 0, "radius": 25, "district": "RockyRidge", "captured": false}
  },
  "lines": {                          // every scripted line; English only (owner decision 29 Oct)
    "P1.walk.01": {"text": "You actually came...", "emotion": "happy", "gesture": "happy", "channel": "own", "audio": "audio/P1.walk.01.wav"}
  },                                  // channel: own (in person, default) | holocall | head (Johnny in V's ear) | remote (a copy's voice in V's ear)
  "gaps": {
    "g1": {"asks": "So. If you weren't running jobs ... what would you be doing right now?",   // the question she just asked (for the note)
           "know": "...", "secret": "...", "wants": "...",                                      // together at most 600 characters in the note
           "idle": "seat",                                                                      // a seat kind or a gesture workspot key (game side)
           "tags": [{"id": "shared", "kind": "honest"}, {"id": "light", "kind": "flatter"}],   // read from V's words (bridge/bond-intent.mjs)
           "resumeAfterSeconds": 600,                                                          // game seconds, never stalls
           "resumeOn": ["together:sunrise:done"]}                                              // event names (section 3) that also end it
  },
  "stages": [{
    "id": "walk", "type": "play",                    // type play: the game executes `do`
    "know": "...", "wants": "...", "label": "...",   // the talk side, exactly as in format 1
    "do": [ {"p": "party"}, {"p": "place", "at": "lookout"}, {"p": "together", "id": "tour", "minutes": 20, "metres": 5} ],
    "script": [                                      // rows: when an event fires, do one thing
      {"when": "stage:enter",            "say": "P1.walk.02"},
      {"when": "place:lookout:arrived",  "say": "P1.walk.03"},
      {"when": "line:P1.sit.01:done",    "gap": "g1"},
      {"when": "event-name",             "text": "P1.sunrise.01", "image": "sunset-coffee"},
      {"when": "gap:g1:shared",          "event": "some:follow-on"}
    ],
    "choices": [{"id": "walked", "on": "event:together:tour:done", "next": "sit"}],   // `on` may now be event:<name>
    "timeout": {"gameHours": 3, "next": "cold-coffee"}
  }],
  "endings": {"left": {"memory": "...", "bond": 15, "history": "A lasting line, 200 characters at most", "script": [{"when": "ending:left", "say": "P1.left.01"}]}}
}
```

Rows fire **once per stage visit**, in file order, when the event of `when` happens. A row does one of: `say` (a scripted line is spoken), `text` (a Phone
Chat message from the character, optionally with `image`, a picture key of the pack), `gap` (opens the talk gap), `event` (fires another event).
`ending:<id>` rows live in `endings[id].script` and run when the ending is reached. A `say` line must exist in `lines`. The stage's `know` and `wants`
stay the talk side: while the stage is current they are the volatile note, plus the open gap's note.

## 3. Events

An event is a lowercase string of letters, digits, `:`, `-`, `_` and `.`. The game reports world events; the bridge reports the ones it decides (a tag read
from V's words) and sends them back to the game as commands, so one table of rows serves both. A `choice` with `"on": "event:<name>"` moves the stage when
that event arrives for the current stage (events carry the stage's `serial`, so a late event of an earlier stage is dropped).

| Event | From | Meaning |
|---|---|---|
| `stage:enter` | game | the game began executing this stage (fires at once, also after a load, only the first time per stage visit) |
| `place:<id>:arrived` / `place:<id>:left` | game | V within the place's radius (with the dwell, if any) / V left it after arriving |
| `together:<id>:done` / `together:<id>:broken` | game | the presence timer ran out / V and the copy were apart for `breakSeconds` |
| `seat:seated` / `seat:stood` | game | V and the copy are both seated / one of them stood |
| `cast:<id>:arrived` | game | the cast member stands at its place |
| `ride:arrived` / `ride:checkpoint:<place>` / `ride:timeout` | game | the drive's events |
| `squad:<id>:spawned` / `:hostile` / `:down` / `:fled` | game | a squad's events |
| `timer:<id>` | game | a `timer` primitive ran out |
| `line:<lineId>:done` | game | a scripted line finished (heard to its end, or shown and dismissed) |
| `gap:<id>:open` | game | the gap opened (the bridge starts adding its note to V's turns) |
| `gap:<id>:resume` | game or bridge | the gap ended by its timer or a world event (`resumeOn`) |
| `gap:<id>:<tag>` | bridge | the gap ended by a tag read from V's words (the bridge also sends `gap:<id>:resume`) |
| `meet:met`, `meet:stood-up` | bridge | the existing appointment outcomes |
| `ending:<id>` | bridge | the quest reached this ending |

## 4. The files

### `runtime/quest-play.json` (bridge writes in place, game reads)

```jsonc
{"version": 1, "revision": 17,           // bumps when anything below changes
 "quests": [{
   "pack": "panam-sunset-coffee", "character": "panam-palmer", "stage": "walk", "serial": 3,   // serial grows with every stage entry of this quest
   "since": 123456,                      // game seconds the stage began; the game ignores a quest stamped later than the loaded save's clock + 120 s
   "places": {"sunset": {"x": 0, "y": 0, "z": 0, "radius": 25, "district": "RockyRidge"}},      // only places this stage uses
   "do": [...], "script": [...],         // the stage's, as in the pack
   "lines": {"P1.walk.02": {"kind": "say", "emotion": "emphatic", "gesture": "talk", "channel": "own"}},   // referenced lines; a `text` line also carries "text" and "image"
   "gaps": {"g1": {"idle": "seat", "resumeAfterSeconds": 600, "resumeOn": ["together:sunrise:done"]}},
   "gap": null                           // or {"id": "g1", "openedAt": 123500}: restore after a load
 }],
 "closing": [{"pack": "...", "character": "...", "ending": "left", "serial": 4, "script": [...], "lines": {...}}],   // an ended quest's ending rows, kept for 5 minutes of real time
 "commands": [{"seq": 5, "pack": "...", "serial": 3, "cmd": "event", "name": "gap:g1:shared"}]               // bridge-decided events; the game acts once per seq
}
```

### `runtime/quest-events.json` (game writes in place, bridge reads at 500 ms only while a quest is active)

```jsonc
{"version": 1, "session": "k3j2h1g0", "seq": 42,                       // session: random per game start; seq: the newest event's number
 "events": [{"seq": 41, "pack": "panam-sunset-coffee", "serial": 3, "name": "place:lookout:arrived", "at": 123500}]}   // the last 32 events
```

The bridge keeps the highest `seq` it handled per `session`; an event for a pack or serial that is not current is dropped. `at` is the game clock.

### The scripted line request (game -> bridge, the ordinary `runtime` request file)

`reaction = {kind: 'scripted', pack, line, channel, expiresAt}` on a private turn of the speaking character (`profileKey`, `entity` of the copy). `text` is a
placeholder. The bridge checks that `pack` is active (or closing) and that `line` is one of its lines, takes the text and the prepared audio from the pack
(never from the request), and answers like any reply. No model is asked. With audio (`lines[id].audio`, a PCM `.wav` inside the pack) the reply is
voiced by `bridge/prepared-voice.mjs` through the same renderer, lease, face model and subtitles as a live reply, whatever voice the player chose. A line
whose file is missing (or cannot be decoded) is never given to the live voice, in any mode: it is shown as a subtitle and a Phone Chat line, and an error is logged once per
line (`[QuestLines] ERROR pack=... line=...`). The reply carries `missingAudio: true` for the game. A prepared file may be WAV, or Ogg Opus, Ogg Vorbis, FLAC or MP3: those are
decoded by `bridge/prepared-audio.mjs` (ffmpeg on the machine, else the Runtime's Python with soundfile; the Runtime ships neither guaranteed, so a shipped pack uses WAV unless one
of them is there) and the decoded samples are cached.

## 5. One voice at a time (game side, `mod/quest-lines.lua`)

A one-slot queue per character, the rules of BOND_QUESTS section 14.5: a line never starts while V talks (talk key held, composer open with text), while
any reply is produced or heard, or while an automatic remark plays (Johnny, speak-ups, battle remarks, loot, housemate chats). A bark waits at most 4 s,
a plot line waits and is shown as a subtitle after 20 s and played at the next silence. A live reply V asks for while a line plays is generated at once and
heard after it. The speak-up scheduler and every automatic remark treat an open gap and a line in progress as busy. Scripted lines are recorded in the
character's memory as her own words after they play (a synthetic exchange).

## 6. Status of each piece

"Offline" means unit tests on a fake game or a fake bridge. "Live" is what only the game can show (the numbered list is section 8).

| Piece | Where | Status |
|---|---|---|
| Format 2 validator (places, lines, gaps, images, calls, `do`, `script`, music, sfx, situations, event choices, history, shares, gate-plus, kind and hangout) | `bridge/bond-packs.mjs`, `bridge/quest-format.mjs`, `bridge/quest-primitives.mjs` | built, offline. Every name of the catalogue is a primitive or has a place in a pack (`CATALOGUE`, `bridge/quest-catalogue.test.mjs`) |
| Runner: events with data, gap (note, tags from V's words, restore), history, stage timeout, closing rows, `lineFor`, play file, commands, hangouts (repeat, caps, offers), reach-outs, gifts, pay, facts, memory share | `bridge/bond-pack-runner.mjs`, `bridge/quest-link.mjs`, `bridge/quest-poller.mjs` | built, offline |
| `line`: prepared audio (WAV, and Ogg Opus, Vorbis, FLAC, MP3 through ffmpeg or the Runtime Python) through the renderer, subtitle plus Phone Chat line plus a logged error when the file is missing, never the live voice | `bridge/prepared-voice.mjs`, `bridge/prepared-audio.mjs`, `bridge/quest-lines.mjs`, `runScriptedTurn` in `bridge/convai-bridge.mjs`, `convaiQuestMissingAudio` in `mod/init.lua` | built, offline. Compressed audio needs a decoder on the player's machine (not shipped), otherwise ship WAV. Precomputed face rows are not used (the live face model runs on the audio) |
| `line` on the game side: queue, one voice, bark and plot rules, the request, call lines | `mod/quest-lines.lua`, glue in `mod/init.lua` | built, offline. Rule 2 of section 5 (a live reply heard after the line) is not built: V talking cancels the line and a plot line is replayed |
| `gap`: open, note, resume by tag, timer, event or command, the `idle` pose and `situation` | `mod/quest-lines.lua`, runner, `mod/quest-world-scene.lua` | built, offline. The pose is played through the gesture device (known idle and seat components, `situation` picks an idle). A seat kind is left to the seating code. Unverified |
| `place`, `pin` | `mod/quest-places.lua`, `mod/quest-world.lua` | built, offline. The map pin and the ground ray are unverified |
| `text` (Phone Chat message, with a picture row) | `mod/phone-chat.lua` `deliverScripted` | built, offline. The picture needs the pack picture archive (`scripts/Build-PhoneImages.ps1 -Packs`, built, dry run tested, the WolvenKit cook not run) and the PNGs |
| `call-in`, `call-script`, the pack's `calls` | `mod/quest-prims-calls.lua`, `mod/quest-world-calls.lua`, `mod/holocall.lua` | built, offline. An incoming call started by the mod (ring until V picks up) is unverified, V can only let it ring out (the redscript reports a tap and a hold as hang up), the text fallback is always there |
| `timer`, `party`, `together`, `seat`, `cast` | `mod/quest-prims.lua` | built, offline. A cast copy of a character is placed through the party queue as a visitor and joins V's party in a `party` stage. Unverified |
| `squad`, `hostage` (floor form), `escortee` | `mod/quest-prims-action.lua`, `mod/quest-world-action.lua` | built, offline. All natives unverified. The kneel form of hostage, squad vehicles and patrol points are not built. A squad honours `squad:<id>:stand-down` (hold-until) |
| `ride`, `remote`, `runner`, `tail`, `check` | `mod/quest-prims-drive.lua`, `mod/quest-world-drive.lua` | built, offline. `check` also reads district and radio. `runner` and `tail` use a neutral chase car record made at runtime (`mod/quest-tweak.lua`) |
| `post` | `mod/quest-prims-drive.lua`, `mod/companion-tactics.lua` | built, offline. It fights from its spot: `post:<id>:fight` or `fightFrom` raises her reaction preset and holds her move orders. Whether the preset alone makes her shoot is unverified |
| `race`, `convoy` | `mod/quest-prims-race.lua`, `mod/quest-world-race.lua` | built, offline. A copy driving her own spawned car and a column of cars are unverified (the riskiest piece). `convoy` falls back to the lead alone with `fallback` |
| `bout`, `hold-until`, `apart`, `unseen`, `dead-zone`, `workspot`, `npc-react` | `mod/quest-prims-scene.lua`, `mod/quest-world-scene.lua`, `mod/npc-reactions.lua` | built, offline. `bout` falls back to a staged scene when a real one cannot be armed. `workspot` plays the known poses and falls back to an idle for the rest (guitar, dance, lie-back, kneel, mechanic, cook, weights, prone-rifle: no path known). `npc-react` listens to an outcome sink in the NPC reactions module. All natives unverified |
| `pay`, `gift`, `garage`, `memory-share`, facts | `mod/quest-prims-systems.lua`, `mod/quest-world-systems.lua`, `mod/quest-facts.lua`, `bridge/quest-pay.mjs`, `bridge/gift-tables.mjs`, `bridge/gift-intent.mjs`, `bridge/quest-facts.mjs` | built, offline. `garage` changes the save and is unverified. Item ids, the inventory read and the fact names are unverified. The gift ids must pass the in-game check (`quest gifts`) before a pack uses them |
| Custom TweakDB records (a gift item, a chase car) | `mod/quest-tweak.lua` | built, offline. `TweakDB:CloneRecord` from a vanilla base, then `SetFlat`, once, guarded, idempotent across reloads. No TweakXL. Unverified: the flat names |
| `reach-out` ("Characters text first", on by default with Story packs) | `bridge/reach-outs.mjs`, `characters/reach-outs/*.json` (124 triggers), `mod/quest-reach.lua` | built, offline. The 73 triggers of the catalogue's 86 that could be expressed (the rest are listed in the captain's log), plus 51 more: one invitation for each of the 50 hangouts, and Jackie's "after a hangout" text. Johnny's voice delivery is a caption only |
| `hangout` | runner, `kind: "hangout"` packs | built, offline. No hangout pack is written yet (the registry of 50 is in BOND_QUESTS.md) |
| `gate-plus` (`facts`, `before`, `notBegun`, `window`, `unfinishedWhen`, the Songbird arc) | `bridge/bond-packs.mjs`, `bridge/quest-facts.mjs`, `bridge/bond-arcs.mjs` | built, offline. The fact names and the freed-branch journal paths are placeholders to check against a save |
| `music`, `sfx` | `bridge/media-*.mjs`, `mod/quest-audio.lua`, `mod/quest-world-audio.lua` | built, offline, plus one headless browser test of the media page. Pack files play on a media page of the hidden browser (own AudioContext, ducked under speech). `radio:` and `game:` sources are played by the game. Every native and every game event name is unverified. Convai's cloud voice does not duck the music by itself |
| `history` | runner, `forgetHistory` on a memory reset | built, offline |
| `image` | row field, picture table, `phone-chat.lua`, `scripts/Build-PackImages.mjs` | built, offline |
| Developer probe (`status`, `capture:<place>`, `event:<name>`, `line:<pack>:<line>`, `reach`, `gifts`, `reap`) | `mod/quest-probe.lua`, `scripts/Send-JohnnyProbe.ps1 quest` | built, offline, Developer mode only |
| Not built | | the kneel form of hostage, squad vehicles and patrol points, a fixed route chauffeur as its own primitive (a quest drive is `ride`, `race` or `convoy`), the rest of the 86 reach-outs, a pure JavaScript Opus decoder, the pocket radio, ducking of game sounds |

The pilot quest is P1 "Coffee at the Sunset", `characters/bond-packs/panam-sunset-coffee.json` (tests: `bridge/quest-pilot-panam.test.mjs` through the runner and the link,
`bridge/quest-pilot-lua.test.mjs` through the real game modules). It is in the repository folder of the shipped packs but NOT in `packaging/release.config.json`, so no
package carries it until its places are captured and its lines have audio.

## 7. Install the build over the 2.5 game for a live test

Close the game first. Nothing here touches `mod/diagnostics.lua`. The game is a player install: the bridge runs from the Runtime's `app\`, so the bridge files go there.

| From the repository | To |
|---|---|
| `mod/*.lua` that changed: `bonds.lua`, `companion-tactics.lua`, `holocall.lua`, `init.lua`, `manager.lua`, `manager-ui.lua`, `npc-reactions.lua`, `phone-chat.lua`, `companion-seating.lua`, `johnny-probe.lua`, the 15 files of `locales/`, and the new `quest-world.lua`, `quest-world-action.lua`, `quest-world-drive.lua`, `quest-world-race.lua`, `quest-world-scene.lua`, `quest-world-systems.lua`, `quest-world-calls.lua`, `quest-world-audio.lua`, `quest-places.lua`, `quest-prims.lua`, `quest-prims-action.lua`, `quest-prims-drive.lua`, `quest-prims-race.lua`, `quest-prims-scene.lua`, `quest-prims-systems.lua`, `quest-prims-calls.lua`, `quest-audio.lua`, `quest-facts.lua`, `quest-reach.lua`, `quest-tweak.lua`, `quest-lines.lua`, `quest-play.lua`, `quest-probe.lua` | the CET folder `bin\x64\plugins\cyber_engine_tweaks\mods\AiNpcCyberpunkMod\` |
| `r6/scripts/CyberpunkConvai/PhoneChat.reds` | `r6\scripts\CyberpunkConvai\PhoneChat.reds` (only needed for the picture row, the game recompiles at start) |
| `bridge/bond-pack-runner.mjs`, `bond-packs.mjs`, `bond-arcs.mjs`, `bonds.mjs`, `convai-bridge.mjs`, `protocol.mjs`, `custom-voice-clip.mjs`, `local-pcm-host.mjs`, `realtime-host.mjs`, `prepared-voice.mjs`, `prepared-audio.mjs`, `media-engine.mjs`, `media-host.mjs`, `media-link.mjs`, `media-mix.mjs`, `media-pcm-client.mjs`, `media-request.mjs`, `quest-lines.mjs`, `quest-poller.mjs`, `quest-link.mjs`, `quest-format.mjs`, `quest-primitives.mjs`, `quest-facts.mjs`, `quest-pay.mjs`, `gift-tables.mjs`, `gift-intent.mjs`, `reach-outs.mjs` | the Runtime's `app\bridge\` (see `packaging/runtime-layout.mjs`; the three browser files `media-engine.mjs`, `media-mix.mjs`, `media-pcm-client.mjs` are client modules, `packaging/release.config.json` `clientModules`) |
| `characters/reach-outs/*.json` (10 files) and `characters/gift-tables.json` | the Runtime's `app\characters\` folder (reach-outs read there, gift tables are the allowlist) |
| `characters/bond-packs/panam-sunset-coffee.json` | the folder that holds `panam-truck-ransom.json` in the installed Runtime |
| `scripts/Send-JohnnyProbe.ps1` | used from the repository, not installed |

Never copy `mod/diagnostics.lua`. Restart the bridge (the service) after copying. Undo afterwards by restoring the shipped copies of the same files.

## 8. Live checks (do X, check Y)

Setup: Settings, Gameplay, Character bonds and Story packs on, Immersive invitations on, Developer mode on for the probe. Panam in the roster, bond 3 or more with her, `q104_02_av_chase` finished
in the save. The probe is `scripts/Send-JohnnyProbe.ps1 quest <action>`.

1. Stand at the Sunset Motel forecourt in Rocky Ridge. Run `quest capture:sunset`. Walk to the lookout behind it. Run `quest capture:lookout`. Check `runtime/quest-place-capture.json` holds both with x, y, z, a radius and the district.
2. Talk to Panam in person (or text her) until she brings up the coffee. Check the bridge log says `pack=panam-sunset-coffee started`, `runtime/quest-play.json` exists with stage `invite`, and a text from Panam ("Motel coffee tastes like engine coolant...") is in her Chat thread.
3. Open the map. Check a pin sits on the motel forecourt. Save, load the save. Check the pin is there again (it must be registered again after a load).
4. Drive toward Rocky Ridge, no closer than 200 m. Check no copy of Panam is there. Come within 150 m. Check her copy appears at the motel (standing, not in the road).
5. Walk into the forecourt. Check she greets V with "You actually came. Here. It's terrible, drink it anyway." The audio does not exist yet, so check it appears as a subtitle and as a Phone Chat line from Panam, the log has one `[QuestLines] ERROR` line for it, it is never spoken by the live voice, the pin disappears, and the log shows `place:sunset:arrived` then stage `walk`.
6. Walk around with her for 20 game minutes (a time skip is fine if you stay close). Check she follows as a party member, says the tour line at the start and the lookout line when you reach the lookout, and stage `sit` starts after about 20 game minutes.
7. In another run walk more than 20 m away from her for 90 seconds. Check the quest ends with "Leaving already? Fine. Next coffee's on you." and her bond rises by the `left` amount (15).
8. In the `sit` stage sit on the motel bench or couch. Check she sits too and says "Sun's coming. Shut up a minute, this is the good part." Check the log shows `seat:seated` and `gap:g1:open`.
9. While the gap is open, talk to her. Check she answers with her question in mind (what V would do if V were not running jobs) and holds back that she is pleased. Say something real and long. Check the short line "Huh. Didn't figure you for that." is spoken, the log shows `gap:g1:shared`, and the stage becomes `last-sip-warm`. Repeat in another run with a bare "nice view": check `gap:g1:light`.
10. While a scripted line plays, hold the talk key or type in the composer. Check the line does not play over V, and a waiting line shows as a subtitle after about 20 seconds.
11. Leave the forecourt. Check the ending runs: a text from Panam arrives ("Proof the view was worth it."), the bond goes up by 45 (55 with the warm answer), and her next talk mentions the motel mornings (the history line).
12. A new save: start the quest and never go to the motel. Check after 3 game hours the cold-coffee ending: the text "Drank both coffees. You owe me." and the bond drops by 5.
13. Start the quest, load an earlier save. Check the next turn's log rewinds or forgets the quest, the pin and her cast copy are gone, and the play file has no quest.
14. Turn Story packs off in the middle of a stage. Check the pin and the cast copy are removed and no quest line appears afterwards.
15. FPS: in a crowd, with the quest in the `walk` stage and with it off, compare the counter. Check there is no difference. With no quest active check `runtime/quest-events.json` is not rewritten and the bridge log shows no quest polling.
16. Probe checks: `quest status` lists the armed quest, `quest event:place:sunset:arrived` moves it on without walking, `quest line:panam-sunset-coffee:P1.walk.02` plays one line, `quest reap` removes everything. Check each does what it says.
17. Picture row (needs the picture archive built as in `docs/PHONE_IMAGES.md` and a `sunset-coffee` PNG, otherwise skip): check the sunrise text arrives with the picture under the caption, and as text only without the archive, with no crash.
18. The other primitives (squads, hostages, escorts, rides, runners, posts) have no quest to play yet. To try one, copy the pilot and put one in a `do` list, or inject events with the probe. Check a squad of 4 spawns only after you come within 150 m and out of sight, turns hostile on `squad:<id>:go`, counts down when defeated and is removed on a stage change. Check FPS with a full wave on screen against the same scene without it.

Round 2 (checks 19 to 52). Setup as above, plus: the round 2 files installed (section 7), Developer mode on, and a throwaway pack copied from the pilot with the primitive under test in a `do` list (the probe injects the events a stage waits for: `quest event:<name>`). Every native here has never run, so each check says what a pass looks like. When a check fails, copy the `Quest` lines of the log and the `runtime/quest-*.json` files into the report.

19. Settings, Gameplay: check a switch "Characters text first" sits beside Story packs and is on. Turn it off, check the play file's `reach.enabled` becomes false and nothing below arrives. Turn it on again.
20. Reach-out by time: set the game clock inside a trigger's hours (a Panam night text needs bond 6, so use a character at the right level, or edit a copy of her file), wait up to 60 seconds with the phone closed. Check one text from her arrives in her Chat thread with a notice, `reach:<id>` is in `runtime/quest-events.json` and the file has a top-level `at`. Reply to it. Check her answer knows why she wrote (the trigger's note).
21. Reach-out caps: let a second trigger become due within the same game hour. Check it waits until the next game hour, and that no more than 3 arrive in one game day. Check none arrives in a fight, a scene, a game call or a chase, and that it arrives afterwards.
22. Reach-out moments: change district into a trigger's district, and end a fight. Check the matching trigger fires once, with no 60 s wait. Check the `healthBelow` and `heatAtLeast` fields are honoured (a fight ended at full health does not fire a `healthBelow` trigger).
23. Missing audio: play any scripted line with no audio file. Check the subtitle appears, a Phone Chat line from the speaker appears once, the live voice does not speak it, and the log has one `[QuestLines] ERROR pack=... line=...`.
24. Compressed audio: put an `.ogg` file under a line (`audio/<id>.ogg`, 24 kHz mono is best) in a copy of the pilot, on a machine with ffmpeg. Check it plays like a WAV, the second play is quicker (decoded cache in the bridge state folder `prepared-audio-cache`), and without ffmpeg and without the Runtime Python the line falls back to the subtitle with a clear error.
25. Call-in: give a stage a `call-in` (ringSeconds 20) with a two-line call. Check the phone rings with the character's name, the call window opens on pick up, the lines play at full level centred, a gap step waits for V to talk, the call ends by itself and `call:<id>:done` is logged.
26. Call-in, not answered: let it ring out. Check `call:<id>:missed` then `call:<id>:texted`, the call's text arrives in Chat, and calling her afterwards plays the same call (`call-script`). Hang up in the middle once: check `call:<id>:hung-up` and the `onHangUp` event.
27. Call safety: start a game call or a scene, then trigger a `call-in`. Check it waits and rings only afterwards.
28. Music file: a stage with `music` `file:music/<x>.ogg` (loop true, fadeIn 2, duck true). Check it fades in from the media page, ducks while anyone speaks and recovers, stops on its `stop` event with the fade, and stops with the stage and with the quest ending. Check the game's own music and the voice are unchanged, and speech latency is the same as without it (stage clock).
29. Music from the radio: in a car, `music` `radio:<a station>`. Check the car radio switches to it, and goes back to the previous station (or off) on the stop event. On foot check it does nothing and logs once.
30. Sound effects: an `sfx` with `file:sfx/<x>.ogg` and `at: bed` (loop), another `at: copy` one-shot, one `at: place:<id>` loop, one `game:ui_jingle_quest_new`. Check each plays, the copy one pans towards her, the place loop gets louder as you walk to the place and is silent beyond 60 m, and every loop stops with the stage.
31. Race: `race` from a start place to a finish place with her in her own car. Check her car appears when you are within 150 m, she sits in it, she waits for `race:<id>:go` (or the head start), drives, and the winner is announced by `race:<id>:won` or `:lost`. Check a wanted level voids it and `limitMinutes` ends it. Reversed: check standing still for 5 seconds loses.
32. Convoy: `convoy` with `lead: self`, `cars: 2`, a driver record, three places. Check the column forms at the first place, drives the legs in a line, raises `leg1`, `arrived`, loses one car when you destroy it (`lost-one`), obeys `reroute`, and with `fallback: true` carries on with the lead alone if the column cannot be driven. Check FPS with the column on screen against the same scene without it.
33. Chase car record: with `runner` or `tail`, check in the log the `Quest tweak` lines for the cloned record (created, flats set, read back), that a second stage or a script reload does not clone again, that the car has no police icon and can be boarded after a wanted level, and that a failed clone falls back to the vanilla record.
34. Post fight: `post` with `fightFrom` for her at a spot, then `post:<id>:fight`. Check she stays on her spot, shoots enemies that come into range and does not walk to them, and that release lets her follow again.
35. Bout: two cast fighters and a `bout` (3 rounds, floor 25). Check they use fists only, never touch you, a round event fires every round, a fighter at the floor stops the bout (`:b-down`, `:stopped`, `:ended`), neither dies. Then `staged: true`: check no one is hit and the winner is the `winner`.
36. Hold until: a `squad` of waves, a `hostage` and `hold-until` with hour = now plus 1 hour. Check the waves keep coming, at the hour the squad stands down and `hold-until:<id>:reached` fires, and the witness dying first gives `:failed`.
37. Apart: `apart` at a place (inner 10, outer 60, 2 minutes). Check staying between the radii counts game minutes, stepping inside 10 m or beyond 60 m raises `:near` or `:far` once, and 120 seconds outside gives `:broken`.
38. Unseen: a relaxed `squad` and `unseen`. Check walking past unseen reaches `unseen:<id>:reached`, and being noticed (or firing) raises `:spotted`.
39. Dead zone: `remote` plus `dead-zone`. Check her voice in your ear stops inside the place (`dead-zone:<id>:entered`, `remote:silenced`) and comes back outside.
40. Workspot: `workspot` with `smoke`, then `sit-ledge`, then `guitar`. Check smoke plays, the ledge sits her on the edge or falls back, and guitar emits `workspot:<id>:fallback` with a plain idle and the quest goes on. Switching poses must not show a T-pose.
41. Gap idle: open a gap with `idle: "panam"` and `situation: "nervous"`. Check her idle changes at the gap start only and returns when the gap closes.
42. NPC reaction: a cast extra, `npc-react`, and threaten or insult it in talk. Check `npc:<id>:leave`, `:attack`, `:cower` or `:brawl` is raised to match what it does, and a command ("get down") gives `:obey`.
43. Pay: a cast guard and `pay` (amount 100, min 60). Offer 50, then 70, then 100 in talk. Check the guard's note names the price, 50 gives `short` and takes nothing, 70 takes 70 and gives `paid`, V's balance falls by that, and with too little money you get `broke`. Check the request carries `quest` only for that cast member.
44. Gift received: a `gift` receive with a tier. Check the item arrives in the inventory with a notice, and giving it again does not repeat. Give V the item first, then check the `second` item arrives instead and `gift:<id>:second` is raised.
45. Gift given: say "I got you something" with a drink, a nomad shirt and a Tyger Claw item in the inventory, one after another, to Panam in a `gift` give stage. Check the item named is taken, she reacts by the tier (loved, liked, disliked), her bond moves by +8, +4 or -4 (only the first counts that game day), and naming something V does not have gives `gift:<id>:nothing`.
46. Gift ids: run `quest gifts`. Check `runtime/quest-gift-check.json` lists the ids missing from the game, and drop those from `characters/gift-tables.json` before any pack uses them.
47. Garage: on a save that does not own the car, a `garage` for a cheap vanilla vehicle first. Check it appears in the garage menu, the stage reports `garage:<id>:added`, running it again reports `owned`. Only then try Guinevere (Kerry's gift). This changes the save: use a test save.
48. Facts: with a pack that requires `takemura-alive`, check `runtime/quest-facts.json` is written once with the fact, is not rewritten while nothing changes, and the pack starts only when the fact is true. Find the real fact names from the log if it stays false.
49. Jackie window: with a Jackie pack open, finish The Heist. Check the pack goes to its `unfinished` ending (bond +0), and no new Jackie pack or reach-out starts afterwards. Before The Heist, check a pack starts while q003 or q004 is active but not tracked.
50. Hangout: start a hangout, finish it, start it again after 3 game days. Check the second run uses the next variation (another place), only one hangout starts per game day per character, and its bond counts into the cap of 20 for that character that day. Check being stood up costs 10.
51. Memory share: finish a quest whose ending has `share` to another character. Check that character brings it up in talk, and Forget clears it.
52. FPS and latency: with a reach-out block active, a media loop playing and a quest in a `race` stage, compare the FPS counter and a reply's latency (stage clock) with all of it off. Check no difference, and that with no quest, no reach items and no sound there is no timer: `runtime/quest-events.json` is not rewritten and the bridge log shows no quest polling.

## 9. Libraries that could make a primitive better (not added, for the owner)

The requirements today are CET, redscript, RED4ext, Codeware and ArchiveXL. Nothing below is used or added.

* **TweakXL** (custom records): NOT used, by the owner's decision of 29 Oct. Custom records (a gift item, a chase car without the police icon) are made at runtime by `mod/quest-tweak.lua` with CET's `TweakDB:CloneRecord` and `SetFlat`. Vanilla records need nothing.
* **A quest graph route (ArchiveXL plus WolvenKit questphases)** for a real journal entry, a gold route marker and objective text. For: native tracking and the road route line. Against: the owner chose mod-side state, an archive per quest is heavy, and our pins cover the map.
* **A choice hub library** for "press F to free the hostage" prompts. For: the standard interaction look. Against: the hostage is freed by standing close for a moment, which needs no prompt, and a new dependency is not worth one prompt.

## 10. Round 2: the contract between the bridge and the game

Round 2 (branch `feat/quest-primitives`, 2026-10-29) adds the primitives and systems that round 1 left out. This section is the contract the two halves are built to. Field names and event names of every primitive are in `bridge/quest-primitives.mjs`. Nothing here has been seen running in the game.

### 10.1 Data on events and commands

* A game event in `runtime/quest-events.json` may carry `data`: a flat object of at most 6 keys, each a number, a boolean or a string of at most 80 characters. The bridge hands it to the runner with the event.
* A bridge command in `runtime/quest-play.json` (`commands[]`) is `{seq, pack, serial, cmd: "event", name, data?}`. The game raises the event as if the world had, without reporting it back, and passes `data` to the listeners (`ctx:on(name, fn)` calls `fn(name, data)`).
* A turn request to an ordinary cast member of a quest carries `quest: {pack, cast}` (the pack id and the cast id) so the bridge can read V's words against what the stage waits for. The game adds it only when the target is a tagged cast spawn of an armed `pay` stage. It costs one field and, on the bridge, one regular expression after the reply.

### 10.2 Pay an NPC (`pay`)

The stage has `{"p":"cast","id":"guard",...}` and `{"p":"pay","id":"toll","to":"guard","amount":100,"min":60}`. While the stage is current, the volatile note of a turn to that cast member says what is asked (you want 100 eddies from V to let V through, you take 60 at the least). The bridge reads V's words after the reply (`bridge/quest-pay.mjs`, using the amount reader of Eddies) and sends the command `pay:<id>:offer` with `data: {amount}`. The game checks V's balance (`TransactionSystem`), takes the money if it is enough and raises `pay:<id>:paid` (the amount is at least `amount`, or at least `min` after a haggle), `pay:<id>:short` (less than `min`: nothing is taken), `pay:<id>:broke` (V does not have it) or `pay:<id>:declined` (V said no, sent by the bridge as an offer of 0 with `declined`). V is charged the smaller of the offer and the asking price, and must be within 15 m of the cast member. Eddies taken are never given back by the quest.

### 10.3 Gifts (`gift`)

Tables are `characters/gift-tables.json` (read by `bridge/gift-tables.mjs`): per character what she gives by tier (`item`, `second`) and what she likes from V (`loved`, `liked`, `disliked` rules). A rule is `{"prefix": "Items.Nomad_"}`, `{"id": "Items.X"}` or `{"contains": "Cop_"}`.

* **She gives (`dir: "receive"`).** The bridge writes the resolved `item` and `second` into the `do` entry of the play file (from `tier`, or the pack's own `item`). The game gives the item with `giveItem` after a quantity check, the `second` instead when V already has the first (`gift:<id>:second`), and raises `gift:<id>:given` or `gift:<id>:failed`. Each tier is given once per save: the bridge does not offer a used tier again.
* **V gives (`dir: "give"`).** The stage carries the character's `likes` rules in the play file (`gifts`). When V says it ("I got you something", "here, this is for you", in the 15 languages the Eddies screen reads), the bridge sends `gift:<id>:offer` with `data: {words}` (V's words trimmed to 80 characters). The game reads V's inventory once for gift-able kinds, matches the item V named, classifies it with the rules, takes it (`takeItem` after a quantity check) and raises `gift:<id>:loved`, `liked`, `neutral` or `disliked` with `data: {item}`, or `gift:<id>:nothing` (no match). The bridge applies the bond (loved +8, liked +4, anything else +1, disliked -4, one counted gift per character per game day). The character's scripted reaction line is a normal `script` row on that event.
* **Custom records.** A gift item that is not a vanilla record is made once at runtime by `mod/quest-tweak.lua` (`TweakDB:CloneRecord` from a vanilla base, then `SetFlat`), guarded and idempotent across script reloads. No TweakXL. Unverified until a live check.
* **The allowlist check.** `characters/gift-tables.json` is the allowlist. The developer probe `quest gifts` checks every id against the game (`TweakDB:GetRecord`), logs the missing ones and writes `runtime/quest-gift-check.json`. No pack uses a gift id before it has passed.

### 10.4 Garage (`garage`)

`{"p":"garage","id":"g","vehicle":"Vehicle.<record>"}` adds the vehicle to V's garage for good with the game's own vehicle unlock (`VehicleSystem:EnablePlayerVehicle`), once per save: `garage:<id>:added`, or `garage:<id>:owned` when V already has it (the stage's script then gives the `second` thing). It changes the save and cannot be taken back. Kerry's Guinevere is the only use. A community pack that names `garage` is refused by the validator (`validatePack(pack, {community: true})`).

### 10.5 Memory share (`memory-share`, endings `share`)

At the stage start (the primitive) or at the ending (an ending's `share: [{to, note?}]`) the bridge adds the note (default: the ending's `memory`) to the target character's lasting history lines, so the target brings it up in talk. A copy of the mod and the game's own character use the same profile memory, and a game-placed one only talks about it (nothing in the game moves). The game side only raises `memory-share:<id>:done`. A character with no packs of her own still receives the line.

### 10.6 Calls (`call-in`, `call-script`, the pack's `calls`)

A call is `calls.<id>: {caller: "self" | "v", picture: "live" | "voice", text?: <line id>, onHangUp?: <event>, steps: [{say: <line id>} | {gap: <gap id>} | {event: <name>} | {hangup: true}]}`. Its lines have channel `holocall` and play with the holocall lease flag (full level, centred). `call-in` makes the character ring V (an incoming holocall started by the mod, unverified). Answered: the steps play, and the call ends after the last step or when V hangs up (`call:<id>:hung-up`, then `onHangUp`). Not answered in `ringSeconds` (30), or when the game cannot start a call: the Phone Chat text `text` (or the call's first line) with "call me" is sent (`call:<id>:texted`) and the same steps play when V calls her (`call-script`). Never during a game call, a scene, a quest dialogue or a fight: the call waits.

### 10.7 Reach-outs (`reach-out`)

Data: `characters/reach-outs/<character>.json`, read by `bridge/reach-outs.mjs`. `{format: 1, character, requires?, triggers: [{id, via: "text" | "call" | "voice", text, image?, after?: [bridge conditions], when?: game condition, minBond?, cooldownDays?, once?, note?, offer?: <hangout pack id>}]}`.

* `after` (the bridge evaluates, from what it knows): `{kind: "quest", path}` (a journal quest finished), `{kind: "bond", level}`, `{kind: "pack", id}` (a story pack finished), `{kind: "idle-days", days}` (no talk for that many game days, never a guilt trip).
* `when` (the game evaluates, at moments that already exist): `{kind: "weather", is}`, `{kind: "hours", from, to, idle?}`, `{kind: "district", is}`, `{kind: "fight-end"}`, `{kind: "heat", atLeast}`, `{kind: "song", contains?}`. Absent: at the next safe moment.
* The bridge writes into the play file `reach: {enabled, items: [{id, character, via, text, image?, when?, offer?}], perHour: 1, perDay: 3}`: only triggers whose `after` holds, that are off cooldown, not once-and-done, for a character who has no story pack waiting on V, and whose character gate passes (Jackie only before The Heist, Songbird only on the freed branch, Johnny only in V's head, the file's `requires` as a pack's). `enabled` is the Story packs setting AND the new setting **Characters text first** (on by default).
* The game checks at each moment (district change, fight end, a 60 s tick that reads the hour, weather and heat, only while `items` is non-empty). It delivers at most one per game hour and 3 per game day, never during a scene, a quest dialogue, a game call, a fight or a chase. It delivers the text as a Phone Chat message from the character (or a call, or Johnny's voice in V's head) and raises `reach:<id>` in `quest-events.json` with `pack: "reach"`. The bridge then starts the cooldown, and V's answer carries the trigger's `note` as a volatile note for that turn and the next two. With `offer`, the bridge offers the hangout pack to the next private turn.
* While `items` is non-empty the bridge reads the events file every 10 s (not 500 ms): the only recurring work reach-outs cause on the bridge. The events file also carries a top-level `at` (game seconds) so a cooldown that ends while V never talks is noticed.
* Extra fields the bridge writes and the game honours (a condition the game cannot read is false, never silently true): `after` bond `levels` and pack `ids` (one delivery per level or per finished pack), `relationship`, `when.district.minutes`, `when.fight-end.healthBelow|heatAtLeast|district`, and `hours.idle` as game minutes or `true`. Only characters V has talked to are listed. Delivery by call falls back to the text when the call route is absent, delivery by voice is Johnny's caption only.

### 10.8 Hangouts (`kind: "hangout"`)

A hangout is a one-stage pack (`kind: "hangout"`, otherwise format 2) with `hangout: {repeatDays: 3, capPerDay: 20, stoodUp: -10, variations: [{id, know?, wants?, places?: {<place id>: <place id>}}]}`. It starts like a quest (talk, or a reach-out with `offer`), at most one a game day per character, and repeats after `repeatDays` game days with the next variation (never the same twice in a row). Its ending bond counts into the 20 points per character per game day. A hangout never starts while a story pack of the character is open, and it takes the same gate as a quest.

### 10.9 Gate-plus (`requires.facts`, `before`, `notBegun`, `window`, `unfinishedWhen`)

* `facts: {"takemura-alive": true}`: named facts (`bridge/quest-facts.mjs`) read from the game. The play file has `factsWanted: [{id, names, kind}]`. The game reads them with `GetFactStr` at session start, on a load and every 5 minutes, and writes `runtime/quest-facts.json` (`{version: 1, at, facts: {id: value}}`) only when a value changed. A fact the game has not reported is "no" (missing data is always a no). The real fact names are unverified.
* `before: [path]`: the quest is not finished (Jackie: The Heist). `notBegun: [path]`: the quest is not in the journal at all (Songbird: the Reed branch). `window: {allowActive: [prefix], untracked: true}`: a quest of those prefixes may be active when it is not V's tracked quest and no scene runs.
* `unfinishedWhen: {finished: path, ending: id}` (pack level): when the journal shows that quest finished while the pack is active, the pack goes to that ending (unfinished, bond +0).

### 10.10 Music and sound effects (`music`, `sfx`)

Stage fields (see the validator). `file:` sources play through the bridge's media page (`bridge/media-host.mjs`, `media-link.mjs`, `media-request.mjs`, with the page modules `media-engine.mjs`, `media-mix.mjs`, `media-pcm-client.mjs`): the game writes commands into `runtime/media-command.json` (`{version: 1, session, seq, commands: [up to 8]}`), each `{kind: "media", op: play | load | stop | fade | duck, pack, id?, file?, loop?, volume?, fadeIn?, fadeOut?, duck?, at?, pan?}`. The file is resolved from the active pack (`characters/bond-packs/<pack id>/music/` and `sfx/`). `load` decodes a file ahead of time. `at: copy` needs a `pan` from the game, because the bridge keeps the speech lease's pan only during a speech. The bridge reads the file from the existing 50 ms tick, at most every 200 ms, and only while a quest is active or a sound plays. `radio:<station>` and `game:<event>` are played by the game (vehicle radio calls, `Game.GetAudioSystem():Play`), and every loop it starts is stopped by the ctx.
