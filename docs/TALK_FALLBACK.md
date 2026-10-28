# Talking with nobody in view: the party answers, and Johnny has his own keys

Written 2026-10-25 on branch `fix/talk-fallback` (from `integration/next`). Not installed, not seen in the game.

## The request

A player on Nexus (2026-10-25): "i spend a lot of time talking to companions while driving or moving somewhere. and having to look at the passenger can be a bit of a pain at times. maybe you could add in some kind of fallback where if you are not looking directly at someone when you hit the PTT button or text input it defaults to your first follower? that way if you are looking at someone you could talk with that person. but if you are not, you still speak to your party/followers?"

The only thing in the way was Johnny: with Johnny in your head turned on, the talk keys with nobody in front of V already did something, they addressed Johnny (`docs/JOHNNY_IN_YOUR_HEAD.md`). The owner's decision: Johnny gets his own keys, and the talk keys with nobody faced go to the party.

## What a player gets

| Key | Someone faced or under the crosshair | Nobody faced |
|---|---|---|
| **Talk by voice** / **Talk by text** | that person, as before | the **first member of the party** |
| **Group voice chat** / **Group text chat** | that person leads the round (anyone V can talk to, a stranger on the street too), then V's companions and the nearest others, up to three (docs/GROUP_VOICE.md "Anyone nearby") | the **first member of the party plus two others picked at random** from the rest of the party (fewer when the party is smaller) |
| **Talk to Johnny by voice** (hold) / **Talk to Johnny by text** (tap) | Johnny, whoever is faced | Johnny |

- "First" is the order of **Companion Manager > Current party**, the order the copies joined, not the nearest. Only ready party members count (a copy still preparing, leaving or failed does not), and only within the talk range of eight metres, the same range the group round uses. A first member who is out of range, switched off in the manager or without a conversation profile is skipped and the next one in the list answers.
- With no party member in range the talk keys show the notice they always showed with nobody in front ("Face a nearby character to talk."). The group keys with a party of one show "Group chat needs two characters nearby."
- Housemates (visiting copies that live in V's flat) and characters another mod spawned never count as the party for the fallback. In a group round they still fill a seat the party cannot, after the party members.
- An installed add-on voice (a talking gun, a cab) still answers a talk key with nobody faced, as before: it was always ahead of the empty crosshair. The fallback is what is left when no add-on voice is available.
- The controller talk button (hold the left stick click, `docs/CONTROLLER_BINDING.md`) and Voice activation use the same talk path, so they follow the party too. A controller button for Johnny is set on the Key bindings page like any other action.
- Facing a party member, or anyone else, is exactly as before, including the rule that a conversation in progress keeps its partner (`mod/talk-target.lua`).

### Johnny

- **Talk to Johnny by voice** and **Talk to Johnny by text** are two more CET bindings (`cyberpunk_convai_johnny_voice`, an input, hold to talk; `cyberpunk_convai_johnny_text`, a hotkey) and two more rows on **Companion Manager > Key bindings** (`docs/KEY_BINDINGS.md`), so a keyboard key or a controller button can be given to each. Nothing is set by default.
- They work as Johnny always worked: while the story has him in V's head, **Settings > Conversations > Johnny in your head** is on, and the game does not have the floor. He answers as the voice in V's head, wherever V faces (facing someone does not change it). The talk keys no longer reach him.
- When he cannot answer, the key says why and starts nothing: "Johnny in your head is off. Turn it on in Settings > Conversations." (setting off, notice `talk-johnny-off`), "Johnny Silverhand is not in your head right now." (the story has not put him there yet or has taken him out, or his profile is switched off in the manager, `talk-johnny-away`), "Johnny Silverhand is busy right now." (a scene, a call, a quest conversation, a fight, a dialogue choice or right after a game line of his, `talk-busy`, as before). The old behaviour showed "Face a nearby character to talk." for every case but the last, which meant nothing for a key that is only for Johnny.
- Group chat never included Johnny, and still does not.

## How it works

`mod/init.lua`, `selectConversation(player, groupMode, singleAction, addonHears, talkJohnny)`, the one place every talk key goes through (typed `beginTextNow`, voice `toggleVoice`; the voice activation, controller button and own key bindings call the same functions):

1. `talkJohnny` (the two Johnny keys): `convaiTalkJohnny(player)` returns Johnny's partner row (the holocall's audio route with the `head` marker, unchanged) or shows the notice. Nothing else of the selection runs: no crosshair query, no holocall check, no add-on voice.
2. Otherwise the crosshair decides as before (`targetAtCrosshair`, `mod/talk-target.lua`). A connected holocall and the add-on voices keep their places ahead of the fallback.
3. Private, nobody faced: `convaiTalkFirstParty(player)` asks `companions.partyInOrder(player, 8)` (ready copies within range, in list order) and takes the first that has a supported, enabled profile. The result goes through the ordinary path (profile, story and quest checks, archetype names, the group "needs two" rule), exactly as if V had faced that copy.
4. Group, nobody faced: `convaiTalkGroupFromParty(candidates)` puts the first party member first, then two picked with `math.random` from the rest of the party, then the unchosen party members, then everyone else (housemates, spawned characters). `groupChat.choose` takes the first three distinct profiles as before. If no party member is among the candidates, the old rule applies (the nearest candidate leads).

