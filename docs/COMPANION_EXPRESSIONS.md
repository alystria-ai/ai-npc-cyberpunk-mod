# Companion expressions

## October 9 (final summary of the face round): what changed, what we found, how to use the probe

**Global changes (product code, CET reload).** Default joy .74 (smile 1.65, squint 1.3, Judy .50) with a joy-only lift
`w x (1 + .5 x (1 - w))`; surprise brows in .80 / out .90, eyes wide .70 (widen cap .7); resting smile and frowns
unscaled. The real emotion path was measured first: brows and frowns reached 65-91% of the captured scale-3 pose at
typical weights, the smile only 41-57%, which is why only joy got a lift. No other family was retuned.

**Per-head findings** (all 23 tier-1 characters can be invited and staged; Johnny has no phone contact but stages; Takemura,
Viktor and Wakako need the long spawn wait). Judged on `runtime/face-captures/check/*.png` and the earlier tier-1 sheets:
- Read well: Mama Welles, Regina, River, Rogue, Mr Hands, Pepe, Meredith, Kerry, Jackie, Takemura, Wakako, Claire, Evelyn,
  Alex, Panam (vanilla, frontal, readable although backlit).
- Weaker, left as judgement calls: joy is mild on Regina, River and Rogue (the mouth corners barely move on those
  heads; a per-head `smile` gain would fix it if wanted); Johnny and Viktor wear sunglasses (brows hidden, the mouth and
  beard carry the emotion); Lizzy's chrome face reads weakly; Solomon, Songbird and Misty are dark because the room has a
  bright window behind the characters (turn V so the window is behind the camera to light faces).
- Identity (via `face-stage check`: record, appearance, display name): Mama Welles `Character.Mama_Welles` /
  `gang__valentinos_wa__sq018__mama_welles`; Regina `Character.reggie` / `service__fixer_wa__regina_jones`; River
  `Character.Sobchak` / `river_ward_default`; Rogue `Character.Rogue` / `rogue_rogue_old`. All are the game's own
  appearances for those characters; no archive mod touches them (appearance archives exist only for Panam, now removed, and
  Misty, kept on purpose). Our definitions are right; nothing was changed. Proof: `runtime/face-captures/identity-check.png`.
- Turn-away on anger is not a gameplay bug: it was the copy's own AI settling in the first ~20 s after spawning (a
  controlled neutral vs anger experiment turned away equally). Anger frames of Mr Hands, Pepe, Meredith and Kerry stand
  steady, facing the camera.

**The probe and the kill switch** (dev only; `mod/face-test.lua`, never in a player package, only `face-test.lua` can be
hot-reloaded with `run face-test-reload`). `Send-FaceStage.ps1 -Character <key>` stages one character 0.85 m in front of V;
`-Action check` returns off-spot distance, body turn, seconds since the last placement, the real head position on screen,
`steady`, `inFrame`, `silenced`, `frozen`, `looking`, `faceDot` (how the head bone points against the camera, y near -1 is
frontal) and the copy's record, appearance and display name; `-Action look` gives the staged copy a strong look-at on V's
eyes (the vanilla idle looks around and down); `-Action freeze` slows the copy to 2% time (individual time dilation, finite
30 s and refreshed every 15 s, so a reload or crash lets it run out) while the facial AnimFeature keeps updating (verified:
smile and brows still appear), which stops the idle sway; `thaw`, `unlook`, `off` and `dismiss` undo them. The kill switch
`convaiCompanions.devQuiet` (keyed by serial; set while a stage is held, cleared on off, dismiss or a CET reload; nil in the
shipped mod) removes the staged copy from `M.update`'s `ready` list so none of our layers (follow, turning, body animation,
gestures, look-at) touch her. Bug found and fixed on the way: the probe's context rows carry no `serial`, so the switch
never engaged until the serial was resolved from the companion list (`54ceb4a`). A capture batch: stage, wait `steady`,
`look`, `freeze` when `faceDot` y < -.96, then per pose send the face-test command, wait for a calm head, capture the crop
around the projected head, re-check, retry at most 3 times, never re-shoot a character that passed.

**Known limits.** Sunglasses hide brows; Lizzy's chrome face and dark faces against a bright window read weakly; the
frozen body keeps whatever pose it had when frozen (the head is faced with the look-at first); time dilation also slows hair
physics, so a stray strand can look stretched; the old `tier1-sheet-A..D.png` and `tier1/` frames were made with older code
and mixed methods, so treat them as superseded by the `check/` sheets.

## October 9 (smile and surprise round): fuller default smile, a stronger surprise, a safer face-stage

**Default smile.** Evelyn's joy at .585 barely read, Jackie's was modest and Panam's corners at .85 read as a clear
natural smile (`runtime/face-captures/smile-surprise-sheet.png`). The default multiplier `smile` in `traitTable`
(`mod/facial-playback.lua`, mirrored by `expressionTarget`/`mixTarget` in `bridge/companion-expressions.mjs`) is now 1.65
(was 1.3): joy 3 writes .45 x 1.65 = .74 on every default head (Evelyn, Jackie, Panam and the rest), trust 3 .58, and
scale-2 trust while speaking about .33 (was .26). Judy stays .7 x gain 1.6 = .504. The resting smile (.12 default, .18
warm, Judy .19) and the frowns are not scaled, so nobody grins at rest. A bigger mouth with the old .27 cheek squint looked
mouth-only, so there is a second per-character factor `squint` (default 1.3, Judy 1): the Duchenne squint follows the
emotion's raw smile times it (.27 -> .35 on default heads, Judy's .43 unchanged). Captures with the .75 corners and the .35
squint (writer mode) on Evelyn, Jackie and Panam read as an open natural smile, not a grin.

**Surprise.** The recipe is brows in .60 -> .80 (outer stays .90, at the brow cap) and widened eyes .55 -> .70 (the widen
cap .6 -> .7). A jaw drop or lip part was not added: `jaw_mid_open` and the lip controls belong to the speech writer, and
surprise is a one-second flick that mostly happens while a reply is being spoken, so a second owner of the mouth would
fight lip sync. Surprise stays a momentary flick (full for 1 s, gone by 2 s). Important finding: the earlier "surprise is
weak on every head" captures were partly an artefact of the probe, not only of the recipe: the policy probe was captured
4 s after it started, when the flick had already faded. `face-test` now keeps the flick at its peak in policy mode, and
at the peak the old recipe already lifted Jackie's brows visibly. The new recipe is clearly wider on Jackie and Evelyn
(eyes open, brows high), and on Judy (her brows already rest high) it reads natural, not startled; none of the heads shows
a distorted lid or brow. Panam's brows sit under her fringe, so on her only the eyes change much (and her look comes
from installed appearance mods, so she is pending a re-capture after the next restart).

**Tests** (`companion-expressions.test.mjs`, `companion-expression-playback.test.mjs`): surprise in .80 / out .90 / widen
.70 and the widen cap .7; default joy .7425 with the squint .351 and Judy joy .504 through the real Lua writer;
Trust 2 while speaking .29-.37.

**Face-stage fixes after captures overlapped.** A raw sequence of invites could leave the previous probe copy standing
on the spot while the next character was placed (Alex was stacked on another character). Now: `face-stage <key>` first
dismisses the characters this probe invited earlier (except the one asked for) and waits until each is really gone
(state `clearing`, `leaving` in the status); `Send-FaceStage.ps1 -Action dismiss` waits until they are gone too; the
spot moves sideways by .8 m when another owned companion stands within .6 m of it; nobody is placed on V (the spot is
.85 m ahead); only the current stage is held (a new stage replaces the old one) and its hold-position command lasts 8 s
and is re-sent every 4 s, so it ends soon after the stage. A walking companion kept leaving the spot, which cost
placements, so the stage also sends `AIHoldPositionCommand` (optional: a game without the class still stages). Tests: the
`face-stage probe` case now covers the wait for the previous copy and the sidestep.

**Joy lift (real emotion path).** Measured through the real writer: typical tagged weights reach about 65-91% of the
captured scale-3 pose for brows and frowns, but the smile only 41-57% (the plan's `toWeight` score x .85 and the trait
range, then the mix curve). Joy alone now gets `w x (1 + .5 x (1 - w))` (`smileLift` in both the Lua writer and the
pure mirror, version 8); other families keep `w^mixCurve`, trust is unchanged, the resting smile and frowns are not
scaled. A typical tagged joy line now reaches about two thirds of the captured smile. Needs a CET reload.

**Dev kill switch for staged characters.** `convaiCompanions.devQuiet` (table keyed by companion serial, set only by
`mod/face-test.lua` while a stage is held, cleared on unstage, dismiss and `off`) is read once per `M.update` in
`mod/companions.lua` and removes those companions from the `ready` list, so the companion update stops steering,
following and facing them while the probe has full control. Nil in the shipped mod, never persisted (a CET reload or
crash leaves it off), no per-frame work beyond one table read and a loop over `ready` that only runs when it is set.
Not yet verified in game (needs a CET reload); `face-stage check` reports `silenced`.

