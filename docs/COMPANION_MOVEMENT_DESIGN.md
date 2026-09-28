# Friend-group movement controller

## User-visible problem and evidence

The September 29 update still turned Judy away when V looked back while she
was arriving. The user clarified that V sees her back. In the recorded stop,
the old controller accepted her position at about 0.9 m/s, cancelled the path,
and saved that point. Native stopping carried her roughly another metre. The
controller then treated that ordinary deceleration as departure from her spot,
ordered a reverse correction, and left her facing the reverse direction.

The new controller treats motion as a continuous operation. Gaze is not a
destination, a travel direction, or evidence that a moving person has stopped.

## Ownership

- `companion-travel.lua`: infer group travel from V's world displacement and
  recent path. Camera direction is used only to place the initial party.
- `companion-space.lua`: stable per-copy lanes, comfortable standing areas,
  separation, and local candidate positions. No game calls.
- `companion-behavior.lua`: one state machine per person, including complete
  arrival and conversation operations. No native commands or camera heading.
- `companion-actuator.lua`: execute one owned movement operation and one gaze
  request; measure native completion/failure and stop-animation motion.
- `companions.lua`: identity, spawning, session lifetime, sensing and ordering.
- `companion-locomotion.lua`: clear the engine's retained facing object only
  for a current ordinary travel command belonging to this mod.

## Behavioral contract

| Situation | Movement | Attention |
| --- | --- | --- |
| Camera turns while V stands | Existing places and travel direction remain valid | A glance may affect eyes/head only |
| Small step inside the resting group | Only a person whose personal space is invaded may adjust | No party-wide rearrangement |
| Back up or circle to face a settled person | Fixed gathering anchors distinguish local interaction from leaving; even the rear members wait | Only the addressed person may readjust after V stops |
| Purposeful departure | Stable lanes follow the actual path; pace follows measured speed | Social body turns yield before locomotion starts |
| Sustained corner or U-turn | Follow the new path after displacement establishes it | Camera yaw alone cannot establish a turn |
| Behind the group | Native catch-up, then a planned approach to free side space | Looking back does not interrupt the route |
| Entering the arrival area | Freeze the approach destination; finish the native stop | Eye contact cannot claim the feet |
| Stop animation/coasting | Measure motion, tolerate a safe overshoot, never reverse toward the first arrival sample | Glance only |
| Actually still | Accept the current safe foot position | Sustained nearby attention may start a small step and turn toward V |
| Look away | Keep the settled stance; no alignment to V's facing or the old travel heading | Relax to a side glance after a short loss-of-attention grace period |
| New movement during a social turn | Cancel the owned social operation once, then travel | Remove its facing target before walking |
| Another member joins/leaves | Existing copies retain their lane identities | No global reordering |
| Occupied/narrow side route | Yield or use native navigation recovery; retry with bounded backoff | Do not chase unreachable exact offsets |
| Combat | Release social locomotion to native combat | Clear owned gaze |
| Death, detach, save change | Drop old actor/command references without querying torn-down components | No callbacks may revive a previous session |

## Verification

Tests must include time-series motion with deceleration and overshoot, rather
than assigning an actor directly to its destination. The reported sequence is
walk -> camera glance back before arrival -> coast past the first arrival
sample -> actual stop. Verify no reverse correction and no body-facing request
until the arrival operation has completed. Repeat with different frame times,
multiple copies, interrupted attention, blocked paths and session teardown.

Native rendered gait still requires the user's game check. Numerical tests
and a stable final frame cannot establish that the whole transition looked
natural.

### September 29 source verification

The complete suite passes **107 tests with no skips**, including the installed
MCM API integration. All **21 Lua files** compile. The new motion suite covers
residual movement after native command success at 0.05, 0.1, 0.23 and 0.5 second
updates; departure during direct attention; quiet navigation recovery; local
personal-space yielding; three people including a duplicate through walking,
running and stopping; and eight copies sharing a route-planning budget.

The integration stand-in models acceleration and stopping distance, not the
game's animation. The separate overshoot replay intentionally reports native
success before motion has stopped, reproducing the boundary the previous
tests missed. Neither is visual acceptance.

The bounded live trace now includes V's world position, confirmed travel
direction, camera direction, selected entity, person state, operation ticket,
native completion, current destination and the latest submitted command.
Camera data is recorded only by diagnostics; it never feeds the controller.

Next live check: walk forward, glance back while Judy is still approaching,
stop and let her arrive, then look directly at her. Verify the whole sequence:
no reversal toward an obsolete spot, a natural stop, and only then a small
social footstep/turn. Repeat with a short run and a second companion. Lua-only
installation requires one CET reload; no redscript restart is needed.

Installed and hash verified at **02:34 IST, September 29**. The preceding 18
installed Lua files are preserved in the ignored local rollback directory
`backups/movement-rebuild-20260929-023441/`. The pre-rebuild party consisted of Judy
`11034257ULL` and Johnny `11034258ULL`; both were ready in the old controller.

### First live trace after activation

The user confirmed CET reload at 02:35 IST. Recreated Judy `11053704ULL` and
Johnny `11053706ULL`; both attached, entered settled state and held one owned
native command with no Lua or gaze error. The 90-second trace is preserved in
ignored `runtime/party-motion-rebuild-first-live-september29.json`.

During Judy's second arrival, one approach ticket remained active through
braking at 42.6 seconds (about 1.04 m/s). She continued another 0.45 metres,
then accepted the actual stopped stance at 44.2 seconds. Direct attention
began afterward, moved about 0.16 metres, and reached a measured facing error
of zero at 47.4 seconds. Looking away retained that stance. The native facing
hook checked 21 commands and cleared one stale object without an error.

No moving sample above 0.4 m/s had movement opposed to body facing by more than
100 degrees. One Johnny side-route validation was rejected; he entered native
recovery and later settled. This is measured runtime evidence, **not visual
acceptance**. The user subsequently accepted the glance but reported that
moving fully into position to face a person still moved the group.

### Moving within a gathering

The same trace confirms a second, distinct intention error: at 61.8 seconds V
had backed up roughly 1.9 metres while still addressing Judy. She was about
three metres away. The simple departure distance treated that as travelling,
rotated the formation and moved both people. Another unselected local step
caused the same transition at 76.5 seconds.

Travel now records fixed positions of settled people for the current stop.
Addressing a nearby person, or stepping across the old travel line within the
gathering, enters local interaction. Gaze loss while circling does not move
the group. The area is bounded by both the original stop (four metres) and
proximity to its people (3.4 metres); its anchors never follow V. Leaving that
area restores travel. Ordinary forward departure without social interest
retains the earlier prompt follow behavior.

Standing members, including distant rear rows, wait during local interaction.
Personal-space yielding still belongs only to the affected person. Once V
stops in a meaningfully different place, the addressed person alone can make
another small social adjustment. It cannot repeat while V remains still.

Regression cases cover backing up during attention, circling with no locked
gaze target, ordinary forward departure, rear rows waiting in an eight-person
party, and one addressed person's adjustment after V stops. The full suite now
passes **112 tests with no skips**; all 21 Lua files compile. Installed and
hash verified at **02:45 IST** with the prior Lua backed up in
`backups/gathering-interaction-20260929-024545/`. This correction still requires
CET reload and a fresh visual check.
