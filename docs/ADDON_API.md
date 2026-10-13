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
| `handle:speaker{id, name, anchor, available, talk, group, minGap, talkPriority, sceneTiers}` | Adds a voice and returns its profile key. `id` and `name` must match the manifest. The options are described below this table. |
| `handle:remark(speakerId, {event, text, facts, priority, ttl, maxWords, interrupt, cooldown})` | Asks for one automatic line. See Remarks. Returns `true` when the remark is queued, or `false, reason` with one of `speaker-cooldown`, `addon-gap`, `episode-budget`, `no-provider`, `event-cooldown`, `queue-full` or `add-on disabled`. |
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
| `remarkFinished` | `{speaker, event, reason, spoken}`. `reason` is one of `finished`, `not-delivered`, `manual-priority`, `scene`, `scene-tier`, `speaker-unavailable`, `interrupted`, `cancelled`, `add-on-disabled` or `anchor-changed` |
| `remarkDropped` | `{speaker, event, reason}`: the remark was never sent. `reason` is one of `replaced`, `expired`, `scene`, `speaker-unavailable`, `speaker-cooldown`, `addon-gap`, `episode-budget` or `request-write-failed` |
| `settingChanged` | `{id, value}`, sent on the tick after Apply (never inside the menu) |

A handler that throws three times is removed. The main mod has no kill, headshot or damage events. An add-on that needs them
hooks the game itself in its own `init.lua` with `Observe`/`ObserveAfter` on the game function, keeps each handler to a few
table writes, and never polls in `onUpdate` (see Skippy below).

## Remarks: few, and at the best moments

Players should hear about **2 to 4 remarks in a typical fight**, each at a moment worth a line. Every add-on with a speaker gets a
built-in **Remarks** setting:

| Remarks | Gap between two remarks of the add-on | Remarks per episode |
|---|---|---|
| Rare | 60 s | 2 |
| **Low** (default) | 30 s | 3 |
| Normal | 20 s | 5 |

- An **episode** is one fight, from `combatStarted` until the next fight starts. Outside combat it is a rolling five minutes.
- The **last remark of the budget is kept for priority 4 or 5.** With Low, two remarks of any priority can be made, and the third
  only for a big moment.
- A **priority 5** remark needs only half the gap, so a near-death line right after a first-kill line still gets through.
- A remark that was never heard (the player started talking, a scene began, or the bridge dropped it as a repeat) does not spend
  the budget or start the gap.
- `handle:remark` refuses at once (`addon-gap`, `episode-budget`) when a remark could not be made, so the add-on does no work for it.

Choose priorities like this:

| Priority | Use for | Skippy | Delamain |
|---|---|---|---|
| 5 | the moment of the fight or ride | near death; fight end | arrival; V nearly dies in the cab |
| 4 | a highlight | first kill; headshot streak (3+); a civilian hit in Pacifist mode | V boards; a crash; a police chase starts |
| 3 | notable | a weapon mode change; a long reload under fire | a landmark passed |
| 1–2 | filler; usually not worth asking | an ordinary kill | small talk |

The other remark fields:

| Field | Default | Meaning |
|---|---|---|
| `event` | required | A name for the moment, such as `first-kill`. One waiting remark is kept per speaker and event; newer facts replace older ones. |
| `text` | `[<add-on>] <event>` | What happened, in one plain sentence. It becomes the start of the trigger. |
| `facts` | none | Plain data, at most 4,000 bytes as JSON (`{streak = 3, weapon = 'Skippy'}`). The speaker may use only these facts. |
| `ttl` | 4 s (1–30) | A remark that cannot start within this time is dropped, never played late. |
| `maxWords` | 14 (3–60) | The trigger asks for one line of at most this many words. Use 6–12 for barks. |
| `interrupt` | false | Stops a remark of a *lower* priority that is playing. |
| `cooldown` | 0 | Seconds before the same event may be remarked again. |

**Arbitration.** A remark never overlaps other speech or game dialogue. It waits while any of these is going on:

- a player turn, the microphone, a group round, phone chat or another automatic turn;
- a pending request, voice playing, or a caption on screen;
- the 2 s after any speech;
- dialogue, choices, a call, or a scene tier the speaker does not allow.

It also waits while subtitles and voice are both off. The scheduler then sends the highest priority first, through the request
file every automatic turn uses, with a lease the bridge checks. If the player starts talking, or a scene starts, the remark stops
at once.

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
- An add-on's request budget is its Remarks setting: at most 3 requests a fight with Low, and at most 5 with Normal.
- Mistral requests are paced by the same scheduler as the companions' requests on that key (about one a second on the free plan).
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

**Few-shot samples are the strongest lever.** A small model copies their length, rhythm and attitude.
- Write 3–6 samples per mode, each as one exchange: `"V: <words>\nSkippy: <line>"` for talk, and
  `"Game event: <what happened>\nSkippy: <line>"` for remarks.
- Cover the moments you will remark on: first kill, streak, near death, fight end.
- Make every sample short and in voice. The speaker is told never to repeat a sample word for word, so samples teach the voice
  without becoming stock lines.

**Anti-repetition.** The bridge keeps each speaker's last 12 spoken lines (`runtime/addon-journal.json`, across game sessions):
- The last 6 go into every prompt as "Your most recent lines (never repeat one, its joke or its wording; find a new angle)".
- A remark that nearly repeats one of the last 8 is **dropped before it is spoken** (`errorCode: 'addon-duplicate'`, silent), and
  the next event gets a fresh chance.