**Face-stage check.** `face-stage check` (on request only) returns off-spot distance, body yaw error, seconds since the
last placement, the real head bone projected to the screen (headX, headY, headZ), `steady`, `inFrame` and `silenced`,
plus the record id, appearance name and display name of the copy (for identity checks). The capture batch crops on the
projected head, waits for `steady`, re-checks after each frame and retries at most 3 times per pose, then logs
`BAD-FRAME` and moves on; a character that passed is never re-shot.

**Turn-away on anger.** Controlled experiment (`runtime/face-captures/turn/`, eight neutral and ten anger frames) shows
the characters turned away just after spawning (the AI settles in the first ~20 s) and in neutral frames as often as in
anger frames; no code path reacts to the anger pose with a turn (grep of the face and companion code). It is not a
gameplay bug; the probe now waits for `steady` and holds position.

**Judy spawning.** Only probe invitations (this session ran several stage batches that include Judy); the mod has no
path that re-summons her, and the stage dismisses probe copies.

## October 9 (later): smile calibration per head, Evelyn, who gets what, and the face-stage probe

**Smile (user: happy stretches Judy's smile).** Judy's joy wrote corners .45 x her gain 1.6 = .72, which the user
found stretched. Evelyn (woman_average_sermo, gain 1) was measured with the `writer` probe at corners .45 / .65 / .85
(each with the .6 cheek squint): .45 is a faint, closed-mouth smile, .65 a natural smile, .85 a broad one
(`runtime/face-captures/live59/ev-smile-*.png`). So the two heads need opposite corrections. New per-character
`smile` multiplier in `traitTable` (`mod/facial-playback.lua`, mirrored as the `smile` parameter of `expressionTarget`
and `mixTarget`): it scales only the EMOTION's smile, never the resting smile, frowns or the squint.
Judy .7: joy .504 written (was .72), trust .39, warm tagged lines about .16 (was .19); her resting smile is
unchanged (.192) and her cheek squint stays at .43 (it follows the unscaled smile). Everyone else 1.3: joy .585
(was .45), trust .455 (was .35); their resting smile is unchanged. Tests changed accordingly (Judy joy .504, default
trust .22-.29, Judy tagged joy at least .18, warm at least .14). Verified in game (CET reloaded):
the capture pair on Judy and Evelyn; verified live in the stage round below.

**Evelyn.** She is a managed companion copy (the probes find her in the owned rows) with status
`prepared:woman_average_sermo`, so the layer applies to her; the quest/scene skip (`547904e`, `RequestWorldFace`) only
concerns world NPCs and returns "managed" for copies. All controls work on her (captures `ev-*.png` in
`runtime/face-captures/live59/`: anger, sad, worried, surprise, joy all move her face). What looked "not great":
- her native rest face has knitted, lowered brows and pressed dark lips, so her neutral already reads stern. Anger
  and disgust gain little contrast against it, and brow raises (surprise, joy's brows) have to climb out of it. The
  rig clamps pose inputs at 0, so this cannot be pulled below rest; the solution would be a per-rig raise gain, not
  done (no measurement of a case that is wrong yet);
- the smile at .45 was weak on her head (fixed above);
- her sad pose is strong and reads clearly (inner brows up, heavy lids), anger now reads as a scowl.
No evidence of a weaker blendshape response or a resting offset beyond that brow state; a different head (average
woman) just needs a bigger smile than Judy's.

**Do the improvements apply to every character?** From the code, not the docs:
- Recipes and caps are global: `familyPoses`, `expressionLimit`, the mix curve, mouth budget, the blink and the sad
  gaze are the same for every actor (`mod/facial-playback.lua`, `bridge/companion-expressions.mjs`).
- Per-character data are only `traitTable` entries keyed by profile key: `warmth` (resting smile), `gain` (corner
  gain, Judy 1.6, others 1), `browDown` (Judy 1.25 for her high resting brows, nobody else) and the new `smile`
  (Judy .7, others 1.3), plus the bridge's manner (expressive, open, reserved, cold: intensity and evidence for a
  smile). So the Judy-specific calibrations are her gain, her browDown and her smile .7; nobody else gets them, and
  characters whose own rest brows are low (Evelyn) have no compensation.
- Which actors get the 59-control graph: every companion copy the manager spawns (story companions and archetype or
  pedestrian copies alike, all tagged `CyberpunkConvaiCompanion`) whose `face_rig` graph is one of the nine in
  `assets/facial/controls.json`: `man_average`, `man_big`, `man_fat`, `woman_average`, `player_man_photomode`,
  `player_woman_photomode` (Judy), the player paperdoll pair and `pma_paperdoll`. A copy on any other graph reports
  `unsupported-graph` and keeps its native face. World NPCs get it only on demand when V talks to them (at most two,
  never one in a scene or dialogue or a quest-bound record).
- Male heads are covered by the archive (`man_average`, `man_big`, `man_fat`, same 59 controls); all 800 extracted
  game lines carry the same 414 rig tracks, so the rig check passes for men too. A live male capture is pending the
  stage probe, see the live stage round below (Jackie: all poses work).

**Face-stage probe** (`mod/face-test.lua`, `scripts/Send-FaceStage.ps1`; development only: `face-test.lua` is in
`scripts/development-files.json` and in no player package, and the writer loads it only when the file exists).
A capture batch never needs the user to frame anyone:
```
.\scripts\Send-FaceStage.ps1 -Character evelyn-parker          # waits until she stands in front of the camera
.\scripts\Send-FaceTest.ps1 "face-test evelyn browsdown 20 policy"
python scripts/Capture-GameWindow.py --hwnd ... --crop ...        # the face is about 1.1 m from the camera
.\scripts\Send-FaceStage.ps1 -Action off | -Action dismiss | -Action status
```
`face-stage <key> [hold]` through the same request file as `face-test`: a present copy of that key is reused,
otherwise it is invited through the real party queue (`convaiManager.party().invite`; a raw `convaiCompanions.spawn`
is refused by `canSpawn`) and waited for (30 s). Then, for the hold (default 60 s, at most 300), it is checked every
.1 s and, only when she is more than .08 m or 6 degrees off the spot and at most every .25 s, an `AITeleportCommand`
through her AI controller puts her .85 m along V's camera direction (horizontal, V's floor) rotated to face the
camera. A plain transform teleport does not work: an AI-driven companion's locomotion undoes it within a tick (Evelyn
stayed beside V). Her own gaze on V is untouched. `off` releases her to her own movement, `dismiss` dismisses (queue
`dismiss`) only the copies the probe invited, `status` returns `spawning|staged|released|lost|failed`. Nothing per frame,
no new hooks, and a failure inside the tick is caught and reported as `failed`. The probe was hot-reloaded without a
CET reload: copy the committed `face-test.lua` into the mod folder and run `Send-GestureProbe.ps1 "run <name>"` with a
runtime file doing `dofile('face-test.lua')`. Limits: only companion definition keys can be invited; archetype
profile keys (`npc-street-resident-female`) answer "That character model is unavailable", so an archetype head cannot
be staged this way. Test: `face-stage probe` in `companion-expression-playback.test.mjs` (geometry, reuse, invite,
AI teleport and put-back, off, dismiss of only its own copies).

**Live stage round (probe worked on Evelyn, Judy, Jackie and Panam; sheet `runtime/face-captures/stage-round-sheet.png`,
frames `live59/st-*.png`).**
- Judy happy, before (writer corners .72) against after (.504): before is a slightly stretched wide smile, after a
  soft natural one. The change is right; her other poses (anger, sad, worried, surprise) read well.
- Evelyn joy after the change (.585): a modest closed-lip smile. Reads as pleased, not broad; her stern rest face limits
  contrast, as above. Anger scowls, sad is strong, worried and surprise read. No change made (one head, one sample;
  a default smile of .65 would be the next step).
- Jackie (`man_big`): the full pose set moves the male head with no distortion or broken region. Anger is a bit mild
  (stern, annoyed); the Judy browDown gain written by hand was not clearly better, so no change. Sad, worried read;
  joy is modest and surprise weak but visible.
- Panam (`woman_average`, second female head): all poses work. Joy at .585 is modest; written corners .85 read as a
  clear natural smile, .65 was similar to the current one. Her head drifts a little between frames (idle animation),
  so use a larger crop than Judy's.
- Nothing was clearly broken; every probe-created copy was dismissed afterwards.

## October 9 (morning): live run of the 59-control face on Judy, and a stronger anger

Judy in V's apartment at conversation distance (1370 x 815 window, face about 130 px high), the installed 59-control
archive, `face-test` probe (`policy` mode for the real scale-3 poses, `writer` mode for exact values),
`scripts/Capture-GameWindow.py` crops, no other game input. Sheet: `runtime/face-captures/judy-59-sheet.png`
(neutral, angry before and after, sad, worried, happy, surprised); single frames in `runtime/face-captures/live59/`.