`mod/companions.lua`: `conversationCandidates` rows now carry `party` (a ready party member) and `order` (the place in the list); `partyInOrder` is the filtered, list-ordered view. `mod/key-bindings.lua`: `M.ACTIONS` gains `johnny_voice` (hold) and `johnny_text` (tap) as slots 6 and 7. The redscript half needed no code change (it takes as many slots as the list holds).

## Cost

Decided once on the key press, never polled: one walk over the few party copies, the same native reads `conversationCandidates` already made for a group round. Nothing in `onUpdate` or on the 10 Hz tick, no new timer, no new file read. The decision adds no wait: the connection that `warmConversation` prepares when the box opens or the key goes down is the chosen member's, picked before that call, and the party's connections are already open (the party owns private connections, `bridge/party-connections.mjs`, up to eight at once). On a player's own free Convai key, which holds one connection at a time, the first member's connection opens on demand like any other member's: there is no pre-opened connection for "the member the next key press will pick", because the pick depends on who V faces at that moment. The probe log has one line per decision: `Talk fallback: first party member <profile>` or `Talk fallback: group of the party, first=... then=...`. A typed line sent that way adds `Talk fallback: request handed to the service: generation=N` when it is written for the service, and every typed line (faced or not) gets one more line 2 s later (6 s if the first look found nothing): `Talk request received by the service: generation=N state=...`, or `Talk request not received by the service within 6 s: generation=N service=<the state the service last wrote> written=<s>s heartbeat=<s>s` (`init.lua convaiTalkReceiptTick`, `mod/service-status.lua receipt`). The bridge marks each request it takes in its status at once (`received`) and logs `[Turn] received <requestId> generation=N`.

`init.lua` is at Lua's limit of 200 local variables in the main chunk, so the three new helpers are global functions (`convaiTalkFirstParty`, `convaiTalkGroupFromParty`, `convaiTalkJohnny`).

## Files

`mod/init.lua`, `mod/companions.lua`, `mod/key-bindings.lua`, `mod/manager.lua` (`keyBindingOrder`), `mod/manager-ui.lua` (the page, the Johnny setting's help text, Restore defaults), `mod/notices.lua`, `mod/locales/*.lua`, `localization/en.json`, `bridge/talk-fallback.test.mjs` (the target choice and the party order), `bridge/key-bindings.test.mjs`, `bridge/phone-input.test.mjs`, `bridge/talk-addon-voice.test.mjs`, `bridge/mcm-host.test.mjs`, `bridge/nsui-manager.test.mjs`, `bridge/manager.test.mjs`. Docs: `docs/KEY_BINDINGS.md`, `docs/JOHNNY_IN_YOUR_HEAD.md`, `docs/NOTIFICATIONS.md`, `docs/MANAGER_UI.md`, `docs/CONTROLLER_BINDING.md`, `docs/SETTINGS_MATRIX.md`, `README.md`, `packaging/PLAYER_README.md`, `docs/NEXUS_PAGE.md`.

## Live checks (not run)

Needs the Scripts install (all committed `mod/` files) and a CET reload. No redscript, no game restart.

1. With a party of three (order in **Current party**: A, B, C), stand still facing a wall and hold **Talk by voice**: A answers, whichever of the three stands nearest. `probe.log`: `Talk fallback: first party member <A>`. Same with **Talk by text**.
2. Face B and press the key: B answers (no fallback line). Walk away from A past eight metres and press with nobody faced: B answers.
3. **Group voice chat** and **Group text chat** facing nobody: A and two of {B, C, D...} answer; repeat a few times, A always leads and the other two vary. With a party of two: both answer. With one: "Group chat needs two characters nearby."
4. Drive with a companion in the passenger seat, never turning the camera to her: the talk key reaches her. (The cab add-on, when installed, still answers first.)
5. No party, nobody faced: "Face a nearby character to talk." and Johnny is not reached even with his setting on.
6. Bind **Talk to Johnny by voice** and **Talk to Johnny by text** (keyboard and a controller button) on Key bindings. With Johnny in your head on and the story past Playing for Time: Johnny answers wherever you face, including while facing a companion. During a scene or a fight: "Johnny Silverhand is busy right now." With the setting off: the "is off" notice. On a save before Playing for Time: the "not in your head" notice.
7. Check one other language for cut-off text on the Key bindings page (the two new sections and the longer help texts).
