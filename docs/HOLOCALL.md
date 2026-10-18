# Holocalls

V can call a mod character from the phone. The game's call window opens at the top left with the
character's name and portrait. V talks by push-to-talk or typed text, and the character answers in the mod
voice with call-style subtitles. Hanging up ends the call. Built 2026-10-14 on branch `holocall`. The entry point
moved to the game's Contacts list (branch `holocall-contacts`), and after the first live test moved again, to the
mod's own Chat tab (branch `holocall-chat-button`): the game's own phone is never changed. The Chat-tab call button
has not yet been tested in game; an open chat no longer shows a Call hint (2026-10-15).

## Player flow

- **The game's own phone is untouched.** Phone > Contacts and its Call action behave exactly as in the unmodded game
  for every contact, including the characters this mod also talks to: Judy, Panam and the others the game stages a
  video holocall for call as they always did, through the game's quest call. (A first build replaced the game's
  call for those contacts; the live test showed only a portrait where the game would have opened its own call, so
  that wrap, `CallSelectedContact`, is gone.)
- **Phone > Chat tab (the mod's own tab), two places to call, one key: V (Triangle on a pad), the game's own `call`
  action, the key the game's message window uses for Call:**
  - **On the Chat list,** the selected row shows two icons: the chat one (**F** and the envelope) and, beside it, a
    call one (a key box with the call key and a phone). The bottom bar reads **Call** (V), **Chat** (F) and Close.
    These are the game's own key hints, the row's call hint and the bottom bar's second hint rebound to the `call`
    action, and the row's chat hint (the game's is `secondaryAction`, R) rebound to `proceed`, the action the bottom
    bar's Chat hint shows (branch `holocall-polish`, 2026-10-16: the row read R while the bar read F), while a Chat row
    is shown, and put back, from the action they held, for any other row or tab, so the glyphs always show the real key. V starts a call with the selected character. (On a pad
    Triangle is also `showAll`, which means nothing on this tab and is swallowed there.)
  - **Inside an open conversation** no Call hint is shown (2026-10-15, branch `holocall-light`: the user's live test
    found the spawned "V  Call" hint beside the Enter/Esc line spoiled the composer layout, so it and its plain-text
    fallback were removed). V still starts the call there, only while that conversation has the focus and not while a
    message is being typed (V is then an ordinary letter). The game's own Call hint in that window stays hidden: it is
    the game's quest call, and the composer panel covers where it sits.
  - **F is not the Call key.** F is the game's confirm (`click`, with Enter and the left mouse button), so on the Chat
    list it opens the text chat, and inside a chat it does nothing. R (`secondaryAction`) opens the chat too, as it
    did before holocalls; a first build had turned R into Call and lost that shortcut.
  - The message box has no placeholder text.
  - Calling is refused (the game's own blocked-action notice) while the game has turned calls off.
- The call starts once the phone has closed. The window rings for 1.5 to 7 s, then connects, with no
  notice (the call window is the cue).
- Talk with the normal push-to-talk or typed-text keys. No one has to be nearby, because the call is the
  conversation partner.
- **Hang up:** tap or hold the phone button (T, D-pad down). Calling the same person again from the phone also hangs
  up. Calling someone else replaces the call. Either way the phone stays closed and control goes back to the game, as
  when a game call ends. The phone button is both `PhoneInteract` and `PhoneReject`, each with a 0.5 s hold
  (`r6\config\inputContexts.xml`), and the game opens the phone on `PhoneInteract`'s hold (`UsePhoneRequest`) unless a
  call is ringing; a hold that hung up the mod's call used to open the phone on its menu as well (live, 2026-10-16).
  During the mod's call that hold is consumed in `OnAction` and only hangs up. The game's own call end
  (`SetPhoneFunction(Inactive)`, the window's disconnect) never opens or closes the phone, so nothing else is needed.

Only mod characters in `characters/phone-contacts.json` with a conversation profile can take a
holocall (the Chat tab lists only them). Johnny Silverhand never can; his ids are excluded in `mod/holocall.lua` (`NEVER`). Game
and story characters are not touched.

## What the game allows (research evidence)

- **The vanilla call path is quest state.** `questTriggerCallRequest` goes through
  `PhoneSystem.TriggerCall`, which writes the quest fact `phonecall_player_with_<contact>`
  (`SetPhoneFact`) and the `UI_ComDevice.PhoneCallInformation` blackboard. Many systems read that blackboard,
  and `NewHudPhoneGameController.OnInitialize` even re-queues a pending call. The mod therefore
  **never** uses that path. It writes no quest fact, no phone blackboard value and no journal entry.
- **The call window can be driven directly.** `NewHudPhoneGameController` owns
  `holoAudioCallElement` and spawns it with `AsyncSpawnFromLocal(..., n"OnHoloAudioCallSpawned")`. Its
  logic controller exposes `ShowIncomingContact(avatar, name)`, `StartAudiocall(avatar, name, ...)`,
  `StartHolocall(...)`, `ShowEndCallContact()` and `Show()`. The HUD's own `m_CurrentFunction`
  (`EHudPhoneFunction`) and `m_CurrentPhoneCallContact` are kept consistent by hand. The ring and
  connect sounds are the game's own (`ui_phone_initiation_call`, `..._stop`,
  `ui_phone_incoming_call_positive`). **This audio window with name and portrait is fully
  script-drivable.**
- **A live holo picture is a world render, not a widget feature.** In vanilla calls the picture comes
  from `base\cinematics\cameras\holocall_camera.ent`, whose `RenderToTextureCamera` component
  (`gameuiHolocallCameraComponent`, fov 35, off until something toggles it) renders into
  `holocall_camera_render_texture.dtex`; the call window's holocall image
  (`HudPhoneAvatarController.m_HolocallRenderTexture`, shown by `StartHolocall`) displays that texture
  through `holocall_camera_texture_atlas.inkatlas`. Script never binds the picture: it is whatever the
  camera films. `StartHolocall(avatar, name)` only switches the window to holocall mode.
- **How the game stages the caller (checked 2026-10-14 in the extracted quest files under
  `research/cyberpunk/cache/game/raw/`).** Every video holocall character has a setup
  `base\quest\holocalls\<name>\<name>_holocall.questphase` (69 in the base game, 20 more in
  `ep1\quest\holocalls\`). Each runs `<name>_holocall.scene` at the studio marker `#<name>_sm_holocall`,
  armed by quest facts `holo_<name>_calls_v_start/end` (the character calls V) and `holo_v_calls_<name>_start/end`
  (V calls them; set by the story quests at scripted moments, e.g. `q105`). The scene holds the studio prefab
  `#holocalls_studio` (out of bounds in the NE, lit by its own lights), switches a per-character lighting
  variant, activates the character's `#<name>_holo` community entry (the character's normal record and
  appearance), mounts a holocall workspot and switches the camera on. The camera rig there: 0.675 m in front
  of the actor, lens 1.65 m above the feet, 20.4 degrees round from their facing, level. The phone's own
  `CallSelectedContact` asks for `questPhoneCallMode.Video`; whether a call becomes a video or a voice call
  (`StartAudiocall`, with the portrait when `showAvatar`) is decided by the scene, so characters without a
  setup only ever get voice calls. (Third-party write-up with in-game measurements that matches this:
  github.com/blackpotoftea/cyberpunk_docs, `holo_studio/`.)
- **Why the mod cannot reuse it.** All of that is quest state: the facts, the scene, the community
  activation and the global `holo_setup_active` lock that every vanilla holocall respects (a leaked one
  blocks every holocall in the save). Script cannot run a scene or a quest node either. So the mod copies
  the mechanism instead: its own copy of the character, the game's own camera and framing, the game's own
  window.
- **Subtitles have a call type.** `scnDialogLineType.Holocall` (= 2). In the dump, `IsMainDialogLine`
  treats it as a main dialogue line whenever the speaker is set, with no distance check. A remote
  speaker therefore gets a normal bottom subtitle.

## Design

### Native (`r6/scripts/CyberpunkConvai/Holocall.reds`)

- **No hook on the game's phone.** Nothing here wraps or replaces `CallSelectedContact`, `CallContact` or any
  other part of the game's call path; the wraps in this file (`OnInitialize`, `OnUninitialize`, `OnHoloAudioCallSpawned`,
  `OnPhoneCall`, `OnAction`) all reach `wrappedMethod` and change nothing unless a mod call is active.
  `bridge/holocall.test.mjs` asserts that no game call function is wrapped or redefined.
