# Companion expressions

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
