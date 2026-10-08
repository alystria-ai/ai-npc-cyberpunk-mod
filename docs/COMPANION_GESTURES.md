# Companion body gestures

Companions use the game's own conversation gestures while they speak a longer
reply, nod while V talks to them, and now and then take a signature idle while
settled (their own vanilla idle where one exists, a labelled generic stance
otherwise; see Round 4). The
**Body gestures** setting (Companion behavior) is **Off by default** until it
is qualified in game. `mod/companion-gestures.lua` is the controller; the
Stage 0 probe (`mod/gesture-probe.lua`) remains a development tool.

## What the game offers (October 6 research)

Evidence: archive listings and serialized assets under
`E:\CyberpunkConvai-offload\work\body-anim\` (WolvenKit 9.0.1, game 2.31).

- All companions use `base\gameplay\anim_graphs\humanoid.animgraph` on three
  rigs: **woman_base** (Judy, Panam, Rogue, Misty), **man_base** (Johnny,
  Kerry, Viktor, Takemura), **man_big** (Jackie, River).
- The body graph has no talk or gesture input. Its only route for authored
  full-body clips outside scenes is the **WORKSPOT** slot.
- Conversation gestures live in the *interactive_scene* animsets that
  workspots load. The family `stand__2h_on_sides__01__*` (relaxed stance,
  hands at the sides) exists with the same names on all three rigs:
  `generic_average_female_stand_2h_on_sides.anims` (+ `..._stand__2h_on_sides`),
  `generic_male_average__stand__2h_on_sides__01.anims`,
  `generic_big_male_stand_2h_on_sides.anims`. Clips are labelled by emotion
  (talk neutral/confident/angry, yes/no/what/whatever with happy, sad, angry,
  disgusted, afraid, surprised; shrug, sigh, nods, gesture holds), 2–8 s each.
  About 80 clips per rig stay in place; clips with steps, turns or root drift
  (`yes__angry__02/03`, `thumb_up__happy__02`, `yes__surprised__03`,
  `whatever__angry__01`, `demonstrate_negative__*`, ...) are excluded.
- Character sets on the same rigs: Takemura (`takemura__stand__2h_on_sides__01`,
  talk 01–04, respectful nod), Kerry (`kerry__stand__2h_on_hip__01`), Johnny
  (`johnny__stand__arms_crossed_front__01`), Jackie (`jackie__stand__2h_on_sides`),
  Judy (3 arms-crossed gestures), Panam (`panam__stand__rh_on_hip__01` idles).
  River, Rogue, Viktor and Misty use their rig's generic set.
- Character idle workspots (signature stances with idle breaks):
  `judy__stand_ground__stand_around__02`, `johnny__stand_ground__stand_around__01`
  (hand in pocket), `panam__stand__stand_around__01` (hand on hip),
  `kerry__stand_ground_stand_around_01` (hands on hips),
  `takemura__stand_ground__stand_around__01`, `jackie__stand_ground__stand_around__01`;
  everyone else uses `generic__stand_ground__stand_around__01`.

## Mechanism

`WorkspotGameSystem` (natives confirmed in 2.31 `final.redscripts`):
`PlayInDevice`, `PlayInDeviceSimple`, `PlayNpcInWorkspot`, `SendJumpToAnimEnt`,
`SendJumpCommandEnt`, `SendFastExitSignal`, `SendSlowExitSignal`,
`StopNpcInWorkspot`, `StopInDevice`, `IsActorInWorkspot`, `GetExtendedInfo`.

The mod ships `convai_gestures.archive`:

- one `cyberpunk_convai\gestures\convai_talk_<family>.workspot` per stance
  family, cloned from vanilla `big__stand_ground__stand_around__01.workspot`
  (EP1 copy): a looping idle sequence plus one sequence per gesture clip, the
  family's per-rig animsets, the fast exit, and (hands-at-sides only) the
  walk entries/exits and bump reactions; crowd Fear reactions are dropped;
- `cyberpunk_convai\gestures\convai_gesture_device.ent`: an invisible
  gameObject with workspot components only — `convai_talk_<family>` and one
  `convai_idle_<character>` per signature idle workspot.

The device is spawned at the companion's feet (DynamicEntitySystem, tag
`CyberpunkConvaiGestureDevice`, not persistent). The companion enters with
`DontPlayAtResourcePosition`, clips are chosen with `SendJumpToAnimEnt`, and
the controller jumps back to the idle loop when a clip ends. Exit is the
native `SendFastExitSignal` with default arguments; after 3 s still inside it
calls `StopInDevice`, after 6 s it gives up and cools down for 30 s. It never
calls `StopNpcInWorkspot` (that wedged the AI command queue). Combat uses the
fast exit with `instant=true`. If, after an exit, a wanted move stays only
queued for 1.5 s, the controller re-enters for 0.9 s and leaves with a clean
fast exit (verified live to repair a wedge), at most twice a minute.

Rejected: `ApplyFeature`/`PushEvent` (no gesture input in the body graph),
the AI action slot (combat AIAction records), `AIUseWorkspotCommand` (needs a
world node), `AnimFeature_FacialReaction` (face only).

### Movement ownership

`companions.lua` has an optional `bodyAnimation` owner. Each tick it gets
`tick(player, step, rows)` once and `observe(entry, context, step)` for every
copy in the settled-stance loop. While `observe` returns true, the actuator
does not issue movement and the equipment holster handoff sees "not idle" —
the same gate the holster uses. A copy that transport, recovery or a tactic
takes (so it is not observed) is stopped on the next tick. Dismissal and fast
travel call `release`; world teardown calls `abandon` (no native calls).
The seating controller (docs/COMPANION_SEATING.md) shares this owner: it is
observed before gestures, so a companion seated beside V is never offered to
the gesture controller.

## Selection policy

`mod/gesture-selection.lua` is pure (no native calls; `npm run test:gestures`).
The controller calls `next(state, input)` every tick with the clock, mode
(`speaking`, `listening`, `thinking`, `idle`), rig, character key, emotion
family and scale (from `facial-playback.lua`), remaining speech seconds, the
phrase timing and the generated catalog; it returns a clip to start now or nil.
It does real work only when a clip may start (after the calm hold, at a phrase
start), never per frame. Rules as of October 9 (Round 4):

- **Short replies:** nothing below 5 s of reply audio (estimated from the
  reply text at 2.6 words/s), with or without phrase timing; never in the last
  1.2 s; a clip starts only if 70 % of it fits the remaining speech.
- **Phrase starts:** when the face timeline carries phrase timing (each local
  voice segment, and the expression track's spans), a clip starts only within
  0.7 s of a phrase start, and each phrase start is decided once (gesture or
  rest; 20 % rest unless the hands have rested 7 s). Without phrase timing the
  time pacing below applies on its own.
- **Calm hold:** after a clip the companion holds the stance loop (hands at
  sides; Judy folded arms) for 1.6-3.2 s (intensity 1), 1.2-2.6 s (2) or
  0.9-2.0 s (3), divided by the character's rate (Takemura and Hanako .7, Saul
  .75, Viktor .85, Johnny 1.2 ...). The first clip comes 0.1-0.4 s in.
- **Emotion fit:** 60 % of picks use the emotion's own category (joy: happy,
  sadness: sad, anger: angry, surprise: surprise ...), the rest calm talk,
  shrugs and questions. Clashing categories never colour a line (a sad line
  never gets happy, emphatic, angry or surprise clips; joy never sad, fear,
  angry or disgust). Each mood caps the measured hand reach: sadness 30 cm,
  fear 34, disgust 42, trust 45, neutral 48, anticipation 54, surprise 56, joy
  and anger 58, plus 6 cm per intensity step.
- **Repetition:** never the previous clip (only a one-clip pool may repeat);
  strictest first, relaxed only when nothing fits: not in the last 4 clips, not
  the previous clip's *kind* (the move without stance, emotion or variant:
  `yes`, `what`, `talk`, Judy's `gesture`), not used in the last 45 s, and no
  kind twice in the last 4. Kinds used in the last 6 picks weigh less.
  Listening nods follow the same rule except the kind (they are all nods).
- **Weights:** measured reach (15-90 cm, larger reads better), times the
  centre share (clips whose moving hands stay in front of the body weigh up to
  1.65, wide ones down to 0.35); character clips weigh 1.5 (was 3).
- **Never played:** threaten, middle finger, clap, thumbs-up, cheer, dance,
  steps or turns, every clip the catalog marks `exclude` (directional,
  turning, sweeping; see Round 4), and directional names as a guard.
- **Thinking / idle:** no clips; idle may use the character's signature idle
  component (`idleComponent`).

## Stance families (catalog v2)

`assets/gestures/gestures.json` v2 defines talk families; each becomes one
workspot and one device component. Clips are discovered by prefix, kept only
when in place (no motion extraction) and not banned, and categorised by name.

| Family | Rigs | Clips (Oct 6 build) | Used by |
|---|---|---|---|
| `arms_crossed` (`stand__arms_crossed_front__01`, + Judy's 3 and Johnny's own) | all | 144 | Judy, Johnny, Rogue |
| `on_sides` (`stand__2h_on_sides__01`, + Jackie's own) | all | 177 | Jackie, River, Viktor, Misty |
| `on_hips` (`stand__2h_on_hip__01`) | woman, big | 45 | Panam |
| `kerry` (`kerry__stand__2h_on_hip__01`) | man_base | 17 | Kerry |
| `takemura` (`takemura__stand__2h_on_sides__01`) | man_base | 7 | Takemura |

Vanilla idles reported by the user: Judy arms folded; Johnny and Jackie hands
at sides. Johnny's family is still provisional (arms crossed vs on sides plus a
signature layer).

## Building

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Build-GestureAssets.ps1
```

