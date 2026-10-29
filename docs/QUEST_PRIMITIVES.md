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
bridge/bond-pack-runner.mjs  --- runtime/quest-play.json  --->  mod/quest-play.lua   (the stage to execute, written when it changes)
bridge/quest-link.mjs        <-- runtime/quest-events.json ----  mod/quest-play.lua   (what the game saw, written when something happened)
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

The table is kept current by the commit that changes a piece. "Offline" means unit tests on a fake game. "Live" is what only the game can show.

| Piece | Where | Status |
|---|---|---|
| Format 2 validator, primitives registry | `bridge/bond-packs.mjs`, `bridge/quest-primitives.mjs` | see the end of this file |
