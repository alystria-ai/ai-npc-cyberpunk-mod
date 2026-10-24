# Add-on API

Add-ons are separate CET mods that give AI NPC Cyberpunk Mod new voices. The first two are Skippy, a talking smart pistol that
comments on fights (Oct 20), and the Delamain cab's voice (Oct 25). Each add-on has its own Nexus page, its own zip and its own
repository: `alystria-ai/ai-npc-cyberpunk-mod-skippy` and `alystria-ai/ai-npc-cyberpunk-mod-delamain` (private until their launch dates;
see "The two add-ons" below). An add-on depends on the main mod, but the main mod never depends on an add-on.

API version: **1.1** (`mod/addons.lua` `M.API_VERSION`, `bridge/addons.mjs` `ADDON_API_VERSION`). An add-on asks for a
version, for example `requires = '1.0'`. A main mod with the same major version and an equal or higher minor version serves it.
Any other version gets one notice: "Skippy needs a newer AI NPC Cyberpunk Mod (add-on API 1.2; this version has 1.1). Update
AI NPC Cyberpunk Mod."

Version history:

| Version | What it added |
|---|---|
| 1.0 | Add-on speakers (a voice with no body), remarks, personas and modes, settings, events, stock, held remarks, replacing the game's own lines. Skippy and the Delamain cab. |
| 1.1 | **Content packs** (see "Content packs" below): an add-on that is only its manifest and changes how the characters talk (world rules, prompt wording, the characters' text and names, Convai twins, name pools, a separate memory). Add-ons written for 1.0 run unchanged on 1.1. |

An add-on is either a **voice add-on** (speakers, an `init.lua`: Skippy, the Delamain cab) or a **content pack** (only `convai-addon.json`
and data files), or both at once.

## Guarantees

- **With no add-on installed, nothing changes.** `convaiAddons.live` stays false and `init.lua` skips every add-on call.
  `AddonHost.active` stays false and the bridge adds no roster rows, blocks, files, watchers or timers. The tests prove this:
  `bridge/addons.test.mjs` ("inert") and `bridge/addons-lua.test.mjs` ("loading the module touches nothing").
- **No Convai for add-on speakers, ever.** An add-on **speaker's** text comes only from **Mistral**, the **local AI** or the player's own **Custom** provider.
  - It never uses Convai: neither the free tier nor a player's own key.
  - It never counts toward the shared key's 500 conversations a day.
  - It never opens a Convai connection, memory or warm-up.
  - A `convai` field in a speaker of a manifest is refused, and an add-on key in `characters.json` is removed at start.
  - A **content pack** (API 1.1) is not a speaker. It may reach the mod's own characters on Convai, in two ways only, both described under "Content packs": its
    world rules join the dynamic info the bridge already sends, and `content.convai` names Convai characters (twins made from the pack's text) that the
    mod's own characters use while the pack is on. A pack opens no Convai connection of its own and adds no Convai call.
- **A pack never changes the safety.** The hard-limit guard, the adults-only line, the facts the game gives a character, and the bridge's input and
  output screens are not part of what a pack can change. They are added after a pack's wording, as they are after the player's own edits.
- **A pack knows no game version.** One zip serves every supported game (2.5 and 2.31): there is no game field in the manifest, no game check, no
  `-for-2.31` suffix and no per-game build of an add-on (`packaging/game-variants.json` is about the main mod's own packages). The main mod's setup
  check and error reports never look at add-on folders, so an add-on can never be reported as a game mismatch.
- **No per-frame work.** Everything runs on the main mod's existing 0.1 s tick, only while an add-on is registered, and on events
  the main mod already has. Bridge hooks are synchronous and must take under 5 ms; a hook that fails three times is switched off.
- **Game characters stay untouched.** A speaker has no body: no face, gaze, gestures or gameplay actions. Game dialogue and scenes
  always win (see Remarks).

## How it fits together

```
add-on folder (its own CET mod)              main mod
  init.lua  ── GetMod('AiNpcCyberpunkMod').addons ──> mod/addons.lua (registration, remark scheduler, events, settings)
                                                        │ the same request / reply / lease files every automatic turn uses
  convai-addon.json  ── read at bridge start ──────> bridge/addons.mjs (AddonHost: persona rows, modes, blocks, journal)
  bridge.mjs (optional hooks) ─────────────────────> runAddonTurn in bridge/convai-bridge.mjs
                                                        └─ TextProviderHost on Custom, Mistral or the local AI → voice → subtitles
```

Each speaker becomes the profile `addon-<addon id>-<speaker id>`, for example `addon-skippy-gun`. The roster, the persona
book, the voices, the recent-lines journal and the game all use that key. The key joins two names with a dash, so two add-ons can
spell the same key (add-on `ab` with speaker `c-d`, add-on `ab-c` with speaker `d`): the first add-on by folder name keeps it, and the
other is skipped and reported (`status: duplicate`).

## The add-on folder

```
my-addon/                            (addons/example/ here; Skippy and Delamain are repositories of their own; the zip puts it in the CET mods folder)
  init.lua                           CET entry point: registers, makes remarks, settings, events
  convai-addon.json                  the manifest the bridge reads: persona, modes, providers, voice
  bridge.mjs                         optional: prompt hooks that run in the bridge
  voice/my-addon.wav                 optional: the voice reference (with its transcript in the manifest)
  eval/*.json                        evaluation scripts (never shipped)
  *.test.mjs                         tests (run by scripts/run-tests.mjs; never shipped)
```

Installed path: `bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkMod<Name>/`, for example `AiNpcCyberpunkModSkippy` or
`AiNpcCyberpunkModDelamainCab`. The bridge finds add-ons the way CET does: in each folder of the CET mods folder that has a
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
| `content` | Optional (API 1.1): a content pack's data, see "Content packs (API 1.1)". With it `schema` and `speakers` may be left out, `requires` may be the plain text `"1.1"`, and `requires.api` must be 1.1 or higher. |
| `providers` | Optional. `["mistral", "local"]` (the default), `["mistral"]` or `["local"]`. Anything else is refused. A speaker may set its own `providers`. `"custom"` is not a value here: the player's Custom provider is followed by every speaker (see Text providers). |
| `speakers[]` | At most 4 (optional in a content pack, see "Content packs"). `id` uses the same characters as the add-on id (1–24); `name` at most 60 characters. |
| `persona.backstory` | Required. At most 12,000 characters. Who the speaker is. |
| `persona.intro` / `identityRule` | Optional. Replace the opening line ("You are X, a real person…") and the "you are a real person" rule. A voice that is not a person should set both. |
| `persona.style` / `samples` / `rules` | Speaking style; at most 12 example exchanges (each at most 600 characters); at most 12 rules. |
| `persona.talkWords` | Optional whole number, 8–60. The longest answer, in words, the speaker gives V when V talks to it. It replaces the main mod's own length rule ("one to three short sentences, about 15 to 40 words, longer when asked") in the output rules and in the reminder after V's words with "one or two short sentences and at most N words", even when V asks for a long answer. Without it the main mod's rule applies, as for every character. A mode may set its own `talkWords`. Remarks are not affected: they follow their own `maxWords`. |
| `persona.voiceContext` | Optional `true`. The speaker is a voice with no body (a cab's AI). Its turns get the voice form of the main mod's context (see "Context"), so it is not told it is standing beside V and does not learn V's lifepath, wallet, heat or health, the party's names outside a group round, or the clock and weather every turn. |
| `modes` / `defaultMode` | Optional personalities, at most 4 (see Personas and modes). `defaultMode` defaults to the first mode. |
| `voice` | Optional. `reference`: a PCM `.wav` inside the folder, at most 8 MB and 0.1–20 s long. `transcript`: the exact words in it. `sha256`: optional checksum. Without a voice the speaker is shown as subtitles only. |

## CET side: `init.lua`

The add-on runs as its own CET mod. It reaches the main mod in `onInit`.

```lua
local Skippy = {}

registerForEvent('onInit', function()
    local main = GetMod('AiNpcCyberpunkMod')
    local api = type(main) == 'table' and main.addons or nil
    if not api then print('[Skippy] AI NPC Cyberpunk Mod is not installed; Skippy stays off.') return end
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

`GetMod('AiNpcCyberpunkMod')` is `init.lua`'s return value, `{addons = <api>}`. CET runs `onInit` for every mod before gameplay
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
| `handle:speaker{id, name, anchor, available, talk, group, minGap, talkPriority, sceneTiers, playThrough, voiceFrom, showsReply, approach, face}` | Adds a voice and returns its profile key. `id` and `name` must match the manifest. The options are described below this table. |
| `handle:remark(speakerId, {event, text, facts, priority, ttl, maxWords, interrupt, cooldown, patience, relevant, hold, holdMax, faceWait, menus, repeatOk, replaces, unlessGameLine})` | Asks for one automatic line. See Remarks. Returns `true` when the remark is queued, or `false, reason` with one of `speaker-cooldown`, `addon-gap`, `episode-budget`, `no-provider`, `event-cooldown`, `busy`, `queue-full`, `game-line` or `add-on disabled`. |
| `handle:setMode(speakerId, modeId)` | Switches the speaker's personality (a mode in the manifest). It is sent with every turn and in `runtime/addon-state.json`. |
| `handle:remember(speakerId, text)` | Keeps a memory the speaker can call back to later, for example "V spared the Tyger Claw who begged." At most 300 characters; a repeat is ignored. The bridge keeps the last 12 per speaker across game sessions. |
| `handle:setContext(speakerId, key, text, tier)` | Adds a prompt block to every turn of this speaker until it is cleared with `text = nil`. At most 8 blocks of 1,500 characters. `tier` is `'world'` (default; changes rarely), `'volatile'` (changes every turn) or `'notes'`. |
| `handle:setCompanionContext(key, text)` | Adds a block to every **companion's** prompt (for example "You are riding in a Delamain cab with V."). At most 4 blocks of 600 characters. Clear it with `nil`. |
| `handle:setState(table)` | Plain data the add-on's bridge module receives as `state` (at most 4,000 bytes as JSON). |
| `handle:on(event, fn)` / events | See Events. |
| `handle:settings{title, description, remarkCap, fixed, items}` / `handle:setting(id)` | A section on the main settings page. See Settings. |
| `handle:setEnabled(bool)` | A disabled add-on is never offered for talk and makes no remarks. Its waiting remarks are dropped. |
| `handle:prepare(speakerId)` | Warms the speaker's text route (opens the Mistral connection, or loads its prompt into the local AI). Call it when the speaker becomes available, for example when a fight starts or V gets into the cab. At most once every 20 s. A speaker with an `approach` object is warmed while that object is there, before V is in it (the Delamain cab parks near V). |
| `handle:cancel(speakerId)` | Drops the speaker's waiting remarks and stops its remark that is playing. |
| `handle:releaseHold(speakerId)` | The speaker's held remark (`hold`) plays now, without waiting for the next tick (with `faceWait`, as soon as the speaker's screen face is ready). `true` when one was held. See "Held remarks and menus". |
| `handle:after(seconds, fn)` | Runs `fn` once, `seconds` (0.1 to 30) from now, on the add-on tick that already runs (0.1 s; never per frame, no timer of the add-on's own). For a cap on something the add-on holds back, such as the Delamain cab's destination map that waits for the welcome line. At most 8 are pending in all; a session reset forgets them. `true`, or `false, reason` (`too-many`). |
| `handle:watchFace(speakerId, on)` | Starts or ends the watch of the speaker's screen face (`face`). See "A face on a screen". |
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
  changes the pan and distance of the voice (every voice is the browser renderer's, including OmniVoice); an object that is detached,
  unreadable or more than 3 m from the camera is dropped for the rest of that reply and the anchor is used. Superseded on 2026-10-22:
  until then the native Omni phrases played **on that object** (it was their Audioware emitter, and Audioware refused V as an emitter),
  so a V-anchored speaker with no `voiceFrom` object fell back to the weapon in V's hands or the chest item V wears, and failed with
  `speech=playback-failed why=Audioware cannot play on V ...` when V had neither. There is no such emitter now: a speaker anchored to V
  is heard from V's position with or without `voiceFrom`, and the weapon and chest-item fallback and that failure are gone.
- `showsReply(text, event) -> boolean` (optional): the add-on shows its remarks itself, so they need no subtitle. Asked **once per
  remark**, when the reply text arrives and before anything is shown. `true`: the main mod plays that remark's voice **without a
  subtitle** (speech.lua skips every caption call that follows the voice). `false`, nothing or an error: the subtitle is shown as always,
  and the log says `Remark subtitle kept: <speaker> (...)` once per remark. Only remarks are asked; V's own conversation with the speaker
  keeps its subtitle. If the voice cannot play (voice off, playback failed) the text is shown as a subtitle anyway, so a line is never
  lost. The add-on answers `true` only when it can show the text at that moment (Skippy: the gun's hologram is reachable); it shows
  the text itself on `remarkStarted` (the `text` field). A main mod older than this option ignores it and shows the subtitle: the
  add-on keeps working. Without add-ons nothing is asked (the main mod's code path is the same as before).
- `approach(player) -> GameObject` (optional): the anchor before V reaches it (the Delamain cab V walks up to, while the `'vehicle'`
  anchor is still empty). Only a remark with `hold` uses it, and only while the anchor itself is not there; talk, group rounds and
  every other remark never do. When V then gets in, the anchor is the same cab, so the line plays on.
- `face = {rig = '<face_rig rig path>'}` (optional): the speaker's face on a screen. See "A face on a screen".

### Held remarks and menus

Two remark options for a line that must start the instant something happens, and keep going through a menu:

```lua
handle:remark('delamain', {event = 'boarded', priority = 4, ttl = 20, maxWords = 22,
    hold = function() return not S.seated end,           -- written and voiced now, silent until V sits
    holdMax = 25,                                         -- given up unheard after this (1 to 30 s, default 20)
    faceWait = 1.5,                                       -- then waits up to this for the speaker's screen face (0 to 5 s)
    menus = function() return S.state <= READY end})      -- the destination map does not pause it
```

- **`hold() -> bool`**: the remark is written and its voice made as soon as it can be (it is anchored on `approach` while the anchor is
  empty), and speech.lua keeps that voice paused from its first frame while `hold()` is true. `hold()` runs on the 0.1 s tick;
  `handle:releaseHold(speakerId)` releases it at once (call it from the game event itself, such as the mount finishing). When the
  hold ends the line plays from its first word; `remarkStarted` is sent then, not when the voice was made. A remark whose `hold()` is
  already false when it is sent is an ordinary remark. A held remark counts as playing for scenes (a speaker with `playThrough` keeps
  it through ordinary scenes) but not as heard: one given up after `holdMax` (`remarkFinished` with `hold-expired`, `spoken = false`)
  costs no remark budget and its voice is stopped. While it is held it is the one remark in flight and its request owns the speech
  (no other automatic line starts); a conversation V starts still cuts it. With voice playback off its subtitle shows when the
  reply arrives.
- **`faceWait` (seconds, 0 to 5, default 0)**: for a held remark of a speaker with a screen face (`face`, below). When the moment comes
  (`hold()` turns false or `releaseHold`) and that face is not ready yet, the remark stays silent until it is, checked on the 0.1 s tick,
  at most `faceWait` seconds; then it plays anyway and the face joins when it appears. The Delamain cab's screen NPC is spawned by the
  game's scene as V sits, after the welcome was voiced (live test 2026-10-15: the welcome's face stayed still, the later lines moved it),
  so the welcome waits up to 1.5 s for it.
- **`repeatOk = true` (default false)**: the bridge normally drops a remark that nearly repeats one of the speaker's recent lines (after one second try that
  names the lines to avoid). With `repeatOk` such a remark is said anyway: for a line V would miss altogether, like the cab's welcome that replaces the
  game's own. A line that breaks a rule of its speaker (the add-on's `check` hook) is still dropped. The log says `remark <event> repeats a recent line ...; said anyway (repeatOk)`.
  The repeat check also takes greeting and farewell words ("good evening", "welcome back", "thank you") as common, so a welcome that opens the way welcomes do is not a repeat of another.
- **`replaces = true` (default false)**: this remark stands in for a game line the add-on mutes (`handle:replaceGameLines`: the cab's "your wish is my
  command", its arrival announcement). (1) It is asked for inside the speaker's `minGap` and the add-on's time between remarks (the game line it replaces
  would have played there, and V would hear nothing); the provider, the fight budget and the local AI's pace still apply. (2) It is written and voiced
  while the game line still plays, kept silent until that line is over (`gameLineUntil`), and starts REPLACE_GAP (0.3 s) after it, instead of being
  written only after the line (live 2026-10-16: the arrival line came about 10 s after the arrival, of which 5 s were the game's line and 3 s the
  writing). A remark asked for before the line was seen is kept silent as soon as it is seen, if it has not started to play. The log says `Remark kept
  silent until the game line it replaces is over`. A game line is waited out, not stopped: the Wwise stop of a scene voice is still unverified.
- **`unlessGameLine = true` (default false; with `replaces`)**: the line is said only when the game's own line it stands in for did not play. The
  voice stop of a scene line is not verified (`audioVerified` false; live 2026-10-15 the cab's goodbye was heard in full and then ours, one
  ending twice), so a muted game line counts as **heard** when it was seen up to 3 s before the ask, or while the remark waits, is written or is
  held: the remark is then refused (`handle:remark` returns `false, 'game-line'`), dropped (`remarkDropped` / `remarkFinished` `game-line-heard`)
  or taken back before a word is spoken, and the game's line is the line V hears. A remark that already plays is not cut. A rule whose
  `audioVerified` is `true` never counts. Log: `Remark dropped: ... reason=game-line-heard` or `Remark released: ... reason=game-line-heard spoken=false`.
- **`menus = true | function() -> bool`**: while the remark plays (or is held), an open game menu does not pause it: speech.lua
  compares the request id once per frame, as it already reads the menu flag. The function form runs on the 0.1 s tick. Without it a
  menu pauses the line and it resumes afterwards, as always.
- Log: `[Addons] Remark: ... (held until its moment)`, `Remark ready, held: <speaker> event=<e> after 3.1s`,
  `Remark hold released: <speaker> event=<e> after 4.2s`, with `faceWait` also `Remark moment came, waiting for the screen face: ...`
  and `(face ready after 0.4s)` or `(face not ready after 1.5s; it joins when it appears)` on the release line.

### A face on a screen

A speaker whose face is shown on a screen in the game (the Delamain cab's seat-back screens film an NPC with Delamain's own head) can
have that face move with its voice:

```lua
handle:speaker({id = 'delamain', ..., face = {rig = 'base\\characters\\main_npc\\delamain\\...\\h0_001_ma_c__delamain_skeleton.rig'}})
handle:watchFace('delamain', true)    -- while the moment lasts (a cab exists); false when it ends
```

- While a rig is watched, `r6/scripts/CyberpunkConvai/Face.reds` gives the NPC that spawns with that `face_rig` rig and one of the
  four crowd face graphs the main mod's **gated** copy of that graph (the same one ordinary NPCs get), whatever its record says: the
  rig names the one character, and the watch lasts only as long as the add-on's moment, so the character is not touched anywhere else.
  The gate keeps the face exactly vanilla (the game's own lip sync included) until the speaker's own line plays.
- Watch it before the NPC spawns: the graph is chosen at spawn or never. `watchFace` is one call into the face service per change; a
  save load or death releases the watch on the next gameplay tick unless the add-on watches again (in `sessionStarted`). Disabling the
  add-on ends it. At most 4 rigs.
- For each of the speaker's replies (when it starts) the main mod looks up the NPC the watch prepared (`ScreenFace`), and when it
  is attached and still runs the gated graph (`ConvaiFaceReady`), the reply's mouth timeline drives that NPC's face, in time with the
  heard voice like every face in the mod. When the face is watched but not there yet (`addons.faceActor` answers `nil, true`), the
  reply asks again every 0.25 s of heard playback (never while it is paused or held), at most 40 times, and the face joins at the
  heard position (log `Screen face joined: <speaker> 0.8s into the line`, or `Screen face not found for this line`). Every other
  reply never retries. The scene and autonomy guards of the expression layer do not apply to that one NPC (it is a
  scene actor by nature). Nothing else of the speaker changes: the voice is still heard from the anchor.
- Nothing runs per frame beyond the face write every speaking face already has; without a watch the spawn callback costs one array
  size read more.

### Replacing the game's own lines

An add-on whose character also speaks in the game (Skippy's "new message detected", the Delamain cab's greeting and farewell) can
have the game's own voice and subtitle for those lines silenced, so that only its AI lines are heard:

```lua
handle:replaceGameLines({name = 'Skippy',
    match = function(line, context) return isSkippy(line) end,   -- cheap: a few string reads; context.typeName() resolves the line type
    active = function() return S.holding end,                     -- optional: only while this is true (V holds the gun, V sits in the cab)
    audio = {'vo_3d_important'},                                  -- optional: Wwise events stopped on the line's speaker (at most 4)
    audioVerified = false,                                        -- true once it is heard in the game that the voice really stops
    silence = function(line, context)                             -- optional: the add-on's own extra way to silence a muted line
        return 'what was done', function() end                    --   returns a short text for the log and a function that is repeated
    end})
```

- **Per add-on option, on by default:** the add-on's settings section gets **Replace the game's own lines** (only when a rule is
  declared) and **Mark our lines in the subtitles**. At most 4 rules per add-on; `replaceGameLines` and `markLines` are reserved ids.
  An add-on that wants no such switches declares `fixed` in `handle:settings` (see Settings): `fixed = {replaceGameLines = true,
  markLines = false}` removes both toggles and applies those values whatever the player saved before.
- **`silence(line, context) -> text, again`** (optional): runs once for each muted line, right after the main mod's own voice stop, for
  whatever else the add-on knows to silence a line (Skippy: the same stops on the gun entity, which the line's own speaker may not be, and
  the game's scene-interrupt fact). `text` (at most 80 letters) is appended to the `audio=` part of the `muted game line` log line; `again`
  is called with the voice stop's repeats at 0.3, 0.8 and 1.6 s. An error in it changes nothing else. Not per frame.
- **What is silenced is only the voice and the subtitle of the lines `match` claims, only while `active()` holds and the add-on is
  enabled.** The scene, the quest, the map, the payment and every other character's line run as always (a line is never skipped
  or blocked). The main mod never decides who the character is: the add-on's own `match` does, and a line of the mod's own replies is
  never hidden.
- **Subtitle:** the first rule installs one `Override` of `SubtitlesGameController.ShouldDisplayLine` (the game asks it once per
  line, never per frame); a claimed line answers "do not display". If the override cannot be installed, the line is hidden right after
  it was handed to the HUD (`UIGameData.HideDialogLine`), and the log says so. Without a rule nothing is hooked and a game line
  costs one boolean read.
- **Voice:** `AudioSystem.Stop(event, speakerEntity)` for each event in `audio`, sent when the line is seen (from the subtitle hook that
  already runs) and sent again 0.3, 0.8 and 1.6 s later on the add-on tick that already runs (a scene voice can start a moment after
  its subtitle line, and a Stop that came first finds nothing to stop; the repeat holds the entity id value and the event names, never
  the entity, and is dropped on a session reset). The scene system plays most dialogue without a named event, so a stop is a try: the log line says whether a stop was sent,
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
| `remarkStarted` | `{speaker, event, text}`: the remark is heard (or its caption is shown). `text` is the reply's text (plain, at most 400 letters; nil from a main mod older than this field, so an add-on that shows it elsewhere keeps working without it) |
| `remarkFinished` | `{speaker, event, reason, spoken, requeued}` (`requeued` is true when a remark with `patience` was taken back at a scene and waits to be written again). A remark that is playing finishes even when its speaker stops being `available` (V steps out of the cab while it ends); only a scene, a conversation V starts, `handle:cancel` or the add-on being switched off cut it. One still waiting to be heard is given up after 2.5 s without its speaker. `reason` is one of `finished`, `not-delivered`, `stale`, `manual-priority`, `scene`, `scene-tier`, `game-line`, `speaker-unavailable`, `interrupted`, `cancelled`, `add-on-disabled`, `anchor-changed`, `game-line-heard` or `hold-expired` |
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

## Text providers: Custom, Mistral or the local AI

The bridge chooses the route for each add-on turn (`AddonHost.routeFor`), from what the speaker allows:

1. The player's **Custom** provider (an OpenAI-compatible endpoint), when it is the conversation provider in use and its endpoint is
   set up (address and model; decision 2026-10-20). Every speaker follows it, like the companions, so no add-on needs an edit: the
   manifest's `providers` list names only `mistral` and `local` and does not need a `custom` entry (it is refused there).
2. Otherwise the player's own conversation provider, when it is Mistral or the local AI, the speaker allows it and it is working.
3. Otherwise **Mistral**, when the speaker allows it and the player has saved a Mistral key that was not refused. Never for a player on Local AI (2026-10-22): a Local AI player whose speaker does not allow `local` has no route (step 5), whatever Mistral key is saved.
4. Otherwise the **local AI**, when the speaker allows it and the Local AI pack is installed and has not failed.
5. Otherwise nothing.

A Custom provider chosen but not set up falls through to 3 and 4 like any other state; Custom is never picked when another provider
is the player's choice. On Custom the turn is the companions' Custom path: the same text host, memory, prompt layout and Custom
route (no pacing of its own, the endpoint's own limits apply). With Mature content on the hard-limit guard runs on it as on every
add-on route (the guard lines in the prompt, the input and output screens; never the crude Mature persona layer, which companions
get). Stock lines (see Stock) are written only on Mistral, never on Custom.

When nothing can answer, the reply carries `errorCode: 'addon-provider'`. The game then shows one notice: "Skippy needs a free
Mistral key or the Local AI pack. Set it up under Conversation provider in AI NPC Cyberpunk Mod's settings." The add-on's remarks
pause for two minutes. For remarks the notice is shown once per session; a message V typed always gets it. A player on a working
Custom provider never gets it.

**The default and the budget.**
- The default route is Mistral for a Convai player who has saved a key. That player keeps Convai for companions, and Skippy and
  Delamain use their Mistral key.
- Each remark is one request of a few hundred new tokens. The persona and the mode are a stable prefix that Mistral caches.
- An add-on's request budget is its two settings. Because the gap counts from the end of the last remark, even the shortest gap
  (4 s) means about one request every 6 to 8 seconds, and never two remarks at once.
- Mistral requests are paced by the same scheduler as the companions' requests on that key (about one a second on the free plan),
  so a remark and a companion reply share that second and nothing is refused for rate.
- On Custom a remark is one request to the player's endpoint, with no scheduler of the mod's (a server on this computer or the home
  network answers one request at a time).
- On the local AI a remark uses the GPU only while it is written. If the pack is installed but not running, the first remark starts
  it, so call `handle:prepare` when a fight or ride begins.
- An add-on turn never touches Convai and never counts toward the shared key's 500 conversations a day.

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
- the main mod's "right now" blocks (time, place, company). With `persona.voiceContext` they have the voice form instead: no
  "you are with V in person", no lifepath, wallet, heat, health, journal or gear, no clock or weather, and who rides with V
  only in a group round; the add-on's own blocks give the rest;
- a note that it is a voice with no body;
- its `setContext` blocks and the facts (or its module's `speakerBlocks`);
- its memories and its recent lines.

Companions get each add-on's `setCompanionContext` blocks and the module's `companionBlocks`.

## Bridge module (optional)

`bridge.mjs` runs inside the bridge. Every export is optional, synchronous, quick (under 5 ms) and free of side effects. A hook
that throws, returns a promise or fails three times is switched off, and the add-on keeps working without it. The module's import and
`activate` must finish within 5 seconds, or the module is dropped for this run (the add-on keeps working without hooks, and
`addons-status.json` carries the reason): one add-on never holds up the start of the bridge.

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

/**
 * Blocks for every companion's turns (profileKey is the companion). `group` is true in a group round: outside one a companion
 * talks with V only, so a note about the add-on speaker should say so (Delamain's: "you speak to the cab only in a group conversation").
 */
export function companionBlocks({profileKey, group, state, settings}) { return []; }

/**
 * A finished remark, before it is spoken: return a short reason (at most 120 characters) when it broke a rule of the speaker, else
 * nothing. A remark that fails is written once more, like a near repeat (the reason goes into the second try's prompt), and
 * dropped if the second one fails too. A reply to something V said is never checked: it streams and cannot be written again, so
 * for those the prompt has to carry the rule. {speaker, profileKey, line, event, facts, group, reaction, state, settings}.
 */
export function check({line, facts, group, state}) { return /^Judy[,.]/.test(line) && !group ? 'it spoke to Judy outside a group chat' : null; }

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
  because it does not need the provider. The words then go to the add-on turn route (`runAddonTurn`: Custom, Mistral or the local AI,
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
- `remarkCap = false` (next to `title` and `description`) hides **Most remarks per fight** for an add-on whose remarks are not fight
  remarks (Delamain's cab talk). The saved value is then unused and the default guard of 30 stays in force.
- `fixed = {replaceGameLines = true|false, markLines = true|false}` (next to `title`) takes the two on/off built-ins away from the
  player and sets them for good: the toggle is not shown, cannot be staged, and the declared value applies even when an older install
  saved the other one. Only the keys given are fixed; the other toggle stays. An add-on without `fixed` is unchanged. Skippy fixes both
  (always replaced, never marked) to keep his settings page to one choice and the two timing settings; the Delamain cab fixes both too.
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
  `'player'`, the vehicle for `'vehicle'`. A speaker whose `showsReply` says yes for a remark has no subtitle for it (see the speaker
  options); the text is then the add-on's to show.

## Evaluating a speaker

Test the prompt offline before shipping, and again after every persona change.

```
node scripts/addon-eval.mjs --addon addons/example --script addons/example/eval/combat.json --dry          # prints every prompt, sends nothing
node scripts/addon-eval.mjs --addon addons/example --script addons/example/eval/combat.json --judge --runs 3
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

## Content packs (API 1.1)

A content pack is an add-on that is **only data**: a folder with `convai-addon.json` (and optionally data files, a README and a LICENSE). It has no
`init.lua`, no `bridge.mjs` and no speakers. It changes how the mod's own characters talk, and only while the player has it switched on. The first
one is "Medieval AI NPCs". `addons/example-content/` is a complete, tested example to copy.

Installed path: `bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkMod<Name>/convai-addon.json`, like any add-on. The bridge finds the folder by its
manifest (CET itself ignores a folder with no `init.lua`, so nothing runs on the game side for it). The pack is read **once, when the bridge starts**; there
are no file watchers, so an edit to a pack needs a bridge restart (starting the game does it).

### A minimal pack

```json
{
  "schema": 1,
  "id": "medieval",
  "name": "Medieval AI NPCs",
  "version": "1.0.0",
  "requires": {"api": "1.1"},
  "speakers": [],
  "content": {
    "worldRules": ["There are no phones, cars or guns in this world; people travel on foot or by horse."],
    "prompting": {"*": {"closing": {"text": "Reply as {name}, in the speech of this age, in one to three short sentences."}}},
    "characters": "characters.json",
    "memory": "separate"
  }
}
```

The short form `{"id": ..., "name": ..., "version": ..., "requires": "1.1", "content": {...}}` (no `schema`, no `speakers`, `requires` as a plain text) is accepted
for a manifest that has `content`. Use the full form above for a pack that should say "needs a newer AI NPC Cyberpunk Mod" on an older bridge (see "Older main mods").
`requires` must be 1.1 or higher when there is a `content` object. Any other top-level field (a `game` field, say) is ignored: a pack has no game version.

### What `content` can hold

| Field | Meaning |
|---|---|
| `worldRules` | A list of texts (at most 24 lines of 600 characters, 4,000 in all). Added to **every** character's world rules **after the player's own**, one line each with a leading `- `. |
| `prompting` | `{"*": override, "<profile id>": override}`: changes to the prompt profiles (the wording of the output rules, the closing line, the sampling, the Mature layer...). Each override has exactly the shape a player's change has in the prompt-profile store (`bridge/prompt-profiles.mjs` `validateOverride`; the editor's Prompting page). `"*"` is every profile; a profile id is `mistral`, `local-lite`, `local-standard`, `mature-lite`, `mature-standard` or a Custom profile's id. At most 12 keys. |
| `characters` | `{"<profile key>": {"name", "summary", "backstory", "speakingStyleDescription", "speakingStyleSampleDialogues"}}`, **or a path** (`"characters.json"`) of a JSON file inside the pack folder holding the same object (or a list of rows with a `key`, the shape of `characters/roster.json`). Keys are those of `characters/roster.json` and `characters/archetype-roster.json`. The name, gender, records and voice of a character are the game's: only `name` (the display name), `summary` and the three texts can be given, and any other field is refused. `summary` is the short description the Companion Manager (Characters, Models and party details) shows under the name, at most 1,300 characters; leave it out and the mod makes one from the first one or two sentences of the pack's `backstory` (the profile marker and any bracketed tags removed, at most 450 characters), so a renamed character never keeps the shipped description. Without a `backstory` and without a `summary` the shipped description stays. |
| `namePools` | The name pools of the random pedestrians, in the shape and under the rules of `characters/npc-name-pools.json` (16 cultures with at least 100 male, 100 female, 100 surnames and 20 handles each, 10 handle styles of at least 30, a blocked list of at least 50 names; `scripts/Build-NpcNamePools.mjs` `validate`). Inline or a path of a JSON file in the pack folder. |
| `convai` | `{"<profile key>": "<Convai character id>"}`: a Convai character made from the pack's text for that character (a "twin", made the way the multilingual twins are, `scripts/Create-MultilingualProfiles.mjs`). |
| `memory` | `"shared"` (the default) or `"separate"`. |

Limits (all checked before anything is used; a pack that breaks one is **skipped whole**, with one line in the log and one notice in the game, never half applied):
a character's backstory is 40 to 9,000 characters, its style at most 1,800, its example lines at most 20 of 600 characters (6,000 in all), and the three together at most 12,500
(the limits of the character editor); at most 512 characters, 512 twins; the `characters` file at most 3 MB and the `namePools` file 1 MB; the rest of `content` (world rules, prompting,
twins) at most 40,000 characters as JSON. A file path must stay inside the pack folder (no drive, no leading slash, no `..`) and end in `.json`. Several packs together may add at most 6,000
characters of world rules (a later pack's lines that do not fit are left out, with a log line).

### Precedence

**The shipped profile < the packs < the player's own editor changes.** Several packs apply in folder-name order, and a **later pack wins per field**
(per sub-field of an object field; a list such as `rules` replaces); world rules are added one pack after the other. For one pack, `"*"` is laid down first and
a specific profile id on top of it. For a character, the pack's text replaces the shipped one, and **a player's own edits of that character (Settings > Edit characters) still win,
field by field**. In the editor "Reset to default" returns to the pack's value when a pack sets that field, to the shipped one otherwise (the pages say so).
The player's changes are checked against the shipped profile with the packs laid over it: a value equal to the pack's is no change, one that equals only the shipped value is kept.

### Providers

- **Mistral, Local AI and Custom** get everything: the world rules, the prompt wording (`prompting`), the characters' text and names.
- **Convai** is changed in two ways only: the pack's **world rules** go into the dynamic info the bridge already sends every turn (`convaiWorldRulesBlocks`, after the
  player's own world rules, kept whole; the packs' lines are added while the whole stays within 4,000 characters, a line that does not fit is left out with one log line), and **`convai`
  twins** (below). Convai's prompting lives on Convai's side, so `prompting` is not applied there.
- An add-on speaker's persona is the add-on's: `characters` never reaches a speaker (`addon-` keys) or a character the player made (`custom-`).
- The guard, the hard limits, the adults-only line and the facts from the game are not part of any of it.
- Nothing happens per turn or per frame: the merged results are made when a pack is switched on or off and kept, so the system prompt stays **byte-stable** within a profile
  (the prompt caches of Mistral and the local AI stay warm). With no pack, or with every pack switched off, every prompt is byte for byte what it is without the feature.

### The player's switch

**Settings > Content packs** (Mod Configuration Menu and Native Settings UI) lists each installed pack with an On/Off switch (on by default, saved in
`runtime/addon-settings.json` as `{"<pack id>": {"contentEnabled": false}}`). The row says what the pack works with (prompt changes: Mistral, Local AI, Custom; on Convai its world rules
and its own Convai characters). A switch counts **from the next reply**, with no restart, for everything the bridge does (prompt, world rules, characters' text and names in the prompt and the editor, Convai twins,
memory). The game shows the **new names and descriptions** (Companion Manager, party, subtitles, phone, holocall, scanner names) after the **next game start or save load**, because the game reads its name lists then;
the old name keeps working as a name for the character in both directions.

### Characters and names

When a pack is on, the persona of a listed key is the pack's text (Mistral, Local AI, Custom). The roster rows themselves carry the pack's text and name, so the prompt (`{name}`, the opening line, the closing
line), the character editor and every reader of the roster see it at once. The shipped name stays an alias, so **the old name is still recognised** (what V says or types, group chats, the editor's and the
manager's search find a character by the new and the old name). Switching the pack off restores the rows exactly. The mod's game side applies the names with the switches (`mod/content-names.lua`, from
`runtime/content-names.json`, which lists the names of every installed pack; the game applies the ones that are on).

`namePools` do the same for pedestrians: while the pack is on the scanner and talk names of ordinary people come from the pack's pools (`runtime/content-name-pools.json`, read once, the first time a name is made).
A shopkeeper who already has a saved name keeps it.

### Convai twins

`content.convai` gives, for a profile key, the id of a Convai character that holds the pack's text for it. While the pack is on, a Convai turn for that character uses the twin's id instead of the
ordinary one (memory per twin is separate on Convai's side, and "Forget" clears the twin with the original, like a multilingual twin). Rules:

- Only on Convai's shared plan, as the multilingual twins are (a player's own Convai key has no twins).
- A key **without** a twin keeps the normal Convai character, plus the pack's world rules through the dynamic info. Its Convai-side memory is then the normal one, shared with the pack's talks.
- **With the multilingual twins:** a turn that goes to a character's multilingual twin (a message that is clearly not English, or a fixed Voice language other than English) keeps using it, because it answers in the
  player's language and the pack's twin is English only. Every other turn uses the pack's twin. (The pack's world rules reach the multilingual twin through the dynamic info like everyone's.)
- A twin for a key the mod has no Convai character for, with an id that another character already uses, or whose provider key (`<profile key>-<pack id>`) does not fit, is left out with one log line.
- The twin's text must carry the ownership marker `[CyberpunkConvai profile v2:<profile key>:<pack id>]`, as a multilingual twin carries `...:multilingual]`, so the memory guards accept it.
- Switching the pack off goes back to the normal character ids at the next idle moment (the bridge retires the connections of the characters whose route changed).

### Memory

With `"memory": "separate"`, while the pack is on, the text providers (Mistral, Local AI, Custom) keep each character's memory (the recent turns, summaries, facts about V, phone and group history, shopkeepers' memory of V) under the key `<profile key>@<pack id>`,
so talks in the pack's world and normal talks never mix. Turning the pack off returns to the normal memory, untouched; turning it on again resumes the pack's. Nothing is moved, copied or deleted.
**Forget memories** (the Memory page of the Companion Manager, and the character editor) acts on the memory in use, and the Memory page names it ("Memory in use"). The player's own hand-written memories of a character
(editor) are shared. Shopkeepers' memory of V splits the same way even when Convai answers. Convai's own memory is the Convai characters' (see "Convai twins"). The last pack that is on and says `separate` decides.
With `"shared"` (the default) nothing changes.

### Older main mods

A pack asks for 1.1. The bridge of an older main mod (1.0) reads the manifest, sees `requires.api` "1.1" and logs `needs add-on API 1.1; this AI NPC Cyberpunk Mod has 1.0` (status `incompatible` in
`runtime/addons-status.json`) and skips the pack. Because a pack has no `init.lua`, **an old game side never reads that file, so the player is not shown a notice**: say "needs AI NPC Cyberpunk Mod 0.3.2 or newer" on the pack's page.
To get the in-game notice on an old main mod too, a pack may ship a tiny `init.lua` that only registers for the notice:

```lua
registerForEvent('onInit', function()
    local main = GetMod('AiNpcCyberpunkMod')
    local api = type(main) == 'table' and main.addons or nil
    if api and not api.compatible('1.1') then api.register({id = 'medieval', name = 'Medieval AI NPCs', version = '1.0.0', requires = '1.1'}) end
end)
```

On a main mod with API 1.1 or newer it does nothing; on an older one `register` refuses and shows the "needs a newer AI NPC Cyberpunk Mod" notice. The builder ships it (a pack with an `init.lua` is built as any add-on).

### Problems the player is told about

At the first gameplay tick the game reads `runtime/addons-status.json` once and shows one notice for each add-on or pack the bridge could not load: "<name> could not load: <reason>" (an invalid pack: the reason names the
field, for example `content.prompting.mistral: sampling.topK is not valid (not-for-mistral)`) or "<name> needs a newer AI NPC Cyberpunk Mod (...)". Nothing else changes and the other add-ons still load.

### Testing a pack

`node --test bridge/addon-content.test.mjs bridge/addon-content-characters.test.mjs addons/example-content/example-content.test.mjs` (the format, precedence, providers, toggles, Convai and memory), and
`node packaging/build-addon.mjs addons/example-content --out dist/addons` to see the zip. In the game: copy the folder into the CET mods folder as `AiNpcCyberpunkMod<Name>`, start the game, open Settings > Content packs, talk to a character on
Mistral or Local AI, switch the pack off, talk again.

## Packaging

```
node packaging/build-addon.mjs addons/example --out dist/addons       # any add-on folder, in this repository or outside it
→ dist/addons/AI-NPC-Cyberpunk-Mod-Example-1.0.0.zip
    bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkModExample/{init.lua, convai-addon.json, bridge.mjs}
node packaging/build-addon.mjs addons/example-content --out dist/addons   # a content pack: no init.lua
→ dist/addons/AI-NPC-Cyberpunk-Mod-ExampleContent-1.0.0.zip
    bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkModExampleContent/{convai-addon.json, characters.json, README.md}
```

A content pack with no speaker and no bridge module is built **without** an `init.lua`; its `characters` and `namePools` files are checked by the same code the bridge uses and must be in the folder. A `LICENSE` file (no
extension) ships too. There is one zip for every supported game: the builder has no game option and the name has no game suffix.

The two shipping add-ons build their own zips with a self-contained copy of this builder (`tools/build.mjs` in each repository; same
files, same bytes, no main checkout needed). If the rules below change here, change them there too.

- The zip ships `.lua`, `.json`, `.mjs`, `.js`, `.wav`, `.txt` and `.md` files. It never ships tests, `eval/`, dotfiles or
  `node_modules`, and any other kind of file stops the build. From a `voice/` folder it takes only the references the manifest
  names: a stray clip or a `*.voice.json` note beside them (cut from game audio, kept out of git) is left out.
- The build checks the manifest and that `init.lua`, the bridge module and every voice reference are in the folder.
- The main mod's packages never include `addons/` (`packaging/addon-packaging.test.mjs`, `bridge/addons.test.mjs`).
- An add-on zip never contains a main mod file.

## Files

| File (in `runtime/`) | Writer → reader | Content |
|---|---|---|
| `addons-status.json` | bridge → game, once at start | which add-ons were found, and why any was not loaded (the game shows one notice per problem) |
| `addon-state.json` | game → bridge, at most twice a second, only when changed | `{version, updated, addons: {<id>: {companionContext, state, modes, memories, warm}}}` |
| `addon-settings.json` | game → bridge, on Apply | `{version: 1, addons: {<id>: {<setting>: value}}}` |
| `content-names.json`, `content-name-pools.json` | bridge → game, once at start | the new names and the name pools of every installed content pack (empty when there is none); the game applies the packs that are on (`mod/content-names.lua`). A pack's switch is `addon-settings.json` `{<pack id>: {contentEnabled: false}}` |
| `addon-journal.json` (state folder) | bridge only | each speaker's last 12 lines and 12 memories |
| `last-input.json`, `reply.json`, `reaction-lease.json` | the existing turn files | a remark is an automatic request with `reaction: {kind: 'addon', addon, speaker, event, priority, expiresAt}` and `addon: {id, speaker, event, text, facts, maxWords, mode, blocks}` |

## Main mod seams (for maintainers)

Every seam is behind `convaiAddons and convaiAddons.live` (Lua) or `addonHost.active` / `addonHost.isSpeaker` (bridge). The tests
check the list of calls.

| Where | What |
|---|---|
| `mod/game-dialogue.lua` | `noteLine`: once per game subtitle line (both hooks, deduplicated; the mod's own replies, crowd chatter and TV are skipped), calls `convaiAddons.gameLine(seconds, kind)` through `options.onGameLine`, only while an add-on is live (`onGameLineWanted`). Independent of the "game dialogue context" setting. Lines an add-on declared with `replaceGameLines` (`matchWanted` / `matchLine` / `onMuted`): `installMute` overrides `SubtitlesGameController.ShouldDisplayLine` on the first rule, `ruleLine` stops the voice events and reports the muted line. |
| `mod/init.lua` | Loads `addons.lua` with `pcall`; returns `{addons = …}` for `GetMod`. Talk target: add-on voices after aimed characters (a vehicle-anchored voice outranks characters outside V's car: `companionOrPassenger`), for the voice keys too when `manager.speechRecognitionReady()` (asked on the key press, with `microphone.decorate` adding the blocks). `sendRequest`/`decorate`; `reactionCanDeliver` → `canDeliver`; `groupAudience` → `participantLive`; the reply error branch → `replyError`; `warmConversation` skips add-on voices; tick, reset and shutdown. |
| `mod/speech.lua`, `continuous-speech.lua`, `subtitles.lua` | `voiceOnly`: no face calls, no `IsDeadNoStatPool` check, subtitles owned by the player. `speech.lua` also sets `voiceProfile`; `subtitles.configure({mark})` adds the ` (AI)` marker to an add-on speaker's name (`captionName`). `speech.faceSource` → `faceActor` once per add-on reply: with a screen face the per-utterance face calls go to that NPC under its own entity (a re-addressed copy of the timeline), and `facial-playback.lua` `screenEntity` exempts it from the scene guards. `speech.holdRequest` / `speech.menuRequest` (seams `hold` / `menus`, set on the add-on tick): the pause decision (`pausedFor`) keeps a held request paused and lets a menus request play in menus. |
| `r6/scripts/CyberpunkConvai/Face.reds` | `WatchScreenFace(rig, watch)` / `ScreenFace(rig)` (seam `faceService`): while a rig is watched, `OnWorldInitialize` prepares the NPC with that rig (`PrepareScreenFace`, gated graph) before the crowd mode check. An empty watch list changes nothing. |
| `mod/group-chat.lua` | `voiceOnly` rows; add-on voices are left out of the other speakers' audience. |
| `mod/microphone.lua`, `mod/manager.lua` | `microphone.decorate` (add-on blocks at start and finish); `manager.speechRecognitionReady()` (the bridge's `stt` flag). |
| `mod/manager-ui.lua`, `mod/notices.lua` | Add-on settings sections; the `addon-notice` notice. |
| `bridge/convai-bridge.mjs` | `AddonHost.load`, `extend` (roster rows; add-on Convai IDs removed), voice config merge, status, state/settings watchers, journal; `runAddonTurn` before every Convai step of `runInput`; one `TextProviderHost` per add-on route (`fixedProvider`, `sharedMemory`); `onWarm`. The microphone poll's add-on branches (start, finish, watch) and `bridge/addon-voice.mjs` (the channel on the Mistral route's recogniser; `MicrophoneSession` passes its `hostFactory` the recording). |
| `bridge/protocol.mjs`, `bridge/mistral-prompt.mjs` | The `addon` request field and reaction; persona rows with `intro`, `identityRule`, `rules` and `talkWords` (an add-on row only; the main mod's length rule is unchanged for every other row). |

## What the game must confirm live

1. `GetMod('AiNpcCyberpunkMod')` from another mod's `onInit` returns the API (CET load order).
2. The voice of a `'player'` speaker plays as V's own audio, and of a `'vehicle'` speaker from the car (the browser renderer, panned and
   attenuated from V's or the vehicle's position). Subtitles show the speaker's name.
3. A remark's latency from `handle:remark` to the first audio on Mistral (target under 2 s, with `prepare` called at the start of
   the fight).
4. A vehicle anchor survives `IsAttached`, and no `IsDeadNoStatPool` call reaches a vehicle.
5. Delamain detection: the add-on's `available()` recognises a Delamain cab ride, and remarks stay silent while the game's own
   Delamain dialogue plays (scene tier above 1, or dialogue).
6. The Local AI pack starts when a remark needs it and no FPS is lost outside the request. Measure the frame time during a
   remark at the local AI's default (about 20 s) and at a 10 s gap; shorten `LOCAL_REMARK_GAP_S` only if both are clean.
7. The provider notice appears once with no Mistral key, no Local AI pack and no ready Custom provider. With Custom chosen and set up,
   Skippy and Delamain answer through it and the notice never appears.
8. Remarks feel right at the defaults (10 s, 30 a fight): frequent but never piled up, and none plays after its moment.
9. Replacing the game's own lines: the log shows `muted game line: Skippy ...` for "new message detected" / "provocation" and the beeps
   are not heard (`audio=stop-sent(vo_3d_important)` and then silence); if the voice still plays, the stop does not work for scene
   dialogue and `audioVerified` stays `false`. For the cab, see item 10.
10. The Delamain cab's own welcome and goodbye (add-on `ai-npc-cyberpunk-mod-delamain`, "The cab's own voice" in its
    `docs/DELAMAIN_RESEARCH.md`): ride a cab with "Replace the game's own lines" on. (a) The cab's greeting is silent and has no
    subtitle, the destination map opens a few seconds after you sit down, the fare and the ride work as always, and our welcome
    plays around the time the map opens (the log shows `the cab's own welcome is switched off for this boarding`). (b) At the end
    the log shows `muted game line: Delamain ... audio=stop-sent(vo_3d,vo_2d,vo_3d_important)`: if the cab's goodbye voice still
    plays, note the line id and the time; the next candidates are other Wwise events and the dialogue volume. (c) With the option
    off the game's own welcome and goodbye play as before and nothing is written. (Since 2026-10-14 the cab fixes the option on:
    (c) no longer applies.)
11. Held remarks, menus and a screen face (the Delamain cab, 2026-10-14). (a) Call a cab and walk to it: the log shows
    `Remark ... event=boarded ... (held until its moment)` and `Remark ready, held` before you sit, and nothing is heard. (b) The
    welcome starts the moment V sits (`Remark hold released ... after <s>`), with no wait for the text or voice. (c) It keeps playing
    while the destination map is open (every voice is the browser renderer's now: note whether it follows a paused game). (d) Delamain's face on the seat-back screens moves with our line (log `Screen face watched: addon-delamain-cab-delamain`;
    if the mouth stays still, the screen NPC may not spawn as an `NPCPuppet`, may spawn before the cab state reaches 1, or its rig may
    fail the 59-track check: the face status reads `screen:unsupported-rig`). (e) The game's own vanilla lip sync of other Delamain
    lines still works, and the FPS during the ride is unchanged.

## The two add-ons

Skippy and Delamain are not in this repository. Each is its own repository (private until launch) with its own releases, README,
tests, character docs and a self-contained zip builder, built against this document and `addons/example/`:

| Add-on | Repository | Local clone (sibling of this checkout) | Release |
|---|---|---|---|
| Skippy (`skippy`) | `alystria-ai/ai-npc-cyberpunk-mod-skippy` | `..\cyberpunk-convai-skippy` | Oct 20 |
| Delamain Cab (`delamain-cab`) | `alystria-ai/ai-npc-cyberpunk-mod-delamain` | `..\cyberpunk-convai-delamain` | Oct 25 |

Their tests run against this repository's add-on host, Lua harness and `mod/addons.lua` (found through `CYBERPUNK_CONVAI_MAIN` or a
sibling folder), so a change to the add-on API here should be checked by running both add-on test files there. To evaluate or
develop one with the main mod, point the bridge at its folder with `CYBERPUNK_CONVAI_ADDONS`, and run
`node scripts/addon-eval.mjs --addon <that folder> --script <that folder>/eval/<script>.json`. The goals each was built to follow:

**Skippy** (`ai-npc-cyberpunk-mod-skippy`, Oct 20):
- One speaker, `gun`, anchored to `'player'` and available while V holds Skippy.
- Two modes in the manifest, `killer` and `puppy`, chosen by a Personality setting through `setMode`.
- Kill, headshot, damage and civilian-hit detection in Skippy's own `init.lua`, through `Observe` hooks with O(1) handlers.
- Remarks: first kill (4), headshot streak of 3 or more (4), near death (5), a civilian hit in Pacifist mode (4), fight end (5),
  and ordinary kills (2) as filler for the short gaps.
- `prepare('gun')` on `combatStarted`.
- `remember` for memorable fights.
- An eval script with at least one full fight per mode.

**Delamain** (`ai-npc-cyberpunk-mod-delamain`, id `delamain-cab`, Oct 25):
- One speaker, `delamain`, anchored to `'vehicle'`, with `group = true`, available only in a Delamain cab.
- Never starts a line over the game's own Delamain scenes (default `sceneTiers = {1}`): every remark has `patience` and waits for the
  scene or subtitle line to end; a line that has started plays through (`playThrough`). The cab's own welcome, "your wish is my
  command", arrival announcement and goodbyes (12 lines of `delamain_taxi.scene`) are replaced while it sits in the cab
  (`replaceGameLines`, the window starts when V climbs in): the welcome through the game's own skip switch (the quest fact
  `delamain_skip_dialog`, set before the scene's node 730, which cleans it up itself; the map, the fare and the ride are not touched),
  the arrival and goodbyes by a voice stop (`audio = {'vo_3d','vo_2d','vo_3d_important'}`, not yet heard-tested) and a hidden subtitle.
- `setCompanionContext('ride', …)` while riding, cleared on exit.
- Remarks: boarding (4), arrival (5), a crash or chase (4), at most one landmark (3).
- `remember` for notable rides.
- An eval script covering a ride with a companion.

Both: `providers` `["mistral", "local"]`; samples for every moment you remark on; average 7 or more in the eval with no repeats;
the zip from the add-on's own `tools/build.mjs`.
