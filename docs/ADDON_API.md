# Add-on API

Add-ons are separate CET mods that give Cyberpunk Convai new voices. The first two are Skippy, a talking smart pistol that
comments on fights (Oct 20), and the Delamain cab's voice (Oct 25). Each add-on has its own Nexus page and its own zip. An
add-on depends on the main mod, but the main mod never depends on an add-on.

API version: **1.0** (`mod/addons.lua` `M.API_VERSION`, `bridge/addons.mjs` `ADDON_API_VERSION`). An add-on asks for a
version, for example `requires = '1.0'`. A main mod with the same major version and an equal or higher minor version serves it.
Any other version gets one notice: "Skippy needs a newer Cyberpunk Convai (add-on API 1.2; this version has 1.0). Update
Cyberpunk Convai."

## Guarantees

- **With no add-on installed, nothing changes.** `convaiAddons.live` stays false and `init.lua` skips every add-on call.
  `AddonHost.active` stays false and the bridge adds no roster rows, blocks, files, watchers or timers. The tests prove this:
  `bridge/addons.test.mjs` ("inert") and `bridge/addons-lua.test.mjs` ("loading the module touches nothing").
- **No Convai, ever.** An add-on speaker's text comes only from **Mistral** or the **local AI**.
  - It never uses Convai: neither the free tier nor a player's own key.
  - It never counts toward the shared key's 100 conversations a day.
  - It never opens a Convai connection, memory or warm-up.
  - A `convai` field in a manifest is refused, and an add-on key in `characters.json` is removed at start.
- **No per-frame work.** Everything runs on the main mod's existing 0.1 s tick, only while an add-on is registered, and on events
  the main mod already has. Bridge hooks are synchronous and must take under 5 ms; a hook that fails three times is switched off.
- **Game characters stay untouched.** A speaker has no body: no face, gaze, gestures or gameplay actions. Game dialogue and scenes
  always win (see Remarks).

## How it fits together

```
add-on folder (its own CET mod)              main mod
  init.lua  ── GetMod('CyberpunkConvai').addons ──> mod/addons.lua (registration, remark scheduler, events, settings)
                                                        │ the same request / reply / lease files every automatic turn uses
  convai-addon.json  ── read at bridge start ──────> bridge/addons.mjs (AddonHost: persona rows, modes, blocks, journal)
  bridge.mjs (optional hooks) ─────────────────────> runAddonTurn in bridge/convai-bridge.mjs
                                                        └─ TextProviderHost on Mistral or the local AI → voice → subtitles
```

Each speaker becomes the profile `addon-<addon id>-<speaker id>`, for example `addon-skippy-gun`. The roster, the persona
book, the voices, the recent-lines journal and the game all use that key.

## The add-on folder

```
addons/skippy/                       (in this repository; the zip puts it in the CET mods folder)
  init.lua                           CET entry point: registers, makes remarks, settings, events
  convai-addon.json                  the manifest the bridge reads: persona, modes, providers, voice
  bridge.mjs                         optional: prompt hooks that run in the bridge
  voice/skippy.wav                   optional: the voice reference (with its transcript in the manifest)
  eval/*.json                        evaluation scripts (never shipped)
  *.test.mjs                         tests (run by scripts/run-tests.mjs; never shipped)
```

Installed path: `bin/x64/plugins/cyber_engine_tweaks/mods/CyberpunkConvai<Name>/`, for example `CyberpunkConvaiSkippy` or
`CyberpunkConvaiDelamainCab`. The bridge finds add-ons the way CET does: in each folder of the CET mods folder that has a
`convai-addon.json`. For development, set `CYBERPUNK_CONVAI_ADDONS` to a `;`-separated list of add-on folders.
`addons/example/` is a complete, tested add-on to copy.

## Manifest: `convai-addon.json`

```json
{
  "schema": 1,
  "id": "skippy",
  "name": "Skippy",
  "version": "1.0.0",
  "requires": {"api": "1.0"},
  "bridge": "bridge.mjs",
  "providers": ["mistral", "local"],
  "speakers": [
    {
      "id": "gun",
      "name": "Skippy",
      "persona": {
        "intro": "You are Skippy, a talking smart pistol in V's hand.",
        "identityRule": "You are a gun with a personality chip, not a person. Never claim to walk, look around or touch anything; you only hear, aim and talk.",
        "backstory": "Skippy is an experimental Arasaka smart pistol with a personality matrix. It belonged to a soldier who did not make it, and now it belongs to V. It is fiercely loyal and talks constantly.",
        "style": "Short spoken lines. Never more than one or two sentences.",
        "samples": ["V: Hey, Skippy.\nSkippy: Hey, boss! Ready when you are."],
        "rules": ["Never ask V a question in the middle of a fight."]
      },
      "defaultMode": "puppy",
      "modes": {
        "killer": {
          "name": "Stone Cold Killer",
          "style": "Cold, clipped, delighted by headshots. Talks about targets, never people.",
          "samples": [
            "Game event: V killed the first enemy of the fight.\nSkippy: One down. Plenty more where that came from.",
            "Game event: V landed three headshots in a row.\nSkippy: Three for three. I could cry.",
            "Game event: the fight is over.\nSkippy: Area clear. Shame, I was just warming up."
          ],
          "rules": ["Celebrate clean kills in a few words; never lecture."]
        },
        "puppy": {
          "name": "Puppy-Loving Pacifist",
          "style": "Anxious, sweet, begs V to aim for the legs. Loves puppies, hates violence, still does its job.",
          "identityRule": "You are a gun that hates hurting anyone. You still fire when V pulls the trigger, and you feel awful about it.",
          "samples": [
            "Game event: V killed the first enemy of the fight.\nSkippy: Oh no. Oh no no no. Was that necessary?",
            "Game event: a bystander was hit.\nSkippy: V! That one was a civilian! I'm going to be sick.",
            "Game event: the fight is over.\nSkippy: Is it over? Please tell me it's over."
          ],
          "rules": ["Never cheer a death.", "Mention puppies at most once a fight."]
        }
      },
      "voice": {"reference": "voice/skippy.wav", "transcript": "Exact words spoken in the reference recording."}
    }
  ]
}
```

