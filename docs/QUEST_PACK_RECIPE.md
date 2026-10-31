# Recipe: turning a quest of BOND_QUESTS.md into pack data

For the model or person who converts the other quests. The system is in [QUEST_PRIMITIVES.md](QUEST_PRIMITIVES.md). The quest text is in [BOND_QUESTS.md](BOND_QUESTS.md)
and its lines are in [BOND_QUEST_LINES.md](BOND_QUEST_LINES.md). The worked example is the pilot, P1 "Coffee at the Sunset"
(`characters/bond-packs/panam-sunset-coffee.json`). Read that file next to this one. Do the steps in order and run the check at the end.

## 0. What you produce

One file, `characters/bond-packs/<pack id>.json`, `"format": 2`. The pack id is the id in the quest heading (`panam-sunset-coffee`). Nothing else is needed to play it
in the game. Pictures (`images/*.png`) and prepared audio (`audio/*.wav`) are made by other jobs and only referred to by name.

Rules for all the text you write: English, no semicolons, no dashes used as punctuation (use a comma, a colon or a full stop), nothing that names another mod.
Scripted lines are copied word for word from BOND_QUEST_LINES.md (the line text may not be reworded). Every string a player sees in the menus goes through the
mod's translation, but pack text is data and stays English.

## 1. The header

| Pack field | Where it comes from in the quest |
|---|---|
| `id`, `character`, `title` | the heading and the character section (`character` is the profile key, for example `panam-palmer`) |
| `summary` | one sentence of the premise, at most 200 characters |
| `description` | the quest's journal text (docs/REAL_QUESTS.md): 1 to 3 sentences, third person, present tense, at most 300 characters, the situation only, never the ending |
| `requires.bond` | "Gate: bond N" |
| `requires.questsFinished` | the game quests named in the Gate, as journal paths (a name like `q104_02_av_chase` is in `bridge/bond-arcs.mjs` or `docs/QUEST_BRIEFINGS.md` with its full path) |
| `requires.notActive` | "no `q104`, `sq004` or `sq027` quest active" as path prefixes |
| `requires.invitations` | true when the quest says it needs Immersive invitations (any quest that places her copy or meets V) |
| `requires.eddies` | true when a stage asks for or pays eddies |
| `start.channels` | `["own","phone","holocall"]` unless the quest says otherwise |
| `start.chance` | the chance of each roll (up to 3 a game day, one per 3 eligible turns): 0.5 for a light quest, 0.35 for a deep one |
| `start.bringUp` | the Premise, in the second person, ending with how she brings it up in her own way |

## 2. Places, lines, gaps, images

* **places**: one entry per "place" word of the quest (the Pins line lists the meeting points). `{"name": "...", "radius": 25}`. Leave out `x`, `y`, `z`: positions are
  captured in the game with the developer probe `quest capture:<place id>` (it writes `runtime/quest-place-capture.json`, which the game uses for any place that has no
  position). Use radius 25 outdoors and 8 indoors, a smaller radius for a lookout or a door. `district` is optional.
* **lines**: one entry per row of the quest's table in BOND_QUEST_LINES.md. The key is the row id (`P1.walk.02`). `text` is the line. `emotion` is the table's emotion
  column (neutral, happy, sad, angry, fear, surprise, shrug, emphatic, nod). `gesture` is the animation column when it is one of the gesture names (talk, describe, nod,
  happy, point), otherwise leave it out. Do not add `audio`: the file name is added when the line is rendered (`"audio": "audio/<id>.wav"`). `channel` defaults to `own`
  (in person). Use `holocall` for a line of a scripted call, `remote` for a copy's voice in V's ear (the quest says "(remote)"), `head` for Johnny in V's head.
* **gaps**: one entry per "Gap <id>" paragraph. `asks` is the question in Asks. `know`, `secret`, `wants` are the paragraph's Knows, Secret and Wants rewritten as
  second person notes (what she knows now, what she has not told V yet, what she wants from V). `idle` is the Idle word when it is a seat kind or a gesture name.
  `tags` are the Flavour tags with a kind from yes, no, honest, flatter (honest: V says something real, flatter: V keeps it light or pays a compliment, yes and no for
  agreeing or refusing). `resumeAfterSeconds` is the timer (game seconds) and `resumeOn` lists events from section 4 that also end it (V stood up, a timer ran out).
* **images**: one entry per prepared picture: `{"file": "images/<name>.png", "width": 1024, "height": 576}`. The key is the name without the extension.

## 3. Stages

One stage per numbered item of "Stages". Give each an `id` (lowercase, hyphens), a `label` (what the Relationships page shows, at most 80 characters), an `objective` (the line of the HUD quest
tracker and the journal while the stage is current, an instruction to the player of at most 80 characters with no full stop, like "Meet Panam at the Sunset
Motel", docs/REAL_QUESTS.md), `know` (what she
knows and feels at this point, second person, at most 600 characters) and `wants` (at most 300). Take them from the stage text and the Talk list. A stage id may not be the
same as an ending id.

