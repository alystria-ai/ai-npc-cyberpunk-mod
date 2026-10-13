# Skippy: remark events and the facts they carry

Every fact below is what `addons/skippy/init.lua` puts in `handle:remark(...)` for the speaker `gun`. The speaker may use only
these facts (the API tells it so). The evaluation writer builds fight scripts from this list, so a script step is
`{"event": "<name>", "text": "<text>", "facts": {...}, "maxWords": <n>}` using exactly these names and keys.

Remarks are frequent now: the API default is a 10 s gap between remarks and up to 30 per fight, so a fight is a stream of
moments. Priority decides which moment wins when the gap is short (5 beats 4 beats 3 ...). Skippy only speaks while V holds it.

## How facts are shaped

Facts are plain JSON, at most 32 keys per object, depth at most 4 (bridge limit). Skippy nests them in three groups. The
prompt block flattens them as `fight.kills: 3; victim.kind: human; ...`. A key that is unknown is **left out** (never `null`,
never a guess). Counts are integers. Words are lowercase unless a proper name.

### `mode` (also sent as the request `mode`)
`killer` (Stone Cold Killer, `mq007_skippy_aim_at_head` is 1) or `puppy` (Puppy-Loving Pacifist). Read from the game fact
when the Personality setting is "From the game" (the default). Switching it mid-session fires `weapon-mode-change`.