| Field | Rules |
|---|---|
| `schema` | `1` |
| `id` | 2–24 characters: lowercase letters, digits and `-`, starting with a letter. Must match `api.register({id})` in `init.lua`. |
| `name` | Shown in notices. At most 60 characters. |
| `version` | `1.0` or `1.0.0` (an optional `-beta.1` suffix is allowed). |
| `requires.api` | The add-on API version the add-on was written for, `"1.0"`. |
| `bridge` | Optional `.mjs` inside the folder (see Bridge module). |
| `providers` | Optional. `["mistral", "local"]` (the default), `["mistral"]` or `["local"]`. Anything else is refused. A speaker may set its own `providers`. |
| `speakers[]` | At most 4. `id` uses the same characters as the add-on id (1–24); `name` at most 60 characters. |
| `persona.backstory` | Required. At most 12,000 characters. Who the speaker is. |
| `persona.intro` / `identityRule` | Optional. Replace the opening line ("You are X, a real person…") and the "you are a real person" rule. A voice that is not a person should set both. |
| `persona.style` / `samples` / `rules` | Speaking style; at most 12 example exchanges (each at most 600 characters); at most 12 rules. |
| `persona.talkWords` | Optional whole number, 8–60. The longest answer, in words, the speaker gives V when V talks to it. It replaces the main mod's own length rule ("one to three short sentences, about 15 to 40 words, longer when asked") in the output rules and in the reminder after V's words with "one or two short sentences and at most N words", even when V asks for a long answer. Without it the main mod's rule applies, as for every character. A mode may set its own `talkWords`. Remarks are not affected: they follow their own `maxWords`. |
| `modes` / `defaultMode` | Optional personalities, at most 4 (see Personas and modes). `defaultMode` defaults to the first mode. |
| `voice` | Optional. `reference`: a PCM `.wav` inside the folder, at most 8 MB and 0.1–20 s long. `transcript`: the exact words in it. `sha256`: optional checksum. Without a voice the speaker is shown as subtitles only. |

## CET side: `init.lua`

The add-on runs as its own CET mod. It reaches the main mod in `onInit`.

```lua
local Skippy = {}

registerForEvent('onInit', function()
    local main = GetMod('CyberpunkConvai')
    local api = type(main) == 'table' and main.addons or nil
    if not api then print('[Skippy] Cyberpunk Convai is not installed; Skippy stays off.') return end
    local handle, reason = api.register({id = 'skippy', name = 'Skippy', version = '1.0.0', requires = '1.0'})
    if not handle then print('[Skippy] ' .. tostring(reason)) return end
    Skippy.handle = handle

    handle:speaker({id = 'gun', name = 'Skippy', anchor = 'player',
        available = function(player) return Skippy.holdingSkippy == true end})

    handle:settings({title = 'Skippy', items = {
        {id = 'personality', label = 'Personality', kind = 'select', default = 2,
            elements = {'Stone Cold Killer', 'Puppy-Loving Pacifist'}},
    }})
    local modes = {'killer', 'puppy'}
    handle:setMode('gun', modes[handle:setting('personality')])
    handle:on('settingChanged', function(change)
        if change.id == 'personality' then handle:setMode('gun', modes[change.value]) end
    end)

    handle:on('combatStarted', function() Skippy.fight = {kills = 0, headshots = 0}; handle:prepare('gun') end)
    handle:on('combatEnded', function()
        handle:remark('gun', {event = 'fight-end', text = 'The fight is over.', facts = Skippy.fight, priority = 5, ttl = 6})
    end)
end)

return Skippy
```

`GetMod('CyberpunkConvai')` is `init.lua`'s return value, `{addons = <api>}`. CET runs `onInit` for every mod before gameplay
starts, so this lookup works from the add-on's `onInit`. A main mod older than the API returns no `addons` field, and the add-on
prints one line and stays off.

### `api`

| Call | Result |
|---|---|
| `api.version`, `api.major`, `api.minor` | `'1.0'`, `1`, `0` |
| `api.compatible('1.0')` | `true` when this main mod serves that API version |
| `api.register({id, name, version, requires})` | A handle, or `nil, reason`. Registering the same id again (a CET reload) replaces the earlier registration. An incompatible `requires` shows one notice. |

### Handle methods

Every method checks its arguments and returns `true` (or a value), or `false, reason`. None throws.

| Method | What it does |
|---|---|
| `handle:speaker{id, name, anchor, available, talk, group, minGap, talkPriority, sceneTiers, playThrough, voiceFrom}` | Adds a voice and returns its profile key. `id` and `name` must match the manifest. The options are described below this table. |
| `handle:remark(speakerId, {event, text, facts, priority, ttl, maxWords, interrupt, cooldown, patience, relevant})` | Asks for one automatic line. See Remarks. Returns `true` when the remark is queued, or `false, reason` with one of `speaker-cooldown`, `addon-gap`, `episode-budget`, `no-provider`, `event-cooldown`, `busy`, `queue-full` or `add-on disabled`. |
| `handle:setMode(speakerId, modeId)` | Switches the speaker's personality (a mode in the manifest). It is sent with every turn and in `runtime/addon-state.json`. |
| `handle:remember(speakerId, text)` | Keeps a memory the speaker can call back to later, for example "V spared the Tyger Claw who begged." At most 300 characters; a repeat is ignored. The bridge keeps the last 12 per speaker across game sessions. |
| `handle:setContext(speakerId, key, text, tier)` | Adds a prompt block to every turn of this speaker until it is cleared with `text = nil`. At most 8 blocks of 1,500 characters. `tier` is `'world'` (default; changes rarely), `'volatile'` (changes every turn) or `'notes'`. |
| `handle:setCompanionContext(key, text)` | Adds a block to every **companion's** prompt (for example "You are riding in a Delamain cab with V."). At most 4 blocks of 600 characters. Clear it with `nil`. |
| `handle:setState(table)` | Plain data the add-on's bridge module receives as `state` (at most 4,000 bytes as JSON). |
| `handle:on(event, fn)` / events | See Events. |
| `handle:settings{title, description, items}` / `handle:setting(id)` | A section on the main settings page. See Settings. |
| `handle:setEnabled(bool)` | A disabled add-on is never offered for talk and makes no remarks. Its waiting remarks are dropped. |
| `handle:prepare(speakerId)` | Warms the speaker's text route (opens the Mistral connection, or loads its prompt into the local AI). Call it when the speaker becomes available, for example when a fight starts or V gets into the cab. At most once every 20 s. |
| `handle:cancel(speakerId)` | Drops the speaker's waiting remarks and stops its remark that is playing. |
| `handle:notify(text)` | One on-screen notice (at most 200 characters; a repeat within 10 s is dropped). |
| `handle:state()` | `{worldReady, combat, vehicle, scene, speaking, conversation, remark}`, read from the last tick. It costs nothing. |
| `handle:live()` | True from the first tick of a session until the main mod releases its game references (a save load, the player detaching, death, fast travel, shutdown). Start every game hook (`Observe*` callback) with `if not handle:live() then return end`: while it is false the engine is destroying or building the world, and a native call from a callback on a half-built or half-destroyed object can crash the game. A session start is delivered by `sessionStarted`, so read the state there, not in a hook that fired earlier. Costs nothing. |
| `handle:party()` | The profile keys of the companions following V now (at most 16), read on demand when the add-on calls it (a ride starts, a fight starts). An empty list when the party cannot be read. `companionJoined` / `companionLeft` only report changes, so use this for the party that was already there. |
| `handle:native()` | A read-only view of the main mod's optional native plugin: `present()`, `use(system)`, `revision(name)`, `status()`. Every call is guarded and returns `false`/`nil` without the plugin, so the add-on never needs the DLL. |
| `handle:log(text)` | One line in the main mod's log. |