**Reads at that distance (strong poses):**
- happy: yes (corners up with the cheek squint), unchanged.
- surprised: yes (brows high, eyes wide); modest.
- worried: yes (inner and outer brows up, widened eyes, small frown); reads as alarmed or worried, distinct from sad.
- sad: yes (inner brows up, heavy lids, corners down, chin up); one eye looks half shut, partly the held droop
  (.30) and possibly an idle blink in that frame.
- angry: the knit and the lowered lids work (written strong anger: brows lower .90, together .875, upper lids .50,
  inner squint .40, nose .15, chin .25, corners down .64, lower-lid squint .40). Clearly different from neutral, but
  it read as stern or annoyed, not furious. Probing the headroom with `custom:` (B: lower 1.0, together 1.0, upper
  lids .80, inner .60, nose .40, chin .35; C: everything .8-1.0 with nose .60) the face stays intact up to C (no
  clipping, no lid through the eyeball, no asymmetry beyond her hair covering the right brow): B reads as a scowl,
  C as bitter and heavy.
- no breakage seen in any frame; her head turns slightly between captures (idle and look-at).

**Change** (Lua and `companion-expressions.mjs`, so a CET reload and a bridge restart; no archive, no `.reds`):
anger upper lids .50 to .80, inner squint .40 to .60, nose wrinkle .15 to .35, chin raise .25 to .35. Limits: the
upper-lid and inner-squint controls get their own caps (.80, .60) instead of the shared squint cap .50 (the lower-lid
smile squint keeps .50). On Judy (browDown 1.25) this writes strong anger as brows .90, together .875, lids .80, inner
.60, nose .35, chin .35 (the "new strong" frame; the subtle-tag frame uses w^.6 of that, about .64). Tests updated;
`companion-expressions.test.mjs` and `companion-expression-playback.test.mjs` pass. The new numbers were captured with
the `writer` probe (the installed Lua was still the old recipe until a CET reload).

## October 9 (night): the whole upper face, nine more rig controls, and a sad gaze

Review of the evening captures (user and coordinator): angry was indistinguishable from neutral, sad and worried
only faintly different; Judy's resting brows already sit high. Target: each feeling nameable from a still frame.

**What was tried, and what worked.**
- *The game's authored mood presets* (`AnimFeature_FacialReaction`): not usable for Judy. Her graph
  (`player_woman_photomode_sermo`) has no consumer for that feature (only the crowd graphs `man/woman_average_sermo`
  do), and the presets drive base mouth tracks under the lip sync. Not adopted.
- *Negative offsets against her raised resting brows*: none. The solver clamps the pose inputs at 0 (reconstructed
  solver on her rig: `brows_raise_out -1` moves nothing; captures agree).
- *More of the face from the 50 existing controls* (captures r5-r7): a held partial lid close (the blink control)
  reads as sad or tired and as a glare with lowered brows; widened eyes plus raised brows read as surprised; the
  smile with the lower-lid squint reads as happy. Anger stays only "stern": the base set cannot pull the brows
  together or bring them down onto the lids.
- *The native rig has 141 pose inputs; our graph exposed 50.* Measured on Judy's rig with the reconstructed solver
  (bone displacement at full weight): brows pulled together (`brows_lateral`) 7.2 mm, upper-lid lowering
  (`oculi_squint_outer_upper`, which also brings the brow down) 5.5 mm, brows lower 4.4 mm, raise in 5.9 mm, raise
  out 3.8 mm, nose wrinkle (`nose_snear`) 6.0 mm, chin raise 3.2 mm, corners down 5.7 mm against 10 mm for corners
  up at .5. These nine controls were added to `assets/facial/controls.json` (brows lateral, outer-upper and inner
  squint, nose sneer, all L/R, and chin raise); the graphs and `FaceFeature.reds` were rebuilt
  (`scripts/Build-FacialAssets.ps1`: 9 graphs, 59 connected controls each, archive entries verified; redscript
  compiles). All 800 extracted game lines (men and women) carry the same 414 rig tracks, so the rig check in
  `Face.reds` still passes. The predicted anger brow motion is 7.9 mm against 1.7 mm for the `6193193` values.
- *Head and gaze*: a sad face lowers its eye-contact target by 15 cm (`facial-playback.lua` `gazeDrop`, hysteresis
  on the smoothed pose; `companion-actuator.lua` adds it to the user's height setting, so the look request changes
  once per mood change). Anger keeps the held stare; worry's head tilt and eye darts were not added.

**Recipes now** (unit poses; `mod/facial-playback.lua`, mirrored in `companion-expressions.mjs`):
- anger: brows lower .80, pulled together .70, upper lids .50, lower-lid squint .40, inner squint .40, nose .15,
  chin .25, corners down .40, a held lid droop .25;
- sadness: inner brows up .85, pulled together .35, lid droop .30, chin .35, corners down .75;
- fear/worry: inner .80, outer .50, pulled together .50, widened eyes .45, corners down .25;
- disgust: brows lower .60, nose .60, squint .25, chin .20, corners down .50;
- surprise: inner .60, outer .90, widened eyes .55; joy: corners up .45, outer brows .30, Duchenne squint.
- Judy's lowering controls get a quarter more (`browDown 1.25`, her raised resting brows).
- The extended controls are written only after the first write proves the installed feature has them; an older
  install keeps the base recipe. The held lid droop rides under the blink rhythm (max of the two).
- Guards unchanged: smile or frown on the earlier corner balance, grief never smiles, Johnny below Panam on the
  same words.

**Captures** (`runtime/face-captures/judy-final-*.png`, `judy-final-sheet.png`; Judy, the base controls only, since
the extended ones need the game restart): happy, surprised and sad read; worried reads as alarmed; angry is still
only stern. The next check after installing (game restart) is the anger frame with the knit and the lowered lids,
for example `face-test judy custom:eye_l_brows_lower=.8,eye_r_brows_lower=.8,eye_l_brows_lateral=.7,eye_r_brows_lateral=.7,eye_l_oculi_squint_outer_upper=.5,eye_r_oculi_squint_outer_upper=.5,eye_l_oculi_squint_outer_lower=.4,eye_r_oculi_squint_outer_lower=.4 6 writer`.

## October 9 (evening): in-game captures, then bigger frowns, brows and eyes

User (after `6193193` with the bridge restarted): never smiles on serious topics, "but I don't really see much
facial movement". Measured in game on Judy in V's apartment at conversation distance (about 1.5 m, a 1370 x 815
window): the face-test probe (`custom:` writer mode) held each pose, `scripts/Capture-GameWindow.py` took
read-only crops, no other game input.

**What reaches the rig and what reads.** Every control the layer writes reaches the rig; nothing overrides it
(no lip sync, gaze or animation-slot override was seen; her head turns slightly between captures from her idle
and the look-at). Visibility at that distance:
- corners up: clear from about .3 (a smile), big at .9;
- corners down: subtle on Judy's full lips even at 1.0 (the frown reads mostly from the brows);
- brows (inner raise, outer raise, lower): a crease and a lifted or lowered arch from about .5, modest even at
  1.0; at the previous .3-.4 hardly visible; her right brow is under her hair;
- eye squint (lower lid) and widen: clear from about .3;
- upper/lower lip raise: very strong (teeth at .6), but they are lip sync controls, so not used for expression;
  lip tighten, stretch and press: barely visible.
- There is no nose-wrinkle or cheek-raise control in the feature (the 50 graph controls; cheek puff only).

**Changes** (`mod/facial-playback.lua`, mirrored in `companion-expressions.mjs`): frowns and brows nearly
doubled (sadness corners .75 / inner brows .85, anger brows .85 / corners .40, fear inner .80 / outer .50 /
corners .25, disgust brows .60 / corners .50, surprise inner .60 / outer .90, joy outer brows .30); the eyes
join in: anger (.30) and disgust (.25) narrow them, surprise (.55) and fear (.45) widen them (`eye_l/r_widen`,
new expression controls; a blink closes over them). Caps: corners .8, brows .9, squint .5, widen .6. Smiles
unchanged. Smile or frown is still decided on the earlier corner balance, so the bigger frowns never tip a joyful
line into a frown and a sad line never smiles. Voice-synced brow emphasis: peak .22 (was .15), every 2.5 s at
most. In the selector, trust is damped under a danger or conflict prior like joy (a misread "I've got a family"
otherwise smiled through a frightened reply). Labelled sets: labels unchanged; false smiles unchanged from
before this round (dev 1 calm soft smile, blind 2).

**Written values now** (Judy, Expressive tags, through the real selector, aligner and writer, phrase p90):
sadness subtle corners down .63 / inner brows .55 (strong .88 / .74); anger subtle brows lower .55 / corners .34 /
squint .19 (strong .74); fear subtle inner .53 / outer .33 / widen .30 (strong .70 / .44 / .39); joy corners up
.47 / squint .35 / outer brows .26; Panam surprise outer .90 / widen .55. Johnny stays below Panam on the same
words (test).

