# Companion body gestures

Companions use the game's own conversation gestures while they speak, nod
while they listen, and take their own idle stance while they stand near V.
The feature is being built in stages; **Stage 0 (a development probe) is the
current state**. Nothing plays unless the probe is installed and asked to.

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

The mod ships `convai_gestures.archive` with two new resources:

- `cyberpunk_convai\gestures\convai_gestures.workspot`: cloned from vanilla
  `big__stand_ground__stand_around__01.workspot` (EP1 copy). It keeps the
  walk entries, exits, fast exit and bump reactions, drops crowd Fear
  reactions, and holds one looping idle sequence (`stand__2h_on_sides__01`)
  plus one sequence per gesture clip, with the per-rig animsets above.
- `cyberpunk_convai\gestures\convai_gesture_device.ent`: an invisible
  gameObject with workspot components only — `convai_gestures` and one
  `convai_idle_<character>` per signature idle workspot.

The device is spawned at the companion's feet (DynamicEntitySystem, tag
`CyberpunkConvaiGestureDevice`, not persistent). The companion enters with
`DontPlayAtResourcePosition`, clips are chosen with `SendJumpToAnimEnt`, and
the controller jumps back to the idle loop when a clip ends. Exit is
`SendFastExitSignal`; a watchdog escalates to `StopNpcInWorkspot` (0.6 s) and
`StopInDevice` (1.2 s). Combat uses the instant stop.

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

## Selection policy

`mod/gesture-selection.lua` is pure (no native calls; `npm run test:gestures`).
The controller calls `next(state, input)` every tick with the clock, mode
(`speaking`, `listening`, `thinking`, `idle`), rig, character key, emotion
family and scale (from `facial-playback.lua`), remaining speech seconds and
the generated catalog; it returns a clip to start now or nil.

- **Speaking:** first clip 0.3–0.8 s after speech starts; then clip duration
  plus a gap of 1.5–4 s (scale 1), 1.2–3 s (2) or 0.8–2 s (3), divided by the
  character's rate (Takemura .7, Viktor .85, Johnny 1.2, Panam/Kerry 1.15 …).
  60 % of picks use the emotion's categories (joy → happy/emphatic, sadness →
  sad, anger → angry, surprise → surprise/question …), the rest calm talk or a
  shrug. A clip starts only if 70 % of it fits the remaining speech and never
  in the last 1.2 s.
- **Listening:** a nod 2–4 s in, then every clip + 5–10 s; nods may repeat.
- **Thinking / idle:** no clips; idle uses the character's signature idle
  component (`idleComponent`), else `convai_idle_generic`.
- **Repetition:** never the previous clip; avoid the last four and anything
  used in the last 30 s, relaxed only when nothing else fits. Character clips
  (e.g. Takemura's own talk) weigh 3×.
- **Never played:** threaten, middle finger, clap, thumbs-up, cheer, dance,
  and anything with steps or turns.

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

## Stages

0. Probe (this). Decide: hold kept vs suspended, start API, clip/idle
   behaviour, face and gaze interplay, interrupt latency, vehicle exit.
1. `companion-gestures.lua` controller behind the setting (default Off):
   speaking gestures, safety gates, watchdog, diagnostics, fixture tests.
2. Emotion/intensity mapping, per-rig catalog, character clips.
3. Listening nods (V speaking, group chat), signature idles when settled.
4. MCM string in all locales, docs, TODO log.