Source: `assets/gestures/gestures.json`. The build extracts fresh inputs into
`E:\CyberpunkConvai-offload\work\gesture-assets\build-*`, validates every path
against the archive listing and every clip against each rig's animsets,
regenerates `mod/gesture-catalog.lua`, round-trips the binaries
(`scripts/Verify-GestureAssets.mjs`) and writes
`E:\CyberpunkConvai-offload\work\gesture-assets\package\convai_gestures.archive`.

Tests: `npm run test:gestures` (Fengari fixture of the probe flow).

## Stage 0 probe

Files: `mod/gesture-probe.lua` (loaded by `init.lua` only if installed),
`mod/gesture-catalog.lua`, `convai_gestures.archive`. Commands are sent with
`scripts\Send-GestureProbe.ps1 "<command>"` while the game runs unpaused
(CET overlay closed). The probe writes `runtime\gesture-probe.log` (JSON
lines: requests, native call results, 4 Hz traces while active).

| Command | Effect |
|---|---|
| `list` | Ready companions, rig, idle component, phase, in-workspot |
| `sigs` | Codeware reflection of the workspot natives into the log |
| `start <who> [component=gestures\|idle\|idle-generic\|idle-judy…] [variant=keep\|suspend] [api=auto\|device\|npc\|simple] [return=on\|off]` | Spawn device, enter workspot |
| `clips <rig>` | Clips available on a rig |
| `jump <who> <clip-name-part\|index\|idle> [instant=on] [by=id]` | Play one clip (auto-returns to idle) |
| `demo <who>` | Play every clip of the rig, idle between |
| `exit <who> [slow]` / `stop <who> [device]` | Leave the workspot |
| `status <who>` | Workspot state, extended info, hold command, position |
| `guard on\|off` | Auto-exit on movement/combat (default on) |
| `clear` | Stop everything, delete devices |