Captures: `runtime/face-captures/judy-{sad,angry,worried,surprised,happy}-before-after.png` (neutral, the
`6193193` values, the new values; the before and after frames were taken at different moments, so her head
turns slightly between them).

## October 9 (later): the idle face holds until the reply is heard

User (in game): "her current emotion during idle becomes bland before the lip sync starts playing; it should go
bland once the lip sync starts". Four things blanked it early, all in `mod/facial-playback.lua`:
- V's input (thinking) or the microphone (listening) retired her current reaction and zeroed the pose at once.
- The resting smile was idle-only, so thinking and listening eased it away.
- `beginExpression` (when the reply was handed to speech, before any audio) cleared her reaction and applied the
  reply's own cue, and the active-but-silent reply counted as "thinking".
- While a stream buffered or an Omni phrase loaded, the speech owner held the face and `pause` reset it to zero.

Now: thinking and listening keep the idle face (resting smile with its mood hold, a lingering reaction until its
usual expiry; mirrored in `companion-expressions.mjs`). A new reply's reset and cue wait for its first heard frame
(`startHeard`, or `expressionHeard` for callers without a timeline); until then the idle writer keeps writing her
face (and blinks), and `pause`/`stop` of a never-heard reply reset nothing. The first heard frame starts the
speaking plan with the same smoothing as before. Routes: phrase replies (Omni, Convai WAV) are heard when the
native cursor moves; stream replies (Pocket, Convai) when the device reports heard audio. No added per-frame
work. Tests: idle smile held through thinking, a prepared phrase with the cursor at 0, an opened and buffering
stream, and a cancel before audio; the sad face then eases in within a second; a lingering reaction holds through
thinking and listening. Both fail on the previous code.

## October 9: blinking while speaking, and expressions that read during a reply

User report (recording Judy for the lip sync video): she never blinks while she talks, and her face barely changes
across a reply, even with Expressive emotions on.

**Blinks: root cause.** Our layer never wrote the eyelids, so nothing of ours froze them. The cause is where the
game's blinks come from. Cyberpunk's own dialogue lipsync animations carry a talking face's blinks on
`eye_l/r_blinkLipsyncPoseOutput`, the same tracks our ConvaiFace feature adds to: 800 extracted lines show about
19 blinks a minute, peak about .64 (up to .95), closed within about .07 s, open again over about .2 s, both eyes
together. Our speech replaces that animation. The face graph's only other blink source is the look-at controller
(`animLookAtAnimationDefinition` playing `additive__blink_fast/half/slow` on a gaze shift; Judy's
`player_woman_photomode_sermo` has no idle facial animation at all). While she talks she holds eye contact with V
(`attend`, a steady look-at), so no gaze shift happens and she never blinks. The same applies to every voice route
(Pocket, Omni, Convai), because they all share one face writer.

**Follow-up in game (same day):** with the fix installed she blinked a little while talking but never at idle. The
idle assumption was wrong. The prepared graphs keep the vanilla blink machinery intact (`FacialMixerSlot` with its
`lookAtDefinitions`, the `LookAtController`; our build only adds zero-default Add nodes just before the Sermo
solver, and the idle writer leaves the lids at 0). But that machinery has only two blink sources in every graph,
vanilla NPC graphs included: animations streamed into the mixer slot (scenes, workspots, dialogue lipsync; the
story Judy is always in one) and the look-at blinks, played only on a look-at transition. A companion copy idles
outside any scene or workspot and holds one steady look-at on V (or none), so neither ever fires. Restoring the
vanilla source would mean re-aiming the gaze every few seconds or streaming facial animations into the slot, with
no script input for the latter; so the writer blinks at idle too.

**Blinks: fix** (`mod/facial-playback.lua`). At all times for the copies this writer owns (managed companions, and
the current speaker while she talks), the writer adds its own blink on the eyelid tracks: every 2-6 s with jitter
(every 1.8-5.2 s while listening; first one 0.6-2.2 s in), now and then one at a phrase start (45 %,
from the expression track's phrase spans), same shape as the game's (smooth close over .07 s, exponential open,
peak .62-.95). It is additive and short, so a native gaze-shift blink on top only merges (the solver clamps at
1). Combat, scenes and native dialogue block it like every other optional delta (a scene streams its own). A
phrase of a phrase-streamed reply (Omni) never starts a blink in its last .35 s, since the face holds its last
frame until the next phrase plays. Cost: a few comparisons and at most one `exp` per write, no tables, no new
hooks; phrase starts are read once per timeline. Simulated over 15 replies: 18 blinks a minute.
`speech-state.json` → `face.blinks` counts the blinks started during replies, `face.restBlinks` the others
(in-game check). Crowd NPCs never reach this writer.

**Expressions: where the range collapsed** (15 replies for Judy, Panam and Johnny through the real selector, the
aligner and the Lua writer, on mouth curves from the game-trained model over real cloned-voice audio):
- *Expressive tags were a third of a pose and flat.* A subtle tag (.45) times a reserved manner (.8, Judy and
  Johnny) is .36, and poses were linear in the weight, so Judy's `{fear}` raised the brows .16. A tag also replaced
  the phrase's own text reading, so a reply with one tag sat at one level throughout ("Too late now" no sadder
  than "Every day").
- *Weak units.* Warm (Trust) smiled .25 × weight: .09-.12 on a tagged warm line, below the .15 a smile needs.
- *Mouth budget.* Speech keeps 85 % of the corners and closures/rounding cut them further: corners average
  about .7 of their target while talking. Kept (it is what stops a smile on "oo" and lip closures).
- Not the cause: the lip sync model writes none of these controls; the .18/.55 s smoothing is far shorter than a
  phrase; the neutral-while-speaking rule only affects phrases with no feeling (kept, it guards grief).

**Expressions: changes.**
- Frowns and brows follow w^.6 of their pose in a blend (`mixCurve`, Lua and `companion-expressions.mjs`); full
  feelings and the caps are unchanged. The smile stays linear: a curved smile made weak, misread joy visible on
  sad and calm replies in the labelled sets (it added two false smiles on negative replies).
- Trust (warm) smiles .35, was .25.
- Expressive tags: subtle .6, strong 1 (were .45/.8), and the phrase's own text can raise the tagged feeling.
- A reserved or cold manner also caps a phrase at .8/.6, so strong text no longer saturates Johnny to Panam's
  level.
- Kept: the idle light smile and its mood hold, the Evelyn grief rules, the mouth budget, the caps.

**Before → after**, peak (p90 within a phrase) of the main controls, written values after the mouth budget,
Expressive emotions on (one or two subtle/strong tags per reply):

| Feeling | Judy (reserved, corner gain 1.6) | Panam (expressive) | Johnny (reserved) |
| --- | --- | --- | --- |
| joy | corners up .39→.48, squint .28→.35 | up .35→.38, squint .25→.27 | up .14→.30, squint .10→.22 |
| warm | up .09→.15, squint .11→.17 | up .11→.20, squint .08→.14 | |
| sadness | corners down .35→.47, inner brows .29→.39 | down .18→.27, inner .23→.36 | down .12→.21, inner .16→.39 |
| anger | brows lower .29→.39, down .21→.29 | lower .41→.45, down .19→.21 | lower .29→.39, down .13→.18 |
| fear | inner brows .16→.39, outer .11→.26 | | |
| disgust | | | lower .13→.23, down .09→.16 |
| surprise | | outer brows .46→.50, inner .32→.35 | |
| neutral | 0 → 0 | | 0 → 0 |