- **Two entry points, both in the Chat tab,** both event-driven (a key press or a click), no per-frame work:
  `PhoneMessagePopupGameController.ConvaiChatHolocall` (the Call key `call` while the conversation has the focus;
  `PhoneChat.reds`) and `NewHudPhoneGameController.ConvaiChatListHolocall` (the `call` key on a Chat row, listened for with the list's own
  inputs, `PhoneChatTabs.reds`). Each checks that calling is enabled (else the game's blocked
  notice) and ends in `ConvaiHolocallRequest(contact)`, which accepts only a contact registered for AI chat
  (`ConvaiPhoneChatHasContact`).
- The request is one contact id, stored by `ConvaiHolocallRequest`, which closes the contact list (the phone closes).
  Lua takes it. Lua refuses, with a notice, a contact with no holocall profile or a Johnny/Silverhand record.
- `ConvaiHolocallBegin(contact)` returns one of the following:
  - `ok`
  - `no-hud`
  - `quest-call`: the game's call phase is Incoming or StartCall, the incoming-call widget exists, or
    `PhoneManager.IsPhoneCallActive()` is true
  - `calling-disabled`: `PhoneSystem.IsCallingEnabled()` is false
  - `unknown-contact`: not an active, known journal contact
- `ConvaiHolocallConnect(live)` switches the window to the audio call (or `StartHolocall` when the live
  picture is ready). It returns `audiocall`, `holocall`, `pending` (the window is still spawning) or
  `ended`.
- **Quest calls always win.** The `OnPhoneCall` wrap sees an IncomingCall or StartCall while a mod
  call is active. It marks the mod call preempted, sets the HUD function to Inactive and queues
  `quest-call`, then **always** runs the game's handler. When a game EndCall arrives and the game has
  no call of its own, the HUD function is briefly Inactive so vanilla does not close the window with a
  null contact.