* A stage that is only talk keeps `"type": "talk"` or no type, and ends by `choices` of kind `tag` (V's words), `eddies:<flow>`, `meet:met` or `meet:stood-up`, exactly as
  in the older packs.
* A stage with gameplay is `"type": "play"`. Its **do** list holds the primitives, taken from the stage's bold words and the quest's Build line:

| In the quest | Primitive entry in `do` |
|---|---|
| a map pin on the meeting point | `{"p":"pin","at":"<place>"}` |
| V must arrive somewhere | `{"p":"place","at":"<place>"}` (add `"dwell": seconds` to wait there) |
| she appears at a place | `{"p":"cast","id":"<name>","who":"self","at":"<place>","carry":true}` (`carry` keeps her through the next stages, she joins V's party when a later stage has `party`) |
| she walks with V | `{"p":"party"}` |
| time spent together | `{"p":"together","id":"<name>","minutes":20,"metres":5}` (add `"seated":true` for a sit, `"at":"<place>"` to stay in a place) |
| a sit | `{"p":"seat"}` (V sits down, she sits too) |
| a timer | `{"p":"timer","id":"<name>","seconds":600}` |
| enemies at a place | `{"p":"squad","id":"<name>","at":"<place>","faction":"maelstrom","count":4,"hostile":false}` |
| a captive | `{"p":"hostage","id":"<name>","at":"<place>","record":"Character.<record>"}` then `{"p":"escortee","id":"<name>-e","from":"<name>"}` |
| a drive | `{"p":"ride","to":"<place>","checkpoints":["<place>"],"limitMinutes":30}` |
| she holds a spot | `{"p":"post","id":"<name>","at":"<place>"}` |
| a car that runs or follows | `{"p":"runner",...}` or `{"p":"tail",...}` |
| one look at the radio, the hour, the heat | `{"p":"check","id":"<name>","what":"heat"}` |
| her car races V | `{"p":"race","id":"dash","from":"start","to":"finish","heat":true}` (`"reversed":true` for slowest wins) |
| a column of cars | `{"p":"convoy","id":"col","route":["gate","bridge","camp"],"reroute":["gate","dam"],"cars":2,"lead":"self","driver":"Character.<record>","fallback":true}` |
| two fighters trade fists | `{"p":"bout","id":"b1","a":"boxer1","b":"boxer2","rounds":3,"floor":25}` (`"staged":true,"winner":"a"` for a talk and bet scene) |
| hold the place until a game hour | `{"p":"hold-until","id":"dawn","hour":6,"squad":"wave","witness":"wit"}` |
| V keeps away from her for a while | `{"p":"apart","id":"ring","at":"pier","inner":10,"outer":60,"minutes":5}` |
| sneak past a squad | `{"p":"squad",...,"hostile":false}` then `{"p":"unseen","id":"sneak","squad":"wave","at":"door"}` |
| her voice cuts out in a place | `{"p":"remote"}` and `{"p":"dead-zone","id":"dz","at":"container"}` |
| she plays a pose | `{"p":"workspot","id":"pose","who":"self","at":"bench","key":"smoke","fallback":"panam"}` |
| what a cast extra does after what V says | `{"p":"npc-react","id":"react","cast":"guard"}` |
| V pays a cast extra | `{"p":"pay","id":"toll","to":"guard","amount":100,"min":60}` |
| she gives V something | `{"p":"gift","id":"get","dir":"receive","tier":"common","second":"Items.<record>"}` |
| V gives her something | `{"p":"gift","id":"give","dir":"give"}`, with rows on `gift:give:loved`, `liked`, `neutral`, `disliked`, `nothing` |
| the car goes to V's garage | `{"p":"garage","id":"car","vehicle":"Vehicle.<record>"}` (shipped packs only) |
| another character learns of it | `{"p":"memory-share","id":"tell","to":"misty-olszewski","note":"..."}` or `"share": [{"to":"...","note":"..."}]` in an ending |
| she rings V | `{"p":"call-in","id":"ring","call":"c1","ringSeconds":30}` (the call is in the pack's `calls`) |
| V rings her | `{"p":"call-script","id":"back","call":"c1"}` |

  The full list with every field and the events each raises is `bridge/quest-primitives.mjs`. A primitive the validator does not know is an error, a typo in a field is an error.

* **script** holds the rows. Each row has `when` (an event name) and exactly one action: `say` (a line is spoken), `text` (a Phone Chat message from her, with an optional
  `image`), `gap` (opens a gap) or `event` (raises another event). Use the line table's **trigger** column: `stage:<id>:enter` becomes `stage:enter` in that stage's script,
  `place:<id>:arrived` stays as it is, `gap:<id>:resume` becomes the event of the tag that resumed it (`gap:g1:shared`), `start (text)` becomes a `text` row on `stage:enter` of
  the first stage, `choice:<id>` is the event the choice waits on, `ending:<id>` rows go into that ending's own `script` (below). A line that plays after another one finishes
  uses `when: "line:<line id>:done"`. A gap opens with a row `{"when":"line:<asking line>:done","gap":"<gap id>"}`.
* **choices** end the stage. `{"id":"came","on":"event:place:sunset:arrived","next":"walk"}`. The `on` is `event:` plus a name from section 4. Give every stage at least one way out
  and a `timeout` (`{"gameHours": 3, "next": "<ending or stage>"}`), because a stage that waits on the world can wait for ever.
* A branch the quest describes (V answers one of two ways and the endings differ) is two ways out to two stages, as P1 does with `last-sip` and `last-sip-warm`.

## 4. Events you can wait on

`stage:enter`, `place:<id>:arrived`, `place:<id>:left`, `together:<id>:done`, `together:<id>:broken`, `seat:seated`, `seat:stood`, `cast:<id>:arrived`, `timer:<id>`,
`squad:<id>:spawned|hostile|down|fled`, `hostage:<id>:down|freed|dead`, `escortee:<id>:arrived|bolted|back|lost`, `ride:started|arrived|timeout|abandoned|failed-heat`,
`ride:checkpoint:<place>`, `post:<id>:set|lost`, `runner:<id>:caught|lost|stopped`, `tail:<id>:noticed|lost`, `check:<id>:<value>`, `line:<line id>:done`,
`gap:<id>:resume`, `gap:<id>:<tag>`, `meet:met`, `meet:stood-up`, and for the round 2 primitives `race:<id>:started|won|lost|void|timeout|stopped`, `convoy:<id>:started|leg<N>|arrived|lost-one|failed|rerouted|fallback`, `bout:<id>:started|round<N>|a-down|b-down|stopped|ended`, `hold-until:<id>:reached|failed`, `apart:<id>:done|near|far|broken`, `unseen:<id>:spotted|reached`, `dead-zone:<id>:entered|left`, `workspot:<id>:set|fallback|lost`, `npc:<id>:leave|call-police|attack|cower|brawl|obey`, `pay:<id>:paid|short|broke|declined`, `gift:<id>:given|second|failed|loved|liked|neutral|disliked|nothing`, `garage:<id>:added|owned|failed`, `memory-share:<id>:done`, `call:<id>:ringing|answered|done|hung-up|missed|texted`. Events the stage listens to (the stage raises them with an `event` row or a choice): `race:<id>:go`, `convoy:<id>:go|reroute`, `bout:<id>:go|stop`, `post:<id>:fight`, `squad:<id>:go`, `check:<id>:go`. The validator rejects a choice or row that waits on an event nothing in its stage can raise.

## 4b. Calls, music, sound, situations, shares

* **calls**: a table of scripted holocalls. `"calls": {"c1": {"caller": "self", "picture": "voice", "text": "P1.call.text", "onHangUp": "call:ring:hung-up", "steps": [{"say": "P1.call.01"}, {"gap": "g1"}, {"event": "x:y"}, {"say": "P1.call.02"}, {"hangup": true}]}}`. Give every line of the call `"channel": "holocall"`. `text` is the Phone Chat line sent when the call cannot ring. The stage that starts it has a `call-in` entry (she rings V) or a `call-script` entry (V rings her).
* **music** and **sfx** on a stage: `"music": [{"source": "radio:Morro Rock Radio", "start": "stage:enter", "stop": "race:dash:won", "fadeIn": 1, "fadeOut": 2, "volume": 0.6, "duck": true, "loop": true}]` and `"sfx": [{"source": "file:sfx/rain.ogg", "at": "place:porch", "loop": true}, {"source": "game:ui_jingle_quest_new", "at": "v", "start": "race:dash:won"}]`. A source is `file:music/<name>.ogg` or `file:sfx/<name>.ogg` (inside the pack folder, `.wav` and `.opus` too), `radio:<station>` (music only, a car radio) or `game:<sound event>`. `at` for sfx is `v`, `copy`, `bed` or `place:<id>`. `start` defaults to `stage:enter`, `stop` to the end of the stage. Every `game:` event name has to be checked in the game once, a wrong name plays nothing.
* **situation** (`nervous`, `celebrating`, `grieving`, `angry`, `relaxed`, `working`) on a stage, a gap or an ending sets the idle and the gesture bias. A gap `idle` is a seat kind or an idle key of `assets/gestures/gestures.json`.
* **share** in an ending: `"share": [{"to": "misty-olszewski", "note": "V and Jackie ate at Mama's."}]`, up to 4, note up to 300 characters.
* **audio files** of lines: `audio/<line id>.wav` (or `.ogg`, `.opus`: those need a decoder on the machine, so a shipped pack uses WAV).

## 4c. The other kinds of file

* **Gate-plus** in `requires`: `"facts": {"takemura-alive": true}`, `"before": ["quests/main_quest/prologue/q005_heist"]` (not finished), `"notBegun": ["ep1/quests/main_quest/q306_reed_epilogue"]`, `"window": {"allowActive": ["quests/main_quest/prologue/q003"], "untracked": true}`. At pack level `"unfinishedWhen": {"finished": "quests/main_quest/prologue/q005_heist", "ending": "unfinished"}` (the `unfinished` ending needs no stage that leads to it). Jackie's quests use `before`, `window` and `unfinishedWhen`, Takemura's `facts`, Songbird's `notBegun`.
* **A hangout** is a one-stage pack with `"kind": "hangout"` and `"hangout": {"repeatDays": 3, "capPerDay": 20, "stoodUp": -10, "variations": [{"id": "dusk", "know": "It is dusk.", "places": {"spot": "spot-b"}}]}`. Use the catalogue's hangout text as the stage. An invitation is a reach-out trigger with `"offer": "<hangout pack id>"`.
* **Reach-outs** are not in a pack: `characters/reach-outs/<character>.json`, `{"format": 1, "character": "panam-palmer", "triggers": [{"id": "storm", "via": "text", "text": "...", "after": [{"kind": "bond", "level": 3}], "when": {"kind": "weather", "is": "dust"}, "cooldownDays": 3, "note": "She saw the storm on a feed."}]}`. The text is copied from the character's "reaches out first" table. `bridge/reach-outs.mjs` validates the file.
* **Gift tables** are `characters/gift-tables.json`: what each character gives by tier and what she likes. A pack names a tier and the bridge picks the item.

## 5. Endings

One entry per outcome, with the id the quest gives. `memory`: the outcome sentence in the second person (at most 300 characters). `bond`: the number in brackets. `history`:
the quest's `history` note if it has one, one sentence the character keeps for good. `script`: the ending's rows, each `{"when":"ending:<id>", ...}` with a `say` or `text`
(and `image`). `outcome` (optional, `succeeded` or `failed`): how the journal files it. Without it, an ending with a negative `bond` or the id `stood-up` is a
failure and any other a success. "Rewards" that move eddies or items are `effects` or a later stage and are not part of the first conversion: list them in your report.

## 6. Check it

```
node -e "import('./bridge/bond-packs.mjs').then(async m=>{const {readFileSync}=await import('node:fs');const r=m.validatePack(JSON.parse(readFileSync(process.argv[1],'utf8')));console.log(r.ok,r.errors,r.warnings)})" characters/bond-packs/<id>.json
```

`ok` must be true with an empty `errors`. Warnings about positions to capture and audio still to render are expected. Then write a test like `bridge/quest-pilot-panam.test.mjs`:
start the quest through the runner, feed each stage's events as the game would, check the stage order, the endings with their bond numbers, the gap and the closing rows.

## 7. The pilot, line by line

* P1's stage 1 "talk + text, meet at a place" is `invite`: `pin` and `place` on the motel, `cast` of her with `carry`, the start text on `stage:enter`, her greeting on
  `place:sunset:arrived`, a choice on that arrival and a 3 game hour timeout to the `cold-coffee` ending.
* Stage 2 "walk" is `walk`: `party`, `place` on the lookout, `together` 20 minutes at 5 metres, the two tour lines, ways out `together:tour:done` and `together:tour:broken`.
* Stage 3 "sit together" is `sit`: `seat`, `together` seated, her line on `seat:seated`, the gap on that line's end, the reply line on `gap:g1:shared`, and four ways out (the two
  tags, the sun timer, V leaving).
* Stage 4 "closing beat" is two stages (`last-sip`, `last-sip-warm`) that wait for V to leave the motel and then end in `sunrise` (+45) or `sunrise-shared` (+55).
* The endings carry the picture text (`text` with `image`), the `left` line and the cold coffee text.

## 8. Things that need the owner or the game, not the conversion

* Positions of places: captured in the game. Audio: rendered later. Pictures: made ahead of time in the photo-mode look. Gift ids and the `garage` call: not part of a first conversion.
* `call-in` and `call-script` are built (section 4b): the call lines are `holocall` channel lines, and the pack's `text` is the fallback when the phone cannot ring.
* Every name of the catalogue is a primitive or a pack field (`CATALOGUE` and `CATALOGUE_ELSEWHERE` in `bridge/quest-primitives.mjs`, covered by `bridge/quest-catalogue.test.mjs`). If a quest asks for something none of them can say (a kneeling captive, squad vehicles, a patrol path), convert the rest, write that stage as a talk stage, and list the missing piece in your report.
