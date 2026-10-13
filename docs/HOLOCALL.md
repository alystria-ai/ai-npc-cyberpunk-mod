# Holocalls

V can call a mod character from the phone. The game's call window opens at the top left with the
character's name and portrait. V talks by push-to-talk or typed text, and the character answers in the mod
voice with call-style subtitles. Hanging up ends the call. Built 2026-10-14 on branch `holocall`.
It has not yet been tested in game.

## Player flow

- **Phone > Chat list:** select a person and press the secondary action (hint **Holocall**, the
  key that used to open the chat a second way). The confirm action still opens the text chat.
- **Inside an AI chat:** the game's **Call** button starts a holocall with that person. It is dimmed
  when the game has turned calling off.
- The call starts once the phone has closed. The window rings for 1.5 to 5 s, then connects. A notice
  says "Holocall with {name}. Tap the phone button to hang up."
- Talk with the normal push-to-talk or typed-text keys. No one has to be nearby, because the call is the
  conversation partner.
- **Hang up:** tap the phone button (PhoneInteract pressed and released without a hold), or hold the
  reject button. Calling the same person again from the phone also hangs up. Calling someone else
  replaces the call.

Only mod characters in `characters/phone-contacts.json` with a conversation profile can take a
holocall. Johnny Silverhand never can; his ids are excluded in `mod/holocall.lua` (`NEVER`). Game
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
  from `base\cinematics\cameras\holocall_camera.ent`, a `RenderToTextureCamera` component that renders
  into `holocall_camera_render_texture.dtex`, which the call widget shows. The caller is a real actor
  posed in front of that camera somewhere in the world. The mod can copy this, but there is no
  script-only "show this NPC in the window" call. So the live picture is **experimental** and off by
  default.
- **Subtitles have a call type.** `scnDialogLineType.Holocall` (= 2). In the dump, `IsMainDialogLine`
  treats it as a main dialogue line whenever the speaker is set, with no distance check. A remote
  speaker therefore gets a normal bottom subtitle.

## Design

### Native (`r6/scripts/CyberpunkConvai/Holocall.reds`)

- The phone (Chat list or chat Call button) stores one request: a contact id checked with
  `ConvaiPhoneChatHasContact`. Lua takes it.
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

### Live picture (setting, off by default)

**Companion Manager > Settings > Development > Live holocall picture (experimental).** With it on,
dialing does the following:

1. Spawns a copy of the character, tagged `CyberpunkConvaiHolocall`, 40 m above V.
2. Holds the copy with the gesture device workspot, using the character's talk family from
   `gesture-catalog.lua`.
3. Spawns `holocall_camera.ent` 0.9 m in front of the copy at 1.62 m height, facing it, and turns on
   its `RenderToTextureCamera`.

If the copy or camera is not ready when the ring ends, or the copy drifts more than 1.5 m, the call
continues with the portrait. In that case the mod logs `holo failed ... fallback=audio` and shows the
notice "Live picture unavailable. The call continues with the portrait." Copies and cameras are
removed at hang-up. A sweep also clears tagged leftovers after a reload.

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
state=dialing contact=<id> profile=<key> mode=audio|holo hud=ok
holo spawn contact=<id> record=<record>                       (live picture only)
holo ready contact=<id> held=true|false camera=on drift=<m>   (live picture only)
holo failed contact=<id> reason=<r> fallback=audio            (live picture only)
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
- That a tap of the phone button reaches the HUD controller as PRESSED then RELEASED on keyboard and
  pad, and does not also open the phone.
- The Holocall subtitle type showing a bottom line for the player as speaker.
- Everything about the live picture: whether the render texture shows the copy, whether the workspot
  holds the copy in mid-air at 40 m, and whether its face animates at that distance.
- What happens when a real quest call arrives during a mod call: the preempt path.

## Files

- `r6/scripts/CyberpunkConvai/Holocall.reds` (new)
- `PhoneChatTabs.reds` and `PhoneChat.reds` (entry points and hints)
- `mod/holocall.lua` (new)
- `mod/init.lua`, `speech.lua`, `continuous-speech.lua`, `subtitles.lua`, `manager.lua`, `mcm.lua`,
  `notices.lua`
- `bridge/protocol.mjs`, `turn-context.mjs`, `mistral-prompt.mjs`
- Tests: `bridge/holocall.test.mjs` covers the protocol, the turn context, static checks on the reds,
  and the Lua state machine in fengari.