### `fight` (on every event)
| Key | Type | Example | Meaning |
|---|---|---|---|
| `seconds` | int | 34 | Seconds since the fight began (0 outside a fight). |
| `kills` | int | 4 | Lethal kills by V this fight (any weapon, hostile NPCs only). |
| `skippyKills` | int | 3 | Of those, kills made with Skippy. |
| `headshots` | int | 2 | Headshot kills and headshot hits on a victim that died. |
| `headshotStreak` | int | 2 | Headshot kills in a row now (a non-headshot kill resets it). |
| `bestHeadshotStreak` | int | 3 | Best streak this fight. |
| `downed` | int | 1 | Enemies put down without dying (defeated or unconscious). |
| `limbShots` | int | 5 | Hits on arms or legs. Only counted when the game reports the zone. |
| `civilians` | int | 0 | Civilians V hit (alive or dead) this fight. |
| `shots` | int | 22 | Shots V fired with Skippy. |
| `hits` | int | 15 | V's hits with Skippy on anything hostile. |
| `accuracy` | string | `good` | `poor`, `fair`, `good` or `excellent`; only once 6 shots were fired. |
| `reloads` | int | 1 | Reloads this fight. |
| `enemies` | int | 3 | Hostiles fighting V right now (the game's combatant count). |
| `peakEnemies` | int | 6 | Most hostiles at once this fight. |
| `sinceLastKill` | int | 12 | Seconds since V's last kill (absent before the first). |
| `health` | string | `hurt` | V's health band now: `healthy` (60+ percent), `hurt` (30-59), `badly-hurt` (under 30). |
| `lowestHealth` | string | `hurt` | The worst band this fight. |
| `stealthOpening` | bool | true | The fight began with V unseen (stealth) and was then spotted. Present only when true. |
| `inVehicle` | bool | true | V is in a vehicle. Present only when true. |

### `where` (on `fight-start`, `fight-end`, `skippy-drawn`, `weapon-mode-change`)
`district` (string, e.g. `Watson`), `area` (string, e.g. `Little China`), `timeOfDay` (`night`, `dawn`, `morning`, `afternoon`,
`evening`), `heat` (int 0-5, only when above 0).

### `victim` (on every kill, downed and civilian event)
| Key | Type | Example | Meaning |
|---|---|---|---|
| `kind` | string | `human` | `human`, `android`, `drone`, `mech`, `cerberus`, `chimera`, `spiderbot`, `other`. |
| `rarity` | string | `elite` | `trash`, `weak`, `normal`, `rare`, `officer`, `elite`, `boss`, `maxtac`. |
| `faction` | string | `Maelstrom` | The gang or corp, cleaned from the game's affiliation. |
| `name` | string | `Maelstrom Gunner` | Display name, only for the first three victims of a fight. |
| `zone` | string | `head` | `head`, `torso`, `arm`, `leg`; only when the game reported it. |
| `distance` | int | 28 | Metres from V. The fact is always sent, but the event text and the remark prompt name it only from 30 m (`long-shot`): nearer distances make the model fixate on metres. |
| `weapon` | string | `skippy` | What did it: `skippy`, `other-gun`, `melee`, `takedown`, `quickhack`, `explosion`, `companion`, `other`. |
| `lethal` | bool | true | Died (false: downed). |
| `headshot` | bool | true | The killing hit was a headshot. |
| `stealth` | bool | false | The hit was a silent or stealth hit. |
| `cyberpsycho` | bool | false | The victim was a cyberpsycho (key only present when true). |
| `police` | bool | false | NCPD or Prevention (only present when true). |
| `civilian` | bool | true | A bystander (only present when true). |

## Events

Priority is the API priority. `maxWords` is what Skippy asks for (6-12 for barks). "Cooldown" is the remark `cooldown`.
"Mode" says which modes fire it. Detection is by the game hooks listed in `init.lua`; none runs per frame.

| Event | Pri | Words | Cooldown | Mode | Fires when | Extra facts (top level) |
|---|---|---|---|---|---|---|
| `fight-start` | 3 | 10 | 45 | both | the moment the API reports `combatStarted`, while V holds Skippy | `lookAt` (string, name of the hostile V is facing, if any), `lookAtKind` |
| `first-kill` | 4 | 10 | 0 | both | V's first kill of the fight | `victim`, `firstBlood` (bool true) |
| `kill` | 2 (puppy lethal: 3) | 9 | 8 | both | an ordinary kill; in puppy mode a lethal kill is the interesting one | `victim`, `regret` (int, lethal kills this fight while in puppy mode, puppy only) |
| `headshot` | 3 | 8 | 10 | both | a headshot kill that does not end a streak of 3+ | `victim`, `headshots` (int) |
| `headshot-streak` | 4 | 9 | 15 | both | the 3rd headshot kill in a row, again at 5, 7, 9 ... | `streak` (int), `victim` |
| `multi-kill` | 3 (5 or more: 4) | 9 | 12 | both | 3 or more kills within 8 s | `count` (int), `window` (int seconds) |
| `last-enemy` | 3 | 9 | 0 | both | the kill that leaves no hostile, while at least 2 enemies were seen | `victim`, `peakEnemies` |
| `elite-kill` | 4 | 10 | 10 | both | a boss, elite, officer, MaxTac or cyberpsycho dies | `victim` |
| `long-shot` | 3 | 9 | 20 | both | a kill from 30 m or more | `victim` |
| `stealth-kill` | 3 | 9 | 20 | both | a silent or stealth kill, or a takedown, while unseen | `victim` |
| `kill-other-way` | 2 | 9 | 40 | both | V kills with melee, a quickhack, an explosion or another gun while holding Skippy, 2 times in 30 s | `victim`, `ways` (int kills by other means) |
| `companion-kill` | 2 | 9 | 40 | both | a companion (not V) killed a hostile | `victim` |
| `enemy-downed` | 3 (killer: 2) | 9 | 8 | both | an enemy is put down without dying | `victim`, `downed` (int) |
| `mercy-streak` | 4 | 10 | 20 | puppy | 3, 5, 8 downed enemies without a lethal kill since | `streak` (int) |
| `limb-shot` | 3 (killer: 2) | 8 | 10 | both | a hit on an arm or leg | `victim` (with `zone`), `limbShots` (int) |
| `dismember` | 3 | 8 | 15 | both | a limb is blown off | `bodyPart` (string), `explosion` (bool), `victim` |
| `miss-streak` | 3 | 9 | 20 | both | 6 or more shots with no hit in the last 4 s | `missed` (int shots) |
| `reload` | 2 | 8 | 30 | both | a reload starts with no enemy hostile counted | `empty` (bool, the magazine was empty) |
| `reload-under-fire` | 3 | 9 | 25 | both | a reload starts in a fight with at least 1 hostile counted | `empty` (bool), `enemies` (int) |
| `v-hurt` | 3 | 9 | 25 | both | V's health first falls below 50 percent this fight | `healthPct` (int) |
| `big-hit-taken` | 3 | 9 | 20 | both | V loses 20 percent or more health in 2 s | `lostPct` (int), `healthPct` (int) |
| `near-death` | 5 | 9 | 20 | both | V's health falls below 25 percent (re-arms above 40) | `healthPct` (int), `enemies` (int) |
| `v-healed` | 2 | 8 | 30 | both | V uses a healing item or heals cyberware during a fight | `healthPct` (int, at that moment) |
| `reinforcements` | 3 | 9 | 25 | both | the hostile count rises by 2 or more in one step during a fight | `from` (int), `to` (int) |
| `heat-up` | 3 | 9 | 40 | both | NCPD heat stage goes up | `heat` (int 1-5) |
| `civilian-hit` | 4 (killer: 3) | 10 | 15 | both | V hits a civilian or bystander | `victim` (with `civilian`), `civilians` (int) |
| `civilian-killed` | 4 | 10 | 15 | both | a civilian dies by V | `victim`, `civilians` (int) |
| `weapon-mode-change` | 3 | 10 | 0 | both | the game's mode fact differs from the last one seen (read at draw and at fight start) | `from` (`killer` or `puppy`), `to`, `where` |
| `skippy-drawn` | 2 | 10 | 120 | both | V holds Skippy outside a fight after not holding it for 60 s | `where` |
| `fight-end` | 5 | 14 | 0 | both | the moment the API reports `combatEnded` with Skippy still held; asks for a `ttl` of 8 s | `outcome` (`clean`, `rough`, `narrow`), `where`, `victim` (the last victim, if any), `longestStreak` (int kills in quick succession) |

Outcome: `narrow` when V's health fell below 25 percent, `rough` when it fell below 50, else `clean`.

## Counters and rules

- The add-on only observes while V holds Skippy (`Items.mq007_skippy` is the active weapon). `fight.kills` counts every lethal
  kill V makes in that time, whatever did it, so the fight summary is honest; `fight.skippyKills` is the share made with
  Skippy (`victim.weapon == 'skippy'`). Kills by other means also add to `ways` of `kill-other-way`.
- **The game's own Skippy lines are replaced, not waited out.** While V holds Skippy and the player's **Replace the game's own lines**
  is on (default), the main mod keeps the game's Skippy voice and subtitle ("new message detected", "provocation", the beeps) off:
  the subtitle through a filter on `SubtitlesGameController.ShouldDisplayLine`, the voice by stopping Wwise event
  `vo_3d_important` on the speaker (an unverified try: the scene system plays most dialogue without a named event; until a live test
  shows the voice stops, a remark still waits for the line to end). The quest, the mode choice and the scenes run as always. A line
  counts as Skippy's when its speaker is named Skippy (or still the key `LocKey#46444`), or it is an `Invisible` line with no
  readable speaker name while he is held; no other speaker's line is touched. Log: `[Addons] muted game line: Skippy <id> (...)`.
  With the option off the game's lines play and a remark waits for them (every event has patience, see below) instead of talking over.
- **Patience.** Every event is patient, by priority: 5 waits up to 12 s, 4 up to 8 s, 3 up to 6 s, 2 up to 4 s (a scene, a game line or
  a cold model that answered late; the moment must still be true: V holds Skippy). Skippy's speaker plays through ordinary scenes.
  The first remark of a fight and the fight end are no longer lost to the pace of the local AI (priority 5 is never refused by it, and
  a remark nobody heard is given back).
- Our lines carry ` (AI)` after the name in the subtitles (**Mark our lines in the subtitles**, default on).
- Every remark uses the API's default `ttl` of 3 s (a line not heard within 3 s of its moment is dropped as stale) except
  `fight-end`, which asks for 8 s. Reflex moments (kills, headshots, health, reloads...) are written ahead of time and kept ready
  by the bridge (`handle:stock`), so they land in about a second; moments with their own specifics (`first-kill`, `elite-kill`,
  `long-shot`, `stealth-kill`, bystanders, `fight-start`, `fight-end`, `heat-up`, `dismember`, mode and draw events) are written
  fresh from their facts. A prepared line may carry slots such as `{fight.kills}`, filled from the facts of the real moment.
- One event can be refused by the API (gap, cap, cooldown, busy). The add-on keeps nothing waiting except the single
  highest-priority candidate (priority 3 or more, refused only by gap or busy), for 1.5 s, which it offers again at the next hook
  event; after that the moment is gone, never played late.
