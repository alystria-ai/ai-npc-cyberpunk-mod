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
whose file is missing is never given to the live voice: it is shown as a subtitle and a Phone Chat line, and a pack error is logged. **Development only**
(Developer mode on): a missing file is spoken through the player's chosen voice instead, so quests can be played before any audio exists.

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
| Format 2 validator (places, lines, gaps, images, `do`, `script`, event choices, history) | `bridge/bond-packs.mjs`, `bridge/quest-format.mjs`, `bridge/quest-primitives.mjs` | built, offline |
| Runner: events, gap (note, tags from V's words, restore), history, stage timeout, closing rows, `lineFor`, play file, commands | `bridge/bond-pack-runner.mjs`, `bridge/quest-link.mjs`, `bridge/quest-poller.mjs` | built, offline |
| `line`: prepared WAV audio through the renderer, subtitle when the file is missing, live voice only in Developer mode | `bridge/prepared-voice.mjs`, `bridge/quest-lines.mjs`, `runScriptedTurn` in `bridge/convai-bridge.mjs` | built, offline. Opus or ogg is not decoded (WAV only). Precomputed face rows are not used (the live face model runs on the audio). The Phone Chat line for a missing file is not added (subtitle only) |
| `line` on the game side: queue, one voice, bark and plot rules, the request | `mod/quest-lines.lua`, glue in `mod/init.lua` | built, offline. Rule 2 of section 5 (a live reply heard after the line) is not built: V talking cancels the line and a plot line is replayed |
| `gap`: open, note, resume by tag, timer, event or command | `mod/quest-lines.lua`, runner | built, offline. The `idle` pose is not played (no simple gesture call) |
| `place`, `pin` | `mod/quest-places.lua`, `mod/quest-world.lua` | built, offline. The map pin and the ground ray are unverified |
| `text` (Phone Chat message, with a picture row) | `mod/phone-chat.lua` `deliverScripted` | built, offline. The picture needs the picture archive (in no package) and the PNGs |
| `call-in` | rows | text fallback only. An incoming holocall started by the mod is not built |
| `timer`, `party`, `together`, `seat`, `cast` | `mod/quest-prims.lua` | built, offline. A cast copy of a character is placed through the party queue as a visitor and joins V's party in a `party` stage. Unverified |
| `squad`, `hostage` (floor form), `escortee` | `mod/quest-prims-action.lua`, `mod/quest-world-action.lua` | built, offline. All natives unverified. The kneel form of hostage, squad vehicles, patrol points, `hold-until` and `unseen` as its own primitive are not built (a relaxed squad's `hostile` event covers unseen) |
| `ride`, `post`, `remote`, `runner`, `tail`, `check` | `mod/quest-prims-drive.lua`, `mod/quest-world-drive.lua` | built, offline. `post` works on a cast copy only and cannot fight from its spot (companion tactics has no hold flag). Stance prone is crouch. `runner` and `tail` need a driver record in the spec |
| `history` | runner, `forgetHistory` on a memory reset | built, offline |
| `image` | row field, picture table, `phone-chat.lua` | plumbing only |
| Developer probe (`status`, `capture:<place>`, `event:<name>`, `line:<pack>:<line>`, `reap`) | `mod/quest-probe.lua` | built, offline, Developer mode only |
| Not built | | `race`, `convoy`, `bout`, `hold-until`, `dead-zone` as its own primitive (the `remote` field `deadZone` covers it), `apart`, `memory-share`, `gift`, `garage`, `reach-out`, `hangout`, `npc-react` outcome events, the pay-an-NPC flow, `workspot`, `music`, `sfx`, `anim`, `call-script`, `gate-plus` |

The pilot quest is P1 "Coffee at the Sunset", `characters/bond-packs/panam-sunset-coffee.json` (tests: `bridge/quest-pilot-panam.test.mjs` through the runner and the link,
`bridge/quest-pilot-lua.test.mjs` through the real game modules). It is in the repository folder of the shipped packs but NOT in `packaging/release.config.json`, so no
package carries it until its places are captured and its lines have audio.

## 7. Install the build over the 2.5 game for a live test

Close the game first. Nothing here touches `mod/diagnostics.lua`. The game is a player install: the bridge runs from the Runtime's `app\`, so the bridge files go there.

| From the repository | To |
|---|---|
| `mod/*.lua` that changed: `bonds.lua`, `init.lua`, `phone-chat.lua`, `companion-seating.lua`, `johnny-probe.lua` and the new `quest-world.lua`, `quest-world-action.lua`, `quest-world-drive.lua`, `quest-places.lua`, `quest-prims.lua`, `quest-prims-action.lua`, `quest-prims-drive.lua`, `quest-lines.lua`, `quest-play.lua`, `quest-probe.lua` | the CET folder `bin\x64\plugins\cyber_engine_tweaks\mods\AiNpcCyberpunkMod\` |
| `r6/scripts/CyberpunkConvai/PhoneChat.reds` | `r6\scripts\CyberpunkConvai\PhoneChat.reds` (only needed for the picture row, the game recompiles at start) |
| `bridge/bond-pack-runner.mjs`, `bond-packs.mjs`, `bonds.mjs`, `convai-bridge.mjs`, `protocol.mjs`, `prepared-voice.mjs`, `quest-lines.mjs`, `quest-poller.mjs`, `quest-link.mjs`, `quest-format.mjs`, `quest-primitives.mjs` | the Runtime's `app\bridge\` (see `packaging/runtime-layout.mjs`) |
| `characters/bond-packs/panam-sunset-coffee.json` | the folder that holds `panam-truck-ransom.json` in the installed Runtime |

Never copy `mod/diagnostics.lua`. Restart the bridge (the service) after copying. Undo afterwards by restoring the shipped copies of the same files.

## 8. Live checks (do X, check Y)

Setup: Settings, Gameplay, Character bonds and Story packs on, Immersive invitations on, Developer mode on for the probe. Panam in the roster, bond 3 or more with her, `q104_02_av_chase` finished
in the save. The probe is `scripts/Send-JohnnyProbe.ps1 quest <action>`.

1. Stand at the Sunset Motel forecourt in Rocky Ridge. Run `quest capture:sunset`. Walk to the lookout behind it. Run `quest capture:lookout`. Check `runtime/quest-place-capture.json` holds both with x, y, z, a radius and the district.
2. Talk to Panam in person (or text her) until she brings up the coffee. Check the bridge log says `pack=panam-sunset-coffee started`, `runtime/quest-play.json` exists with stage `invite`, and a text from Panam ("Motel coffee tastes like engine coolant...") is in her Chat thread.
3. Open the map. Check a pin sits on the motel forecourt. Save, load the save. Check the pin is there again (it must be registered again after a load).
4. Drive toward Rocky Ridge, no closer than 200 m. Check no copy of Panam is there. Come within 150 m. Check her copy appears at the motel (standing, not in the road).
5. Walk into the forecourt. Check she greets V with "You actually came. Here. It's terrible, drink it anyway." The audio does not exist yet, so check it appears as a subtitle (with Developer mode on it is spoken by the live voice), the pin disappears, and the log shows `place:sunset:arrived` then stage `walk`.
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

## 9. Libraries that could make a primitive better (not added, for the owner)

The requirements today are CET, redscript, RED4ext, Codeware and ArchiveXL. Nothing below is used.

* **TweakXL** (custom records). For: Kerry's Guinevere or any gift with a custom item, a neutral-affiliation copy of a vehicle for `runner` and `tail` so a chase car is boardable and has no police icon, custom `UIIcon` records that would let a Phone Chat picture use the game's own picture route instead of our row. Against: it was dropped once because game patches broke it. Vanilla records need none of it, and every primitive built here uses only vanilla records. The case is only worth making for gifts with new items and for a chase vehicle.
* **A quest graph route (ArchiveXL plus WolvenKit questphases)** for a real journal entry, a gold route marker and objective text. For: native tracking and the road route line. Against: the owner chose mod-side state, an archive per quest is heavy, and our pins cover the map.
* **A choice hub library** for "press F to free the hostage" prompts. For: the standard interaction look. Against: the hostage is freed by standing close for a moment, which needs no prompt, and a new dependency is not worth one prompt.