- The `OnAction` wrap only watches PhoneInteract and PhoneReject. It never consumes input and always
  calls `wrappedMethod`. It is ignored while the contact list is open.
- Events for Lua (`hangup`, `quest-call`, `hud-lost`) are capped at eight, with no duplicates.

### Lua (`mod/holocall.lua`, global `convaiHolocall`)

- `drain` runs in the phone request drain that already exists. `update` runs from the 0.1 s game tick.
  Nothing runs per frame: an idle mod does one nil check, and a call steps every 0.25 s.
- A request starts only when the world is playable. The call is refused (with a short notice) in
  these cases:
  - combat
  - a replacer
  - a game call
  - a scene: a dialogue, choices, or a non-gameplay tier
  - disabled conversations
  - a contact that is not a mod character
- End reasons logged:
  - `hangup`
  - `replaced`
  - `quest-call`
  - `combat`, `scene`, `replacer`
  - `disabled`
  - `idle`: 180 s with no talk
  - `max-length`: 30 min
  - `hud-lost`
  - `shutdown`, `abandoned` or the session's own reason (save load, world lost)
  - `error`, logged after `Holocall update failed: ...`
- **Conversation partner.** Talk targets the call, not a nearby NPC:
  - **Audio:** `npc` is the player, `voiceOnly` is set, and the protocol carries
    `holocall = {version = 1, contact, mode}`.
  - **Live picture:** `npc` is the posed copy.
  - In both modes, `init.lua` skips the gaze focus, the microphone decorate step and gameplay actions.
- **Speech.** `speech.lua` and `continuous-speech.lua` play the voice at the player with zero distance,
  so it is a phone voice at full volume. `subtitles.lua` forces dialogue mode and uses
  `scnDialogLineType.Holocall`.
- **Latency.** Dialing warms the bridge conversation (`warmConversation`) while the window rings, so
  the first turn uses the same warm path as face-to-face talk.

### Live picture (setting, on by default)

**Companion Manager > Settings > Conversations > Live holocall picture.** (It was in
Development until 2026-10-14; it is the only holocall setting.)

**On by default since 2026-10-14.** It was off by default at first, and the first version wrote that `false` into
`runtime/settings.json` for everyone, so merely changing the default would not have reached an existing install.
`mod/manager.lua` therefore treats a saved `false` as a choice only when an Apply carried it
(`holocallLiveImageChosen`, as for Expressive emotions); an unchosen `false` becomes `true` on the next load. The
live test that prompted this saw only the portrait for exactly that reason: with the setting off the call is always
the portrait voice call, a normal result, not a failure.

**Who gets a picture, as in the game (branch `holocall-native-look`, 2026-10-14).** Only the contacts the game
itself has a holocall setup for (`STAGED` in `mod/holocall.lua`: 59 of the mod's phone contacts, mapped by hand
from the folders above, e.g. `stout` -> `meredith`, `marianne` -> `claire`, `stud` -> `mr_stud` (mq012)). Every other
contact is a voice call with the portrait, as the game does for contacts without a setup, with no spawn, no search
and no notice. The probe line says `cast=video` or `cast=voice`.

With the setting on, dialing a staged character does the following (one step per 0.25 s call tick):

1. **Finds a studio** out of V's sight: a level floor with 2.3 m of headroom, hidden from V's eyes by something
   solid, with open space for the camera on one side. Candidates in order: **near first**, a floor 10 m above to
   10 m below V's feet straight over or under V and at eight points on each of two rings, 5 and 8 m round V, kept only
   when it is within 11 m of V (`FACE_RANGE`; see "Face" below), each near column tried **floor by floor** (when the
   first floor down will not do, the one under it, up to four: see "Ready and near" below); then the first floor 10 to
   90 m above V, straight up and at eight points 30 m away; then, when nothing stands above V (a high apartment, open
   ground), floors from 10 m above to 80 m below V's feet on rings of 12, 24 and 40 m round V (24 columns). Three
   candidates (one floor of one column, up to about 22 raycasts) per tick: once per call and nothing afterwards; where
   nothing near is hidden the whole search is about 23 ticks (the picture waits up to `RING_MAX`, 10 s). No floor: `holo failed ... reason=no-studio-spot (<reason>=<count>, ...)` and the portrait. The
   vanilla studio has a floor too: a copy in mid-air falls.
2. **Spawns the copy** there with the character's own record (checked to be a real character record first: a
   record that does not resolve would crash), tagged `CyberpunkConvaiCompanion` (speech face layer) and
   `CyberpunkConvaiHolocall`, transient, `alwaysSpawned`.
3. **Spawns the game's camera** (`holocall_camera.ent`) at the game's framing: 20.4 degrees round from her facing,
   level, fov 35, at a 0.5 m frame (0.79 m away, lens 1.6 m above her feet; the game's own is 0.675 m and 1.65 m,
   a slightly tighter face shot that a taller or shorter character can fall out of).
4. **Spawns the light rig** round the copy: three of the game's corridor lights (see "Light" below).
5. **Keeps the copy animating** off screen (`AnimationSystem.SetForcedVisible(id, true)`; without it an unseen body
   is culled and stands frozen with a still face), holds her in her talk pose (gesture device workspot, her talk
   family from `gesture-catalog.lua`), switches the camera on (`Toggle(true)`), and turns her to the lens
   (`LookAtAddEvent` on the camera entity, see "Gaze" below), renewed every 5 s.