`<who>` is a serial, part of a name/record (`judy`, `johnny`), or `all`.

## Stage 0 findings (October 6, live)

- Natives (Codeware reflection): `PlayInDevice(device, actor, workspotStateFlavourName,
  actorDataCompName, deviceDataCompName, syncSlotName, slideTime, slideBehaviour:
  gameWorkspotSlidingBehaviour, callback)`; `SendFastExitSignal(actor, dirLS,
  stayInWorkspotIfFailed, playSlowExitIfFailed, instant, tryBlendToWalk)`;
  `StopInDevice(actor, posDelta, orientDelta)`; `SendJumpCommandEnt(actor, entryId:
  Int32, instant)`; `PlayNpcInWorkspot(npc, master, referenceEntity, ...)`.
- With `DontPlayAtResourcePosition` (the `gameWorkspotSlidingBehaviour` enum) and
  slide time 0 the companion enters in place, no slide. Clips jump and return
  to the idle loop correctly; lip sync and eye contact keep working.
- The settled check must ignore single-tick group-frame flickers (camera turn,
  opening chat/mic): movement = V > .75 m away from the start, V running, or a
  non-hold decision for .8 s.
- **AI wedge:** after an exit escalated to `StopNpcInWorkspot` (and once
  `StopInDevice` that had not finished), the AI never ran another command:
  the follow stays `Enqueued` indefinitely although flags, role, status
  effects and workspot state are normal; role cycling and in-place teleport do
  not help. The only clean exit observed was `SendFastExitSignal` with native
  defaults finishing on its own (0.1 s). The probe now never uses
  `StopNpcInWorkspot` unless asked and waits 3 s before `StopInDevice`.