`handle:speaker` options:

- `anchor`: where the voice is heard. `'player'` (V's own audio: Skippy), `'vehicle'` (the car V is in: Delamain), or a function
  `(player) -> entity`.
- `available(player)`: runs on the tick and at the talk key. It must be cheap: cache what it needs from events.
- `talk`: answers the talk key (default `true`).
- `group`: joins group conversations (default `false`).
- `minGap`: the speaker's own gap after it speaks (default 8 s).
- `talkPriority`: the order among voices.
- `sceneTiers`: the game scene tiers in which it may make a remark (default `{1}`, free gameplay).
- `playThrough`: a line of this speaker that has started is not cut when an ordinary game scene begins (dialogue, a choice menu, a
  scene tier below 4); a phone call, a replacer (Johnny), a cinematic tier (4 and 5), a conversation the player starts,
  `handle:cancel` or the add-on being switched off still stop it. Default `false`: any scene stops the line. The Delamain cab uses
  it, because the game's own cab dialogue is a quest scene that opens and closes around its lines. A log line,
  `Remark plays through a game scene: ... signals=dialogue+tier=2`, names the flags that were up.
- `voiceFrom(player) -> GameObject` (optional): where the voice is heard from when that is not the anchor. Skippy's anchor stays V
  (subtitles, availability, the talk key), but his voice comes from the gun in V's hand. It is asked once when a reply starts and
  only changes the pan and distance of the browser voice (continuous Pocket playback). An object that is detached, unreadable or more
  than 3 m from the camera is dropped for the rest of that reply and the anchor is used. The native Omni phrases still play on the anchor.

### Replacing the game's own lines

An add-on whose character also speaks in the game (Skippy's "new message detected", the Delamain cab's greeting and farewell) can
have the game's own voice and subtitle for those lines silenced, so that only its AI lines are heard:

```lua
handle:replaceGameLines({name = 'Skippy',
    match = function(line, context) return isSkippy(line) end,   -- cheap: a few string reads; context.typeName() resolves the line type
    active = function() return S.holding end,                     -- optional: only while this is true (V holds the gun, V sits in the cab)
    audio = {'vo_3d_important'},                                  -- optional: Wwise events stopped on the line's speaker (at most 4)
    audioVerified = false})                                       -- true once it is heard in the game that the voice really stops
```

- **Per add-on option, on by default:** the add-on's settings section gets **Replace the game's own lines** (only when a rule is
  declared) and **Mark our lines in the subtitles**. At most 4 rules per add-on; `replaceGameLines` and `markLines` are reserved ids.
- **What is silenced is only the voice and the subtitle of the lines `match` claims, only while `active()` holds and the add-on is
  enabled.** The scene, the quest, the map, the payment and every other character's line run as always (a line is never skipped
  or blocked). The main mod never decides who the character is: the add-on's own `match` does, and a line of the mod's own replies is
  never hidden.
- **Subtitle:** the first rule installs one `Override` of `SubtitlesGameController.ShouldDisplayLine` (the game asks it once per
  line, never per frame); a claimed line answers "do not display". If the override cannot be installed, the line is hidden right after
  it was handed to the HUD (`UIGameData.HideDialogLine`), and the log says so. Without a rule nothing is hooked and a game line
  costs one boolean read.
- **Voice:** `AudioSystem.Stop(event, speakerEntity)` for each event in `audio`, once per line, from the subtitle hook that already
  runs. The scene system plays most dialogue without a named event, so a stop is a try: the log line says whether a stop was sent,
  and `audioVerified` tells the scheduler whether to believe it. While it is `false` a patient remark waits for the whole line
  (the voice may still play); when `true` it waits only ~0.6 s. A rule with no `audio` mutes the subtitle only.
- **The scene behind a muted line** keeps running without a voice: for the length of that line its `dialogue` flag and (non-cinematic)
  tier do not close the scene gate for this add-on. Choices, a call, a replacer and the cinematic tiers still do.
- **Marker:** with **Mark our lines in the subtitles** on (default), the add-on speaker's own subtitle carries ` (AI)` after its name
  (`Skippy (AI)`), so it can be told from the game's own lines. V's live words never carry it.
- Log (probe.log): `[Addons] muted game line: <speaker> <6 digit id> (subtitle=filtered|hidden-after audio=stop-sent(...)|no-event-known|... <s>s)`
  for each muted line; `Game dialogue: subtitle filter installed` or `NOT installed (<why>)` once.

### Events

| Event | Payload |
|---|---|
| `sessionStarted` / `sessionEnded` | `{}` / `{reason}` (a save load, death or shutdown) |
| `combatStarted` / `combatEnded` | `{}` |
| `vehicleEntered` / `vehicleExited` | `{vehicle, vehicleId}` / `{}` |
| `sceneStarted` / `sceneEnded` | `{}`: dialogue, choices, a call or a scene tier above 1 |
| `companionJoined` / `companionLeft` | `{profileKey}` |
| `turnStarted` / `turnEnded` | `{requestId, profileKey, reaction, addon}` for any conversation turn |
| `speechStarted` / `speechEnded` | `{requestId, name}` / `{requestId}` |
| `remarkStarted` | `{speaker, event}`: the remark is heard (or its caption is shown) |
| `remarkFinished` | `{speaker, event, reason, spoken, requeued}` (`requeued` is true when a remark with `patience` was taken back at a scene and waits to be written again). A remark that is playing finishes even when its speaker stops being `available` (V steps out of the cab while it ends); only a scene, a conversation V starts, `handle:cancel` or the add-on being switched off cut it. One still waiting to be heard is given up after 2.5 s without its speaker. `reason` is one of `finished`, `not-delivered`, `stale`, `manual-priority`, `scene`, `scene-tier`, `game-line`, `speaker-unavailable`, `interrupted`, `cancelled`, `add-on-disabled` or `anchor-changed` |
| `remarkDropped` | `{speaker, event, reason}`: the remark was never sent. `reason` is one of `replaced`, `expired`, `irrelevant`, `scene`, `game-line`, `speaker-unavailable`, `speaker-cooldown`, `addon-gap`, `episode-budget` or `request-write-failed` |
| `settingChanged` | `{id, value}`, sent on the tick after Apply (never inside the menu) |