- "Nearly repeats" (`isNearDuplicate`) means the same words, a word overlap of 0.6 or more, or the same run of four words.
- A reply to something V typed is never dropped.

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
/** Once at bridge start. api = {version, addon: {id, name, version, speakers}, log, settings(), state()} (frozen). */
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

/** A line the speaker just said: return a memory string to keep, or nothing. */
export function remember({speaker, event, facts, mode, line, reaction, settings}) {
  return event === 'fight-end' && facts?.kills >= 5 ? `A ${facts.kills}-kill fight; Skippy said: "${line}"` : null;
}

/** The add-on's settings changed (the values from runtime/addon-settings.json). */
export function onSettings(values) {}
```

## Talk and group conversation

- **Talk key (typed).** An available speaker answers the talk key when no character with a profile is under the crosshair. A
  character V aims at always wins. Replies use the same route, persona, voice and subtitles as remarks, and stream their first
  sentence to the voice.
- **Voice key.** Not supported for add-on speakers yet. Pressing it with only an add-on voice in reach shows: "Skippy answers
  typed messages only for now. Use {key}." In a group, voice rounds leave add-on voices out.
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

- The section appears on the main settings page after Reactions, with the built-in **Remarks** setting first.
- `id` uses letters, digits and `_`. `remarkRate` is reserved for the built-in setting. At most 24 items; `kind` is `bool` or
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

- Each step goes through the same persona and mode, blocks, trigger, recent lines, duplicate drop and text host as in the game.
  Nothing touches the game, Convai or the player's memories.
- The key comes from `MISTRAL_API_KEY`, or from the key saved in the state folder, and is never printed.
- `--judge` scores each line from 1 to 10 with a second model, against this rubric: in character, fun, fits the moment, short and
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
| `mod/init.lua` | Loads `addons.lua` with `pcall`; returns `{addons = …}` for `GetMod`. Talk target: add-on voices after aimed characters, and never for the voice key. `sendRequest`/`decorate`; `reactionCanDeliver` → `canDeliver`; `groupAudience` → `participantLive`; the reply error branch → `replyError`; `warmConversation` skips add-on voices; tick, reset and shutdown. |
| `mod/speech.lua`, `continuous-speech.lua`, `subtitles.lua` | `voiceOnly`: no face calls, no `IsDeadNoStatPool` check, subtitles owned by the player. |
| `mod/group-chat.lua` | `voiceOnly` rows; add-on voices are left out of the other speakers' audience. |
| `mod/mcm.lua`, `mod/notices.lua` | Add-on settings sections; the `addon-notice` notice. |
| `bridge/convai-bridge.mjs` | `AddonHost.load`, `extend` (roster rows; add-on Convai IDs removed), voice config merge, status, state/settings watchers, journal; `runAddonTurn` before every Convai step of `runInput`; one `TextProviderHost` per add-on route (`fixedProvider`, `sharedMemory`, never Groq); `onWarm`. |
| `bridge/protocol.mjs`, `bridge/mistral-prompt.mjs` | The `addon` request field and reaction; persona rows with `intro`, `identityRule` and `rules`. |

## What the game must confirm live

1. `GetMod('CyberpunkConvai')` from another mod's `onInit` returns the API (CET load order).
2. The voice of a `'player'` speaker plays as V's own audio, and of a `'vehicle'` speaker from the car (Audioware emitter on V and
   on vehicles). Subtitles show the speaker's name.
3. A remark's latency from `handle:remark` to the first audio on Mistral (target under 2 s, with `prepare` called at the start of
   the fight).
4. A vehicle anchor survives `IsAttached`, and no `IsDeadNoStatPool` call reaches a vehicle.
5. Delamain detection: the add-on's `available()` recognises a Delamain cab ride, and remarks stay silent while the game's own
   Delamain dialogue plays (scene tier above 1, or dialogue).
6. The Local AI pack starts when a remark needs it and no FPS is lost outside the request.
7. The provider notice appears once with no Mistral key and no Local AI pack.
8. Remarks per fight feel right on Low (2–4 heard in a typical fight).

## Building Skippy and Delamain

Build against this document and `addons/example/`.

**Skippy** (`addons/skippy`, Oct 20):
- One speaker, `gun`, anchored to `'player'` and available while V holds Skippy.
- Two modes in the manifest, `killer` and `puppy`, chosen by a Personality setting through `setMode`.
- Kill, headshot, damage and civilian-hit detection in Skippy's own `init.lua`, through `Observe` hooks with O(1) handlers.
- Remarks: first kill (4), headshot streak of 3 or more (4), near death (5), a civilian hit in Pacifist mode (4), fight end (5).
- `prepare('gun')` on `combatStarted`.
- `remember` for memorable fights.
- An eval script with at least one full fight per mode.

**Delamain** (`addons/delamain-cab`, Oct 25):
- One speaker, `delamain`, anchored to `'vehicle'`, with `group = true`, available only in a Delamain cab.
- Never active in the game's own Delamain scenes (default `sceneTiers = {1}`).
- `setCompanionContext('ride', …)` while riding, cleared on exit.
- Remarks: boarding (4), arrival (5), a crash or chase (4), at most one landmark (3).
- `remember` for notable rides.
- An eval script covering a ride with a companion.

Both: `providers` `["mistral", "local"]`; samples for every moment you remark on; average 7 or more in the eval with no repeats;
`packaging/build-addon.mjs` for the zip.