Text only (no tags): sadness and anger rise by .03-.09 (Judy sadness down .22→.31), smiles are unchanged, and the
strongest phrases of reserved characters are capped (Johnny joy .33→.27, Judy's strongest fear brows .45→.39).
Labelled sets (`scripts/Evaluate-EmotionSelector.mjs`): labels unchanged; one more calm reply shows a soft smile
(dev d038, a misread warm phrase at .18); no new false smile on a negative reply.

**Tests** (`companion-expression-playback.test.mjs`): blinks through a 20 s reply on each source (local-jali,
convai-arkit61, local-phonetic, audio-envelope): 4-11 blinks, gaps .55-6.3 s, game-shaped peaks, both eyes,
speech fields untouched; idle blinks every 1.9-6.1 s and listening more often, thinking blinks, blocked faces
never blink; phrase
boundary blinks and the Omni phrase tail; per-feeling minimum visible deltas on Judy; a reply changes face between
tags and the text deepens a tag; Johnny below Panam on the same words but at least 60 % of her; grief never smiles
through the writer (with or without a tag) and still reads sad. All seven fail on the previous code.

**In game** (needs a CET reload or game restart for the Lua and a bridge restart for the selector): Judy blinks
every few seconds at all times, while she stands idle, talks, listens or thinks, about as often as in a story scene, with no double or stuck
half-closed lids between Omni phrases; `face.blinks` in `speech-state.json` climbs during replies. Tagged
feelings show clearly on brows and corners and change between phrases; Evelyn still never smiles; Johnny moves
his face less than Panam on similar lines.

## October 8 (later): the light idle smile is back, held off after sad turns

In game the user missed Judy's light resting smile while she is not talking; the objection was only to smiling
on sad topics. `mod/facial-playback.lua` (mirrored in `companion-expressions.mjs`, `restSmile .12`):
- **Idle only:** a light resting smile by manner, slightly below the October 7 levels: warm characters .18,
  default .12, dry .05, cold 0; Judy .12 with her corner gain 1.6 (about .19 on her rig).
- **While speaking:** no resting smile at all; the context selector below decides the whole face (the idle
  smile releases into speech over about half a second).
- **After a sad, angry, scared or disgusted turn** (any negative weight .2 or more in that turn's track or
  label): the idle face stays neutral for 60 s of game time, or 10 s after a later calm turn ends, then the
  smile eases back over 5 s. A further negative turn restarts the minute.
- Tests: `companion-expression-playback.test.mjs` "idle smile: present at rest, absent during and after the
  Evelyn reply, back after the mood decays" (real selector plan, real Lua writer).

## October 8: neutral rest, a context-aware emotion selector, and Convai's own label for local voices

**The problem (user, in game).** Judy smiled when V asked her a sad question about Evelyn. With Expressive
emotions on it was "a little better".

**Root cause (measured on the labelled sets below).**
- *Resting smile.* Lua rested every non-negative face at a smile (Judy .14 × gain 1.6 ≈ .22 corner-up; warm
  characters .22). The text plan then added a resting Trust baseline (.67 for warm characters, ≈ .27 on Judy
  with gain) under every sentence. A reply with no feeling at all therefore smiled while speaking.
- *Pleasant words as smiles.* The lexicon scored "love", "family", "glad", "thanks", "beautiful", "laughed",
  "friend", "sister" and forms of address ("V", "choom") as Joy/Trust, so grief told through fond memories
  ("She was beautiful, V. I loved her so much") smiled harder (.65) than a neutral line.
- *No conversation context.* Only the reply was read, never the player's question, so a sad question answered
  briefly ("Thanks for asking. Some days are easier") had nothing sad in it.
- *Weak negative cues.* "Sorry" was .35; regret, counterfactuals ("if I'd picked up"), "since she's gone" and
  most concern phrases scored nothing. The baseline smile only yielded to a negative weight of .2 or more.
- *Two bugs.* A segment starting with "V" read `tokens[-1]` and threw, so the whole plan fell back to
  `text-emotion.mjs`, whose default is a Trust scale-2 smile for warm characters. Lexicon phrases stored
  without apostrophes ("dont like this", "cant believe") never matched real text. Both are fixed in
  `emotion-analysis.mjs`.
- Negation, sentence segmentation and intensity mapping were not the cause; the joy bias was (above).

**Convai's own emotion (research and live probes, `@convai/web-sdk` 1.7.0).**
- The REST `POST /character/getResponse` and the beta `live.convai.com/connect/stream` SSE return no emotion
  field (docs.convai.com interaction API pages). "State of Mind" is a Playground view (an emotion wheel) with
  no read API. The SDK's `stateOfMind` / `updateEmotion()` *sets* the character's mood as an input
  (`state_of_mind` on connect, `update-emotion` message); it is not an output.
- The realtime SDK sends `bot-emotion` (`{type, emotion, scale}`, scale 1-3, Plutchik-style labels: Joy,
  Serenity, Ecstasy, Trust, Acceptance, Sadness, Pensiveness, Grief, Anger, Fear, Surprise, Interest,
  Anticipation, Disgust, Boredom, neutral) when `enableEmotion` is on, one per turn with
  `emotionConfig.provider: 'llm'` (ours). `provider: 'nrclex'` streams several per reply (one per text chunk)
  but is a word lexicon: Judy's grief reply came back neutral, then Pensiveness/1.
- **Text-only turns (Pocket and Omni) do get it**, contrary to the October 5 note: it arrives 291-620 ms
  (median about 480 ms) after `bot-llm-stopped`, after `reply()` had already returned, which is why it was
  never seen. 43 of 43 live text-only turns on five characters carried one (fresh test end-user IDs; evidence
  in `assets/emotion/exchanges-real.json`, scratch probes not committed).
- Quality on those 43 real replies (blind labels): Convai's label alone is acceptable for 90.7 % (exact
  51.2 %), with no false smiles. It is per turn, not per sentence.

**What changed.**
- `mod/facial-playback.lua`: resting warmth 0 for every character (Judy keeps corner gain 1.6). Mirrored
  in `companion-expressions.mjs` (`restSmile: 0`).
- `bridge/emotion-selector.mjs` (new): the selector. Inputs: the player's message, the reply, the previous
  turn's mood for this character (three minutes, in memory, fades instead of renewing itself), the
  character's manner (expressive, open, reserved, cold: intensity and how much evidence a smile needs),
  Convai's label, and the character's tags. It reuses the existing segmentation, lexicon scoring and the
  timeline aligner, adding conversation frames (grief and loss, sore questions, danger, conflict,
  celebration, humour; death idioms such as "over my dead body" removed), about 20 phrase patterns
  (empathy, regret, longing, concern, reassurance, hospitality, laughter, disbelief, scorn, threats),
  whole-reply sarcasm, contraction normalising ("I am sorry"), and gates: mild words never smile, a grief
  frame turns fond words into sadness, a clearly negative phrase leaves no smile under it. A reply with no
  feeling is calm: no reply-level cue, neutral face.