A handler that throws three times is removed. The main mod has no kill, headshot or damage events. An add-on that needs them
hooks the game itself in its own `init.lua` with `Observe`/`ObserveAfter` on the game function, keeps each handler to a few
table writes, and never polls in `onUpdate` (see Skippy below).

## Remarks: as often as the player likes, never piled up

How often an add-on speaks is the player's choice. Every add-on with a speaker gets two built-in settings:

| Setting | Choices | Default |
|---|---|---|
| **Time between remarks** | 4, 6, 8, 10, 15, 20, 30 or 60 s, counted from the end of the last remark | **10 s** (about 20 s on the local AI, see below) |
| **Most remarks per fight** | 5, 10, 20, 30, 50 or No limit; outside combat, per rolling five minutes | **30** |

At the defaults a busy fight gets a line every 10 to 15 seconds, so remark on every moment worth a line and let the priorities
pick. The rules:

- An **episode** is one fight, from `combatStarted` until the next fight starts. Outside combat it is a rolling five minutes.
- The **last remark of the cap is kept for priority 4 or 5**, so the end of a long fight still gets its line.
- A **priority 5** remark needs only half the gap, so a near-death line right after a first-kill line still gets through.
- A remark that was never heard (the player started talking, a scene began, the reply came too late, or the bridge dropped it as
  a repeat) does not count toward the cap or start the gap.
- **One remark at a time.** No new remark starts while one is being written or spoken. While one is in flight, at most one waits
  behind it: the strongest (a tie goes to the newer moment). A weaker one is refused with `busy`; an equal or stronger one replaces
  the waiting one.
- **A late remark is dropped.** If the reply arrives more than `ttl` seconds (3 s by default) after the moment, it is dropped
  (`remarkFinished` with `stale`) instead of playing late. A waiting remark that cannot start within `ttl` expires.
- **On the local AI** the bridge keeps the default gap at about 20 seconds between remark starts
  (`LOCAL_REMARK_GAP_S`; the reply is `errorCode: 'addon-pace'` with `gap` (the spacing) and `retryAfter`, and the game waits that
  long, and from then on waits the whole gap before it asks again instead of asking and being refused). Each remark is a
  GPU burst of about half a second beside the game, and its frame-time cost is not measured yet, so the default keeps it rare. A
  gap the player picks is used as it is. **Priority 5 is never refused by the pace**, and a remark that never reached the player
  (withdrawn by the game, cancelled while being written, dropped as a repeat) is given back to it, so a moment is not lost for a
  remark nobody heard (live 2026-10-14: every Skippy remark was refused within a second of the one before).
- `handle:remark` refuses at once (`addon-gap`, `episode-budget`, `busy`) when a remark could not be made, so the add-on does no work
  for it.

### Patience: waiting for the game's own voice instead of losing the moment

By default a remark that meets a game scene is dropped (`remarkDropped` with `scene`), which suits a fight remark: its moment is over.
Moments that matter and will still be true a few seconds later (V sits in the Delamain cab, the cab arrives) should wait:

```lua
handle:remark('delamain', {event = 'arrival', priority = 5, ttl = 12,
    patience = 25,                                   -- seconds the remark may wait for the game's voice (0 to 60; 0 = drop, the default)
    relevant = function() return stillInTheCab() end}) -- optional, cheap: is the moment still true when its turn comes?
```

- While a game scene (dialogue, choices, a call, a scene tier above the speaker's `sceneTiers`) or a **game dialogue line** (the
  subtitle hooks of `mod/game-dialogue.lua`, with the line's own duration when the game gives one, else an estimate from its words,
  at most 15 s) is on, the remark is **kept**, and its `ttl` does not run down. Nothing is polled for it: it is looked at on the
  add-on tick that already runs while any remark waits.
