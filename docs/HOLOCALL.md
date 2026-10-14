# Holocalls

V can call a mod character from the phone. The game's call window opens at the top left with the
character's name and portrait. V talks by push-to-talk or typed text, and the character answers in the mod
voice with call-style subtitles. Hanging up ends the call. Built 2026-10-14 on branch `holocall`. The entry point
moved to the game's Contacts list (branch `holocall-contacts`), and after the first live test moved again, to the
mod's own Chat tab (branch `holocall-chat-button`): the game's own phone is never changed. The Chat-tab call button
has not yet been tested in game.

## Player flow

- **The game's own phone is untouched.** Phone > Contacts and its Call action behave exactly as in the unmodded game
  for every contact, including the characters this mod also talks to: Judy, Panam and the others the game stages a
  video holocall for call as they always did, through the game's quest call. (A first build replaced the game's
  call for those contacts; the live test showed only a portrait where the game would have opened its own call, so
  that wrap, `CallSelectedContact`, is gone.)
- **Phone > Chat tab (the mod's own tab), two places to call, one key: V (Triangle on a pad), the game's own `call`
  action, the key the game's message window uses for Call:**
  - **On the Chat list,** the selected row shows two icons: the chat one (**R** and the envelope, as always: R opens the
    chat) and, beside it, a call one (a key box with the call key and a phone). The bottom bar reads **Call** (V),
    **Chat** (F) and Close. These are the game's own key hints, the row's call hint and the bottom bar's second hint
    rebound to the `call` action while a Chat row is shown and put back, from the action they held, for any other
    row or tab, so the glyphs always show the real key. V starts a call with the selected character. (On a pad
    Triangle is also `showAll`, which means nothing on this tab and is swallowed there.)
  - **Inside an open conversation,** a Call hint (the game's key hint for `call`, with the game's own translated Call
    label) sits under the message box, beside the Enter/Esc line. V or a click on it starts the call. The key is only
    live while that conversation has the focus, and not while a message is being typed (V is then an ordinary
    letter). The game's own Call hint in that window stays hidden: the first test showed no call button there, most
    likely covered by the composer panel, so the hint now lives in that panel.
  - **F is not the Call key.** F is the game's confirm (`click`, with Enter and the left mouse button), so on the Chat
    list it opens the text chat, and inside a chat it does nothing. R (`secondaryAction`) opens the chat too, as it
    did before holocalls; a first build had turned R into Call and lost that shortcut.
  - The message box has no placeholder text.
  - Calling is refused (the game's own blocked-action notice) while the game has turned calls off.
- The call starts once the phone has closed. The window rings for 1.5 to 7 s, then connects. A notice
  says "Holocall with {name}. Tap the phone button to hang up."
- Talk with the normal push-to-talk or typed-text keys. No one has to be nearby, because the call is the
  conversation partner.
- **Hang up:** tap the phone button (PhoneInteract pressed and released without a hold), or hold the
  reject button. Calling the same person again from the phone also hangs up. Calling someone else
  replaces the call.

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
  `PhoneMessagePopupGameController.ConvaiChatHolocall` (the Call key `call` while the conversation has the focus, or
  a click on the Call hint; `PhoneChat.reds`) and `NewHudPhoneGameController.ConvaiChatListHolocall` (the `call` key on a Chat row, listened for with the list's own
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

**Companion Manager > Settings > Conversations > Live holocall picture (experimental).** (It was in
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
   solid, with open space for the camera on one side. Candidates in order: the first floor 10 to 90 m above V,
   straight up and at eight points 30 m away; then, when nothing stands above V (a high apartment, open ground),
   floors from 10 m above to 80 m below V's feet on rings of 12, 24 and 40 m round V (24 columns). Three candidates
   per tick (about 22 raycasts each), so the whole search is at most 11 ticks (2.75 s), once per call and nothing
   afterwards. No floor: `holo failed ... reason=no-studio-spot (<reason>=<count>, ...)` and the portrait. The
   vanilla studio has a floor too: a copy in mid-air falls.
2. **Spawns the copy** there with the character's own record (checked to be a real character record first: a
   record that does not resolve would crash), tagged `CyberpunkConvaiCompanion` (speech face layer) and
   `CyberpunkConvaiHolocall`, transient, `alwaysSpawned`.
3. **Spawns the game's camera** (`holocall_camera.ent`) at the game's framing: 20.4 degrees round from her facing,
   level, fov 35, at a 0.5 m frame (0.79 m away, lens 1.6 m above her feet; the game's own is 0.675 m and 1.65 m,
   a slightly tighter face shot that a taller or shorter character can fall out of).
4. **Keeps the copy animating** off screen (`AnimationSystem.SetForcedVisible(id, true)`; without it an unseen body
   is culled and stands frozen with a still face), holds her in her talk pose (gesture device workspot, her talk
   family from `gesture-catalog.lua`), switches the camera on (`Toggle(true)`), and turns her eyes to the lens
   (`LookAtAddEvent` on the camera entity, eyes leading, transition speed 80 as the game's holocall look),
   renewed every 5 s.
5. The call connects with `StartHolocall`: the window shows the holocall image instead of the portrait.

If the copy or camera is not ready when the ring ends (6 s at most; the game's own failsafe is 8 s), or the copy
drifts more than 1.5 m, the call continues with the portrait. In that case the mod logs `holo failed ...
fallback=audio` and shows the notice "Live picture unavailable. The call continues with the portrait." At hang-up
the look is retired, the forced animation cleared, the pose left, the copy deleted, and the camera switched off at
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

**Not solved: light.** The game's studio is a black box lit by its own lights; the mod's copy stands under the
real sky, so the picture has the city behind it and at night may be dark. Spawned lights are a further step
(a light component added at entity assembly, or a baked light sector in an archive).

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
holo spawn contact=<id> record=<record> floor=+<m>m yaw=<deg> lens=<m>m                (live picture only)
holo ready contact=<id> held=yes camera=on animated=true|false look=true|false drift=<m> (live picture only)
holo failed contact=<id> reason=<r> fallback=audio                                       (live picture only)
state=connected contact=<id> mode=audio|holo window=audiocall|holocall|pending
window=<w> contact=<id>                                       (a pending window appeared)
state=ended contact=<id> reason=<r> length=<n>s
refused contact=<id> reason=<r>
Holocall conversation: profile=<key> mode=<mode>              (init.lua, each talk turn)
```

The bridge turn-context diagnostic ends with `holocall=audio` or `holocall=holo`.

## Not verified yet

- The window in game: the ring, the portrait, the connect, and the end animation drawn by
  `ShowEndCallContact`. The redscript compiles in the isolated check (2026-10-14).
- That the Chat list's selected row shows the chat icon (R, envelope) and the call icon (a key box with V, a phone)
  with the separator, that the bottom bar reads Call (V), Chat (F), Close, and that V starts the call there while R
  and F open the chat; that the rebinding of the game's key hints leaves the Contacts and Messages tabs showing their
  own keys (F and R, Z) afterwards; that the Call hint under the message box in an open chat shows (the spawned
  `inputDisplayLabelFlex` item, or the plain "V  Call" text if the game's item could not be built), and that V and
  a click on it start the call (and that V typed into a message does not); that the vanilla Contacts Call (F) for
  Judy, Panam and others opens the game's own call again, untouched.
- That the live picture now finds a place: `holo spawn ... floor=...m` (negative when below V), then `holo ready`,
  and everything after it (the copy, the camera, the pose, the look), none of which has run in the game yet.
- That a tap of the phone button reaches the HUD controller as PRESSED then RELEASED on keyboard and
  pad, and does not also open the phone.
- The Holocall subtitle type showing a bottom line for the player as speaker.
- Everything about the live picture: whether the floor search finds a roof in typical places (V's apartment,
  a street, the Badlands), whether the window's holocall image shows the copy, how dark it is at night, the
  framing, whether her lips move with the mod voice and her eyes find the lens.
- What happens when a real quest call arrives during a mod call: the preempt path.

## Files

- `r6/scripts/CyberpunkConvai/Holocall.reds` (new)
- `PhoneChatTabs.reds` and `PhoneChat.reds` (the Chat tab's call entry points: the Call hint in a chat, the Call action on the list)
- `mod/holocall.lua` (new)
- `mod/init.lua`, `speech.lua`, `continuous-speech.lua`, `subtitles.lua`, `manager.lua`, `mcm.lua`,
  `notices.lua`
- `bridge/protocol.mjs`, `turn-context.mjs`, `mistral-prompt.mjs`
- Tests: `bridge/holocall.test.mjs` covers the protocol, the turn context, static checks on the reds,
  and the Lua state machine in fengari.
