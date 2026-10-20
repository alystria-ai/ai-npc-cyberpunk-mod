# Companion body gestures

Companions use the game's own conversation gestures while they speak a longer
reply, nod while V talks to them, and now and then take a signature idle while
settled (their own vanilla idle where one exists, a labelled generic stance
otherwise; see Round 4). The
**Body gestures** setting (Companion behavior) was Off by default until it was
qualified in game, On by default from October 11, 2026, and **removed on October 20, 2026**: gestures are
always on and there is no row (a saved `bodyGestures` key is ignored and dropped from the file once). `mod/companion-gestures.lua` is the controller; the
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

> Round 5 (below) superseded the idle table in this section: every tier-1 now has an idle of their own.

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
1. Controller behind the setting (default Off until October 11, 2026, then On) — built (`companion-gestures.lua`,
   `gesture-workspot.lua`, fixture tests `bridge/companion-gestures.test.mjs`).
2. Emotion/intensity mapping, stance families, character clips — built.
3. Listening nods (V speaking) and signature idle flavour — built; group-chat
   listeners since Round 10 (October 14).
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

**In-game checks** (Developer mode for `Gestures gesture`
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

## Round 5 (October 10): variety across replies, the body twitch, an idle for every tier-1, the mouth sealed under a workspot

User feedback after testing Evelyn: she did the same gesture twice; her body
moves and twitches a bit as a gesture starts; her hip idle looks nice and every
tier-1 should get a signature animation. A coordinator note the same day: on
two OmniVoice and Pocket replies the mouth stayed shut although the Lua face
writer wrote an open jaw (`speech-state.json` `face.expressions.lastSpeech`
398 of 676 frames open, peak .54; later 302 of 431, peak .612), and both
coincided with a gesture workspot.

### The mouth under a workspot

Mechanism (face graph `woman_average_sermo.animgraph`, extracted and read):

- While any workspot runs, the NPC face graph's "Idle" state swaps its own
  emotion idle for the `WORKSPOT` graph slot (`UpdateWorkspot.isActive`, node
  expression `(UpdateWorkspot > 0) & less_or_equal(CoverStance, 0) &
  less_or_equal(FacialReaction, 0)`). The slot plays the facial idle named on
  the workspot's `animAnimNode_WorkspotHub` node (`facialIdleMaleAnimation`,
  `facialIdleFemaleAnimation`, plus a key pose `facialIdleKey_*` at
  `facialKeyWeight`).
- Our generated talk workspots were cloned from
  `big__stand_ground__stand_around__01.workspot`, whose hub names
  **`idle__interested__female/male`** with the key pose `..__attentive`
  (the generic idle workspots `generic`, `generic_arms_crossed`,
  `generic_hips_big`, and `reed` carry `interested` + `focused`; `jackie` carries
  a `neutral__default` key). Judy, Panam, Johnny, Kerry, Takemura and the rest
  use `idle__neutral__*` with no key.
- The speech layer only **adds** `<control>LipsyncPoseOutput` deltas before the
  Sermo solver. The game's own dialogue also writes `<control>AnimOverrideWeight`
  (keyed to `1 - pose`) to fade the idle under the lipsync; ours stays at 1, so
  the facial idle plays at full weight under the mouth.
- The facial idle clips (`generic_average_female_facial_idle.anims`, decoded
  from the WolvenKit glTF `trackKeys`) hold the lips closed: `lips_together_up/dn`
  mean .66/.73 with a 90th percentile of 1.0 for `idle__interested__female`,
  against .32/.32 (p90 .79) for `idle__neutral__female`, plus `jaw_mid_close`,
  `lips_suck_dn` .27, purse .28, chin raise .20. The `attentive`/`focused` key
  poses add `lips_together`, purse and chin raise on top. A jaw of .1-.3 (the
  speech median is .12, p95 .37) cannot open lips held at .7-1.0.
- The gesture clips themselves carry no facial tracks (only rig `pla_*` float
  tracks), and our workspots set no other facial field.

Live check (Evelyn staged at .85 m, face-test `jaw` .5 written by the writer,
12 frames over 3 s each, no Convai turn): no workspot open (one earlier run
shut at that moment), the talk family (`interested`) **shut for the whole 3 s in
one run and open in the next**, the neutral signature idle open. So the idle
layer seals the lips intermittently with any facial idle; `interested` doubles
the closure and its mean, which is why it showed on gesture replies. This is
evidence of a contributing cause, not a proof that nothing else seals the mouth.

Fixes (archive; game restart):

- `scripts/Build-GestureAssets.mjs` sets the hub of every generated talk
  workspot to `idle__neutral__male/female`, no key pose, and copies the five
  vanilla idle workspots whose hub is not plain neutral (`generic`,
  `generic_arms_crossed`, `generic_hips_big`, `reed`, `jackie`) to
  `cyberpunk_convai\gestures\convai_face_<name>.workspot` with the same change
  (vanilla files are never overridden, so ambient NPCs keep theirs). The ps1
  extracts every idle and sit workspot for it. `Verify-GestureAssets.mjs` fails
  the build unless every shipped workspot reads neutral, no key, after the
  binary round trip (21 workspots).