- Priority: the character's own tags (Expressive emotions) from the first tag on; then Convai's label as the
  reply prior (other families' text feelings × .7, joy damped under a negative label); then the text.
- Convai's late label: `realtime-client.mjs` keeps the one id-less `bot-emotion` that arrives between a
  text-only reply's end and the next reply's `bot-llm-started` (4 s limit; a second one is ambiguous and
  dropped) and returns `lateEmotionToken` with the reply; `RealtimeHost.lateEmotion()` reads it. The bridge
  polls it (80 ms, 1.5 s limit) alongside the voice: Omni re-plans before returning the first phrase if it is
  in (it usually is: phrase 1 takes longer to render), never waiting for it, and otherwise updates the plan
  its later phrases use; Pocket's stream planner picks it up at its next rebuild. Nothing waits on it, so no latency is added.
- Fallback setting: `"emotionSelector": "legacy"` in `runtime/settings.json` (no menu entry; the game keeps
  unknown keys) returns to the reply-only planner. The Lua rest stays neutral in both.
- Receipt: `runtime/expression-receipt.json` version 3 adds `selector`, `convai`, `convaiLate` (ms), and the
  plan's `evidence` and `summary`; a second receipt is written when Convai's late label arrives.

**Evaluation** (`node scripts/Evaluate-EmotionSelector.mjs all`; labelled sets in `assets/emotion/`, labels
by separate writers; "acceptable" counts the gold label or one listed as also reasonable; a false smile is a
visible corner-up ≥ .15 while speaking on a sad, afraid, angry or disgusted reply).

| Set | Previous exact / acceptable | False smiles (negative) | Smiles on calm | Selector exact / acceptable | False smiles | Smiles on calm |
| --- | --- | --- | --- | --- | --- | --- |
| dev, 130 (tuned on) | 27.7 % / 44.6 % | 45/59 | 13/20 | 84.6 % / 93.8 % | 0/59 | 0/20 |
| holdout, 80 (first look) | 37.5 % / 45.0 % | 25/36 | 8/12 | 75.0 % / 80.0 % | 2/36 | 0/12 |
| blind, 90 (first look) | 26.7 % / 38.9 % | 30/41 | 9/14 | 62.2 % / 74.4 % | 5/41 | 0/14 |
| real Convai replies, 43 (first look) | 39.5 % / 58.1 % | 13/16 | 10/14 | 37.2 % / 72.1 % | 0/16 | 0/14 |
| real, with Convai's label (first look) | | | | 46.5 % / 88.4 % | 0/16 | 1/14 |

Holdout, blind and real were then used for one round of general fixes each (now 91.2/96.3, 78.9/92.2 and,
with Convai's label, 51.2/90.7; 0, 2 and 0 false smiles); the first-look numbers above are the honest ones.
"Previous" is the installed code (`PREVIOUS_BRIDGE` pointed at the HEAD copy), including its crash fallback. Every Evelyn exchange in the four sets is
now sad or the accepted feeling, with no visible smile (it smiled in all seven of the dev ones before). The
real replies are terse and often calm, which is where the text alone is weakest and Convai's label helps most.
Cost: about 0.15 ms median, 0.4 ms p95 per reply in Node (the previous planner 0.07 ms), off the game's thread.

**A local model was not adopted.** A distilled RoBERTa emotion classifier (about 82 M weights, 7 classes, no
warm/interest) would need onnxruntime-node and about 80-330 MB of weights (int8/fp32) downloaded, typically
10-40 ms per sentence on one CPU core, more while the game runs, and still reads only text. Convai's label is
already context-aware (it saw the whole conversation), free, and arrives in time; the selector covers phrase
timing and the gaps. Not measured here (it would need the download).

**In-game checks.** See TODO "Context emotion selector".

## October 7: resting warmth, calm brows, and a multi-emotion timeline

**Live findings (screenshots of Judy via the face-test probe, installed `0d89060`).** Writer-mode
poses are all visible, and `face-test off` returns her to the same neutral idle as before (no stuck jaw,
brows or corners). Corners .45 read as a modest smile; adding the outer-eye squint (the closest control
the feature exposes to a cheek raise; there is no cheek-raise or lid-tighten track, only cheek puff and
suck) makes it read as warm; corners .65 + squint .35 is a clear friendly smile. Squint alone looks
stern, so it is only ever driven by the smile.

**Why the face looked flat/odd, from the code and the logs:** an Interest cue (a question tone) replaced the
resting smile (no corners, brows only), so Judy had no smile while speaking; the voice-synced brows
(model raise gain .65-.8, no dead zone) lifted the brows by roughly .1 almost constantly and
bobbed them alone on a static face; and any emotion's brows were held 4 s (8 s if negative) after the
voice stopped, which with a question cue on most replies reads as "brows always raised at idle". The current code
reproduces none of these (idle brows are exactly 0 five seconds after a reply in the simulation below).
Also fixed: a face-test `policy` run injected a feeling and marked the turn active, so it could leave the
actor in "thinking" (no resting smile) after `off`.

Changes (Lua `mod/facial-playback.lua`, mirrored in `bridge/companion-expressions.mjs`):

- Resting warmth is a **floor** under every non-negative intent (Interest, surprise, neutral tone),
  idle and speaking, combined by max with the emotion's own smile; sadness/anger/fear/disgust and unknown
  labels remove it. Per character (actor-row profile keys, Lua only): warm .22, default .15, dry .07,
  cold 0. Judy: warmth .14 with a corner gain of 1.6 (about .22 at rest), caps scaled by at most 1.3.
- Duchenne squint on `eye_l/r_oculi_squint_outer_lower`: .6 of the smile, capped .35, smoothed, not
  affected by mouth closure (eyes are not the mouth).
- Interest: brows .15 (was .30) plus the warmth smile. Surprise and Interest brows are a **flick**
  (full for 1 s, gone by 2 s). Other emotion brows hold through the phrase and **release within 1.5 s after
  speech** (corners keep the 4/8 s expiry).
- Voice-synced brows are rare emphasis: dead zone .25 on the model's raise, peak .15, and after one
  emphasis the next is held off 3 s.
- Brow/corner values over a 6 s reply plus 10 s (simulation through the real Lua writer, Judy, model raise
  mean .1 with two stresses): Interest speech corners .19-.20, brows raise_out .09-.10 for the first
  second then 0 by 4 s; idle after speech corners .224 (resting), brows 0.000. Sadness: raise_in .30 held
  through the reply and 1.5 s after, .12 at +2 s, 0.001 at +5 s.

### Multi-emotion timeline (local voices, and phrase variation on Convai)

- `bridge/emotion-lexicon.mjs` and `bridge/emotion-analysis.mjs`: a few-millisecond, LLM-free analysis
  splits the reply into segments (sentences, contrast clauses at "but/however...", long clauses, and forced
  edges such as Omni phrase boundaries) and scores 8 families with intensities (about 640 words and phrases,
  inflections, intensifiers and diminishers, negation within 3 words, contrast, questions, exclamations,
  ellipsis hesitation, laughter, profanity as anger or emphasis, affectionate address, reliable sarcasm
  patterns), then merges a per-character baseline and range (warm, neutral, dry, cold). A Convai
  reply-level label (basis ordered/response-id, never our own cue) becomes the baseline at 60 %, and the
  phrase analysis varies it. The reply-level receipt cue is derived from the plan.
- `bridge/expression-timeline.mjs` aligns segments to REAL audio time: Omni phrases are their own audio
  files (each phrase timeline starts at its own audio start); Pocket and Convai streams use pauses in the
  mouth timeline (jaw/lip aperture of the game-trained model or the provider's poses) snapped to the text's
  sentence boundaries, with a syllable/punctuation duration estimate rescaled to the audio received so
  far; the estimate only fills boundaries not yet heard. No recognizer. Each change starts 200 ms before
  the phrase's audio, blends over 300 ms, holds through the phrase, and the last phrase decays to
  baseline.
- Lua applies the track at the heard position (`expressionTrack`, format `emotion-mix-v1`, validated,
  ignored if malformed), blending families with a soft sum inside the caps (bittersweet = a slight smile with
  sad brows); corners cross-fade on one signed axis, so a smile turning into a frown passes through
  neutral. Mouth priority is unchanged and tested: closures/rounding zero the corners and leave every speech
  field identical. Between Omni phrases the last mix is held.
- Diagnostics: `runtime/expression-receipt.json` (version 2) lists per-segment offsets, weights, tags
  and phrase spans (no dialogue); each timeline's `expressionTrack.segments` (in `reply.json`,
  `speech-stream.json`) carries the aligned audio times; `speech-state.json`
  `face.expressions.lastSpeech` has `mix`/`mixPeak` per family and the peak pose.
- Tuning is data: caps, strengths, warmth/gain table (Lua) and lexicon weights; `LEAD_SECONDS`,
  `BLEND_SECONDS` in `expression-timeline.mjs`.

## October 6 (later): live face-test, second recalibration

`mod/face-test.lua` (driven by the facial writer; `scripts/Send-FaceTest.ps1`) pushed
extreme poses on Judy while the user watched. Writer mode showed the full smile,
frown, brows and jaw clearly, so the write path works; the strengths were the
problem. Ramp-smile: a smile reads clearly at about .35-.5 on Judy and 1.0 is an
exaggerated grin. The first recalibration (peaks <= .20, rest .06) was therefore
still invisible, because the game's authored .10/.20 offsets are not what reads
on this rig. The probe also left `jaw_mid_open` .5 after the sweep (the writer
keeps its idle feature between frames); it now zeroes probe-written fields when a
step, run or "off" ends.

Policy v2 (Lua and `companion-expressions.mjs` identical): scale strength .4 / .67 / 1;
joy corners .45 (.30 at scale 2) with brow raise-out .20; trust .25; sadness corners
down .40 with raise-in .45; anger lower .45 with corners down .25; fear down .15,
raise-in .45, raise-out .30; disgust down .30, lower .35; surprise raise-in .35 and
raise-out .50; interest .30. Caps: corners .50, brows .55. Resting smile .10 (idle
and speech). The warm default cue (Trust scale 2) is .167, about .14 while speaking;
other characters get scale 1 (.10); cold characters get a flat Interest cue while
speaking. Provider (Convai) multipliers: corners .30, brows .55/.45/.40. Model brow
gain .8. Unchanged: 85 % of mouth emotion kept while speaking, smoothing (.18 s
attack, .55 s release), and mouth priority. Closures (P/B/M) and rounding (O/U) still
remove corner emotion after smoothing, tested for seven emotions at scale 3, and
jaw/closure/rounding fields are bit-identical with or without an expression.
Known limit: the idle resting smile is one value for every character; "cold" is
expressed through the cue while they speak, not in the idle pose.

## October 6: why the face looked blank on local voices, and the recalibration

User report (Omni 32, Judy): lip sync good, "I don't see any expression ever".
Traced from the installed runtime and the code, not guessed:

1. **The wiring was fine.** An October 5 `companion-systems.json` capture shows the
   native writer applying the idle pose to every managed copy (about 24,000
   `ConvaiFaceApply` calls, `lips_*_corner_up = 0.025`), and the current
   `reply.json` of a Judy Omni turn carries `jali-audio-v1` frames plus
   `modelExpressions` (`jali-upper-v1`). The Omni route copies the bridge's
   `expressionSignal` onto every phrase, and `ownedExpressionReceipt` binds it
   to the request. Nothing dropped the field.
2. **No cue was produced.** That reply ("... I'm just glad I've got someone I can
   actually trust ...") scored one Joy hit; the cue needed two (score >= 1.5 and
   a margin), so the turn had no `expression` receipt at all, as most ordinary
   replies would not.
3. **Even a cue was nearly invisible.** Joy scale 2 wrote .085 x .65 = .055, then
   speech kept 60 % = .033; the voice-time resting smile did not exist at all
   (it was idle-only) and idle was .025.
4. **The calibration target was misread.** The earlier note "the game holds
   corners at about .10" is true but means something specific. Across 6938
   extracted dialogue lines, the game's lipsync does not animate these controls
   smoothly. Each line holds one constant mood offset: smile = corner up .10 with
   brows raise .10 (39 % of lines), frown = corner down .20 with brows lower .324
   (20 %); nothing else (values are exactly those constants, 500-line sample).
   Our caps (.12 up, .10 down, .20 brows) sat at or below that, frowns at half the
   game's own, and every emotion was then scaled down again by 35-65 % and by the
   speech factor.

Changes (Lua `mod/facial-playback.lua` and the mirrored pure policy in
`bridge/companion-expressions.mjs`):

- Strength by scale (1..3): .5 / .8 / 1 (was .35 / .65 / 1). Joy corners up
  .20 x strength, Trust .12, Sadness down .12 with brows raise-in .16, Anger down
  .08 with brows lower .20, Fear down .05 with raise-in .15 and raise-out .10,
  Disgust down .10 with lower .14, Surprise raise-in .08 and raise-out .16,
  Interest/anticipation raise-out .08. Caps: corners up .20, corners down .20
  (the game's frown), brows raise .25, brows lower .32 (the game's .324).
- Speaking keeps 85 % of mouth emotion (was 60 %); closed lips and rounded
  O/U still remove it after smoothing, so visemes keep the mouth.
- Resting smile .06 (was .025), shown while idle **and while speaking** when no
  emotion is known. It is roughly 60 % of the game's own authored smile.
- Model brows from the audio use gain .65 (was .35). The model output is already
  a regressed, shrunk estimate; the extra .35 shrank it twice. Still max-combined
  with the emotion pose, cap .25, predicted lowering still ignored.
- Convai provider pose multipliers raised in step (brows .25/.20/.18, corners
  .14) because they were chosen against the old invisible caps.
- Local voices: `bridge/text-emotion.mjs` now **always** returns a cue. Order: a
  lexicon feeling when one clearly leads (one clear word is enough, weighted
  cues, Joy and Trust reinforce each other, negated positives cancel); else the
  tone (a question lifts the brows with Interest, an exclamation smiles, a
  refused positive such as "not happy" stays flat); else the character's resting
  warmth (Trust scale 2 for warm companions such as Judy, Jackie, Panam, Kerry,
  scale 1 for everyone else, flat Interest for cold ones such as Adam Smasher or
  Yorinobu). It is a local heuristic with no model or network request and still
  one cue per reply.
- Diagnostics: the bridge writes `runtime/expression-receipt.json` per local
  turn (request, profile, provider, emotion, scale, basis, delivered; no
  dialogue), and `speech-state.json` face.expressions.lastSpeech now holds the
  emotion label, family, scale, frame count and the peak pose written to the rig
  during that turn. Both are readable after one in-game reply.

Not verified in game: whether .10-.20 reads as natural on Judy's graph (it does
not use the game's authored mood animation, so these offsets are all there is).
If it looks too strong or too weak, only the numbers above change.

## October 5: what Convai actually sends, game-informed ranges, all routes

**Live probe** (`scripts/lipsync/probe_convai_emotion.mjs`, four short turns as
the existing test end user on Alex): every *voiced* turn carried exactly one
`bot-emotion` server message (label + scale, e.g. `Interest`/1), on the pinned
provider's reliable channel, after the reply's LLM text and before the first
audio packet. Neither its inner nor outer envelope has a `response_id`,
`turn_id` or epoch, so the previous receiver rejected **every** live emotion
(`missing-or-invalid-event-owner`); this is why no correlated emotion had ever
been seen. *Text-only* turns (the ones Pocket and Omni voice) carried **no**
emotion at all.

Changes:

- `ConvaiEmotion.acceptOrdered` admits one id-less label per response when it
  arrives on that ordered channel after the response's own audio owner *or*
  its reply text, and before its terminal; a second id-less label makes the
  response ambiguous (no expression). Events with ids keep the strict match.
  The label therefore reaches the face before the first spoken syllable.
- Local voices: `bridge/text-emotion.mjs` derives a cue from the reply's own
  text (small lexicon, negation, intensity); it fires only when one feeling
  clearly dominates and otherwise leaves the face neutral. Ownership is exact
  (it is that reply's text). Same receipt path as Convai.
- Voice-synchronous upper face: the game's dialogue lipsync animates brows
  with the voice (raise in/out together: speech mean .10, p95 .44; lower: p95
  .16). The game-trained model learns brow raise/lower from audio and
  timelines carry them (`modelExpressions`, `jali-upper-v1`, same frame times
  as the mouth). On held-out game lines audio predicts brow raises only loosely
  (r .29; lowering r .13), so the single writer uses raises at 35 % (cap .20),
  ignores predicted lowering, combines by **max** with the smoothed emotional
  pose (never summed), and reduces raises in anger/disgust. Mouth expression still
  yields to lip contact and rounding after smoothing; visemes keep the mouth.
- Ranges now follow the game more closely: corner up .12 (game dialogue holds
  ~.10), corner down .10, brows .20; speech keeps 60 % of mouth emotion (was 30 %).

What the native rig/animation system offers: the 414-track face rig has the
full expression set (corners, brows, squints, sneer, cheeks), all reachable
through our 50-control feature for corners and brows. The game also has an
authored crowd mood layer, `AnimFeature_FacialReaction {category, idle}`
(e.g. 3/5 joy, 3/3 sad, 3/1 aggressive, 3/7 disgust, 3/8 surprise, 3/10 fear,
1/3 curiosity, 2/2 neutral; `reactionComponent.script`). It is consumed by
`man_average_sermo`/`woman_average_sermo` but **not** by
`player_woman_photomode_sermo` (Judy's graph), is tied to crowd look-at
reactions and graph states, and would change base mouth tracks under the
lipsync; it is documented here but not used.

Verification: CPU/fixture tests cover ordered admission (before owner, after
text, duplicate, after terminal), text cues, local routing, the brow curve
through the real Lua writer, misaligned curves and caps. Rendered strength on
Judy/Johnny remains the in-game check.

## Product behavior and current scope

Managed companions should have a small relaxed smile at rest by default.
Explicit Convai emotional intent may change that expression. Anger, sadness,
fear and disgust suppress the friendly smile; unfamiliar labels use a neutral
expression. The user requested this as default behavior, with no extra toggle.

`bridge/companion-expressions.mjs` defines the pure policy. The same bounded
policy now runs in the single native writer in `mod/facial-playback.lua`.
`speech.update(delta, expressionContext)` brackets the existing speech update
with a gameplay expression clock and the idle-copy pass. The context supplies
current actor rows, pause/block state and any thinking/listening entity; these
actor rows are consumed immediately and never retained by the face coordinator.
No new redscript or facial archive is required. The expression strengths below
are conservative starting values, not visually qualified calibration results.
The integration's CPU tests make no game, GPU or Convai request.

## Actual Convai surface

The installed package is `@convai/web-sdk` 1.7.0. Its `ConvaiClient` sends emotion
configuration only when `enableEmotion: true`; the realtime client now supplies that option.
The documented `emotionChange` body is `{emotion: string, scale?: number}` or
`null` on reset. Scale is an integer from 1 to 3. Documentation places the event
after each character turn. Supported detection providers are `llm` and `nrclex`;
the latter uses word-level lexicon matching. The connection configuration uses
the default contextual `llm` provider. These are response metadata, not an
audio-time expression curve. [Official emotion guide](https://docs.convai.com/api-docs/plugins-and-integrations/web-plugins/convai-web-sdk/emotions).

`updateEmotion()` / `stateOfMind` are outgoing generation-mood controls. Forcing
them to “happy” would change conversation generation rather than merely add a
resting face. They are not part of this rendering feature. The installed source
also confirms that the SDK's convenient `emotionChange` callback retains only
the label and scale; it drops the original transport envelope. See
`node_modules/@convai/web-sdk/dist/core/MessageHandler.js` and
`dist/core/ConvaiClient.js`.

`bridge/convai-emotion.mjs` validates the original reliable `bot-emotion` frame
from the pinned current provider participant. The realtime client returns an
optional `expressionSignal` only after response correlation. Enabling the
connection option is not proof that a particular server response contains a
correctly correlated emotion. The diagnostics expose admitted/skipped counts
and ownership booleans, without dialogue, labels or remote identifiers.

### Ownership and arrival timing

An emotion callback must not be stamped with whichever request happens to be
active when it arrives. A late label could otherwise cross a cancelled turn,
a reused connection or two copies of the same character.

The transport adapter establishes the verified connection, remote participant
and response correlation. Convai voice uses the existing accepted audio owner;
TTS-disabled Omni generation needs an explicitly owned raw `bot-llm-started`
event. The emotion's response/turn owner must match, including any shared epoch.
Conflicting text response owners make the optional signal ambiguous. Retired
owners, missing/foreign participants and unreliable packets cannot acquire a
new expression lease. Only then does `ownedExpressionReceipt` bind the existing
game `entity`, `requestId` and `generation`. Uncorrelated events are skipped;
SDK `state.emotion` and `emotionChange` never establish ownership. The documented
body alone lacks response identity. Actual server payload qualification remains
a live verification task.

`OwnedExpressionSignal` accepts only an already correlated game owner and an
increasing producer sequence. It rejects missing owners, another copy, stale
generations, duplicates and events after audible completion. Cancellation,
despawn, save/load and connection retirement call `clear()`. Normal completion
may retain a known positive expression for four gameplay seconds or a negative
one for eight, then discard it. A post-speech clock earlier than completion
also discards it. Beginning
a new turn clears the previous turn's intent. The caller supplies a monotonic
gameplay clock that stops while paused; this module has no timers or global
actor registry.

Emotion is optional. Audio/text playback must neither wait for detection nor
fail when metadata is absent, late, unknown or malformed. If a label arrives
while already generated audio is still draining, the actor may show a short
reaction then. The documented API cannot promise the appropriate label at the
start of every spoken sentence.

## Available facial channels

Convai's SDK supplies ARKit61 and MetaHuman251 streams. The mod already validates
and uses the provider's timed custom ARKit61 layout. The order is taken from
the installed `dist/lipsync-helpers/arkitOrder61.js`, not guessed from array
length. [Official SDK overview](https://docs.convai.com/api-docs/plugins-and-integrations/web-plugins/convai-web-sdk).

Relevant custom-order channels are:

| Provider signal | Indices | Proposed treatment |
| --- | --- | --- |
| MouthSmile left/right | 23 / 24 | Extra positive intent only with an explicit positive label; these also occur in “ee” speech shapes |
| MouthFrown left/right | 25 / 26 | Small direct corner-down physical pose; not independent proof of the dialogue's semantic emotion |
| BrowDown left/right | 41 / 42 | Small bounded brow-lowering delta |
| BrowInnerUp | 43 | Small symmetric inner-brow delta |
| BrowOuterUp left/right | 44 / 45 | Small independent outer-brow deltas |
| Blinks, eye directions, head/eye rotations | 0–13 / 52–60 | Excluded; native blinking and accepted gaze retain ownership |

No additional model is required. Omni's acoustic mouth cues do not themselves
supply these provider expression curves, but the optional Convai emotion
metadata can still guide the same expression targets. A missing expression
curve uses bounded presets; it does not trigger sentiment analysis, GPU work,
synthetic dialogue or another request.

## Native rig and single-writer integration

`assets/facial/controls.json`, generated `FaceFeature.reds`, and the installed
facial graph already contain ten suitable tracks:

- `lips_l/r_corner_up` and `lips_l/r_corner_dn`;
- `eye_l/r_brows_raise_in`, `eye_l/r_brows_raise_out`, `eye_l/r_brows_lower`.

These tracks are disjoint from the accepted speech track list. The generated
graph adds feature deltas before the native Sermo solver. Zero deltas preserve
the existing native animation. `ConvaiFaceApply` already checks readiness and
the managed-copy tag. Supported graphs/rigs need no new archive or redscript
for these controls; unsupported rigs should keep their native face.

The important constraint is `mod/facial-playback.lua`: it applies a **whole**
`ConvaiFaceFeature`, and `ConvaiFaceReset()` zeroes the whole feature. A second
independent resting-smile writer would erase speech tracks; a speech reset
would erase the smile. Appending another `ConvaiFaceApply` call is insufficient.

The implemented coordinator uses one final writer per actor:

1. Maintain expression metadata/smoothing state for each owned companion copy,
   using primitive owner data rather than retained world handles.
2. Leave the accepted speech timeline, interpolation and device clock intact.
   On a current speaker tick, use its existing interpolated speech feature.
   At rest, use zero speech deltas.
3. Obtain the expression-only target from a known label and, when available,
   the corresponding already validated timed ARKit61 pose. Start with the small
   default rest smile when no intent is known.
4. Smooth expression deltas with gameplay time. Then reapply mouth conflict
   budgets and negative-intent suppression **after** smoothing.
5. Write the ten expression fields into that same feature and call
   `ConvaiFaceApply` once. All speech field values remain exactly unchanged.
6. Route speech stop/reset through the coordinator. It either resumes the
   actor's bounded idle expression or clears the feature during teardown.

The coordinator yields to combat, injury status tags, scripted/native facial
ownership and unsupported/invalid actors. A blocked context produces zero
expression deltas immediately; it must not decay a previous smile through a
fight or let a stale actor acquire a new face. Native callbacks should merely
queue primitive state. Feature allocation/application belongs in the existing
top-level update path, avoiding the previously observed small native callback
allocation budget. The optional context is:

```lua
speech.update(delta, {
    actors = currentOwnedCandidates, -- {entity=string, npc=currentHandle}
    paused = not worldReady,
    blocked = unsafeGlobalContext,
    thinkingEntity = pendingEntity,
    thinkingRequestId = pendingRequestId,
    listeningEntity = recordingEntity,
})
```

`facial-timeline.mjs` preserves all existing speech weights and timestamps.
Validated provider samples add a separate `arkit61-expression9` companion curve
using the exact same frame times. The Lua adapter rejects malformed optional
curves without rejecting speech. It interpolates those nine source channels at
the existing heard cursor and writes only the ten owned expression controls.
Native Omni phrases carry their original Convai receipt through `SpeechStream`;
continuous Convai state can publish a later receipt even when the audio/facial
source is already complete. Neither route waits for emotion.

## Pure helper contract

| API | Responsibility |
| --- | --- |
| `normalizeConvaiEmotion(body)` | Validate bounded labels and categorical scale; unfamiliar labels remain explicitly unknown |
| `OwnedExpressionSignal` | Exact per-copy request/generation admission, sequence ordering, cancellation and bounded post-speech intent |
| `emotionSuppressesSmile(body)` | Suppress a previous smile for negative or unfamiliar intent |
| `expressionTarget(options)` | Build a complete ten-track pose, including optional physical provider deltas and phoneme conflict budgets |
| `ExpressionSmoother.update(target, delta, options)` | Pause-aware, frame-rate-independent approach/release without native handles |
| `composeExpressionPose(speech, expression, options)` | Immutable final pose; reapply hard mouth budgets after smoothing and preserve every other field exactly |

Initial rest smile is `.025` on each corner-up control. Positive expression
corner-up is capped at `.09`, corner-down at `.08`, and brow deltas at `.10`.
Speaking reduces additional mouth emotion to 30%; native lip contact and
rounding further suppress it. A pressed P/B/M or fully rounded O/U reduces
additional mouth corners to zero, including a previously smoothed smile.
Jaw opening, independent lip lift/contact, tongue controls, blinks and gaze
are never changed by this policy.

An unfamiliar valid label suppresses the smile rather than defaulting to joy.
Alias families are local rendering choices for explicit provider labels, not
a claim that Convai guarantees a fixed emotion catalog. The helper never
classifies user/character text. Malformed or ambiguous facial formats produce
no expression authority. New numeric gains require rendered qualification;
they must not be presented as accepted Cyberpunk calibration.

## Dawnwalker reference and verification

The reviewed Dawnwalker 0.5.5 code provides a useful ownership principle:
its engagement layer transfers its idle face lease to conversation ownership
and restores it on release. Its resting smile uses Unreal/JALI-specific
corner pull/up, dimples and cheek raising, and its ambient upper-face loop
supplies blinking. Those weights and blink behavior cannot be copied into
Cyberpunk's native Sermo controls. This feature keeps Cyberpunk's working
native blinking and eye contact.

`node --test bridge/companion-expressions.test.mjs` covers
actual native-schema track availability, accepted speech-field immutability,
strict categorical intensity, unfamiliar labels, negative transitions, timed
provider-only channels, malformed formats, closures/rounding after smoothing,
blocked contexts, paused and 10/30/60 FPS clocks, copy/generation/sequence
ownership, cancellation and post-speech expiry. These are CPU contract tests,
not evidence of a natural rendered smile or observed backend emotion delivery.

`companion-expression-playback.test.mjs` executes the real speech and facial Lua
adapters to verify one writer, separate copies, pause, teardown, exact speech
weights, optional curve rejection, negative suppression and native context
yielding. Realtime and stream tests verify transport qualification, retired
owners, unchanged PCM and timing, late metadata during audio drain, and Omni
phrase continuity. Rendered corner/brow strength and real backend emotion
envelopes still need a live check. No lip-sync, blink or eye-contact redesign
is part of this integration.

### October 4 source and running-service review

The current running bridge was sampled through its read-only diagnostic command:
four warmed local-TTS connections had no active response and had received no
emotion frames since startup. This is not evidence of working emotion playback.
The retained October 2 capture had four received/skipped emotion frames and zero
accepted frames; its aggregate counters cannot establish why they were skipped.

The receiver now records bounded skip reasons and booleans showing whether the
raw inner/outer envelope supplied response/turn IDs, whether the provider was
pinned, and whether a response owner was established. It stores no IDs, emotion
labels, utterances or raw packets in these diagnostics. This distinguishes an
ownerless event from a late event or a different response without guessing.

There is still a local-TTS lifecycle limitation: text collection retires its
Convai response before Pocket/Omni finishes local playback. An emotion arriving
after collection cannot currently update that reply. The pinned SDK's public
emotion body provides only a label and optional scale, and the reviewed
Dawnwalker engagement code establishes facial-layer ownership rather than a
backend response-correlation contract. Extending the local playback lease must
therefore use observed, matching raw response identity; borrowing whichever
request is active would be unsafe. No facial gains or speech timing were changed
by this review, and no sentiment-classification fallback was added.