6. The call connects with `StartHolocall`: the window shows the holocall image instead of the portrait.

If the copy or camera is not ready when the ring ends (6 s at most; the game's own failsafe is 8 s), or the copy
drifts more than 1.5 m, the call continues with the portrait. In that case the mod logs `holo failed ...
fallback=audio` and shows the notice "Live picture unavailable. The call continues with the portrait." At hang-up
the look is retired, the forced animation cleared, the lamps switched off and deleted, the pose left, the copy deleted, and the camera switched off at
once but deleted 1.5 s later: freeing a render-to-texture camera in the frame it is switched off can crash the
render thread. A sweep also clears tagged leftovers after a reload; a load forgets everything without native calls.

**Why the first live test showed no face (2026-10-14/15, CET log `scripting.log`):** the search only looked 10 to
90 m above V, and every call logged `holo failed ... reason=no-studio-spot (no-floor) fallback=audio` (Alex, Judy,
Mama Welles; all nine columns found nothing above V), so the call went on with the portrait. The call start, the ring
and the window were fine. The search now also looks level with and below V (above).

**Why the first version stayed empty (never seen in game; from the code and the research):** the copy was
placed 40 m straight up in mid-air, so it fell out of frame while its talk pose was still being set up (and inside
a tall building or megabuilding that spot is inside walls); nothing kept an unseen copy's animation running; the
camera stood dead in front at 0.9 m with no look at the lens.

### Face (branch `holocall-face`, 2026-10-15)

**Why her face did not move.** The speech path was right all along: a holocall reply's face goes to the copy (speech
target `holo.npc`, `facial-playback.lua` `start`/`sync` on it, its graph prepared through the companion tag; the
CET log's last holocall turn showed 387 written frames, jaw peak 0.58, `blocked=false`). The game simply does not
animate a face far from V's own camera. Measured live with one `ConvaiFaceApply` (jaw 0.9, then blink 1) on the call's
copy, the studio forced to chosen floors (probe `runtime/holo-face.lua`):

| Copy from V | Jaw / blink seen through the call camera |
|---|---|
| 2.5 m, 5 m, 7.8 m, 11.2 m | yes |
| 15.8 m, 19.2 m, 42.5 m | no (frozen face, body still animated; at 19 m and beyond the face mesh is also coarser) |

Setting `clientForcedLod 0`, `clientForcedVisibility` and `useLongRangeVisibility` on the copy's `face_rig` at
runtime, with or without toggling the component off and on, changed nothing at 42 m. The game's own holocall actor
is spawned with `forceMaxVisibility` (judy_holocall.scene, `spawnSetParams`); there is no script call for it.

**Fix.** The studio search tries near floors first (step 1 above), so a picture within 11 m of V is used whenever there
is one; the probe line's `away=<m>` says how far she is. From V's Corpo Plaza apartment the search found a floor 5.1 m
above V and the picture showed the jaw, the blink and a replayed talking timeline (`face-play` through the real writer)
moving. A farther studio is no longer used (`M.FAR_PICTURE`, false since 2026-10-18; see "Far studios" below): the
call goes on with the portrait. Also, `Face.reds` asks the holocall copy's
animated components for full detail before they attach (`clientForcedLod 0`, `clientForcedVisibility`,
`useLongRangeVisibility`), since runtime changes are ignored; whether that alone keeps a far face moving is checked
after the next game restart (see "Not verified yet").

### Expressions (branch `holocall-expressions`, 2026-10-16)

The user: "would be nice if [they] smiled though and had the expression support ... like we do normally for our mod
characters". The speech writer already drew a reply's emotion on her while she spoke (the reply's expression receipt
and tracks reach any speaker), but the idle face writer (`mod/facial-playback.lua` `updateExpressions`) works only on
the face layer's actor rows, which were the party's copies (`companions.expressionActors`), and its ownership check
(`owns`) asked `convaiCompanions.owns`. So the holocall copy had no resting smile, no blinks or thinking and listening
face between replies, no lingering reaction and no mood hold, and her expression slot was dropped the frame after each
reply ended (with a plain face reset instead of the hand-over to the idle face).