- Look: the generic hands-at-sides stance replaced Judy's folded-arms idle and
  looked bland. Talk now uses the stance family matching each character's own
  idle (v2 catalog), and nothing replaces the vanilla idle when not talking.


## Round 3 (October 7): visible gestures, own idles, all tier-1

- **Queued jumps were the "no gestures" cause.** `SendJumpToAnimEnt` with
  instant=false waits for the current clip; with a 22–25 s loop most requests
  never played. Gesture jumps are instant (the workspot still blends them);
  the return to the idle loop stays queued. Verified by capture.
- **Reply length** comes from the reply text (2.6 words/s), not the current
  phrase timeline (local voices stream phrase by phrase).
- **Measured motion.** `scripts/Measure-GestureMotion.py` runs forward
  kinematics on WolvenKit glTF exports and stores each clip's hand reach in
  `assets/gestures/clip-motion.json`. Talk uses 15–90 cm clips weighted by
  reach; overhead sweeps (demonstrate, stretch, exercise) and symbolic shapes
  are excluded. The man_big hands-at-sides set does not export, so its clips
  borrow the reach of the same names on the other rigs.
- **Own idle as the loop.** Every tier-1 companion (23 spawnable records)
  maps to a family whose loop is its vanilla relaxed `idle_stand`, so entering
  and leaving show no pose change. FK hand poses: only Judy idles with folded
  arms; all others idle with hands at sides and gesture from those clips.

| Characters | Rig | Loop |
|---|---|---|
| Judy | woman | wa_judy (own) + arms-crossed clips |
| Panam, Rogue | woman | own relaxed idle |
| Misty, Alex, Claire, Evelyn, Lizzy, Mama Welles, Meredith, Regina, Songbird, Wakako | woman | wa_gang relaxed idle |
| Johnny, Kerry, Viktor, Mr. Hands, Padre | man | ma_gang relaxed idle |
| Takemura | man | own relaxed idle (+ his talk clips) |
| Jackie, River, Reed | big | own relaxed idle |
| Pepe | big | mb_gang relaxed idle |

- **Exclusions:** threaten, middle finger, clap, thumbs-up, cheer, dance,
  steps/turns, go away/come closer, salute, fist, draw gun/aim, be quiet,
  cracking knuckles, angry stop/me, talk to the hand, demonstrate, stretch,
  exercise, and Judy's `gesture__02` (a raised thumb, seen in capture).
- **Hot reload:** probe `reload-controller` swaps the controller files;
  `reload` swaps the probe. Archive changes need a game restart.

## Stages

0. Probe — done for start, slide, clips, face/gaze, guard, wedge/recovery;
   still open: clean walk-away with native exit, suspend variant, long hold,
   signature idles, missing clip, vehicle.
1. Controller behind the setting (default Off) — built (`companion-gestures.lua`,
   `gesture-workspot.lua`, fixture tests `bridge/companion-gestures.test.mjs`).
2. Emotion/intensity mapping, stance families, character clips — built.
3. Listening nods (V speaking) and signature idle flavour — built; group-chat
   listeners are not yet included.
4. MCM string in 9 locales + `localization/en.json` — done. In-game
   qualification of the controller is next.