- When the scene and the line are over, it waits **1.2 s more** (the game's last word, a pause, the next line) and then goes with a
  fresh `ttl`. A scene or line that begins again in that gap restarts it. With no scene and no line playing there is **no wait at all**.
- A remark already **in flight** (being written, not yet heard) that meets a scene is taken back (the request is withdrawn, so it cannot
  talk over the game) and goes through the same wait, then is written again with the facts it was given. At most twice per remark;
  `remarkFinished` carries `requeued = true` for those. A remark that has begun to play is never taken back (see `playThrough`).
- A request that nobody has answered `ttl` + 2 s after its moment (a cold model, a busy bridge) is withdrawn for every remark, so it
  cannot hold up the later ones (`remarkFinished` with `stale`); a remark with patience is asked for again once with a fresh clock,
  within its patience.
- `relevant()` is asked every tick while the remark waits and before it is sent. A remark that stays irrelevant for 2.5 s is dropped
  (`remarkDropped` with `irrelevant`); a flicker of a moment is forgiven. One that waited past `patience` is dropped with `expired`.
- A remark without `patience` is unchanged: the scene gate drops it, and a game dialogue line does not hold it back.
- Log lines (all in `probe.log`): `[Addons] Remark held: <speaker> event=<e> reason=scene|scene-tier|game-line signals=dialogue+tier=2 patience=25s`,
  `[Addons] Remark released: ... reason=scene signals=... (taken back; it is asked for again)`,
  `[Addons] Remark: <speaker> event=<e> priority=<p> waited=3.4s`, `[Addons] Remark dropped: ... reason=expired|irrelevant|...` and
  `[Addons] Game line: Regular for about 3.2 s (its own duration|estimated); patient remarks wait for it`. The `signals` name which
  flags of the observer were up, so a live ride shows which of them the game's own cab dialogue raises.

Choose priorities like this:

| Priority | Use for | Skippy | Delamain |
|---|---|---|---|
| 5 | the moment of the fight or ride | near death; fight end | arrival; V nearly dies in the cab |
| 4 | a highlight | first kill; headshot streak (3+); a civilian hit in Pacifist mode | V boards; a crash; a police chase starts |
| 3 | notable | a weapon mode change; a long reload under fire | a landmark passed |
| 1–2 | filler; heard only when nothing better is waiting | an ordinary kill | small talk |

The other remark fields:

| Field | Default | Meaning |
|---|---|---|
| `event` | required | A name for the moment, such as `first-kill`. One waiting remark is kept per speaker and event; newer facts replace older ones. |
| `text` | `[<add-on>] <event>` | What happened, in one plain sentence. It becomes the start of the trigger. |
| `facts` | none | Plain data, at most 4,000 bytes as JSON (`{streak = 3, weapon = 'Skippy'}`). The speaker may use only these facts. |
| `ttl` | 3 s (1–30) | A remark that cannot start, or whose reply does not arrive, within this time of its moment is dropped, never played late. Give a slow moment, such as a fight end, a longer one. |
| `maxWords` | 14 (3–60) | The trigger asks for one line of at most this many words. Use 6–12 for barks. It is also enforced: the reply is asked for few tokens, stops streaming at the limit plus 3 words, and a longer line is cut at its last sentence end (or clause) within the limit plus 3 words. |
| `interrupt` | false | Stops a remark of a *lower* priority that is playing. |
| `cooldown` | 0 | Seconds before the same event may be remarked again. |

**Arbitration.** A remark never overlaps other speech or game dialogue. It waits while any of these is going on:

- a player turn, the microphone, a group round, phone chat or another automatic turn;
- a pending request, voice playing, or a caption on screen;
- the 2 s after any speech;
- dialogue, choices, a call, or a scene tier the speaker does not allow (a remark with `patience` also waits for a game dialogue
  line; either way it waits instead of being lost, see Patience).

It also waits while subtitles and voice are both off. The scheduler then sends the highest priority first, through the request
file every automatic turn uses, with a lease the bridge checks. If the player starts talking, or a scene starts, the remark stops
at once.

## Stock: lines written ahead of the moment

A fresh remark costs a model call and then the voice (about 1.6 to 2.5 s). To land within about a second, an add-on can ask the
bridge to **write lines ahead of time** with the model, from the facts of the current fight, and use one the moment the event
happens. Every line is still written by the model; nothing is a fixed list. This is an addition to API 1.0 (the version number is
unchanged; an add-on that never calls it is not affected).

```lua
handle:stock('gun', 'first-kill', {
    text = 'V is about to kill another enemy',
    facts = {enemies = 4},
    maxWords = 8, want = 2, ttl = 90,
    slots = {'fight.kills'},        -- the line may say "{fight.kills} down"
})
handle:remark('gun', {event = 'first-kill', text = 'V killed an enemy.', facts = {fight = {kills = 3}}, priority = 4, stock = true})
handle:stock('gun', 'first-kill', nil)   -- clears it
```

`handle:stock(speakerId, key, spec | nil)` returns `true`, or `false, reason`, and never throws. `key` is an event name (letters,
digits, `_ . : -`, at most 48). `spec`:

| Field | Default | Meaning |
|---|---|---|
| `text` | required | What the line is for, at most 600 characters. It becomes the start of the trigger, like a remark's `text`. |
| `facts` | none | Plain data, at most 4,000 bytes as JSON, like a remark's. The line may use only these facts. |
| `maxWords` | 10 (3-60) | The line's length. |
| `want` | 2 (1-4) | Unused lines the bridge keeps ready for this key. |
| `ttl` | 90 (10-300) | Seconds a prepared line stays usable. |
| `slots` | none | Up to 8 names (`A-Za-z0-9_.`) the line may contain in curly braces, like `{fight.kills}`. |

- At most 12 keys per speaker. Calling `stock` again with an equal spec changes nothing. A different `text`, `facts`, `maxWords`,
  `want`, `ttl` or `slots` is a new **revision**, and the bridge throws away every line it wrote for the old one. Keep `facts`
  steady for a fight and put numbers that change in slots.
- The bridge writes lines one at a time, only while the player is not talking and no turn is running, at most 20 a minute, with a
  pause of 1.2 s between lines and 20 s after a failure. It writes them only on Mistral (never on the local AI, so a fight does not
  pay for them on the GPU). A line that is empty, uses a slot that is not in `slots`, or nearly repeats one of the speaker's last 8
  lines or any other prepared line is thrown away. Lines are written for the speaker's current personality mode; a mode change
  discards them.
- `handle:remark(..., {stock = true})` asks for a prepared line. The bridge takes the oldest usable one for the remark's `event`,
  fills each `{slot}` from the remark's `facts` by path (`fight.kills` reads `facts.fight.kills`; numbers and strings only), and
  speaks it with no model call. The usual repeat check and the voice still run, and the spoken line joins the speaker's recent lines.
- **Fallback to a fresh line.** With nothing ready (stale, another mode, a slot the facts cannot fill, the local AI, nothing written
  yet) the remark is written fresh exactly as without `stock`, so `stock = true` never makes a remark fail.
- The state file carries `stock = [{speaker, key, text, facts, maxWords, want, ttl, slots, rev, blocks}]` per add-on, where `blocks`
  is a copy of the speaker's context blocks (at most 4, 3,000 characters) so the lines are written in its voice. A save load, death
  or shutdown clears the stock: ask again from `combatStarted`.

## Text providers: Mistral or the local AI only

The bridge chooses the route for each add-on turn (`AddonHost.routeFor`), from what the speaker allows:

1. The player's own conversation provider, when it is Mistral or the local AI and is working.
2. Otherwise **Mistral**, when the player has saved a Mistral key that was not refused.
3. Otherwise the **local AI**, when the Local AI pack is installed and has not failed.
4. Otherwise nothing.

When nothing can answer, the reply carries `errorCode: 'addon-provider'`. The game then shows one notice: "Skippy needs a free
Mistral key or the Local AI pack. Set it up under Conversation provider in Cyberpunk Convai's settings." The add-on's remarks
pause for two minutes. For remarks the notice is shown once per session; a message V typed always gets it.

**The default and the budget.**
- The default route is Mistral for a Convai player who has saved a key. That player keeps Convai for companions, and Skippy and
  Delamain use their Mistral key.
- Each remark is one request of a few hundred new tokens. The persona and the mode are a stable prefix that Mistral caches.
- An add-on's request budget is its two settings. Because the gap counts from the end of the last remark, even the shortest gap
  (4 s) means about one request every 6 to 8 seconds, and never two remarks at once.
- Mistral requests are paced by the same scheduler as the companions' requests on that key (about one a second on the free plan),
  so a remark and a companion reply share that second and nothing is refused for rate.
- On the local AI a remark uses the GPU only while it is written. If the pack is installed but not running, the first remark starts
  it, so call `handle:prepare` when a fight or ride begins.
- An add-on turn never touches Convai and never counts toward the shared key's 100 conversations a day.

## Personas and modes: quality is the product

The bridge builds the speaker's system prompt from its persona row (`bridge/mistral-prompt.mjs` `systemHead`). Within a mode the
text is the same on every turn: it is the **stable prefix** that Mistral's prompt cache and the local AI's prompt cache keep warm.
A mode switch starts a new prefix. A mode combines with the base persona like this:

| Base field | With a mode |
|---|---|
| `backstory` | base backstory, then the mode's `backstory` (if any) |
| `style` | the mode's `style`, or the base style |
| `samples` | the mode's `samples`, or the base samples |
| `rules` | base rules, then the mode's rules |
| `intro`, `identityRule` | the mode's, or the base ones |
| `talkWords` | the mode's, or the base one |

**Few-shot samples are the strongest lever.** A small model copies their length, rhythm and attitude.
- Write 3–6 samples per mode, each as one exchange: `"V: <words>\nSkippy: <line>"` for talk, and
  `"Game event: <what happened>\nSkippy: <line>"` for remarks.
- Cover the moments you will remark on: first kill, streak, near death, fight end.
- Make every sample short and in voice. The speaker is told never to repeat a sample word for word, so samples teach the voice
  without becoming stock lines.

**Anti-repetition.** The bridge keeps each speaker's last 12 spoken lines (`runtime/addon-journal.json`, across game sessions):
- The last 6 go into every prompt as "Your most recent lines (never repeat one, its joke or its wording; find a new angle)".
- A remark that nearly repeats one of the last 8 is **written once more** before anything is dropped: the second try gets a block
  that names the repeated line and the line it resembled ("Do not reuse any phrasing from these"). Only if that is a repeat too is
  the remark **dropped before it is spoken** (`errorCode: 'addon-duplicate'`, silent), and the next event gets a fresh chance.
- **The second try respects the staleness rule.** It starts only if the time the first try took, times 1.25, plus 250 ms, still ends
  before the remark's `ttl` runs out (`reaction.expiresAt`); otherwise the remark is dropped at once. A line from stock that
  repeats counts the first try as 900 ms. At most two model requests per remark; nothing is generated when the first line is fresh.
- "Nearly repeats" (`isNearDuplicate`) means the same words, a word overlap of 0.6 or more, or the same run of four words that holds
  at least two words that are not common. Function words, number words and units (`the`, `shall`, `hundred`, `metres`, `eddies`,
  `V`, ...) are common, so "I shall continue to" and "three hundred and fifty eddies" are not a repeat, while "do try not to sign
  anything" is. Curly apostrophes and quotation marks are read as straight ones (`you’re` is one word).
- A remark is also checked against the speaker's example lines (the active mode's and the persona's; only the spoken part), which count as already used, by the same check and with the same second try.
- A reply to something V typed is never checked, dropped or written again.

**Memories for callbacks.** `handle:remember(speakerId, text)`, or the bridge module's `remember` hook, adds a memory. The last 6
go into the speaker's prompt as "Earlier moments you shared with V", to call back to now and then. Keep each memory one concrete
sentence: who, where, what V did.

**The trigger.** A remark's user message is:
- `text`;
- then "This event was not spoken by V. React as Skippy with one short spoken line of at most N words. Use only these facts;
  do not invent numbers, names, injuries, kills or outcomes. Do not ask a question. Return only the spoken line…";
- then the facts, in a block of their own.

A bridge module can replace the trigger.

**Context.** A speaker's prompt has:
- the main mod's "right now" blocks (time, place, company);
- a note that it is a voice with no body;
- its `setContext` blocks and the facts (or its module's `speakerBlocks`);
- its memories and its recent lines.

Companions get each add-on's `setCompanionContext` blocks and the module's `companionBlocks`.

## Bridge module (optional)

`bridge.mjs` runs inside the bridge. Every export is optional, synchronous, quick (under 5 ms) and free of side effects. A hook
that throws, returns a promise or fails three times is switched off, and the add-on keeps working without it.

```js
export const apiVersion = '1.0';

let log = () => {};
/**
 * Once at bridge start. api = {version, addon: {id, name, version, speakers}, log, settings(), state(), character(keyOrName)} (frozen).
 * character("Panam Palmer") -> {key, name, gender: 'female' | 'male' | null}, or null for someone the main mod does not know (call
 * it from a hook, not from activate: the roster is attached after the modules load). Use it to give a companion's pronoun.
 */
export function activate(api) { log = api.log; }

/** Extra blocks for the speaker's own turns: [{key, text, tier}]. event/facts are null for a conversation turn. */
export function speakerBlocks({speaker, event, text, facts, mode, reaction, group, state, settings}) {
  if (event === 'headshot-streak') return [{key: 'streak', tier: 'volatile', text: `V has landed ${facts.streak} headshots in a row.`}];
  return [];
}

/** Replace the trigger of a remark (return a string), or return nothing for the default. */
export function trigger({speaker, event, text, facts, maxWords, mode, settings}) {}

/** Blocks for every companion's turns (profileKey is the companion). */
export function companionBlocks({profileKey, group, state, settings}) { return []; }

/**
 * A line the speaker just said: return a memory string to keep, or nothing. `heard` is the text the line answered (the event's
 * sentence, or what V or the previous speaker said; at most 240 characters), `group` is true in a group round. A module may keep
 * its own short, in-memory log of the current ride or fight from these calls (nothing else here may have side effects).
 */
export function remember({speaker, event, facts, mode, line, heard, group, reaction, settings}) {
  return event === 'fight-end' && facts?.kills >= 5 ? `A ${facts.kills}-kill fight; Skippy said: "${line}"` : null;
}

/** The add-on's settings changed (the values from runtime/addon-settings.json). */
export function onSettings(values) {}
```

## Talk and group conversation

- **Talk key (typed, F6).** An available speaker answers the talk key when no character with a profile is under the crosshair. A
  character V aims at wins. One exception for a speaker with `anchor = 'vehicle'` while V sits in that vehicle (a cab's AI):
  only a character in the car with V, or one of V's companions, takes the key from it; a pedestrian drifting through the
  windscreen's aiming cone does not (the cab's interior, the windscreen or nothing under the crosshair all mean the speaker).
  The choice is made on the key press only, from the speakers' `available` and anchor; nothing runs per frame, and the main mod
  names no add-on. Replies use the same route, persona, voice and subtitles as remarks, and stream their first sentence to the voice.
- **Voice key (F7, F10).** The voice keys work with add-on speakers on the same target rules as the typed keys (a character under the
  crosshair first; a vehicle-anchored voice outranks characters outside V's car; chosen on the key press only). Convai recognises
  speech inside its own session, which an add-on speaker never opens, so V's recording is recognised on this computer by the
  recogniser the Mistral route already uses (`bridge/local-stt.mjs`, `bridge/local-stt-capture.mjs`, the Moonshine model in the
  hidden voice browser; `docs/LOCAL_STT.md`). It is the same whichever conversation provider the player chose, Convai included,
  because it does not need the provider. The words then go to the add-on turn route (`runAddonTurn`: Mistral or the local AI,
  never Convai), and the reply is voiced and captioned as any add-on reply. No Convai connection, memory or warm-up is opened.
  The microphone lease, cancel and finish handling accept a profile key that is not in the character roster, and the live words
  appear while V speaks. The recording's context blocks are added at the start and again at the finish (`microphone.decorate`).
  Without the recogniser installed on this computer (the status `stt` flag the bridge publishes), F7 with only an add-on voice
  in reach still shows: "{name} answers typed messages only for now. Use {key}.", and in a group the voice rounds leave the add-on
  voices out. In a group voice round (F10) an add-on voice joins the companions: if it leads the round its own recording is
  recognised as above; if a companion leads, the companion's recording keeps its Convai or Mistral route and the add-on voice
  answers the recognised words as a later speaker, like a typed round. A companion's Convai audience and memory are unchanged by an
  add-on voice being present.
- **Group conversation** (`group = true`). The speaker joins the nearby companions in a group round and hears their lines, and they
  hear its lines. An add-on voice is never part of a companion's routing audience, so a companion's route and memory stay the same
  as without the add-on. Use `setCompanionContext` to tell companions where they are (Delamain: "You are riding in a Delamain cab
  with V; Delamain is the cab's AI and can hear you.").
- **Talk memory.** Conversations with a speaker are kept in the local memory store under its profile key (they never reach Convai).

## Settings

```lua
handle:settings({title = 'Skippy', description = 'The talking smart pistol.', items = {
    {id = 'personality', label = 'Personality', kind = 'select', default = 2, elements = {'Stone Cold Killer', 'Puppy-Loving Pacifist'},
        description = 'How Skippy feels about violence.'},
    {id = 'swearing', label = 'Swearing', kind = 'bool', default = true, description = 'Skippy may swear.'},
}})
```

- The section appears on the main settings page after Reactions, with the built-in **Time between remarks** and **Most remarks per
  fight** settings first.
- `id` uses letters, digits and `_`. `remarkGap`, `remarkCap`, `remarkGapChosen`, `remarkRate`, `replaceGameLines` and `markLines` are
  reserved for the built-in settings (the last two: **Replace the game's own lines**, only with a rule, and **Mark our lines in the
  subtitles**, for every add-on with a speaker). At most 24 items; `kind` is `bool` or
  `select` (2–12 elements, and `default` is the 1-based index).
- Changes are checked when the player applies them, saved only if the main Apply succeeds, written to
  `runtime/addon-settings.json`, and announced by `settingChanged` on the next tick.
- `handle:setting(id)` returns the current value.
- Labels are shown as written (they are not translated).

## Voice and placement

- Give a speaker a `voice` in the manifest. At bridge start the reference is checked, copied next to the main voice references,
  and merged into copies of the voice configurations (`addons.<name>` in the state folder). The main files are never changed.
- The speaker then speaks with the player's local voice engine (Pocket, Voxtral or OmniVoice).
- Without a voice entry, or with voice playback off, the speaker shows subtitles only. The Convai cloud voice is never used.
- Subtitles show the speaker's name (`subtitles.lua` dialogue mode, fallback `voice-only`). Audio comes from the anchor: V for
  `'player'`, the vehicle for `'vehicle'`.

## Evaluating a speaker

Test the prompt offline before shipping, and again after every persona change.

```
node scripts/addon-eval.mjs --addon addons/skippy --script addons/skippy/eval/fight.json --dry          # prints every prompt, sends nothing
node scripts/addon-eval.mjs --addon addons/skippy --script addons/skippy/eval/fight.json --judge --runs 3
```

- The script (`bridge/addon-eval.mjs` `parseScript`) is a sequence of game events and things V says. See
  `addons/example/eval/combat.json`:

  ```json
  {"speaker": "gun", "mode": "killer", "context": "V is on foot in a Watson back alley at night.",
   "memories": ["V spared the Tyger Claw who begged."],
   "steps": [
     {"event": "first-kill", "text": "V killed the first enemy of the fight.", "facts": {"enemies": 4}, "maxWords": 10, "expect": "smug, short"},
     {"event": "headshot-streak", "text": "V landed three headshots in a row.", "facts": {"streak": 3}, "maxWords": 8},
     {"say": "Skippy, how many left?"},
     {"event": "fight-end", "text": "The fight is over.", "facts": {"kills": 4}, "maxWords": 12, "mode": "puppy"}
   ]}
  ```

- A script or a step may carry `state`: the add-on state the game would have written (what a bridge module's hooks receive as
  `state`). A step's state stays until another step sets one. A field named `...At` holding a number of zero or less means that many
  seconds from now (`"startedAt": -180` is three minutes ago). A bridge module is loaded and its hooks run, so what the module builds
  from state and facts (ride blocks, logs) is evaluated, not hand-written into `blocks`.
- `--gap-ms N` (default 1500) spaces every model request, so a shared free key is not hit in bursts.
- Each step goes through the same persona and mode, blocks, trigger, recent lines, second try and duplicate drop (`AddonHost.produce`) and text host as in the game.
  Nothing touches the game, Convai or the player's memories.
- The key comes from `MISTRAL_API_KEY`, or from the key saved in the state folder, and is never printed.
- `--judge` scores each line from 1 to 10 with a second model, strictly (5 is filler, 7 is genuinely good). It sees the speaker's example lines and the facts of the event, and penalises a copied example or a number that is not in the facts. Rubric: in character, fun, fits the moment, short and
  fresh.
- A speaker is ready when it averages **7 or more** over three runs, with **no dropped repeats**, and no line breaks character.
- `--json` prints the results for comparison between persona versions.
- In tests, pass `chat` (and `llmJudge({chat})`) a stand-in, as `addons/example/example.test.mjs` does.

## Packaging

```
node packaging/build-addon.mjs addons/skippy --out dist/addons
→ dist/addons/CyberpunkConvai-Skippy-1.0.0.zip
    bin/x64/plugins/cyber_engine_tweaks/mods/CyberpunkConvaiSkippy/{init.lua, convai-addon.json, bridge.mjs, voice/skippy.wav}
```

- The zip ships `.lua`, `.json`, `.mjs`, `.js`, `.wav`, `.txt` and `.md` files. It never ships tests, `eval/`, dotfiles or
  `node_modules`, and any other kind of file stops the build.
- The build checks the manifest and that `init.lua`, the bridge module and every voice reference are in the folder.
- The main mod's packages never include `addons/` (`packaging/addon-packaging.test.mjs`, `bridge/addons.test.mjs`).
- An add-on zip never contains a main mod file.

## Files

| File (in `runtime/`) | Writer → reader | Content |
|---|---|---|
| `addons-status.json` | bridge → game, once at start | which add-ons were found, and why any was not loaded (the game shows one notice per problem) |
| `addon-state.json` | game → bridge, at most twice a second, only when changed | `{version, updated, addons: {<id>: {companionContext, state, modes, memories, warm}}}` |
| `addon-settings.json` | game → bridge, on Apply | `{version: 1, addons: {<id>: {<setting>: value}}}` |
| `addon-journal.json` (state folder) | bridge only | each speaker's last 12 lines and 12 memories |
| `last-input.json`, `reply.json`, `reaction-lease.json` | the existing turn files | a remark is an automatic request with `reaction: {kind: 'addon', addon, speaker, event, priority, expiresAt}` and `addon: {id, speaker, event, text, facts, maxWords, mode, blocks}` |

## Main mod seams (for maintainers)

Every seam is behind `convaiAddons and convaiAddons.live` (Lua) or `addonHost.active` / `addonHost.isSpeaker` (bridge). The tests
check the list of calls.

| Where | What |
|---|---|
| `mod/game-dialogue.lua` | `noteLine`: once per game subtitle line (both hooks, deduplicated; the mod's own replies, crowd chatter and TV are skipped), calls `convaiAddons.gameLine(seconds, kind)` through `options.onGameLine`, only while an add-on is live (`onGameLineWanted`). Independent of the "game dialogue context" setting. Lines an add-on declared with `replaceGameLines` (`matchWanted` / `matchLine` / `onMuted`): `installMute` overrides `SubtitlesGameController.ShouldDisplayLine` on the first rule, `ruleLine` stops the voice events and reports the muted line. |
| `mod/init.lua` | Loads `addons.lua` with `pcall`; returns `{addons = …}` for `GetMod`. Talk target: add-on voices after aimed characters (a vehicle-anchored voice outranks characters outside V's car: `companionOrPassenger`), for the voice keys too when `manager.speechRecognitionReady()` (asked on the key press, with `microphone.decorate` adding the blocks). `sendRequest`/`decorate`; `reactionCanDeliver` → `canDeliver`; `groupAudience` → `participantLive`; the reply error branch → `replyError`; `warmConversation` skips add-on voices; tick, reset and shutdown. |
| `mod/speech.lua`, `continuous-speech.lua`, `subtitles.lua` | `voiceOnly`: no face calls, no `IsDeadNoStatPool` check, subtitles owned by the player. `speech.lua` also sets `voiceProfile`; `subtitles.configure({mark})` adds the ` (AI)` marker to an add-on speaker's name (`captionName`). |
| `mod/group-chat.lua` | `voiceOnly` rows; add-on voices are left out of the other speakers' audience. |
| `mod/microphone.lua`, `mod/manager.lua` | `microphone.decorate` (add-on blocks at start and finish); `manager.speechRecognitionReady()` (the bridge's `stt` flag). |
| `mod/mcm.lua`, `mod/notices.lua` | Add-on settings sections; the `addon-notice` notice. |
| `bridge/convai-bridge.mjs` | `AddonHost.load`, `extend` (roster rows; add-on Convai IDs removed), voice config merge, status, state/settings watchers, journal; `runAddonTurn` before every Convai step of `runInput`; one `TextProviderHost` per add-on route (`fixedProvider`, `sharedMemory`, never Groq); `onWarm`. The microphone poll's add-on branches (start, finish, watch) and `bridge/addon-voice.mjs` (the channel on the Mistral route's recogniser; `MicrophoneSession` passes its `hostFactory` the recording). |
| `bridge/protocol.mjs`, `bridge/mistral-prompt.mjs` | The `addon` request field and reaction; persona rows with `intro`, `identityRule`, `rules` and `talkWords` (an add-on row only; the main mod's length rule is unchanged for every other row). |

## What the game must confirm live

1. `GetMod('CyberpunkConvai')` from another mod's `onInit` returns the API (CET load order).
2. The voice of a `'player'` speaker plays as V's own audio, and of a `'vehicle'` speaker from the car (Audioware emitter on V and
   on vehicles). Subtitles show the speaker's name.
3. A remark's latency from `handle:remark` to the first audio on Mistral (target under 2 s, with `prepare` called at the start of
   the fight).
4. A vehicle anchor survives `IsAttached`, and no `IsDeadNoStatPool` call reaches a vehicle.
5. Delamain detection: the add-on's `available()` recognises a Delamain cab ride, and remarks stay silent while the game's own
   Delamain dialogue plays (scene tier above 1, or dialogue).
6. The Local AI pack starts when a remark needs it and no FPS is lost outside the request. Measure the frame time during a
   remark at the local AI's default (about 20 s) and at a 10 s gap; shorten `LOCAL_REMARK_GAP_S` only if both are clean.
7. The provider notice appears once with no Mistral key and no Local AI pack.
8. Remarks feel right at the defaults (10 s, 30 a fight): frequent but never piled up, and none plays after its moment.
9. Replacing the game's own lines: the log shows `muted game line: Skippy ...` for "new message detected" / "provocation" and the beeps
   are not heard (`audio=stop-sent(vo_3d_important)` and then silence); if the voice still plays, the stop does not work for scene
   dialogue and `audioVerified` stays `false`. For the cab, the subtitle goes and the voice (no known event) still plays.

## Building Skippy and Delamain

Build against this document and `addons/example/`.

**Skippy** (`addons/skippy`, Oct 20):
- One speaker, `gun`, anchored to `'player'` and available while V holds Skippy.
- Two modes in the manifest, `killer` and `puppy`, chosen by a Personality setting through `setMode`.
- Kill, headshot, damage and civilian-hit detection in Skippy's own `init.lua`, through `Observe` hooks with O(1) handlers.
- Remarks: first kill (4), headshot streak of 3 or more (4), near death (5), a civilian hit in Pacifist mode (4), fight end (5),
  and ordinary kills (2) as filler for the short gaps.
- `prepare('gun')` on `combatStarted`.
- `remember` for memorable fights.
- An eval script with at least one full fight per mode.

**Delamain** (`addons/delamain-cab`, Oct 25):
- One speaker, `delamain`, anchored to `'vehicle'`, with `group = true`, available only in a Delamain cab.
- Never starts a line over the game's own Delamain scenes (default `sceneTiers = {1}`): every remark has `patience` and waits for the
  scene or subtitle line to end; a line that has started plays through (`playThrough`). Its own greeting and farewell subtitles are
  hidden while it sits in the cab (`replaceGameLines`); the cab voice has no known event to stop.
- `setCompanionContext('ride', …)` while riding, cleared on exit.
- Remarks: boarding (4), arrival (5), a crash or chase (4), at most one landmark (3).
- `remember` for notable rides.
- An eval script covering a ride with a companion.

Both: `providers` `["mistral", "local"]`; samples for every moment you remark on; average 7 or more in the eval with no repeats;
`packaging/build-addon.mjs` for the zip.