Now `holocall.lua` `M.faceRow()` gives the face layer a row for her (`entity`, `npc`, her profile key, so her own
traits apply: Judy's warmth .12 and corner gain 1.6, for example) while the live picture is connected and the studio is
within `FACE_RANGE` (11 m: a farther face does not animate, so it gets no row); `companions.expressionActors` appends it
at its 0.1 s rebuild, and `owns` also accepts the copy `holocall.lua` `M.ownsFace` names. One row table per call. When
the call ends the row is gone at the next rebuild and the slot is released with no native call. Lip sync is unchanged;
the end of a reply now hands her face to the idle writer as for a companion. Nothing runs per frame beyond what one
more companion costs (an idle face sleeps once settled).

**Seen live (probe call, Judy, studio forced near V).** Owned, idle, not blocked; resting pose lip corners up .19 with
a slight lower-lid squint (a visible soft smile); a forced Joy raised the corners to .50 with squint .43 and outer brows
.30 (a clear smile); a forced Sadness showed raised inner brows and lowered corners. At a spot whose studio was 20.7 m
away she got no row, as intended. Not yet seen: a real reply's emotion tag on the call (needs a talk turn).

**The call face mirrors her face in the world, with no boost, by design (2026-10-16).** The face row carries only her
entity, actor, profile key and name, so the copy's face is driven exactly as a mod-spawned copy's is in the world: the
same traits, emotion policy, caps, mouth budget and resting smile. There is no call-only scaling or reshaping.

For the record, two call-only layers were tried and removed:

- **`holocall-expr-2`: an expression boost.** The emotion mix x1.6, a reply label raised one step, and the resting smile
  x1.6.
- **`holocall-expr-3`: a smile shape.** Corner stretch, upper-lip raise and lip stretch derived from the written corners,
  on the Lua path and in the native core.

The user saw the smile live and found it too much: "dont over push emotions actually, just let it copy how the character
look in game with our mod".

What the bold A/B on Alex's call copy established, at full window resolution with forced poses held 3-4 s:

- Every control the writer sends reaches the rendered face: jaw, corners, brows and widened eyes.
- So the face graph, the component, the talk pose and the writer are not at fault.
- At the call picture's size (her face is about 60 px in a 1366x768 game), corners up alone read weakly.
- The lower-lid, upper-lid and inner squints do not move on Alex's crowd head even at 3. They do on Judy's rig.

The capture sheet is `runtime/holocall-expressions-compare.png` (not in git).

### Gaze (branch `holocall-face`, 2026-10-15)

The game's holocall scene aims its caller with one `scnLookAtEvent` (preset "Eyes & Head"): the eyes lead, with
additional parts Head (weight 0.1) and Chest (weight 2), nothing suppressed, transition speed 80, at a look-at entity
just behind the camera. The copy now gets the same request on the camera entity, with the head at 0.3
(`M.LOOK_HEAD`): her camera stands 20.4 degrees round, and at the game's 0.1 her face stayed visibly short of the lens.
Before, the request turned only the eyes (head 0.05, suppressed) and the frozen far face could not turn even those, so
she looked past the camera to the viewer's left. It is sent once when the picture is ready and renewed on the
existing 5 s beat (the game drops a stale look request), nothing per frame.

### Light (branch `holocall-light`, 2026-10-15)

**What the user saw.** The first lit-up live picture (Judy, V in a high apartment at 7 pm in fog) showed her as a
black silhouette: the search had put the copy 41 m below V, at street level under an overhang, and the camera saw her
against the bright open street behind her, with no light on her face. Frames: scratchpad `holo/before-1`.

**How the game lights a holocall.** Evidence: `base\quest\holocalls\judy\judy_holocall.scene`, the studio sector
`base\worlds\03_night_city\_compiled\default\quest_ec82d0423d8f1435.streamingsector` and
`base\cinematics\cameras\holocall_camera.ent`, extracted with WolvenKit 9.0.1 from `basegame_4_gamedata` and
`basegame_3_nightcity`.

- The camera is the same one the mod spawns: `gameuiHolocallCameraComponent` `RenderToTextureCamera`, fov 35, a
  256 x 256 `RGBA_Uint8_SRGB` dynamic texture, `farPlaneOverride` 1000, no `env` override, `features.localShadows` 0,
  and a `DistantFogAreaSettings` block of its own. Nothing about the render target is special: no render plane, no
  light channel, no scene layer other than `Default`. The cameras placed in the studio override nothing relevant.
- The light is in the **world**, not in the camera. The studio (`$/03_night_city/ne2/#holocalls_studio`, near
  5894, 6135, out of bounds) is a black box of editor boxes and `q110_black_box` meshes, with **270
  `worldStaticLightNode`s** in prefab variants, one reflection probe (`envprobe_002`,
  `holocalls_studio_026069e7.envprobe`) and one light-channel volume (`LC_Channel1`). The scene switches the lighting
  per character: `questTogglePrefabVariant` on `#holocalls_studio_lighting`, variant `judy_holocall_lights`, shown at
  the start and hidden at the end (together with `#judy_holocall_setup`), and
  `questEntityManagerToggleComponent` `RenderToTextureCamera` on `#judy_holocall_camera`. A quest holocall is
  `questCallContact` plus that scene; the actor is the `#judy_holo` community entry on a workspot.
- A lighting variant is 3 to 6 small lights within 0.5 to 1.1 m of the face, 1.4 to 2.3 m up, aimed at 1.4 to 1.8 m:
  spot lights of 5 to 150 lm and area lights of 50 to 100 nit, radius 0.5 to 5 m, no local shadows,
  `autoHideDistance` 5 m (a few have 10 to 30 m), light channel 0 (29 of the 270 are `LC_Character`). Typically a
  warm or white key in front and above, and coloured accents (blue, cyan, green, orange) at the side and behind. The
  blue-cyan holo look is the call window's overlay; the lights themselves are ordinary. A third-party write-up
  measured the same (github.com/blackpotoftea/cyberpunk_docs, `holo_studio/`).

**Why the mod cannot copy it directly.** World light nodes and prefab variants are quest data, and script cannot
toggle a prefab variant. A light component added to an already attached entity at run time (Codeware
`Entity.AddComponent` from CET) is listed but never lights: tried, no change even at 100 times the intensity. A new
`entLightComponent` defaults to light channel 511 (`LC_Channel1` to `8` plus `LC_ChannelWorld`), a 100 lm point light,
radius 5, `autoHideDistance` 15.

**The fix: the game's own lamp, three times.** `M.LIGHTS` in `mod/holocall.lua` spawns
`base\gameplay\devices\lighting\residential\corridor_light\corridor_light_a.ent` (a light device: a point
`gameLightComponent`, a fixture mesh and a collider) at three places round the copy, tagged and transient like the
copy, in the same spawn step as the camera. Once a lamp has spawned its mesh and collider are switched off and its
light is driven by the light's own script API (`ToggleLight(true)`, `SetIntensity`, `SetRadius`, `SetColor`):

| role | bearing from her facing | distance | height | lumen | colour |
|---|---|---|---|---|---|
| key | 55 degrees (the camera's side, further round) | 0.85 m | 2.0 m | 110 | warm white 255, 238, 220 |
| fill | -50 degrees | 0.9 m | 1.45 m | 28 | cool white 220, 232, 255 |
| rim | 170 degrees (behind) | 0.75 m | 2.05 m | 75 | blue-cyan 110, 200, 255 |

Radius 2.5 m, and shadows off as in the game's studio, so a lamp that lands inside a wall still lights her and the
light does not reach far. They are point lights rather than spots because the device's light is a point light; at
these distances a point light carries the same rig. The lumens were tuned live against the call window: 3000 lm blew
the face out (the user's "too much" was this test), 250/60/150 was still bright, 120/30/80 looked naturally lit and
60/15/40 started to go dim, so 110/28/75 is used. The fill is a quarter of the key so the face keeps its modelling.
Frames (scratchpad `holo/`): `lampA.png` (unlit, then a 3000 lm lamp), `rigB.png` (no rig, 250, 120, 60),
`final1.png` (before, the shipped rig at 10 s and at 40 s, after hang-up).

- **Range.** The lamp's `autoHideDistance` (30 m) did not hide it with V 43 m away: the hide distance is measured
  from the view that renders the light, here the call camera 0.8 m off.
- **The spot.** Any spot now renders lit, at night, underground or under cover, because the rig is self-contained and
  shadowless. The world behind her is cut out (see "Backdrop and body" below).
- **Cost.** The three lamps exist only between the spawn and the hang-up (switched off, then deleted with the copy;
  the reload sweep clears tagged leftovers). Lighting them is one check per pending lamp on the call's 0.25 s step;
  once all are lit, `IsOn` is checked on the look's 5 s beat and a lamp the game switched off is lit again. Nothing
  runs per frame. The render cost is three small unshadowed point lights during a call.
- Probe lines: `holo ready ... lights=3/3`, and `holo lit contact=<id> lights=3/3` when a lamp came up after the
  picture was ready.

### Backdrop and body (branch `holocall-polish`, 2026-10-16)

The user's round on 2026-10-16: every body was turned to one side while the eyes found the lens, and the world showed
behind her where the game's own holocalls stand against black.

- **Body.** The game's studio films its actor 20.4 degrees round from her facing (a three-quarter view), and the copy
  was placed the same way. Now her body is spawned facing the camera squarely (`M.bodyYaw`: the spot's facing plus
  `SHOT.orbit`), once; the camera and the lamps keep their places round the spot's facing, so the framing and the
  light are unchanged, and the look at the lens still runs. Probe line: `holo spawn ... yaw=0 body=20.4`.
- **Backdrop.** The call camera's own component has a `depthCutDistance`: the camera draws nothing farther than that.
  Set (live probe, 2026-10-16) to the lens distance plus 0.9 m (`M.BACKDROP`), it removes everything behind her and
  leaves her and anything within 0.9 m behind her. The cut part of the picture is transparent: the camera's
  `backgroundColor` with `overrideBackgroundColor` is not drawn (tried black and red, opaque), and the window showed
  its own frame dots and the game behind it. So the call window gets a black rectangle the size of its holocall image
  (`holocallRenderTexture`, 450 x 450, opacity 0.93), inserted just behind the image in its holder
  (`Holocall.reds`, `HudPhoneAvatarController.ConvaiHolocallBacking`), shown only while the mod's holocall shows and
  hidden when it ends or a game call takes the window. Nothing is spawned, nothing runs per frame: the cut is set
  once before the camera is switched on, the backing on the window's state changes. Lua makes the cut only when
  `PlayerPuppet.ConvaiHolocallHasBacking()` exists, so an older redscript keeps the world behind her rather than a
  see-through hole. Probe line: `holo ready ... backdrop=true`. Frames (scratchpad `holo/`): `bg1.png` (before, the
  cut with the background colour set: no change until the camera is switched off and on, then see-through),
  `bg2.png` (a red background colour: still see-through; no cut), `bg3-back/crop.png` (the cut with the black
  rectangle: Judy against black).

### Ready and near (branch `holocall-ready`, 2026-10-16)

The user's first real call (alex, from the Chat tab, V on a Vista Del Rey terrace): no lip sync, no expressions, and
the first reply said "Preparing connection".

**Why no face.** `holo spawn ... floor=-16.8m away=20.7m`: the studio was a low-ring column 12 m out and 16.8 m down,
past `FACE_RANGE`, so no face row and a frozen face (the speech face was written: `face=true/prepared`). The probe
`runtime/holo-scan.lua` (read-only) showed why: every near column's first floor was V's own terrace, in plain view, or
open air; the search took only the first floor down each column. `runtime/holo-layers.lua` listed what was under it:
surfaces 2 to 5 m below V's feet in most columns. This also settles `Face.reds`'s full-detail request: the real call
wrote the face at 20.7 m and the user saw it frozen, so it does not keep a far face moving.
Now a near column goes on to the floor under one that will not do (`studioAt`'s `below`, up to `NEAR_LAYERS` = 4
floors), and a second near ring at 8 m. The search still takes three candidates per tick; a column ends without
spending one when the next floor would be past its range. Run against V's spot (`runtime/holo-next.lua`, the branch's
`holocall.lua` loaded beside the live one): a floor 6.6 m from V, 4.3 m under V's terrace, on the 11th candidate.

**Why "Preparing".** The call warmed her connection while it rang (`env.warm`, a composer hint), but with the player's
own key the bridge pre-opens nothing (`keys.singleSession`, also on a paid plan: `PartyConnections.deferWarm`), so her
page stayed `waiting` until the first turn opened it. The stage clock of that turn: `connectionWarm.state=waiting`, 22 s
after dialing; 8.7 s to the voice start, then 7.8 s more for a Voxtral timeout and retry (a separate cloud hiccup).
The second turn: `ready`, 3.7 s. Now:
- the ring-time hint is marked `call` (`init.lua warmConversation`), and kept while the call lives (a closed text box
  or a cancelled recording would otherwise drop it);
- the bridge opens that caller's page at once (`PartyConnections.openCall`, as an invitation's `warmSingle` does on a
  single-session plan), and maintenance retries it if it was gated; nothing else is pre-opened on that plan;
- the call rings until `env.ready` (the same check as the "Preparing connection" notice: her private connection
  `ready` in `runtime/party-connection-state.json`, read at most once a second) or `READY_MAX` (18 s), asked once per
  0.25 s tick while it rings. The connect line says `ready=yes|timeout ring=<s>s`.
With Mistral or the local AI the warm resolves at once, so the call connects as soon as the picture is up.

### Far studios (branch `holo-fix`, 2026-10-18)

**Seen live (2026-10-18, V on a street in Little China, five calls).** No near floor was hidden from V, so every
call took the first column above V: `holo spawn ... floor=+79.0m away=84.5m` (a roof 79 m up, 30 m to one side). The
picture came up, but her face never moved with a reply (the speech face was written: `face=true/prepared`, 151 to
163 frames applied, as at 20 m on 2026-10-15), Blue Moon's body was coarse and without facial detail, and Rogue's
picture had broken scenery along its bottom edge. `Face.reds`'s full-detail request for the copy's components does not
keep a far face moving or detailed. The calls of 2026-10-15/16 that worked were all placed from apartments, with a
near studio (`floor=+4.5m away=4.5m`, `+5.1m`).

**Now.** The search stops after the near columns (`M.FAR_PICTURE = false`): with no hidden floor within `FACE_RANGE` the
call connects with the portrait, the usual `holo failed ... reason=no-studio-spot (<reasons>) fallback=audio` line and the
"Live picture unavailable" notice. `far=<n>` in the reasons counts near floors that were hidden but past 11 m. Setting
`M.FAR_PICTURE = true` restores the farther columns.

**Voice probe line.** Each holocall reply logs `Holocall voice: path=browser level=<0..1>` (the cloud and Pocket voices,
the browser renderer, at the phone's full level) or `Holocall voice: path=audioware on=<class> away=<m>m` (an Omni or
prepared WAV, played on V's weapon or chest item: full level within 2 m, silent past 18 m), once per reply.
With the 2026-10-18 voice fix the Audioware line is `Holocall voice: path=audioware-v` (see below); `path=audioware on=...`
only appears with an older `Speech.reds`.

**Native voice on a call (2026-10-18).** Seen live from an apartment (`floor=+4.5m away=4.5m`): a prepared OmniVoice
WAV played on a holocall moved her lips (the Audioware cursor advanced, `nativePlaybackObserved: true`) but nothing was
heard, while V's own voice and a Voxtral (browser) reply on the same kind of call were heard normally. The Audioware
phrase was a spatial `DynamicEmitterEvent` on V's weapon or chest item (`bodyObject`, because Audioware refuses V as an
emitter): a kira spatial track placed at that item's world position, attenuated by distance (silent past 18 m) and an
occlusion filter, heard from the listener. An item's world position need not be where V stands (a worn item's entity is
not V's body), so the phone voice could play somewhere V could not hear it. Fix: `Speech.reds`
`ConvaiSpeechStartOnV(event)` queues a `DynamicSoundEvent` on V itself; Audioware's `Engine::play` sees the listener's
own entity and plays it on V's non-spatial track (`tracks.v.vocal`), with no place, distance or occlusion: a phone voice.
`speech.lua` tries it first for every holocall phrase; `ConvaiSpeechPosition`, `Pause` and `Stop` serve both kinds, so
the clock, lip sync, pause and stop are unchanged. With an older `Speech.reds` (no such method) the emitter path is kept.
Needs a full game restart (redscript).

### Bridge

- `bridge/protocol.mjs` `parseHolocall`: version 1, contact `[A-Za-z0-9_]{1,64}`, mode `audio` or `holo`.
  Group turns ignore it.
- `bridge/turn-context.mjs` describes the call as remote. It drops the party, health, heat and money
  lines and says:
  - audio: "You are on a voice call with V on the phone, not talking to V in person; ..."
  - holo: "You are on a holocall with V (a video call on the phone): you see and hear each other, ..."
- The diagnostic line gains ` holocall=<mode>`.
- The channel stays private, so memory is shared with face-to-face talk.
- `bridge/mistral-prompt.mjs` treats these sentences as a "where" line.

## Probe lines (`[Holocall]` in the CET log, one per state change)

```
requested contact=<id>
state=dialing contact=<id> profile=<key> mode=audio|holo cast=video|voice hud=ok
holo spawn contact=<id> record=<record> floor=+<m>m away=<m>m yaw=<deg> lens=<m>m        (live picture only)
holo ready contact=<id> held=yes camera=on animated=true|false look=true|false drift=<m> lights=<n>/3 (live picture only)
holo lit contact=<id> lights=3/3                                                         (a late lamp, live picture only)
holo failed contact=<id> reason=<r> fallback=audio                                       (live picture only)
state=connected contact=<id> mode=audio|holo window=audiocall|holocall|pending ready=yes|timeout ring=<s>s
window=<w> contact=<id>                                       (a pending window appeared)
state=ended contact=<id> reason=<r> length=<n>s
refused contact=<id> reason=<r>
Holocall conversation: profile=<key> mode=<mode>              (init.lua, each talk turn)
```

The bridge turn-context diagnostic ends with `holocall=audio` or `holocall=holo`.

## Not verified yet

- **Seen 2026-10-15 (window capture, call started with the dev probe, V in a high apartment at about 7 pm):** the
  ring, the connect into the holocall window, the live picture of Judy (`holo spawn ... floor=-41.1m`, `holo ready`),
  the silhouette before the light rig, the naturally lit face with it (still lit after 40 s), and the window and every
  spawned entity gone after the hang-up.
- The end animation drawn by `ShowEndCallContact`. The redscript compiles in the isolated check (2026-10-15).
- That the Chat list's selected row shows the chat icon (R, envelope) and the call icon (a key box with V, a phone)
  with the separator, that the bottom bar reads Call (V), Chat (F), Close, and that V starts the call there while R
  and F open the chat; that the rebinding of the game's key hints leaves the Contacts and Messages tabs showing their
  own keys (F and R, Z) afterwards; that an open chat now shows only the Enter/Esc line under the message box (no
  Call hint) and that V there still starts the call (and V typed into a message does not); that the vanilla Contacts
  Call (F) for Judy, Panam and others opens the game's own call again, untouched.
- That a tap of the phone button reaches the HUD controller as PRESSED then RELEASED on keyboard and
  pad, and that neither a tap nor a hold leaves the phone open after hanging up (branch `holocall-polish`).
- The black backing drawn by `Holocall.reds` itself (the look was checked with a probe-made rectangle), and the
  row's chat hint showing F (needs the game restart).
- The Holocall subtitle type showing a bottom line for the player as speaker.
- **Seen 2026-10-15 (holocall-face, window capture, probe calls):** with the studio within 11 m her jaw opens, she
  blinks and a replayed talking timeline moves her mouth; with the head and chest look she faces the lens. Not seen yet:
  her lips following a real reply's voice (no talk turn was made), and whether `Face.reds`'s full-detail request keeps a
  face moving at a far studio (needs the game restart).
- (holocall-ready) The call ringing until her connection is open and the first reply without "Preparing" (needs the
  bridge change: the bridge runs from the main checkout, so after the merge and a bridge restart).
- The live picture elsewhere: the floor search and the light rig in other places (a street, the Badlands, at
  night, a spot inside a building), how often a near floor exists there, other characters and heights in the framing,
  and a call placed by the player from the Chat tab rather than by the probe.
- What happens when a real quest call arrives during a mod call: the preempt path.

## Files

- `r6/scripts/CyberpunkConvai/Holocall.reds` (new)
- `PhoneChatTabs.reds` and `PhoneChat.reds` (the Chat tab's call entry points: the Call key in a chat, the Call action and hints on the list)
- `mod/holocall.lua` (new)
- `mod/init.lua`, `speech.lua`, `continuous-speech.lua`, `subtitles.lua`, `manager.lua`, `mcm.lua`,
  `notices.lua`
- `bridge/protocol.mjs`, `turn-context.mjs`, `mistral-prompt.mjs`
- Tests: `bridge/holocall.test.mjs` covers the protocol, the turn context, static checks on the reds,
  and the Lua state machine in fengari.