## Round 4 (October 9): no repeats, no pointing, fit to the line, more idles

User feedback after testing Judy: the same gesture several times in a row;
pointing in directions that made no sense; good moments when her hands stayed
centred in front of her body; signature idles for more characters.

**Why it repeated.** Judy's own `judy__stand_2h_arms_crossed__01__gesture__01`
and `__03` are 9.3 s long and weighed 3x as character clips (gesture 03 also
2.9x for reach), so over a long reply they came back each time the 30 s
cooldown ran out; and nothing stopped two variants of the same move (two `yes`
nods, two `describe` hands) back to back. Listening nods could repeat the same
clip. Both Judy clips also turn the torso 25-27 degrees and are now excluded.

**Why it pointed.** The `neutral` category matched `describe_left/right/back`,
`point_back`, `head_flick_left/right` and talk clips that open one hand out to
the side, and `describe`/`point` were weighted as *expressive* (2.5x).

**Audit** (`scripts/Measure-GestureShape.py`, output
`assets/gestures/clip-shape.json`): forward kinematics on the WolvenKit glTF
exports (15 frames/s, frame of the clip's first frame, facing -Z), per clip:
one hand outside its shoulder while the other is not (`side`), past the other
shoulder (`cross`), behind the chest (`back`), index finger out with the others
curled while raised (`point`; these exports do carry animated finger bones),
one straight raised arm (`stretch`), chest and head turn (`yaw`, `head`), hands
above the head, reach, and `centre` (share of moving frames with every moving
hand in front of the body, within 26 cm of the midline, between hips and
chest). `assets/gestures/gestures.json` `conversationFit` holds the name rules
and thresholds (point >= .4 s, side >= 20 cm, cross >= 12, back >= 8, stretch
>= .6 s, torso >= 25 deg, head >= 65 deg, above the head, reach > 60 cm). The
build writes per clip `kind`, `fit` (`centred`, `neutral`, `directional`,
`turn`, `sweep`) and `exclude` (the reason) into `mod/gesture-catalog.lua`; a
clip measured on several rigs takes the worst rig. The man_big hands-at-sides
set does not export and borrows the same names. Excluded clips keep their
workspot sequence (the probe can still play them).

Conversation pool before and after (talk categories, after the existing bans,
reach and leg checks):

| Family / rig | Before | Excluded | Left | Centred / neutral left |
|---|---|---|---|---|
| arms_crossed / woman_base (Judy) | 123 | 36 | 87 | 75 / 12 |
| arms_crossed / man_base | 113 | 30 | 83 | 72 / 11 |
| arms_crossed / man_big | 115 | 31 | 84 | 73 / 11 |
| on_sides / woman_base | 124 | 58 | 66 | 34 / 32 |
| on_sides / man_base | 118 | 57 | 61 | 32 / 29 |
| on_sides / man_big | 117 | 54 | 63 | 32 / 31 |
| kerry / takemura / johnny (man_base) | 12 / 5 / 7 | 4 / 1 / 4 | 8 / 4 / 3 | |

Examples: `describe_left/right/back__*`, `point_back__01`,
`head_flick_left/right__*` (by name); `describe_up__01` (index finger out
1.4 s), `talk__neutral__04` (one hand 39 cm out past the shoulder),
`stop__afraid__01` (one straight arm .9 s), `talk__neutral__07` and Judy's
`gesture__01/03` (torso turned 25-32 deg), `what_is_this__angry__02` (68 cm
sweep), `shrug__broad__*` (by name). Every character keeps 29-31 non-excluded
clips with 25 cm+ reach.

A hands-in-front hold (`stand__2h_on_sides__01__gesture_hold__01` and its
flicks) exists, but its feet sit 15-18 cm from the stance loop (crossed legs on
blend), so the stance loop stays the rest pose; centred clips are preferred.

**Signature idles.** Every candidate workspot was serialized from the 2.31
archives (EP1 copies override) and its loop and idle-break clips checked in the
animsets of the character's rig: present, no motion extraction (no walking), no
item or effect events (no props). Rigs come from each character's entity
animated component. The flavour idle plays now and then while settled (after
20 s settled, first at 45-90 s, then every 60-150 s, for 18-30 s); talk still
uses the character's talk family.

| Character | Idle workspot | Kind |
|---|---|---|
| Judy | `judy__stand_ground__stand_around__02` (hands on hips) | character |
| Johnny | `johnny__stand_ground__stand_around__01` (hand in pocket) | character |
| Panam | `panam__stand__stand_around__01` (hand on hip) | character |
| Kerry | `kerry__stand_ground_stand_around_01` (hands on hips) | character |
| Takemura | `takemura__stand_ground__stand_around__01` | character |
| Jackie | `jackie__stand_ground__stand_around__01` | character |
| Misty | `misty__stand__stand_around__01` (hands held in front, q101) | character |
| Hanako | `hanako__stand_ground__stand_around__01` (hands folded in front) | character (new to the catalog) |
| Saul | `saul__stand_ground__stand_around__01` (arms crossed) | character (new to the catalog) |
| Reed | `ep1__reed__stand_ground__stand_around__01` (hands at sides) | character |
| Placide | `placide__stand_ground__stand_around__01` (hands at sides) | character (new to the catalog) |
| River | `q202__river__stand_ground__stand_around__01` | character workspot, shared clips |
| Rogue | `sq031__rogue__stand__stand_around__01` (arms crossed) | character workspot, shared clips |
| Alex | `q303__alex__stand__arms_crossed_front__01` | character workspot, shared clips |
| Songbird | `q304__songbird__stand__arms_crossed_front__01` | character workspot, shared clips |
| Viktor, Meredith, Regina, Mitch | `generic__stand_ground_arms_crossed__stand_around__02` | generic (arms crossed) |
| Mama Welles, Evelyn, Lizzy Wizzy | `generic__stand_ground__stand_around__10` (one hand on hip) | generic |
| Claire | `female__stand_ground__stand_around__02` (hands on hips) | generic |
| Wakako, Padre, Mr. Hands | `generic__stand_ground__stand_around__05` (hands behind back) | generic |
| Pepe | `generic__stand_ground__stand_around__01` (relaxed) | generic |

Rejected: Viktor `sq018__victor__stand_ground_gloves` (holds gloves), Evelyn's
three own idles (purse), Claire `sq024__claire__stand__argue__01` (an argument),
Mama Welles `sq018` (funeral key hold), Mitch `q202` (cigarette), Dexter (all
cigar poses; the man_fat rig has no talk families), Songbird `ep1__q305` (no
rig animsets), Adam Smasher (man_massive), Alt (not in the roster). The generic
hand-on-hip set moves on man_base/man_big, and the generic arms-crossed and
hands-front sets miss clips on man_big, so each generic is used only on the
rigs where it checked clean (`idleSources` in gestures.json, enforced by the
build). Hanako, Saul, Placide and Mitch are new catalog characters (talk family
`on_sides` on their rig), so they also gesture when the setting is on.

**Performance.** Selection runs only when a clip may start; phrase tracking is a
cursor over the timeline's spans (no tables per tick); with the setting Off the
controller no longer looks up speech each tick. No new hooks.

**Install.** Game restart for the rebuilt `convai_gestures.archive` (13 new idle
components, 42 in all) from `runtime/gestures/package/`; CET reload for
`mod/gesture-selection.lua`, `companion-gestures.lua`, `gesture-catalog.lua`,
`init.lua`.

**In-game checks** (Body gestures On, Developer mode for `Gestures gesture`
lines in probe.log):
1. Judy, a long reply (15 s+): no clip twice in a row, no two nods or two
   "what" back to back, no pointing or hand flung to a side, no turning away;
   hands mostly in front of her; calm folded-arm holds between gestures.
2. The same with a hands-at-sides companion (Panam, Johnny, Jackie).
3. A sad reply: small, close gestures only; a happy or angry one may open up.
4. A short reply (one sentence): no gesture.
5. Gestures start with a new sentence, not mid-phrase.
6. Settled 1-2 minutes: Judy (hands on hips), Misty, River, Rogue, Reed,
   Hanako, Saul and Placide take their idle; a generic one for Viktor, Claire,
   Wakako; no walk-in step, no prop, a clean return to the vanilla idle.