- **Fixed in the lip-sync layer (October 10, later; see `docs/FACIAL_ANIMATION.md`, "speech owns the mouth"):** even the
  neutral idle holds `lips_together` up to .98 at times, and a per-control `1 - pose` override would not have helped
  (a control whose own pose is 0 at that instant keeps the idle's closure). `speech_owner` now fades the idle's jaw, lip
  and cheek controls through `lipSyncEnvelope` and `<control>AnimOverrideWeight` for as long as a reply is heard
  (graph archive plus `FaceFeature.reds`: game restart).
- To read `speech-state.json` `lastSpeech` next time: `jawPeak` and
  `openFrames` high with a shut mouth on screen during a workspot means this
  layer, not the writer.

### Why she repeated

Memory was per companion and survives across replies, so the repeat was not a
reset. The causes:

- Clip weights grew linearly with hand reach (top-heavy), so a handful of the
  30 neutral clips took most picks; emotion pools of two or three clips (a
  happy reply has `what__happy` and `calm_down__happy`) were exhausted into
  level 0 of the relaxation ladder, "not the previous clip", so a clip came back
  after one other.
- Nothing grouped look-alikes: `rh_flick`, `lh_flick`, `2h_flick` and the
  `describe_*` moves read as the same small hand sketch from a few metres.
- The pool per family and rig is not small (Evelyn: 62 usable clips, 30 calm,
  29 at the neutral reach cap before this round), so the pool size was not the
  bottleneck; the policy was.

`mod/gesture-selection.lua` now: memory of the last 24 clips; a ladder of
levels that first avoids anything in the last 12, any look-alike group
(`flick`, `describe`, `talk`, `what`, `shrug`, `yes`, `head`, `calm`, `self`,
`weigh`) in the last two picks, the previous kind and anything used in the last
75 s, and only relaxes (last 8, last 4, last 2, the previous clip) when nothing
fits, widening the mood's reach cap by 12 cm before the last two levels; reach
weight `sqrt(reach/15)` capped at 2.2; kinds and groups used recently weigh
less; the same hand as the previous clip weighs half; `fit: "open"` clips weigh
.6; a mood's own clips are boosted inside the calm pool to about 60 % of picks
instead of replacing it. 60 simulated companions, twelve 14 s replies each (about
2.9 gestures per reply), Evelyn's family on `woman_base`, same grouping for
both:

| Mood | Same clip within 6 gestures | within 12 | Look-alike back to back | Distinct clips |
|---|---|---|---|---|
| neutral before / after | 11.7 % / 0 % | 40.2 % / 0 % | 18.1 % / 0 % | 29 / 36 |
| joy before / after | 38.5 % / 0 % | 53.1 % / 0.1 % | 4.0 % / 0.1 % | 29 / 39 |
| sadness before / after | 23.6 % / 0 % | 44.3 % / 0.1 % | 4.2 % / 0 % | 30 / 39 |

Pool per tier-1 (`node scripts/Report-GesturePools.mjs`, the real policy and
catalog; usable = conversation clips after bans, reach, leg gap and exclusions;
calm = the filler categories; at mood = under the neutral reach cap):

| Group (family, rig) | Usable before > after | Calm | Calm at mood | Kinds | Look-alike groups | Open clips |
|---|---|---|---|---|---|---|
| 14 women: Alt, Claire, Evelyn, Hanako, Lizzy, Mama Welles, Misty, Panam, Rogue, Meredith, Regina, Songbird, Alex, Wakako (on_sides, woman_base) | 62 > 69 | 30 > 37 | 29 > 36 | 18 > 19 | 12 | 10 |
| Judy (arms_crossed, woman_base) | 79 > 75 | 41 > 41 | 41 > 41 | 19 > 18 | 12 | 1 |
| 9 men on man_base: Johnny (2 records), Kerry, Takemura, Viktor, Mr. Hands, Padre, Mitch, Saul | 59 > 66 | 31 > 38 | 28 > 35 | 18 | 12 | 9 |
| 5 big men: Jackie, River, Reed, Pepe, Placide | 61 > 69 | 30 > 37 | 28 > 35 | 18 > 19 | 12 | 10 |

The pool grew by the 20-30 cm "open" class: a hand held out to the side by
20-30 cm (a shrug, a "what", a flick; 16 clips such as `talk__neutral__03`,
`what__neutral__05`, `shrug__01`) was excluded as directional at 20 cm; the side
limit is now 30 cm and `fit: "open"` clips play at 0.6 weight. Judy's pool shrank
by the body exclusion below.

### The body twitch

Measured offline (`scripts/Measure-GestureBody.py`, forward kinematics on the
glTF exports, `assets/gestures/clip-body.json`): the clips that survive the
other filters start and end in the stance loop pose (hips, spine, head, feet
gap 0; the loop drifts at most 2 degrees over 10 s), so the clip pose itself is
not the pop. What moves the body is:

- **Blends around the clips and the stance.** Enter 1.1 s, exit 1.0 s, forced
  exit 0.25 s, clip blend-out 0.7 s, and the first clip landing 0.1-0.4 s after
  the reply starts, while the 1.1 s enter blend into the stance was still running.
  Now: enter 1.5, natural exit 1.4, forced exit 0.5, auto transition 1.2, clip
  blend-out 0.9 (`blend` in `gestures.json`, baked into the workspots), and the
  controller (`mod/companion-gestures.lua`) passes `busyUntil` = active time +
  the family's enter blend + .15 s, so the first clip waits for the end of the
  enter blend; it then lands on the next phrase start.
- **Clips that whip the torso or the hips.** Spine angular speed above 55 deg/s,
  spine, neck or head above 150 deg/s, or the hips travelling more than 15 cm
  inside the clip (stance shuffles, steps): excluded with fit `body`, 5-8 clips
  per family and rig (about 7 %: `yes__happy__01` 67 deg/s, `what__angry__01`
  166 deg/s, `calm_down__afraid__01`, `shuffle__02`, `crack_knuckles__angry__01`).
  The thresholds are the top 10 % of the 1,391 measured clips, not calibrated by
  eye.

Not reproduced offline and not yet captured live: which of these the user saw.
A live capture of a gesture start is the check.

### Signature idles, all tier-1

| Character | Idle workspot (stance) | Kind |
|---|---|---|
| Judy | `judy__stand_ground__stand_around__02` (hands on hips) | own |
| Panam | `panam__stand__stand_around__01` (hand on hip) | own |
| Evelyn | `generic__stand_ground__stand_around__10` (one hand on hip; the user liked it, kept) | generic |
| Rogue | `sq031__rogue__stand__stand_around__01` | own workspot |
| Misty | `misty__stand__stand_around__01` | own |
| Alex | `q303__alex__stand__arms_crossed_front__01` | own workspot |
| Songbird | `q304__songbird__stand__arms_crossed_front__01` | own workspot |
| Hanako | `hanako__stand_ground__stand_around__01` (formal) | own |
| Claire | `female__stand_ground__stand_around__02` (hands on hips) | generic |
| Alt Cunningham | `q116__alt__stand__stand_around__02` (relaxed, her own 34.8 s loop, no break clips) | own |
| Lizzy Wizzy | `q000__jackie_stand__2h_on_hips__01` (hands on hips, short loop) | generic |
| Mama Welles | `panam__stand__stand_around__02` (hands on hips, 20 break clips) | own workspot |
| Meredith | `bodyguard__stand_ground__2h_front__01` (formal, hands in front) | generic |
| Regina | `generic__stand_ground__stand_around__08` (arms crossed, 8 break clips) | generic |
| Wakako | `generic__stand_ground__stand_around__05` | generic |
| Johnny | `johnny__stand_ground__stand_around__01` | own |
| Kerry | `kerry__stand_ground_stand_around_01` (hands on hips) | own |
| Takemura | `takemura__stand_ground__stand_around__01` (formal, hands at sides) | own |
| Viktor | `ripperdoc__stand_ground_arms_crossed__talk__01` (arms crossed) | generic |
| Mr. Hands | `bodyguard__stand_ground__2h_back__01` | generic |
| Padre | `generic__stand_ground__stand_around__07` (hands raised and held in front; Round 12: that was judged by name, the pose is a right hand held out at belly height, and Padre now rests in `generic_front`, hands folded in front) | generic |
| Mitch | `generic__stand_ground_arms_crossed__stand_around__02` | generic |
| Saul | `saul__stand_ground__stand_around__01` (arms crossed; the loop is the `angry` set, to be watched; Round 12: it was angry and did not fit him, he now rests in the generic hands-at-sides idle) | own |
| Jackie | `jackie__stand_ground__stand_around__01` | own |
| River | `q202__river__stand_ground__stand_around__01` | own workspot |
| Reed | `ep1__reed__stand_ground__stand_around__01` | own |
| Placide | `placide__stand_ground__stand_around__01` | own |
| Pepe | `generic__stand_ground__stand_around__03` (hands on hips) | generic |

No two characters share an idle now (the test `every tier-1 character has an
idle of their own`; the two Johnny records share his). Eight workspots are new
components (`alt`, `jackie_hips`, `panam_hips`, `bodyguard_front`,
`bodyguard_back`, `generic_hold`, `ripperdoc_arms`, `generic_arms_crossed_b`),
each checked on its rig by the idle audit (`idleSources`, enforced by the build:
loop and break clips present in the rig's animsets, no motion extraction, no
props). `generic_hold` (hands raised in front) is the one to look at: its pose
was judged by name only. Alt's hook was added with her profile; this round gives
her an idle of her own.

### Install and checks

Archive rebuilt into `runtime/gestures/package/convai_gestures.archive` (not
installed): **game restart**. CET reload for `mod/gesture-selection.lua`,
`mod/companion-gestures.lua`, `mod/gesture-catalog.lua`.

1. A reply with a gesture workspot: the mouth moves (`speech-state.json`
   `lastSpeech` `jawPeak`/`openFrames` and the screen agree) on Evelyn, Judy,
   Johnny and a man_big.
2. The first gesture of a reply starts after a settled stance, no visible
   twitch; the same for later clips; stepping out of a gesture is smooth.
3. Long replies on Evelyn: no clip twice within about six gestures, no two flicks
   or describes back to back.
4. Idles: Alt, Lizzy, Mama Welles, Meredith, Regina, Padre (hands raised),
   Mr. Hands, Viktor, Pepe look natural and different from each other.

## Round 5b (October 10, evening): the twitch is the stance entry

After the round-5 archive was installed the user still saw a twitch at the start of a reply and just before the hand-on-hip idle, and an abrupt shift from the idle to the talk stance. Live captures (Evelyn, 34 fps crop of her upper body, the head's blue hair and the dress hem tracked frame by frame; probes `start evelyn component=talk|idle`, no Convai turn) and the controller's own log:

- **Entering a mod workspot makes the whole body lurch.** About 0.1 s after the play call the head drops 15-19 px (about 6-8 cm) and the hem 16-30 px in 0.15-0.2 s, the torso swings 8-20 px to the side and back, and the pose is calm again after about 0.5 s, back at the original height. It happens for the talk family (enter blend 1.5 s: head 19 px, hem 30 px, side swing up to 16 px) and for the vanilla hand-on-hip idle (enter blend 0.5 s: head 15 px, hem 16 px). Both look alike in time, so the engine's enter inertialization duration is not what sets it; a 3x longer blend did not make it gentler.
- **The exit is not the problem.** The talk exit is smooth (head under 1 px, nothing visible); the idle exit looked abrupt only because Evelyn walked off (the companion follow resumed).
- **Why Evelyn most: the legs.** Offline foot positions in the hips frame, her ambient locomotion idle (`evelyn_purse_locomotion` `idle_stand`) against the stance loops: 27 cm average per foot against `on_sides`, 24 against `on_hip`; the generic woman's ambient idle is 5-9 cm from the same loops, Rogue 12, Judy 24, Panam 29, Johnny's group 6-13. A 25-30 cm foot and hip reposition inside half a second is the shuffle you see. No stance family in the archives is closer to her purse stance than 24 cm.
- **The real controller repeated it.** The log at 21:48Z shows the talk stance entered four times in ten seconds (begin, `exit movement` 1-4 s later, begin again: V and the follower were moving), and every flavour idle in the last minutes was left within 2-5 s for `movement`. Each begin is one lurch, each exit another. The stance also started again right after every reply ended when the hand-on-hip idle came due (one second after the exit).

Changed (Lua only, CET reload; `mod/companion-gestures.lua`):

1. The talk stance needs 1.0 s of being settled beside V (`policy.talkSettled`).
2. After an exit that was not the normal end (movement, too far, a guard, transport, recovery) no re-entry for 4 s (`reenterDelay`), so a moving V no longer produces a begin/exit loop.
3. The hand-on-hip signature idle waits 45 s after a talk stance ended (`flavourAfterTalk`), so it never follows the reply by a second.
4. The stance is entered while V waits for the reply ('thinking', and it lingers through it), so the entry shuffle is over before the first word. A reply that turns out shorter than 5 s leaves again after the 2.5 s linger.

Not changed, open (needs live A/B, one agent at a time, with the controller paused for the probed companion):

- A slower enter blend for the idle workspot copies (vanilla 0.5 s) next to the vanilla ones, and a longer talk enter blend (2.5-3 s), to see whether the lurch's size follows the duration at all.
- A bridge workspot per ambient stance (an entry sequence that plays the character's own locomotion idle clip and then blends into the stance loop inside the workspot, where clip blends are cross-fades), which removes the foot mismatch at the engine's enter.
- Probing hygiene: the gesture probe runs next to the shipped controller and the companion actuator on the same companion (the probe's auto-unstick also releases the actuator's command); during the 03:20 IST tests Evelyn walked back and forth. Probe only with the controller paused for that companion (the face-stage kill switch covers staged copies only).

## Round 5c (October 10, night): bridge workspots, the stance loop was the jolt

Live A/B on face-staged copies (silenced follow, gestures and seating; the workspot driven directly on the staged copy; 34 fps captures; torso displacement by phase correlation, the largest vertical change inside any 0.2 s window around the play call):

| Workspot entered on Lizzy Wizzy (same body) | Vertical jolt |
|---|---|
| `convai_talk_on_sides` (loop `stand__2h_on_sides__01`), two runs | 22 and 26 px |
| `convai_idle_generic_hip` (Evelyn's own idle) | 17 px |
| `convai_talk_woman_sides` (loop = her ambient `idle_stand`) | 4 and 5 px |
| `convai_talk_on_hips` | 4 px |
| `convai_idle_jackie_hips` | 5 px |
| Panam on `on_sides` | 2 and 3 px |
| live Evelyn: talk, hip idle | 24 and 11 px |

A gesture jump from `idle_stand` to a clip is 8 px, a jump inside `on_sides` 1 px, exits 1-3 px everywhere. So the lurch is set by how far the stance loop's first pose is from the pose she stands in (the same enter blend, 0.5 s or 1.5 s, gives the same lurch), not by the character or the blend time, and a loop that is her own ambient idle enters without it. The 4 s re-entry guard and the 1 s settle (Round 5b) stay; this removes the lurch itself.

**Bridge workspots** (archive; game restart; `mod/companion-gestures.lua`, CET reload): `on_sides` and `arms_crossed` carry `bridge: "idle_stand"` and the relaxed locomotion animset of each rig in their animset lists (`wa_gang`/`ma_gang`/`mb_gang`; Judy's `arms_crossed` uses `wa_judy`). The workspot has two looping sequences, the ambient `idle_stand` first (sequence 100) and the stance loop second (102); the controller:

1. enters on the ambient loop (no lurch, same as `woman_sides`),
2. once the enter blend is over (+ .15 s) jumps instantly to the stance loop (`bridge-in` in the log; clips wait another second),
3. plays gestures from the stance loop as before (clips start and end in it),
4. before any non-instant exit jumps back to the ambient loop (`bridge-out`), waits one second and only then sends the native fast exit; combat, transport and an unobserved tick still leave at once without crossing.

Signature idles (`convai_idle_*`) are separate vanilla workspots and are not bridged: `convai_idle_generic_hip` still lurches 11-17 px on entry. Characters whose own ambient idle differs from the gang one (Panam, Rogue, Jackie, Takemura, Johnny, Kerry, River, Reed, Padre) bridge from the gang idle for now; their own loops exist as the `*_own` families and can get a bridge of their own the same way. To check live after the restart: the entry of the talk stance on Evelyn (the head should no longer drop; `bridge-in` and `bridge-out` lines in `probe.log`), the first gesture a second after the crossing, and no visible shift at the exit.

## Round 5d (October 10, night): the entry clips were the lurch, not the ambient idle

After the Round 5c archive was installed the mouth was fine but Evelyn's body still twitched when V sent a typed message (the stance is entered on 'thinking'). `probe.log` showed the bridge running as designed (`begin`, `bridge-in` two seconds later, `bridge-out` at the end), so the lurch sat at the begin itself. The first guess was that her real ambient idle is not the gang `idle_stand` the bridge starts from (her entity lists `evelyn_purse_locomotion`, 24-28 cm from the stance loops offline). A live A/B on Evelyn (her own copy adopted under the face-stage kill switch, workspots driven directly, 34 fps captures, largest vertical torso change in the 0.2 s around the play call) says otherwise:

| Workspot entered on Evelyn | Entry clips in the workspot | Vertical jolt |
|---|---|---|
| `convai_talk_on_sides` (the bridge; gang ambient first), two runs | yes | 18 and 15 px |
| `convai_idle_generic_hip` (vanilla hip idle copy) | yes | 19 px |
| `convai_talk_woman_sides` (loop = gang `idle_stand`), two runs | no | 2-5 px |
| `convai_talk_judy` (wa_judy ambient) / `panam` / `rogue` | no | 1.5 / 6.5 / 3.5 px |
| `convai_talk_on_hips`, `convai_idle_jackie_hips` | no | 4.5, 2.5 px |

- **The jump to the stance inside the bridge is 1 px**, because she is already in the stance by then: the installed `on_sides` bridge never started on its ambient loop. `on_sides` keeps the template's `workEntryAnim` clips (`walk_0__to__stand__2h_on_sides__01__turn*`); the engine plays one of them on every enter and it lands straight in the stance, that is the 15-19 px lurch. The same clips are in every vanilla idle workspot that has them (the hip idle).
- The gang `idle_stand` is close enough to her real pose (2-5 px), so per-character ambients (Evelyn's purse loop, Panam, Rogue, Jackie, River, Reed, Takemura) are not needed for the entry. `legs.py`'s offline foot distance is not a predictor of the jolt.
- Exits are small everywhere (1-5 px).

Changed (archive; game restart; the catalog is regenerated, CET reload):

1. No stance family keeps the template's `workEntryAnim` clips (bumps and exits stay), so a bridge family now really starts on its first sequence, the ambient loop.
2. Every vanilla idle workspot the mod plays is a mod-owned copy `convai_idle_<name>` (same component names) with the neutral facial idle and without its entry clips. The signature idles therefore enter like `jackie_hips` (2-5 px) with no controller change.
3. `on_sides_plain` (`convai_talk_on_sides_plain`, no bridge, no entry clips, same clips and ids, the catalog shares `on_sides`'s clip table) for a live A/B against the bridge. If the plain entry is as quiet (2-5 px) the bridge and its crossing delays can go: map `characters[...].talk` to `on_sides_plain` in `assets/gestures/gestures.json` (Lua catalog only).
4. `Verify-GestureAssets.mjs` fails the build if any stance or idle workspot keeps an entry clip.

To check live after the restart: the entry of the talk stance on Evelyn when V sends a typed message (the head should no longer drop; `bridge-in`/`bridge-out` in `probe.log`), the hand-on-hip idle's entry, and the A/B of `convai_talk_on_sides` against `convai_talk_on_sides_plain` on a staged copy.

## Round 5e (October 10, night): the device was moved and played in the same tick

Live report on Alex after the Round 5d archive: (1) V looked at her, she turned toward V, but when V sent a message she talked facing elsewhere; (2) V walked about 12 m, turned and asked again: she "spawned behind, walked a bit backwards and then back in position". `probe.log` and `movement-trace.ndjson` (companion brain phase, command, speed, position and gap per sample; the trace clock runs about 0.88 of wall time, anchored on the 09:03:09Z `stranded` line = trace clock 226.0):

- Alex's gesture device was kept from her earlier stance and flavour idle. At every later begin the controller called `moveDevice` (a teleport of the device) and, in the same tick, `PlayInDevice`. The workspot plays at the device's transform and the teleport lands a frame or more later, so the play used the device's previous spot and yaw.
- (1) The device had been placed at her pre-turn yaw (the 09:01:17Z flavour idle); her attention turn ran afterwards; the 09:02:15Z begin entered with the old yaw.
- (2) V had walked 12 m, Alex followed and was in `attend` (trace 241.2, gap 1.3 m) when the 09:03:30Z begin played at the device's last spot, 12.3 m back at (-1603.9, 354.0), her old stance spot (trace 244.4, gap 12.3 m, command `follow` enqueued); `exit too far` in the same second, a `stranded` recovery at 09:03:32Z, then she walked back (trace 245.5-253.9). That is the visible teleport plus the walk back.
- A separate, earlier relocation at 09:03:09Z (trace 226.0: Alex 6 m back while catching up, `Companion recovery stranded gap 13.5`) happened with no gesture state for her (none since 09:02:34Z): it is `companions.lua` recovery after V moved 12 m fast, not this change.

Changed (Lua only, CET reload; `mod/companion-gestures.lua`, `mod/gesture-workspot.lua`):

1. **The device is placed, checked, then played.** After the move the controller compares the device's world position (0.12 m) and yaw (8 degrees) with hers (`gesture-workspot.devicePlaced`) every tick and plays only when it matches; it re-sends the move every 0.4 s and, if it has not followed after 1.5 s, deletes the device and spawns a new one at her pose (`device-replaced` in the log). She stays held, not walking, for that second. Nothing runs per frame outside an entry in progress.
2. **The talk stance waits until she has turned.** A begin needs `facingError` (her angle to V, the same value the attention behaviour uses) at most 35 degrees; while she is still in her attention turn the stance does not start, and the stance is then placed at her pose and yaw. Walking and unsettled states were already refused (`idle`, `settled`, social phases only), and a begin is refused beyond 4 m.
3. Tests: a kept device that has not followed is not played, a device that never follows is replaced, and the stance waits for the turn.

To check live: V looks at a companion who had a stance or idle earlier, she turns, V sends a message: she stays facing V in the stance (`probe.log` `begin` then `play`, no `device-replaced` normally); V walks off 10 m and asks again: no relocation at the begin.

## Round 5f (October 10, night): the bridge itself was the slide, so the bridge is gone

Live report on Lizzy and then Evelyn after Round 5e: she faces V, but when a message is sent she "goes back a bit smoothly, like she is sliding, just a bit". A first guess (the ambient clip's blend-out, 2.4 s) did not change it live.

Measured live on Evelyn (her own copy under the face-stage kill switch, workspots driven directly by a temporary probe file, 36 fps window capture, phase correlation on head and body with the constant per-frame bias fitted out; half-resolution pixels, about 190 px per metre):

| Workspot entered | What the capture shows |
|---|---|
| `convai_talk_on_sides` (the bridge: gang `idle_stand` first, jump to the stance 2 s later), two runs | after the play call she moves about 8-13 px down and 4-5 px sideways over about 1.2 s (the enter blend from her own idle to the gang ambient), then a second quick 4-5 px shift at the jump that settles over 1-1.8 s |
| `convai_talk_on_sides_plain` (no bridge, the stance loop is the first sequence) | nothing beyond +/-1.5 px of ordinary sway |

The entity itself never moves: its world position and yaw were logged every tick during the whole bridge run and stay constant to 0.01 cm with `inWorkspot` true, `probe.log` has no `device-replaced`, and the movement trace is flat. The slide is the animation: the gang ambient's root and pose differ from her own idle by several centimetres, and the bridge makes her blend there first and then across to the stance. The Round 5d jolt metric (largest change in a 0.2 s window) could not see a slow glide of this kind, which is why the bridge looked fine then.

Since Round 5d the stance workspots have no entry clips, so the reason for the bridge (the entry lurch) is gone and a stance loop can be entered directly, as `woman_sides` and the plain variant always were.

Changed (archive, game restart, then a CET reload; `assets/gestures/gestures.json`, `scripts/Build-GestureAssets.mjs`, `mod/companion-gestures.lua`, `mod/gesture-catalog.lua`):

1. `on_sides` and `arms_crossed` lose `bridge`: the stance loop is the first sequence (ids 100/101), the ambient `idle_stand` sequence and the loose locomotion animsets of those two families are gone. `on_sides_plain` is removed (identical now).
2. The controller no longer has the bridge machinery (jump in after the enter blend, `bridge-out` before the exit, the `leaving` phase, `bridgeBlend`/`bridgeLead`, the 5f settle). The first gesture again waits only for the enter blend (1.5 s) plus `firstClipMargin`; the exit is the native fast exit. Signature idles and combat or transport exits never used the bridge.
3. Tests: the bridge tests are replaced by one that checks a stance is entered directly, gestures come after the enter blend and the exit is the plain fast exit, and that no family has a bridge.

To check live after the restart: send a message to a companion standing still; she should keep her place and only her arms settle into the stance (no downward drift, no second shift about 2 s later).

## Round 5g (October 11): a fresh copy hovers 30 cm above the floor until she moves, so the stance floated

Live report with the Round 5f archive (bridge removed): when V spoke to a freshly invited Evelyn she floated up and came back down once her reply was done.

Cause, from `movement-trace.ndjson` and a live floor query (no capture needed for the cause): the entity z of a fresh copy is the navmesh height, not the floor. In V's apartment the navmesh at her spot is 49.4-49.5 and the Static floor is 49.2 (raycast down from Evelyn and from V, 49.200). Evelyn and Blue Moon both attached at z = 49.50 (V stands at 49.20). A copy that only holds, attends or sits in a workspot keeps that height; Blue Moon dropped to 49.20 the moment she walked (`attend_step`), and Evelyn's z went 49.50 (before and during the whole stance, 18:58:30 to 18:59:07 UTC) to 49.30 right after the workspot exit and 49.24 a moment later. The workspot never moved her: the entity z is constant through the stance (the device is placed at her entity position). So the stance did not raise her, it kept her up and the exit let her settle. A live check on a staged Evelyn standing at the floor (z 49.20): a stance enter and exit shows no rise (a few px, no float).

Changed (Lua only, CET reload; `mod/companions.lua`): at attach, before she is first drawn, one Static raycast straight down from 60 cm above her to 80 cm below; when the floor is 5-35 cm below her feet she is teleported straight down onto it (same x, y and yaw). It is charged to the shared spatial budget (one query per spawn) and defers the attach when the frame's budget is spent. Anything else (no floor found, already on it, a bigger gap) is left alone. The navmesh is not used as ground: here it is the wrong height. `loweredBy` appears in the companion diagnostics dump.

Tests: a copy 30 cm high is lowered once at attach and keeps her yaw; one 1 cm high is left alone; the query-budget test now counts the one extra ray per attach (144 to 152).

To check live (needs a fresh invite: Leave V's Party, then follow again, or a restart): the new copy stands on the floor at once (movement trace z = floor, no 0.3 higher value), and a stance neither lifts her nor drops her at the exit.

## Round 6 (October 11): gestures and a hip idle for every companion not in the catalog

Live: Blue Moon (a tier-2 contact, record `Character.sq017_blue_moon`) showed no signature idle and no gestures, because the controller only acts for records listed under `characters` (29 of them, all tier-1). Every other contact, every model-only copy and any record added later had nothing.

Changed (Lua only, CET reload, no archive; `assets/gestures/gestures.json` `generic`, the generated `mod/gesture-catalog.lua`, `mod/companion-gestures.lua`, `mod/gesture-workspot.lua`): a fallback for any record that is not in `characters`.

- The copy's body type is read once (`npc:GetBodyType()`, lower case without separators) and cached per copy; an unreadable value is retried at most every 5 s, an unmapped one never. Nothing runs per frame beyond a table lookup: the decision sits behind the same checks as before (setting on, settled beside V, speech or a flavour due).
- `womanaverage` takes the `woman_sides` talk family and the one-hand-on-hip idle (`generic_hip`); `manaverage` takes `man_sides` and the folded-arms idle (`generic_arms_crossed`); `manbig` takes `big_sides` and the hands-on-hips idle for big bodies (`generic_hips_big`). The talk loop of those families is the rig's own relaxed `idle_stand`, so entering shows no pose change (Round 5d), and only clips that checked clean on that rig play (the same pools as the tier-1 `on_sides`, centred and neutral hand gestures). Each idle is only used on rigs where `idleSources` says it checked clean, which the build enforces.
- Left out on purpose: `ManFat` and `ManMassive` bodies and anything unmapped (mechs, animals, unreadable), and the records in `generic.never`: Adam Smasher (man_massive) and Dexter (the man_fat rig has no talk families), both rejected in Round 5. A record that is in `characters` never reads the body type.
- The catalog only gained the `generic` block; the families and sequence ids are unchanged, so the installed Round 5f archive (`a71aa51e...`) is still the right one.
- Tests: each of the three body types talks from its family, gestures only with valid clips, leaves, reads the body type once and takes its hip idle after a long settle; ManFat gets nothing and is decided once; an unreadable body type is retried after 5 s and works when readable; Smasher and Dexter never read it; Judy still uses her own catalog row; the catalog's mapping is complete and checked.

Live result and fix (same day): the first CET reload did nothing for Blue Moon (setting on, `attend`, 1.3 m, standing still, no `begin` or `flavour-begin` for the new copy). Cause: `npc:GetBodyType()` returns a CName and `tostring()` of one prints `ToCName{ hash_lo = 0x02871D38, hash_hi = 0xA1219CE9 --[[ WomanAverage --]] }`, which normalises to `tocnamehashlo...womanaverage`, not `womanaverage`, so the body type never matched `generic.bodyTypes` and every copy was decided as unmapped. The offline tests stubbed the read with plain strings. `gesture-workspot.lua` `bodyType` now resolves the CName with `NameToString` and falls back to the name inside the `--[[ ... --]]` comment; a new test feeds it that exact CName form. (The same `tostring(GetBodyType())` pattern sits in `companion-tactics.lua` and `companions.lua`'s diagnostics; those are left alone.)

To check live (CET reload): invite Blue Moon, stand beside her, send a typed message: she enters the hands-at-sides talk stance (`begin` with `convai_talk_woman_sides` in `probe.log`), gestures during a reply, and after about 45-90 s of standing she takes the hand-on-hip idle.

Real signature idles for tier-2 characters need their own vanilla workspot or animset (found by quest id: sq017 Blue Moon, sq021 Joss, sq023 Rachel, q101 Spider Murphy, mq303 Lina and Shank, mq019 Liam, mq038 Dennis, mq040 Cynthia and so on), a gestures.json idle row plus `idleSources` check, and a rebuilt archive (game restart). The Round 5 survey only covered tier-1 names, so those workspots are not extracted yet.


## Round 6b (October 11): Blue Moon's slide, idles from the start, a pool per rig

Live with the Round 6 fallback installed: Blue Moon "slides back" on the talk entry. The movement trace shows her entity does not move (x -1606.502, y 356.153, z 49.2 through every entry), so it is a pose blend, the same kind as 5f.

**Measurement** (Blue Moon staged under the face-stage kill switch, each workspot driven directly through a temporary probe, 36 fps captures, torso tracked by its dominant clothing colour: area, centre x and y over the 3 s after `play`; `scripts` scratch tooling, files removed afterwards; the vertical-jolt number of Round 5 cannot see a depth or sideways drift):

| Workspot on Blue Moon | Torso drift 0-3 s after play (half-resolution px) |
|---|---|
| `convai_talk_woman_sides` (loop = gang `idle_stand`), two runs | centre -15 x, +6..10 y, area +8-9 %, steady, no recovery |
| `convai_talk_on_sides` (stance loop), two runs | -4 / -7 x, area 0.97-0.99 |
| `convai_talk_on_hips` | +4 x, area 0.97 |
| `convai_idle_jackie_hips`, `panam_hips`, `alt` | within 6 px on entry and exit |
| `convai_idle_generic_hip` (Evelyn's and the Round 6 fallback idle) | 40-59 px sideways swing at 2 s, back by 3.5 s, in both runs |
| `generic_hips`, `generic_back`, `generic_hold`, `bodyguard_*`, arms-crossed idles | varies with the idle's own break clips or changes the torso shape too much to judge this way |

The `woman_sides` loop is the gang `idle_stand`; it matched Evelyn's ambient pose but not Blue Moon's, so the 1.5 s enter blend crossed from one to the other. The `on_sides` stance loop is what every catalogued character uses and showed no drift.

Changed (Lua, catalog, no archive change beyond the Blue Moon idle component):
- The generic fallback talks from `on_sides` on all three rigs, not from `woman_sides`, `man_sides` or `big_sides` (those families stay in the archive, unused).
- A pool of idles per rig (`generic.rigs[rig].idles`): women `jackie_hips`, `panam_hips`, `generic_hips`; men `generic_arms_crossed`, `generic`; big men `generic_hips_big`, `generic`, `jackie_hips`. `generic_hip` is out of the generic pool (the lurch). Each is checked on its rig by the build. With `generic.mix` the pool is also added to every catalogued character's own idle, so each one rotates; the controller picks a random one each time and never the one she just had when there is a choice.
- Idles start as soon as she has been settled for 1.5 s (a copy that never talked included), no first-idle timer; the gap to the next one is 10-25 s after the end of the last (idle length 25-50 s); five seconds after the end of a reply (`flavourAfterTalk`, was 45); the idle also waits until she has turned toward V (`facingError` within 35 degrees, like the talk stance). Nothing is added per frame.
- Blue Moon is a catalogued character now: `Character.sq017_blue_moon`, talk `on_sides`, signature idle `uscracks_cute` (the sq017_18 US Cracks stage workspot `uscracks__stand_stage__cute__01`: the dirtgirl hip loop with shuffles, a spin and poses, no props).

Signature-idle survey of the Top 11 (workspot and animset names by quest id, offline; extracted to `E:\CyberpunkConvai-offload\work\signature-tier2\`): only Blue Moon has a prop-free standing idle of her own (US Cracks, sq017). Yorinobu (q113: fallen, sitting on the ground), T-Bug (q005 sitting), Spider Murphy (q101: cyberdeck, q304: aiming a gun), Joss (sq021: at the microwave), Rachel (sq023: leaning on a car), Lina (mq303: chair), Shank (mq303: mop, bar, cell), Carol (sq027/q202: chair, tablet), Aaron (mq306: seated, lying in a chair) and Coach Fred (no workspot found) have none that stands without a prop or a piece of furniture, so they keep the generic fallback and its pool.

To check live (archive and Lua installed, game restarted): Blue Moon enters the talk stance without sliding back, takes an idle about 1.5 s after she settles beside V and five seconds after each reply, and the idle never repeats twice in a row.

### Round 6b follow-up (October 11): per-character check, Judy, Alex, Saul, Johnny, Alt

All 29 catalogued characters were checked live (staged under the kill switch, talk entry, signature idle and one pool idle driven directly, torso tracked at 36 fps, then where she rests 3.5 s after each exit against the 0.3 s before the play). Every talk entry, idle and exit is clean except as noted:

- **Judy**: her `arms_crossed` talk loop moved her about 15 % closer to V and 22 px sideways on entry; her own-ambient family `judy_own` (`convai_talk_judy`, loop `idle_stand`) measures 0-3 px on entry and exit and rests at area 0.99, cx -1. Catalog only.
- **Alex**: `on_sides` left her about 24 px off with area 0.88 after the exit; `arms_crossed` and `woman_sides` moved her about 21-23 px; `on_hips` put her hands on her hips. `judy_own` measures area 1.00, cx +3 on entry, cx -1 on exit, rests at cx +1, and keeps her arms-crossed look. Talk is now `judy_own` (catalog only).
- **Saul, Johnny**: the shifts seen on the exit of their own idles were pose changes (arms crossed to arms down), not slides. Both rest at the pre-play spot (area 1.00-1.02, cx within 1 px). No change.
- **Alt**: clean once her data was installed (talk area 1.03, idle 1.00, exit 0.99).
- Evelyn keeps `generic_hip` in her rotation by decision. No character needed the step-back or weight-shift fallback.

### Round 5g follow-up (October 11): the attach snap did not hold for Alt

Live on a fresh invite of Alt (V and the Static floor at z 49.200): the attach snap ran (`loweredBy` 0.30 for both Evelyn and Alt, read through a read-only probe), yet `movement-trace.ndjson` shows Alt at z 49.500 from her first sample, 49.359 and 49.254 over the next 6 s as she turned (`attend_turn`), 49.241 and 49.200 at her first `attend_step`, and then 49.200 for good. The teleport inside `attachFollower` is undone by what follows it (`SetAIRole`, `ai:OnAttach()` put the copy back on the navmesh). The lowering now runs 0.5 s after attach (`settleOnFloor` in `mod/companions.lua`, called from the update loop only while `entry.floorFix` exists), re-checks 1 s later if she was moved, and stops after two tries; tests in `bridge/companion-placement.test.mjs`.

## Round 7 (October 13): twisted legs, a wrong diagnosis (reverted)

A screenshot of Judy with her legs twisted at the shins led first to the Round 6b `judy_own` talk loop (ambient idle 37.6 cm from every arms-crossed clip's feet, and no leg gap in the catalog for ambient-loop families). The user says the twist is older than Round 6b, so that change was reverted and nothing in the controller or catalog was changed. Still true as data: the arms-crossed clips and Judy's ambient idle differ by 37.6 cm and the build gives ambient-loop families no leg gap. Not established as a cause of anything seen live. The re-face after V moves and looks again was audited: no code path turns or steps her while a workspot holds her; the step (`attend_step`) starts as soon as the workspot exit finishes (`probe.log` 21:20:31Z `exit movement`, trace `settled` then `attend_step` 0.6 s later), during the exit pose blend. Unproven; open.

## Round 8 (October 13): no gesture over a crouch

Live (Carol Emeka, probe.log 09:48Z): V crouched, `Companion stance: crouch`; 14 s later an idle flavour gesture began (`flavour-begin`), the stance module saw her in a workspot and stood her (`stand - workspot`), crouched her again two seconds later, and the gesture exited `not relaxed`; when V stood the stand was logged, yet she stayed crouched.

Rule now: a workspot and a crouch never overlap. `companions.lua` passes `crouched` in the observe context (V is crouched, or the stance module holds this copy crouched, or its stand is not yet confirmed). With it set, no idle or talk stance starts, and one that is running or starting leaves at once with the fast exit (reason `crouching`, log `exit`). `companion-stance.lua` waits while the workspot is still there (`Companion stance: crouch waiting - workspot`, once) and crouches when it ends. Idle gestures also do not run while V is in combat, as before. V in stealth is a crouch, so it is covered by the same flag.

## Round 9 (October 13): leave the workspot, let the pose blend out, then walk

The movement check watches V (0.75 m from the anchor taken when the workspot began, running, or the group frame moving for 0.8 s), and the follow is suppressed while a workspot holds the copy. After the exit signal the workspot is left within a tick, but the pose blends out for about 0.5 s more; the follow used to start in that window. `exitSettle` (0.4 s) now keeps the copy held after any non-instant exit; combat and transport exits stay instant. `Gestures drift` is logged once per workspot if the body moves more than 15 cm while held (Evelyn, 10:02:00Z: 0.24 m with V standing still, 45 s into `convai_idle_panam_hips`, cause not found).

## Round 10 (October 14): group listeners

Phase 2 listed "group listener nods" as open: until now only the one companion V talks to (the microphone's entity) nodded while V spoke; in a group round (V talking to two or three companions at once, or one companion answering after another) the others stood in whatever they were doing, and a signature idle could even start while a neighbour spoke.

Built (Lua only, CET reload; no archive, nothing per frame):

- `mod/group-chat.lua` `roleOf(entity)` reads the round's own fields: `nil` (no round, not a member, or an add-on voice), `'recording'` (V is speaking the group utterance), `'reply'` plus the speaker's entity (a reply is being written or heard), `'between'` (the next speaker is being prepared or the round has just begun). Three comparisons at most.
- `mod/companion-gestures.lua` `modeFor`: after the copy's own speech, a member of a round is never `nil`. During the microphone she is `listening` (group pacing); while another member's reply of at least 5 s (the same estimate as for gestures, 2.6 words/s) is heard she is `listening` with the speaker's remaining time and phrase timing; otherwise (a short reply, between speakers, the speaker herself waiting) she is `thinking`, which only holds the stance. So the stance is entered when the round starts, kept across the speaker changes (no leave-and-enter between speakers, no idle starting mid-round) and left 2.5 s after the round ends, the same linger as after a reply. A copy outside the round gets `nil` from the lookup and behaves as before; with the setting Off the round is never asked about (a test counts the calls).
- `mod/gesture-selection.lua` group pacing (`groupFirst` 3-7 s, `groupGap` 8-16 s; one-to-one listening stays 2-4 s and 5-10 s): the first nod is 3-7 s into a speaker's reply (the clock restarts for each new speaker's reply and for the microphone), then at most one every 8-16 s after the nod ends; never into the last 1.2 s, never in a reply under 5 s, only a nod that fits (70 % of its length) the remaining speech, and inside the 0.7 s after a phrase start when the speaker's phrase timing is known. Only the `nod` category plays, never the same clip twice running.
- Stagger: two listeners of one round never start a nod within 2 s of each other (`policy.groupStagger`, one number on the controller), so three heads do not bob together.
- `Gestures gesture` log lines for a listener carry `group = true`.

Tests: `bridge/gesture-selection.test.mjs` (pacing, bounds, short reply, phrase window, restart per speaker), `bridge/companion-gestures.test.mjs` (three copies: listeners keep one stance, only nod, 1-3 nods in a 24 s reply 8 s or more apart; the speaker still gestures; two listeners 2 s apart over 110 s; short reply, no nod and no exit; between speakers no exit and no re-entry, then one exit each after the round; microphone: all three nod after 3 s; outside copy and Off), `bridge/group-chat.test.mjs` (`roleOf` across text and voice rounds and an add-on voice).

To check live (Developer mode for `Gestures` lines in `probe.log`; two or three companions standing within 4 m of V, hands-at-sides or any catalogued ones; a group chat by text, then by voice):
1. Send one group message: each member enters the talk stance once (`begin`), the first speaker gestures, the others only nod (`gesture` lines with `group: true`, category `nod`), about one nod per listener per reply, never together.
2. A reply of one sentence: nobody nods; nobody leaves the stance between that speaker and the next.
3. The round ends: each leaves with `reply ended` about 2.5 s later, no second `begin` in between.
4. Group voice: while you speak, all members nod now and then, the first one 3 s or later into your speech.
5. A fourth companion beside you who is not in the round does not take the stance, nods or exits.

## Round 11 (October 15): an idle that walks the body away from a still V

Live 2026-10-14 (Alex, V standing still the whole time): her idle workspot convai_idle_generic_hips (vanilla emale__stand_around__02) carried her body 0.7 m at +25 s and 2 m at +30 s into the idle (1.2 to 2 m/s, the follow command hold already Interrupted, no mod walk, no teleport); idle_alex and idle_jackie_hips never moved her. The idle scheduler (45 to 90 s idle, 20 to 45 s gap) made the slides recur. policy.travellingIdles (generic_hips) is never picked; and an idle flavour whose body moves more than policy.driftExit (0.45 m) from where the workspot began, V still, is left at once (drift-exit line, inished reason drifted) and its idle key is not picked again this session (self.travelling). 15 to 25 cm of settling stays. V walking away still ends every idle with movement.

## Round 12 (October 15): prop idles, Johnny's flavour, Padre and Saul measured

Phase 2 items built without the game: the cigarette cleanup, Judy and Panam prop idles, Johnny's flavour animations, a better idle for Saul, and a data check of Padre's `generic_hold`. Everything below was read from the extracted animation and workspot data (`scripts/Audit-PropIdles.mjs`, WolvenKit JSON of the workspots and the animsets they load) and from hips-frame forward kinematics of the exported clips; nothing was played in the game. The live checks at the end are what is still open.

### How a prop gets into a hand, from the data

The prop is not spawned by the mod. A clip carries an `animAnimEvent_WorkspotItem` with a `workEquipItemToSlotAction` (an `Items.*` record and `AttachmentSlots.WeaponRight` or `WeaponLeft`) at frame 0, or the workspot lists the same action in its `initialActions`. The workspot's `itemsPolicy` (SpawnItemOnIdleChange, DespawnItemOnIdleChange, DespawnItemOnReaction) says when the engine removes it again. The mod's idle workspots are copies of the vanilla ones, so they carry the same events; the prop appears and should leave without the controller touching anything. The controller therefore does not guess: the item and slot of each prop idle are in the catalog (`propIdles`, generated from `assets/gestures/gestures.json`, shape enforced by the build), and the cleanup removes exactly that item from exactly that slot.

| Idle key | Workspot | Prop (item record, slot, where the data equips it) |
|---|---|---|
| `johnny_smoke` | `johnny__stand_ground_cigarette__idle__01` | cigarette `Items.crowd_cigarette_i_stick`, WeaponLeft (`lh_cigarette__aggressive__01`, `cig_equip` at frame 0; ember effect on the item, smoke effects on the puff clips) |
| `johnny_shades` | `johnny__stand_ground_glasses__stand_around__02` | his specs `Items.crowd_int_apparel_002__h0_001_ma_specs__silverhand`, WeaponRight (`rh_glasses__01`, `glasses_equip`) |
| `judy_coffee` | `generic__stand_ground_coffee__drink__01` | paper cup `Items.takeout_cup_a_small`, WeaponRight (`stand__rh_cup__01`, cup event at frame 0) |
| `panam_beer` | `generic__stand_ground_bottle__drink__01` | bottle `Items.crowd__bottle_k_beer`, WeaponRight (`stand__rh_bottle__01`, bottle event at frame 0) |

Rejected on the data: Judy's BD-headset workspot (no equip event anywhere in it, so the prop would have been invisible; the coffee cup replaced it).

### What the controller does (`mod/companion-gestures.lua`, `mod/gesture-workspot.lua`)

All of it runs on demand, never per frame. With the catalog's `propIdles` and the two new natives present:

1. **Start.** A prop idle is picked like any other idle of her pool. Before it starts, one read of its hand slot(s) (`slotItem`): if the hand holds anything that is not empty fists, a prop-free idle is played instead (log `props-busy`), so a weapon in her hand is never fought over.
2. **One look.** 2.5 s after the idle became active (`policy.propLook`) the slot is read once more. `props-seen`: the declared item is there. `props-other`: something else is in the hand (noted only). `props-missing`: empty. A key whose prop is missing twice (`policy.propMisses`) is dropped for the session (`props-disabled`): an idle that drinks from nothing is worse than no idle.
3. **Cleanup.** After the idle ends, whatever ended it (flavour time, a conversation, movement, combat, a failed start, `release`), the declared item is taken out of the slot at 0.5 s and again at 3 s (`policy.propCleanup`, jobs held in a table that is empty except for those seconds). `clearSlot` reads the slot, leaves anything that is not the declared item alone (`other`), removes it with `RemoveItemFromSlot` (then `RemoveItem` if it is still there) and reports `removed`, `empty`, `other` or `stuck`; only a removal or trouble is logged (`props-clear`). The engine's own despawn normally leaves the slot empty already, so the log line is the live answer to whether the engine cleaned up. `abandon` (world teardown) clears the jobs and makes no native call.
4. **Kill switches.** `M.policy.propIdles = false` turns every prop idle off; an old `gesture-workspot.lua` without the natives means no prop idle is ever picked.

The cigarette was the Round 4 "experimental" idle (cleanup unverified, so it was never in a pool). It is now Johnny's `johnny_smoke` with this cleanup.

### Build changes

- `idleOptions.<key>.endless`: the vanilla coffee, bottle, crossed-arms, aggressive and glasses workspots play a few break clips and then leave through their own exit, which would end the idle while the controller thinks it still plays (the seats did exactly that, `docs/COMPANION_SEATING.md`). Their break list is set to a clip count that is never reached and the sequence repeats; entries, exits and fast exit are untouched. The copies' entry clips are dropped as for every idle.
- `idleOptions.<key>.omitClips`: `generic_front` loses `stand__2h_front__01__shuffle__05`, which the man rig does not carry (a missing clip would stall the workspot).
- Validation: every character's `idles` pool must have a workspot and a rig check; `propIdles` need a workspot, a checked source and `Items.*` records in a hand slot; the catalog now carries `propIdles` in place of `experimentalIdles`.

### Johnny

Both Johnny records (`Character.Silverhand`, `CyberpunkConvai.JohnnyCompanion`) keep `johnny` and gain a pool of four more of his own workspots, all on `man_base`, all with complete clip sets and no motion extraction: `johnny_crossed` (`stand_around__02`, arms crossed, wait, shuffles, look around), `johnny_aggressive` (`2h_on_sides__aggressive__01`, look back, look around, shuffles), `johnny_smoke` and `johnny_shades` (above). The generic mix of the rig's clean idles stays in his pool as before; two consecutive idles are never the same.

### Judy and Panam

`judy_coffee` joins Judy's pool, `panam_beer` Panam's; both are generic workspots on `woman_base` (right-hand cup or bottle, drink and shuffle clips; the bottle also yawns and checks the bottle). They are the prop idles of the two women; the rest of their rotation is unchanged.

### Padre and Saul

- **Padre's `generic_hold`.** Measured from the animation (hips-frame kinematics, hands relative to the hips): the right hand is held out at belly height, 10 cm above the hips and 20 cm forward, the left hangs at the side. It is not "hands raised", so it was a wrong fit for a man who should look calm. `generic_hold` stays in the catalog (relabelled, used by nobody). Padre now rests in `generic_front` (`generic__stand_ground__stand_around__04`, hands folded in front at belt height, 11 cm apart) with `generic_back` (hands behind the back) as his second idle.
- **Saul.** His own workspot loop is `saul__stand__arms_crossed_front__angry__01`: hands crossed at the chest, 29-33 cm above the hips, from the `angry` set. It did not fit the character. He now rests in the relaxed generic hands-at-sides idle (`generic`) with `generic_back` as his second; the note on his catalog row says why. The test that required every listed character to have a non-generic signature idle excludes him on purpose.

### Tests

`bridge/companion-gestures.test.mjs` (fake hand slots; the existing seeded idle tests only needed Johnny's pool and Saul's choice updated): a prop idle starts with a free hand, is looked at once, and its declared item and slot are cleaned in two passes with a quiet second pass and no further native call; a busy hand gets a prop-free idle and nothing is ever cleared; empty fists are free and a foreign item found at the look is `props-other`; two misses drop a prop idle for the session and it is never picked again, with cleanup still scheduled; no natives or the kill switch means no prop idle at all; release still cleans and abandon makes no native call; the catalog declares every prop idle completely (component, source, `Items.*` records in hand slots, the right rig, never a primary idle) and Padre and Saul's rows are as described.

### Together with the drift exit (Round 11)

The new idles go through Round 11's drift exit like every other idle: a flavour idle that carries the body more than `policy.driftExit` (45 cm) with V still is left at once (`drift-exit`, `finished` reason `drifted`) and its key is banned for the session (`self.travelling`). A prop idle that drifts also runs its prop cleanup, because the cleanup is scheduled in `finish`, which every exit reaches (a test drives a cigarette idle through it). `policy.travellingIdles` (`generic_hips`) is filtered out of the pool before the prop and busy-hand logic, so a prop-free fallback never brings it back.

### Install

Archive rebuilt into `E:\CyberpunkConvai-offload\work\gesture-assets-p3\package\convai_gestures.archive` (nothing installed): **game restart** is needed for the new idle workspots. CET reload for `mod/companion-gestures.lua`, `mod/gesture-workspot.lua`, `mod/gesture-catalog.lua`. All committed `mod/` files get installed; `diagnostics.lua` never.

### To check live (Developer mode for `Gestures` lines in `probe.log`; Johnny, Judy and Panam as companions, one at a time, standing within 4 m of V)

1. Johnny, a cigarette idle (`flavour-begin` with `convai_idle_johnny_smoke`): is a cigarette in his left hand, does it glow, and is he puffing? About 2.5 s in, `props-seen`. When the idle ends: is the hand empty (nothing stuck to it, no floating cigarette)? `props-clear` lines are only for a removal; none means the engine had already despawned it.
2. Johnny, the sunglasses idle: specs in the right hand, `props-seen`, gone afterwards. Then the crossed-arms and aggressive idles: pose, shuffles, and that none of them ends by itself before 45-90 s (`flavour ended` should be the only reason).
3. Judy with the cup and Panam with the bottle: item in the right hand, drinking clips look right, `props-seen`. If `props-missing` shows twice for a key the idle is dropped for the session; the line also tells which keys the engine does not equip on this mod's copied workspot.
4. Hand busy: give a companion a drawn weapon, wait for an idle: `props-busy` and a prop-free idle, the weapon untouched.
5. Entry and exit of the new idles: the blend into and out of each pose, whether the legs cross, and the first seconds after a prop idle ends for any leftover item.
6. Padre in the hands-folded idle and Saul in hands-at-sides: do they look calm and fitting.

## Round 13 (October 15): one stance for the whole conversation

Live (the user, Alex in a conversation): "she ping-pongs between hands folded when she has no gesture, and then upright for a gesture". Two causes, both found in the data and in `probe.log` (Alex, serial 6, 23:19-23:21Z).

1. **The talk loop was not the pose the gestures start and end in.** Alex and Judy talked from `judy_own`: the workspot loops Judy's ambient `idle_stand` while every clip it plays (`stand__arms_crossed_front__01__*`, `judy__stand_2h_arms_crossed__01__gesture*`) starts and ends in the `stand__arms_crossed_front__01` base pose. Measured on the exports in the hips frame (up, side, forward, cm): the loop's head is at (55.6, -8.3, 24.9) and the base's at (61.8, 3.0, 9.5), 20 cm apart (15 cm further forward, 6 cm lower); the chest differs by 7.6 cm and the left hand by 13 cm (and the Round 7 note records 37.6 cm at the feet). So between gestures she sank into the slouched folded-hands loop and each gesture popped her upright and back. The other ambient-loop families (`panam_own`, `woman_sides` and the like, loop `idle_stand` too) are unused by the catalog; every other family loops its own clips' base pose.
2. **The stance was left and re-entered between every turn.** After a reply the stance lasted 2.5 s (`policy.linger`), then she went back to her vanilla idle, and 5 s after that a flavour idle could start; the next turn's thinking or listening exited the idle (`conversation`) and entered the stance again. The log shows it: `begin` 23:19:38, `reply ended` 23:19:55, `begin` 23:20:01, `reply ended` 23:20:21, `flavour-begin` (her own idle) 23:20:26.

Changed:
- Judy and Alex talk from the `arms_crossed` family (loop = the clips' own base pose, legs fit-checked) instead of `judy_own`. Catalog only (`assets/gestures/gestures.json`, `mod/gesture-catalog.lua`): the `convai_talk_arms_crossed` workspot is already in the installed archive, so a CET reload is enough. `judy_own` stays in the catalog, unused. What it costs: the Round 6b measurement that `arms_crossed` moved Judy about 15 % closer and 22 px sideways on entry and back on exit; that is now once per conversation, not once per gesture.
- `policy.conversationHold = 20` replaces the 2.5 s linger for the talk stance: any conversation activity (speech, a short reply, listening, thinking, a group round) holds the stance, and it is left once 20 s have passed without any (reason still `reply ended`). `policy.linger` is no longer used for the stance.
- A flavour, signature or prop idle starts only `conversationHold + flavourAfterTalk` (25 s) after the last conversation activity (`s.talkedAt`, one number set in `observe`), short replies included. The talk stance itself is not an idle, so it never brings a folded-arms or prop idle back. The drift exit, the prop cleanup and the travelling-idle ban are unchanged; nothing runs per frame beyond the existing tick.
- Test: `m.policy.conversationHold = 2.5` in the fixture keeps the older tests' timing; new tests set 20 (one stance across two turns and the grace, only clips or the loop jumped to, an idle giving way once, short replies, catalog: no character talks from an ambient loop, Judy and Alex on `arms_crossed`).

To check live (Developer mode; Alex, then Judy): 1. Talk to her over several turns: she goes into the arms-crossed stance once (`begin`), gestures start from and return to the same upright pose, no sinking in between. 2. Stay quiet after a reply: she keeps the stance about 20 s, leaves it (`reply ended`), and an idle starts no sooner than about 5 s after that. 3. Watch the entry and exit of the stance for a sideways shift or step towards V (it is once per conversation now); if it is bad, say so and the family can be switched back (one catalog line) while a fitted loop is built.

## Round 14 (October 16): interesting idles come up early and often; Johnny's worn glasses hide during his glasses idle

Live (the user): the cigarette came only after a while, and for many characters the plain idles seemed to come first. Johnny's last log (serial 2, 2026-10-16 07:56-08:00Z): `generic_arms_crossed` at spawn, a talk stance, then `johnny_smoke` (07:58:56) and `johnny_shades` (08:00:40). There is no warm-up, unlock gate, first-idle delay or plain-first rule in the controller; the pick was a uniform random over the pool, which for Johnny is seven idles of which two are plain generics, and the cadence was slow (gap 20-45 s after the last idle, each idle 45-90 s: about 105 s per idle, so one particular idle of seven took ten minutes on average). Prop load latency is not a cause: the log shows `props-seen` 3 s after `flavour-begin`.

- **Weighted random pick** (`pickIdle`, `policy.interestingBonus = 2.75`, the one constant to tune): an interesting idle (a prop idle, or an idle whose `idleSources` kind is not `generic` and that is not part of the rig's generic mix) weighs 2.75 times a plain generic idle. Still random: no forced order. Never the idle just played, never a prop idle straight after a prop idle (relaxed only when nothing else is left). Johnny: five interesting idles (13.75) against two plain (2): about 87 % interesting, a prop idle about 35 % of the time as the first pick.
- **Cadence**: gap 8-20 s (was 20-45) and length 40-75 s (was 45-90), about 70 s per idle instead of 105. Each idle begin and end is still one pose blend; the idle count rises by about half.
- **Worn glasses** (`hideComponents` on a `propIdles` entry, optional list of plain substrings of visual component names): Johnny's `johnny_shades` holds his aviators in the hand while the pair on his face stays on. From `silverhand.app` (extracted read-only from `basegame_4_appearance.archive`): the copy's appearance `riot__not_blendable` carries the mesh component `h1_001_ma_specs__silverhand3152`; `riot__no_glasses` does not. `hideComponents = {"ma_specs__silverhand"}`. `native.setComponentsVisible(npc, names, visible)` (`mod/gesture-workspot.lua`) toggles the matching visual components (one component walk, at idle start and end only). The controller hides when the idle becomes `active` (log `worn-hidden`) and shows again in `finish`, `fail`, `release` and when a copy leaves the rows, immediately and again at the cleanup passes (0.5 s, 3 s; idempotent). `abandon` makes no native call; a respawned copy is a new entity with the glasses on. `policy.hideComponents = false` is the kill switch; an old `gesture-workspot.lua` without the native just plays the idle. Not covered: the `AppearanceProxyMesh` component (the distant-LOD proxy mesh of the appearance also shows the glasses; at idle viewing distance the full mesh is used).
- Install: CET reload for `mod/companion-gestures.lua`, `mod/gesture-workspot.lua`, `mod/gesture-catalog.lua`; no archive change, no bridge restart.
- To check live: Johnny's sunglasses idle: the glasses on his face vanish as he raises the pair in his hand and are back when the idle ends (also if V walks off or a fight starts); `worn-hidden` in `probe.log`. If the face glasses stay, the component name differs on the live copy: run a probe that lists `npc:GetComponents()` names containing `specs` on the copy.

## Round 15 (October 16): idles hold whole cycles of their own loop clip; a two-idle pool may repeat

Live (the user, Johnny, 2026-10-16 08:36Z): `convai_idle_johnny_aggressive` "looped a couple of times" (its hold was a random 40 s here), while `johnny_shades` (50 s) looked right. Same log, 08:20-08:36Z: one companion with a two-idle pool played `convai_idle_alex` and `convai_idle_jackie_hips` strictly alternately for sixteen minutes. Cause of the second: the pool was alex + the rig's generic mix (jackie_hips, panam_hips, generic_hips), but `generic_hips` is never picked (`policy.travellingIdles`) and `panam_hips` had drifted at 07:23Z and 08:02Z (`drift-exit`, learned in `self.travelling` for the session), so two idles were left and no-immediate-repeat forced A-B-A-B. An uncatalogued ManAverage or WomanAverage copy starts with that two-idle pool by design.

- **Where the lengths come from.** The idle workspots the catalog plays are vanilla workspots; the build only edits their break lists. `scripts/Measure-IdleCycles.mjs` reads the same WolvenKit JSON the build uses (the extracted workspot, and the animsets listed in its `finalAnimsets` for each rig) and takes the duration of the loop clip, the `idleAnim` of the main sequence (the first sequence outside a reaction that has a break list), for each rig. The animsets for the idles added in rounds 12-14 (Johnny's aggressive, glasses and cigarette sets, the cup and bottle sets, the generic hips and arms-crossed sets) were extracted read-only with the vendored WolvenKit CLI from `basegame_4_animation.archive` and `ep1_2_gamedata.archive` into a scratch folder (nothing is installed or rebuilt). Result: `assets/gestures/idle-cycles.json` (37 idles; per rig seconds, plus the break-list shape for reference), which `Build-GestureAssets.mjs` copies into the catalog as `idleCycles`. `mod/gesture-catalog.lua` was regenerated by running the build script alone on the latest extracted inputs (`gesture-assets-p3uild-4009...`): the diff against the committed catalog is only the new `idleCycles` table (no archive rebuilt, no resource changed). To refresh: `node scripts/Measure-IdleCycles.mjs --workspots <json dir> --animsets <json dir>... `, then the build.
- **Loop clips found** (seconds; man_base unless noted): johnny 25.47, johnny_aggressive 25.47, johnny_crossed 22, johnny_smoke 11, johnny_shades 10, generic 25.47 (woman_base 34.8), generic_arms_crossed and alex and songbird 22, jackie_hips and generic_hips 10, panam_hips 10, kerry 10, takemura 25.47, judy 10, misty 8.83, rogue 13.77, saul's own 4.17, hanako 11.37, placide 13.37, reed 25.47, generic_back 9.73, judy_coffee 10, panam_beer 3.8-5.3. The workspot is: the loop clip plays while the body waits, the break list (3-5 clips of 3-11 s, or more for the generic sets) plays one clip after another with a pause of `pauseBetweenLength +- pauseLengthDeviation` (mostly 4 s +- 1, 7 +- 4 for Johnny's aggressive and crossed sets) between them; the build's `endless` option repeats that list for ever.
- **The hold** (`cycleHold` in `mod/companion-gestures.lua`): one cycle for a loop clip of `policy.shortCycle` (12) s or more; a shorter clip runs two cycles, or the whole cycles that reach `policy.cycleMinimum` (15) s (a 4 s clip: four). The count starts at the `play` call (the loop clip starts with the workspot) and the exit signal goes `policy.cycleLead` (0.15 s) before the cycle end, because the workspot leaves 0.1 s after the signal (log `exitLatency` 0.10); the pose then blends out from the end of a cycle, not mid-motion. Johnny's aggressive idle: 25.47 s instead of 40-75 s; Alex and generic arms-crossed: 22 s; the 10 s hips idles: 20 s; generic man_base 25.5 s. The `flavour-begin` log line now carries `hold` and `cycles`. Not cycle-held, they keep the random 40-75 s: prop idles (their loop clip is the held-prop pose and the action is in the breaks: `johnny_smoke`, `johnny_shades` which looked right live, `judy_coffee`, `panam_beer`), an idle or rig with no measured cycle, and any hold beyond `flavourLength[2]` (a long pose-and-hold). `policy.cycleHold = false` switches it all off.
- **Cadence.** The gap between idles is unchanged (8-20 s). Idles get shorter (about 20-25 s instead of 40-75 s), so about 35 s per idle instead of 70 s: more begin and end pose blends, each of the old size. A side effect to watch: the drift exits in the logs came at 54-62 s into an idle; most holds now end well before that.
- **Two-idle pools.** The rig's generic idles already join every catalogued character's pool (`catalog.generic.mix`), so that is not the lever; a pool of exactly two (counted after the never-picked and learned-travelling idles) now repeats the last idle with `policy.repeatChance` = 0.3 (one random draw; the repeat is returned directly, so it is 30 % exactly), never a prop idle. Three or more idles never repeat; props are never twice in a row; the interesting-idle weighting (`interestingBonus` 2.75), the glasses hide and restore, stop-on-move, fight exits and drift handling are untouched.
- **Cost.** Nothing per frame: the hold is one table lookup when an idle begins and one assignment at the play call.
- **Not verified live.** Whether the loop clip's phase really lines up with the hold (the break clips and their pauses run inside it), and whether a 20 s hold of a 10 s loop reads as one idle; the aggressive idle is the one to look at, and the glasses one should look as before.
- Install: CET reload for `mod/companion-gestures.lua` and `mod/gesture-catalog.lua`; no archive, no bridge restart.

## Round 16 (October 16): look-alike idles never follow each other; longer pose blends into and out of the idles

Live (the user, Johnny, 2026-10-16): "he did hands folded animation twice in a row ... we should kind of also have two similar-ish animations not play in a row, also can you make the transition from animation to base stance a little more smoother". `probe.log`: `convai_idle_generic_arms_crossed` at 08:59:46, then `convai_idle_johnny_crossed` at 09:00:21: two different clips that both look arms-crossed.

### 1. Visual similarity groups

Every idle workspot has one group (`idleGroups` in `assets/gestures/gestures.json`, described in `idleGroupNotes`; the build requires a group for every idle workspot, a description for every group, and no group row without a workspot, and writes `idleGroups` into the catalog). Assigned from the loop clip named in `assets/gestures/idle-cycles.json` and the `idleSources` description:

| Group | Idles (loop clip) |
|---|---|
| `arms_crossed` | `alex`, `songbird`, `generic_arms_crossed`, `ripperdoc_arms`, `generic_arms_crossed_b` (`arms_crossed_front__01`), `rogue` (`arms_crossed_front__03`), `saul` (`arms_crossed_front__angry__01`), `johnny_crossed` (`johnny__stand__arms_crossed_front__01`) |
| `hands_on_hips` | `judy`, `uscracks_cute` (`dirt__stand__2h_on_hip__01`), `kerry`, `jackie_hips`, `generic_hips_big` (`2h_on_hip__01`), `panam_hips`, `generic_hips` (`2h_on_hip__02`), `panam`, `generic_hip` (`rh_on_hip__01`, one hand) |
| `hands_at_sides` | `generic`, `takemura`, `reed`, `placide`, `river`, `alt` (`2h_on_sides*`), `jackie` (`stand__relaxed__01`) |
| `hands_front` | `hanako` (`2h_front`), `misty` (`2h_hold`), `bodyguard_front`, `generic_front` (`2h_front__01`) |
| `hands_behind_back` | `generic_back`, `bodyguard_back` (`2h_back__01`) |
| `hand_in_pocket` | `johnny` (`lh_pocket__01`) |
| `hand_held_out` | `generic_hold` (`gesture_hold`) |
| `tense` | `johnny_aggressive` (`2h_on_sides__aggressive__01`: hands at the sides but a confrontational stance) |
| `smoking` | `johnny_smoke` (`lh_cigarette`) |
| `glasses` | `johnny_shades` (`rh_glasses`) |
| `drinking` | `judy_coffee` (`rh_cup`), `panam_beer` (`rh_bottle`) |

Pick (`pickIdle`, `mod/companion-gestures.lua`): three passes. Pass 1: not the idle just played, no prop idle after a prop idle, and not an idle of the previous idle's group. Pass 2 (nothing left): a look-alike may follow. Pass 3 (still nothing): a prop idle may follow a prop idle (the Round 14 fallback). The interesting-idle weight (`interestingBonus`), the glasses hide, cycle holds and the two-idle-pool repeat (`repeatChance`, one draw before the passes) are untouched. A catalog without `idleGroups` behaves as before.

Effects worth knowing: Johnny's `johnny_crossed` and `generic_arms_crossed` can no longer follow each other (his seven idles run in six groups). A character whose pool is mostly one look alternates: Judy has three hips idles (`judy`, `jackie_hips`, `panam_hips`; `generic_hips` is never picked) and one coffee idle, so after a hips idle only the coffee idle is left and she goes hips, coffee, hips, coffee (Panam the same with the beer; Alex alternates `alex` and a hips idle). That is the rule working as asked, not a bug; if a prop idle then feels too frequent, the lever is a softer rule (a chance to ignore the group), not data. A pool whose idles are all of one group falls back to the earlier rules.

### 2. Pose blends into and out of an idle

How it works (read from the extracted vanilla workspots: `inertializationDurationEnter`, `...ExitNatural`, `...ExitForced` on the workspot tree; all 37 idle copies carry the vanilla values):

- **Enter**: `PlayInDevice` starts the workspot; the engine inertializes from the companion's current pose into the idle's first pose over `inertializationDurationEnter`: **0.5 s** in the vanilla idle workspots.
- **Exit**: the controller sends `SendFastExitSignal` (the only exit that leaves the AI queue healthy); the workspot is left about 0.1 s later (log `exitLatency` 0.10-0.12) and the pose inertializes into the locomotion idle over `inertializationDurationExitForced`: **0.2 s** in the idle workspots (natural exit 0.5 s, used only if a workspot leaves by itself). That 0.2 s is the abrupt return to the base stance. The talk stances already use enter 1.5, natural exit 1.4, forced exit 0.5 (Round 5), which is why they looked smoother than the idles.
- **No runtime control**: the natives the controller uses carry no blend time (`PlayInDevice`: state flavour, component names, slide time, slide behaviour; `SendFastExitSignal`: direction, stay-if-failed, slow-exit-if-failed, instant, blend-to-walk), and the workspot tree is a resource. A Lua-side blend would mean per-frame pose work, which is out of the question.

What changed:

- `assets/gestures/gestures.json` `idleBlend`: enter **0.9 s**, natural exit **0.8 s**, forced exit **0.8 s**. `scripts/Build-GestureAssets.mjs` writes them into every `convai_idle_*` workspot copy (talk stances and seats keep their own values, checked by a test and by `Verify-GestureAssets.mjs` after the binary round trip) and into the catalog as `idleBlend`. The generated copies were produced into a scratch folder to confirm; **the archive was not rebuilt**.
- Controller (`mod/companion-gestures.lua`, Lua only, CET reload): after an idle exit that is not instant the copy stays held for `max(exitSettle, catalog.idleBlend.exitForced)` (was a fixed 0.4 s), so movement and the follow never start while the pose is still blending out; the prop clean-up passes wait for the part of the blend-out longer than the vanilla 0.2 s (`policy.vanillaExitBlend`) so a cigarette or cup does not vanish from the hand mid-blend; `finished` logs `blendOut`. An older catalog without `idleBlend` keeps the plain 0.4 s.
- **The exit signal timing is unchanged on purpose**: it goes `cycleLead` (0.15 s) before the end of the cycle of the idle's own loop clip, where the clip is back at its base pose, and the longer blend-out then runs after the hold (the engine fades the old pose out; the clip is not played on). Moving the signal earlier would cut the idle mid-motion. The enter blend does not shift the cycle count either (the clip starts at the `play` call).
- Not changed: the worn-glasses restore (`showWorn`) still happens at the exit, so during the 0.8 s blend-out both the held aviators and the face pair can show; the talk stance start after an idle `conversation` exit does not wait for the blend-out (reply latency comes first).

**This needs the archive rebuilt.** Until the gesture archive is rebuilt and installed, the idle workspots keep 0.5 / 0.5 / 0.2 s; the Lua change alone only makes the hold after each exit 0.4 s longer (the settle follows the catalog's 0.8 s) and delays prop removal by 0.6 s. What the rebuild changes, exactly: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Build-GestureAssets.ps1` extracts fresh inputs, runs the build (which now sets the three blend fields of the 37 idle workspot copies; nothing else in any workspot differs) and packs `convai_gestures.archive` (do not let `Refresh-ReleaseData` overwrite the committed one with an untested build). A game restart is needed for the new archive. Not verified: the Round 5b/5c measurements say the entry lurch's size follows how far the loop's first pose is from the standing pose, not the blend duration (a 3x longer blend did not make it gentler there), so the longer enter may soften the pose switch less than the exit does; the exit's 0.2 s was the shortest blend of the three.

Tests (`bridge/companion-gestures.test.mjs`): the groups cover every idle and match the data file; Johnny over thousands of picks never plays two look-alikes in a row and his two arms-crossed idles never follow each other; the same with a busy hand; the all-one-group fallback keeps the earlier rules and keeps turning; an older catalog behaves as before; Judy alternates; `idleBlend` is 0.6-1.0 s, longer than vanilla and passed through as set; the build (skipped when the extracted data is not on the machine) writes the blends into every idle copy and leaves stances and seats alone; the hold after an exit follows the catalog's blend-out (0.8 s, 1.5 s, none); the exit signal stays at the cycle end whatever the blend and the copy is held for the blend that follows. Three older tests changed (the hold after an exit is 0.8 s in two of them, prop removal waits for the blend-out in one).

To check live (after the archive rebuild and a game restart; Developer mode): 1. Johnny over ten minutes: no two arms-crossed idles in a row (`flavour-begin` lines: `convai_idle_johnny_crossed` and `convai_idle_generic_arms_crossed` never adjacent). 2. The start and end of each idle: the pose should ease in and out over about a second with no snap to the base stance; say if the end is still abrupt (the forced blend can go to 1.0-1.2 s) or the start still lurches. 3. The cigarette and glasses idles: the item leaves the hand after the blend-out, not during it.
